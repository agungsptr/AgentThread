import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import type { Actor, EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { rotateCoordinator } from "../../src/orchestration/sessions.ts";
import { sweep } from "../../src/orchestration/sweep.ts";
import { HANDOFF_REQUEST_PREFIX } from "../../src/agents/prompts.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, threadCreated } from "../helpers.ts";

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const W = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NEW = "00000000-0000-4000-8000-000000000001";
const COORD: Actor = { role: "coordinator", thread: "001", session: C };
let n = 0;
const ctx = (config = DEFAULT_CONFIG) => ({ root: "/repo", config, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` });

function apply(state: State, ts: string, ...bodies: EventBody[]): StoredEvent[] {
  return applyAs(state, ts, USER, ...bodies);
}

function applyAs(state: State, ts: string, actor: Actor, ...bodies: EventBody[]): StoredEvent[] {
  return bodies.map((b) => {
    const ev = { ...b, seq: state.lastSeq + 1, ts, actor } as StoredEvent;
    applyEvent(state, ev);
    return ev;
  });
}

function base(): State {
  n = 0;
  const s = stateOf(INIT, threadCreated("001", { status: "in_progress" }), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
  apply(
    s,
    "2026-10-11T10:00:00.000Z",
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    { type: "session.started", thread: "001", payload: { session: C } },
  );
  return s;
}

test("precompact requests rotation once and queues a handoff request", () => {
  const s = base();
  const r = react(s, apply(s, "2026-10-11T10:01:00.000Z", { type: "session.compacting", thread: "001", payload: { session: C } }), ctx());
  expect(r.events).toEqual([{ type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "precompact" } }]);
  const q = react(s, apply(s, "2026-10-11T10:01:00.000Z", ...r.events), ctx());
  expect(q.events).toHaveLength(1);
  expect((q.events[0] as { payload: { text: string } }).payload.text.startsWith(HANDOFF_REQUEST_PREFIX)).toBe(true);
  // a second compacting while pending does nothing
  expect(react(s, apply(s, "2026-10-11T10:02:00.000Z", { type: "session.compacting", thread: "001", payload: { session: C } }), ctx()).events).toEqual([]);
});

test("high context on idle requests rotation; below threshold does not", () => {
  const s = base();
  expect(react(s, apply(s, "2026-10-11T10:01:00.000Z", { type: "agent.idle", thread: "001", payload: { session: C, contextTokens: 100_000 } }), ctx()).events).toEqual([]);
  expect(react(s, apply(s, "2026-10-11T10:02:00.000Z", { type: "agent.idle", thread: "001", payload: { session: C, contextTokens: 150_000 } }), ctx()).events).toEqual([
    { type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "context" } },
  ]);
});

test("handoff while rotating: rotated, replacement split from old pane, carried notices exclude the request", () => {
  const s = base();
  apply(
    s,
    "2026-10-11T10:01:00.000Z",
    { type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "context" } },
    { type: "notice.queued", thread: "001", payload: { session: C, text: `${HANDOFF_REQUEST_PREFIX} rotate` } },
    { type: "notice.queued", thread: "001", payload: { session: C, text: "Ticket T1 is done." } },
  );
  const r = react(s, applyAs(s, "2026-10-11T10:02:00.000Z", COORD, { type: "handoff.submitted", thread: "001", payload: { content: "## …", generated: false } }), ctx());
  const newId = "00000000-0000-4000-8000-000000000001";
  expect(r.events).toEqual([
    { type: "session.rotated", thread: "001", payload: { session: C, reason: "context" } },
    { type: "session.created", thread: "001", payload: { session: newId, role: "coordinator", agent: "claude-code", name: expect.any(String), replaces: C } },
    { type: "notice.queued", thread: "001", payload: { session: newId, text: "Ticket T1 is done." } },
  ]);
  expect(r.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", session: newId, splitFrom: "w1:p2", direction: "right", bootstrap: "handoff" })]);
  // attach of the replacement closes the old pane and moves the root pane
  apply(s, "2026-10-11T10:02:00.000Z", ...r.events);
  const a = react(s, apply(s, "2026-10-11T10:03:00.000Z", { type: "session.attached", thread: "001", payload: { session: newId, pane: "w1:p5" } }), ctx());
  expect(a.events).toEqual([{ type: "thread.root_pane_changed", thread: "001", payload: { pane: "w1:p5" } }]);
  expect(a.effects).toEqual([{ kind: "pane.close", pane: "w1:p2" }]);
});

test("handoff without a pending rotation does nothing", () => {
  const s = base();
  expect(react(s, apply(s, "2026-10-11T10:02:00.000Z", { type: "handoff.submitted", thread: "001", payload: { content: "x", generated: false } }), ctx()).events).toEqual([]);
});

test("idle timeout: a stale coordinator is rotated with a generated handoff instead of receiving the notice", () => {
  const s = base();
  apply(s, "2026-10-11T10:00:30.000Z", { type: "agent.idle", thread: "001", payload: { session: C } });
  const r = react(s, apply(s, "2026-10-13T10:00:00.000Z", { type: "notice.queued", thread: "001", payload: { session: C, text: "wake up" } }), ctx());
  expect(r.events.map((e) => e.type)).toEqual(["handoff.submitted", "session.rotated", "session.created", "notice.queued"]);
  expect(r.events[0]).toMatchObject({ payload: { generated: true } });
  expect(r.effects.map((e) => e.kind)).toEqual(["agent.spawn"]);
});

test("sweep: handoff timeout generates a handoff, or rotates directly when fallback is off", () => {
  const s = base();
  apply(s, "2026-10-11T10:01:00.000Z", { type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "precompact" } });
  expect(sweep(s, "2026-10-11T10:05:00.000Z", ctx()).events).toEqual([]);
  const late = sweep(s, "2026-10-11T10:07:00.000Z", ctx());
  expect(late.events).toEqual([{ type: "handoff.submitted", thread: "001", payload: { content: expect.stringContaining("did not write a handoff within 5m"), generated: true } }]);
  const off = { ...DEFAULT_CONFIG, session: { ...DEFAULT_CONFIG.session, handoff: { timeout: "5m", fallback_generate: false } } };
  expect(sweep(s, "2026-10-11T10:07:00.000Z", ctx(off)).events.map((e) => e.type)).toEqual(["session.rotated", "session.created"]);
});

const notices = (events: EventBody[], session: string) =>
  events.filter((e) => e.type === "notice.queued" && e.payload.session === session).map((e) => (e as { payload: { text: string } }).payload.text);

test("idle timeout with two notices in one batch: nothing is delivered to the old pane, the replacement gets them once", () => {
  const s = base();
  apply(s, "2026-10-11T10:00:30.000Z", { type: "agent.idle", thread: "001", payload: { session: C } });
  const r = react(
    s,
    apply(
      s,
      "2026-10-13T10:00:00.000Z",
      { type: "notice.queued", thread: "001", payload: { session: C, text: "a" } },
      { type: "notice.queued", thread: "001", payload: { session: C, text: "b" } },
    ),
    ctx(),
  );
  expect(r.effects.filter((e) => e.kind === "notice.deliver")).toEqual([]);
  expect(r.events.filter((e) => e.type === "session.rotated")).toHaveLength(1);
  expect(notices(r.events, NEW)).toEqual(["a\nb"]);
  expect(notices(r.events, C)).toEqual([]);
});

function withWorker(): State {
  const s = base();
  apply(
    s,
    "2026-10-11T10:01:00.000Z",
    { type: "session.created", thread: "001", payload: { session: W, role: "worker", agent: "claude-code", name: "w", ticket: "T1" } },
    { type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "context" } },
  );
  return s;
}

test("a worker failure in the same batch as the rotating handoff is queued for the replacement", () => {
  const handoff: EventBody = { type: "handoff.submitted", thread: "001", payload: { content: "h", generated: true } };
  const failed: EventBody = { type: "session.failed", thread: "001", payload: { session: W, reason: "boom" } };
  for (const order of [[handoff, failed], [failed, handoff]]) {
    const s = withWorker();
    const r = react(s, apply(s, "2026-10-11T10:02:00.000Z", ...order), ctx());
    expect(r.events.filter((e) => e.type === "session.rotated")).toHaveLength(1);
    expect(notices(r.events, C)).toEqual([]);
    expect(notices(r.events, NEW)).toEqual(["Worker for T1 failed: boom."]);
  }
});

test("only a coordinator-authored or generated handoff completes a pending rotation", () => {
  const s = withWorker();
  expect(react(s, apply(s, "2026-10-11T10:02:00.000Z", { type: "handoff.submitted", thread: "001", payload: { content: "x", generated: false } }), ctx()).events).toEqual([]);
  const g = react(s, apply(s, "2026-10-11T10:02:00.000Z", { type: "handoff.submitted", thread: "001", payload: { content: "x", generated: true } }), ctx());
  expect(g.events[0]).toEqual({ type: "session.rotated", thread: "001", payload: { session: C, reason: "context" } });
});

test("a repeated rotation_requested does not queue a second handoff request; a high-context idle while pending requests nothing", () => {
  const s = withWorker();
  expect(react(s, apply(s, "2026-10-11T10:03:00.000Z", { type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "context" } }), ctx()).events).toEqual([]);
  expect(react(s, apply(s, "2026-10-11T10:04:00.000Z", { type: "agent.idle", thread: "001", payload: { session: C, contextTokens: 190_000 } }), ctx()).events).toEqual([]);
});

test("idle-timeout rotation fed back through the reactor does not rotate again", () => {
  const s = base();
  apply(s, "2026-10-11T10:00:30.000Z", { type: "agent.idle", thread: "001", payload: { session: C } });
  const r = react(s, apply(s, "2026-10-13T10:00:00.000Z", { type: "notice.queued", thread: "001", payload: { session: C, text: "wake up" } }), ctx());
  const next = react(s, apply(s, "2026-10-13T10:00:00.000Z", ...r.events), ctx());
  expect(next.events).toEqual([]);
  expect(next.effects).toEqual([]);
});

test("sweep is quiet after the rotation and ignores a coordinator that is not the thread's acting one", () => {
  const s = withWorker();
  const r = react(s, applyAs(s, "2026-10-11T10:02:00.000Z", COORD, { type: "handoff.submitted", thread: "001", payload: { content: "h", generated: false } }), ctx());
  apply(s, "2026-10-11T10:02:00.000Z", ...r.events);
  expect(sweep(s, "2026-10-11T11:00:00.000Z", ctx()).events).toEqual([]);

  // a second live coordinator with a pending rotation, behind the acting one
  const t = base();
  const C2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  apply(
    t,
    "2026-10-11T10:01:00.000Z",
    { type: "session.created", thread: "001", payload: { session: C2, role: "coordinator", agent: "claude-code", name: "c2" } },
    { type: "session.rotation_requested", thread: "001", payload: { session: C2, reason: "context" } },
  );
  expect(sweep(t, "2026-10-11T11:00:00.000Z", ctx()).events).toEqual([]);
});

test("rotateCoordinator does nothing for a done thread or one without a root pane", () => {
  const s = base();
  const c = s.sessions.get(C)!;
  const t = s.threads.get("001")!;
  t.status = "done";
  expect(rotateCoordinator(s, c, "context", ctx())).toEqual({ events: [], effects: [] });
  t.status = "in_progress";
  t.rootPane = undefined;
  expect(rotateCoordinator(s, c, "context", ctx())).toEqual({ events: [], effects: [] });
});

test("old-log resuming restarts a pending rotation's clock and records resumingAt; the sweep skips the starting coordinator", () => {
  const s = base();
  apply(s, "2026-10-11T10:01:00.000Z", { type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "precompact" } });
  apply(s, "2026-10-11T10:09:00.000Z", { type: "session.lost", thread: "001", payload: { session: C, reason: "x" } }, { type: "session.resuming", thread: "001", payload: { session: C } });
  const c = s.sessions.get(C)!;
  expect(c.rotation).toEqual({ reason: "precompact", requestedAt: "2026-10-11T10:09:00.000Z" });
  expect(c.resumingAt).toBe("2026-10-11T10:09:00.000Z");
  // starting, no pane: neither a handoff nor a rotation, even though the original request is long overdue
  expect(sweep(s, "2026-10-11T10:10:00.000Z", ctx())).toEqual({ events: [], effects: [] });
  // attached and started again: the clock counts from the resume
  apply(s, "2026-10-11T10:10:00.000Z", { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } }, { type: "session.started", thread: "001", payload: { session: C } });
  expect(sweep(s, "2026-10-11T10:13:00.000Z", ctx()).events).toEqual([]);
  expect(sweep(s, "2026-10-11T10:15:00.000Z", ctx()).events.map((e) => e.type)).toEqual(["handoff.submitted"]);
});

test("sweep skips a coordinator without a pane", () => {
  const s = base();
  delete s.sessions.get(C)!.pane;
  apply(s, "2026-10-11T10:01:00.000Z", { type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "precompact" } });
  expect(sweep(s, "2026-10-11T11:00:00.000Z", ctx()).events).toEqual([]);
});

test("turns trigger rotation at exactly max_turns", () => {
  const cfg = { ...DEFAULT_CONFIG, session: { ...DEFAULT_CONFIG.session, rotation: { ...DEFAULT_CONFIG.session.rotation, max_turns: 3 } }, checkpoint: { reminder_turns: 99, reminder_after: "999d" } };
  const s = base();
  s.sessions.get(C)!.authored = true; // it ran agt commands: the stall watchdog stays out of this test
  const turn = (min: number) => {
    apply(s, `2026-10-11T10:0${min}:00.000Z`, { type: "session.active", thread: "001", payload: { session: C } });
    return react(s, apply(s, `2026-10-11T10:0${min}:00.000Z`, { type: "agent.idle", thread: "001", payload: { session: C } }), ctx(cfg)).events;
  };
  expect(turn(1)).toEqual([]);
  expect(turn(2)).toEqual([]);
  expect(turn(3)).toEqual([{ type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "turns" } }]);
});

/** One finished turn: active, then idle. */
const oneTurn = (s: State, ts: string) =>
  apply(s, ts, { type: "session.active", thread: "001", payload: { session: C } }, { type: "agent.idle", thread: "001", payload: { session: C } });

test("sweep requests rotation by age once", () => {
  const s = base();
  oneTurn(s, "2026-10-11T10:05:00.000Z");
  expect(sweep(s, "2026-10-11T17:59:00.000Z", ctx()).events).toEqual([]);
  const r = sweep(s, "2026-10-11T18:01:00.000Z", ctx());
  expect(r.events).toEqual([{ type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "age" } }]);
  apply(s, "2026-10-11T18:01:00.000Z", ...r.events);
  expect(sweep(s, "2026-10-11T18:02:00.000Z", ctx()).events).toEqual([]);
  const q = react(s, [{ ...r.events[0]!, seq: s.lastSeq, ts: "2026-10-11T18:01:00.000Z", actor: USER } as StoredEvent], ctx());
  expect((q.events[0] as { payload: { text: string } }).payload.text.startsWith(HANDOFF_REQUEST_PREFIX)).toBe(true);
});

test("sweep does not rotate by age a parked coordinator with 0 turns, nor one whose thread is in review or blocked", () => {
  const s = base();
  expect(s.sessions.get(C)!.turns).toBe(0);
  expect(sweep(s, "2026-10-12T10:00:00.000Z", ctx()).events).toEqual([]);
  oneTurn(s, "2026-10-11T10:05:00.000Z");
  for (const to of ["review", "blocked"] as const) {
    const t = s.threads.get("001")!;
    apply(s, "2026-10-11T10:06:00.000Z", { type: "thread.status_changed", thread: "001", payload: { from: t.status, to } });
    expect(sweep(s, "2026-10-12T10:00:00.000Z", ctx()).events).toEqual([]);
  }
  apply(s, "2026-10-11T10:07:00.000Z", { type: "thread.status_changed", thread: "001", payload: { from: "blocked", to: "in_progress" } });
  expect(sweep(s, "2026-10-12T10:00:00.000Z", ctx()).events).toEqual([{ type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "age" } }]);
});
