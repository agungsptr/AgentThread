import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import type { EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { sweep } from "../../src/orchestration/sweep.ts";
import { HANDOFF_REQUEST_PREFIX } from "../../src/agents/prompts.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, threadCreated } from "../helpers.ts";

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let n = 0;
const ctx = (config = DEFAULT_CONFIG) => ({ root: "/repo", config, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` });

function apply(state: State, ts: string, ...bodies: EventBody[]): StoredEvent[] {
  return bodies.map((b) => {
    const ev = { ...b, seq: state.lastSeq + 1, ts, actor: USER } as StoredEvent;
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
  const r = react(s, apply(s, "2026-10-11T10:02:00.000Z", { type: "handoff.submitted", thread: "001", payload: { content: "## …", generated: false } }), ctx());
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
