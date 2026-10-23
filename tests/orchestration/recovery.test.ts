import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import type { EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, threadCreated } from "../helpers.ts";

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const W = "11111111-1111-4111-8111-111111111111";
let n = 0;
const ctx = () => ({ root: "/repo", config: DEFAULT_CONFIG, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` });
const apply = (s: State, ...bodies: EventBody[]): StoredEvent[] =>
  bodies.map((b) => {
    const ev = { ...b, seq: s.lastSeq + 1, ts: "2026-10-11T10:00:00.000Z", actor: USER } as StoredEvent;
    applyEvent(s, ev);
    return ev;
  });

function base(): State {
  n = 0;
  const s = stateOf(INIT, threadCreated("001", { status: "in_progress" }), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
  apply(
    s,
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "agt-ab12-c001" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "a", scope: ["a"] } },
    { type: "ticket.created", thread: "001", payload: { ticket: "T2", title: "b", scope: ["b"] } },
    { type: "session.created", thread: "001", payload: { session: W, role: "worker", agent: "claude-code", name: "w", ticket: "T1" } },
    { type: "session.attached", thread: "001", payload: { session: W, pane: "w1:p3" } },
    { type: "ticket.claimed", thread: "001", payload: { ticket: "T1", assignee: W } },
  );
  return s;
}

test("lost coordinator is replaced by a fresh split from the root pane, with a generated handoff", () => {
  const s = base();
  const r = react(s, apply(s, { type: "session.lost", thread: "001", payload: { session: C, reason: "no agent in pane w1:p2" } }), ctx());
  expect(r.events.map((e) => e.type)).toEqual(["handoff.submitted", "session.created"]);
  expect(r.events[0]).toMatchObject({ payload: { generated: true, content: expect.stringContaining("the previous coordinator session was lost") } });
  const created = r.events[1]!;
  const newId = created.type === "session.created" ? created.payload.session : "";
  expect(newId).not.toBe(C);
  expect(created).toMatchObject({ payload: { role: "coordinator", replaces: C, retirePane: "w1:p2" } });
  expect(r.effects).toEqual([
    { kind: "agent.spawn", session: newId, role: "coordinator", name: expect.any(String), thread: "001", cwd: "/repo/.worktrees/001-thread-001", splitFrom: "w1:p2", direction: "right", bootstrap: "handoff" },
  ]);
  expect(r.effects[0]).not.toHaveProperty("resume");
  expect(r.effects[0]).not.toHaveProperty("pane");
  // with an existing handoff, none is generated
  const s2 = base();
  apply(s2, { type: "handoff.submitted", thread: "001", payload: { content: "x", generated: false } });
  expect(react(s2, apply(s2, { type: "session.lost", thread: "001", payload: { session: C, reason: "x" } }), ctx()).events.map((e) => e.type)).toEqual(["session.created"]);
});

test("a stored session.resume_failed event (old logs) produces no reaction", () => {
  const s = base();
  apply(s, { type: "session.lost", thread: "001", payload: { session: C, reason: "x" } }, { type: "session.resuming", thread: "001", payload: { session: C } });
  const r = react(s, apply(s, { type: "session.resume_failed", thread: "001", payload: { session: C, reason: "no saved Claude session" } }), ctx());
  expect(r).toEqual({ events: [], effects: [] });
  expect(s.sessions.get(C)!.status).toBe("lost");
});

test("lost worker releases its ticket, tells the coordinator, frees its slot", () => {
  const s = base();
  apply(s, { type: "worker.queued", thread: "001", payload: { ticket: "T2" } });
  const r = react(s, apply(s, { type: "session.lost", thread: "001", payload: { session: W, reason: "no agent in pane w1:p3" } }), ctx());
  expect(r.events).toEqual([
    { type: "ticket.released", thread: "001", payload: { ticket: "T1", reason: "worker session lost" } },
    { type: "notice.queued", thread: "001", payload: { session: C, text: "Worker for T1 was lost; the ticket is open again." } },
    expect.objectContaining({ type: "session.created", payload: expect.objectContaining({ ticket: "T2" }) }),
  ]);
});

test("tab reopened with a stale coordinator: loses it and its workers, no fresh spawn", () => {
  const s = base();
  const r = react(s, apply(s, { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t9", rootPane: "w1:p9" } }), ctx());
  expect(r.events).toEqual([
    { type: "session.lost", thread: "001", payload: { session: C, reason: "tab was reopened" } },
    { type: "session.lost", thread: "001", payload: { session: W, reason: "tab was reopened" } },
  ]);
  expect(r.effects).toEqual([]);
});

test("tab reopened in the same batch as a probe loss: one replacement, no fresh coordinator", () => {
  const s = base();
  const evs = apply(
    s,
    { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t9", rootPane: "w1:p9" } },
    { type: "session.lost", thread: "001", payload: { session: C, reason: "no agent in pane w1:p2" } },
  );
  const r = react(s, evs, ctx());
  const created = r.events.filter((e) => e.type === "session.created");
  expect(created).toEqual([expect.objectContaining({ payload: expect.objectContaining({ replaces: C, retirePane: "w1:p9" }) })]);
  expect(r.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", splitFrom: "w1:p9", bootstrap: "handoff" })]);
  expect(r.effects[0]).not.toHaveProperty("resume");
  // the replacement attaching retires the new tab's root pane (the lost session's old pane is gone with its tab)
  const newId = created[0]!.type === "session.created" ? created[0]!.payload.session : "";
  apply(s, ...r.events);
  const a = react(s, apply(s, { type: "session.attached", thread: "001", payload: { session: newId, pane: "w1:p10" } }), ctx());
  expect(a.effects).toEqual([{ kind: "pane.close", pane: "w1:p9" }]);
});

const COORD = { role: "coordinator" as const, thread: "001", session: C };

test("a rotation pending at loss: the replacement does not inherit the handoff request", () => {
  const s = base();
  const req = react(s, apply(s, { type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "context" } }), ctx());
  apply(s, ...req.events); // the HANDOFF REQUEST notice, not yet delivered
  const r = react(s, apply(s, { type: "session.lost", thread: "001", payload: { session: C, reason: "no agent in pane w1:p2" } }), ctx());
  expect(r.events.map((e) => e.type)).toEqual(["handoff.submitted", "session.created"]);
  const back = react(s, apply(s, ...r.events), ctx());
  expect(back.events.filter((e) => e.type === "session.rotated" || e.type === "session.created")).toEqual([]);
});

test("coordinator and worker lost in one batch: ticket released and the notice is queued to the replacement", () => {
  const s = base();
  const r = react(
    s,
    apply(
      s,
      { type: "session.lost", thread: "001", payload: { session: C, reason: "no agent in pane w1:p2" } },
      { type: "session.lost", thread: "001", payload: { session: W, reason: "no agent in pane w1:p3" } },
    ),
    ctx(),
  );
  const newId = (r.events.find((e) => e.type === "session.created") as { payload: { session: string } }).payload.session;
  expect(r.events).toEqual([
    expect.objectContaining({ type: "handoff.submitted" }),
    expect.objectContaining({ type: "session.created", payload: expect.objectContaining({ replaces: C }) }),
    { type: "ticket.released", thread: "001", payload: { ticket: "T1", reason: "worker session lost" } },
    { type: "notice.queued", thread: "001", payload: { session: newId, text: "Worker for T1 was lost; the ticket is open again." } },
  ]);
});

test("tab reopened path: the follow-up losses replace C and queue the worker notice to the replacement", () => {
  const s = base();
  const first = react(s, apply(s, { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t9", rootPane: "w1:p9" } }), ctx());
  const r = react(s, apply(s, ...first.events), ctx());
  const newId = (r.events.find((e) => e.type === "session.created") as { payload: { session: string } }).payload.session;
  expect(r.events).toEqual([
    expect.objectContaining({ type: "handoff.submitted" }),
    expect.objectContaining({ type: "session.created", payload: expect.objectContaining({ replaces: C, retirePane: "w1:p9" }) }),
    { type: "ticket.released", thread: "001", payload: { ticket: "T1", reason: "worker session lost" } },
    { type: "notice.queued", thread: "001", payload: { session: newId, text: "Worker for T1 was lost; the ticket is open again." } },
  ]);
  expect(r.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", session: newId, splitFrom: "w1:p9", bootstrap: "handoff" })]);
  apply(s, ...r.events);
  expect(s.sessions.get(newId)!.notices).toEqual(["Worker for T1 was lost; the ticket is open again."]);
});

test("lost coordinator: notices queued later in the same call go to the replacement; feeding its events back does not rotate", () => {
  const s = base();
  apply(s, { type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "context" } });
  const r = react(
    s,
    apply(
      s,
      { type: "session.lost", thread: "001", payload: { session: C, reason: "x" } },
      { type: "ticket.blocked", thread: "001", payload: { ticket: "T2", reason: "needs input" } },
    ),
    ctx(),
  );
  const created = r.events.find((e) => e.type === "session.created");
  const newId = created?.type === "session.created" ? created.payload.session : "";
  expect(r.events.find((e) => e.type === "notice.queued")).toMatchObject({ payload: { session: newId, text: "Ticket T2 is blocked: needs input." } });
  const back = react(s, apply(s, ...r.events), ctx());
  expect(back.events.filter((e) => e.type === "session.rotated" || e.type === "session.created")).toEqual([]);
});

test("worker lost whose ticket is not in progress and assigned to it: no release, plain notice", () => {
  const s = base();
  apply(s, { type: "ticket.completed", thread: "001", payload: { ticket: "T1" } });
  const r = react(s, apply(s, { type: "session.lost", thread: "001", payload: { session: W, reason: "x" } }), ctx());
  expect(r.events).toEqual([{ type: "notice.queued", thread: "001", payload: { session: C, text: "Worker for T1 was lost." } }]);
});

test("a loss of an ended session is ignored", () => {
  const s = base();
  apply(s, { type: "session.ended", thread: "001", payload: { session: W } });
  const r = react(s, apply(s, { type: "session.lost", thread: "001", payload: { session: W, reason: "x" } }), ctx());
  expect(r.events.filter((e) => e.type !== "session.created")).toEqual([]);
});

test("lost coordinator's replacement attaching in its own split retires the old root pane", () => {
  const s = base();
  const r = react(s, apply(s, { type: "session.lost", thread: "001", payload: { session: C, reason: "x" } }), ctx());
  const created = r.events.find((e) => e.type === "session.created");
  expect(created).toMatchObject({ payload: { replaces: C, retirePane: "w1:p2" } });
  const newId = created?.type === "session.created" ? created.payload.session : "";
  apply(s, ...r.events);
  expect(s.sessions.get(newId)!.retirePane).toBe("w1:p2");
  const a = react(s, apply(s, { type: "session.attached", thread: "001", payload: { session: newId, pane: "w1:p8" } }), ctx());
  expect(a.effects).toEqual([{ kind: "pane.close", pane: "w1:p2" }]);
  expect(a.events).toEqual([{ type: "thread.root_pane_changed", thread: "001", payload: { pane: "w1:p8" } }]);
});

test("a lost coordinator of a done thread is not replaced", () => {
  const s = base();
  s.threads.get("001")!.status = "done";
  expect(react(s, apply(s, { type: "session.lost", thread: "001", payload: { session: C, reason: "x" } }), ctx())).toEqual({ events: [], effects: [] });
});

test("a worker that ends with its ticket in progress releases it and tells the coordinator", () => {
  const s = base();
  apply(s, { type: "worker.queued", thread: "001", payload: { ticket: "T2" } });
  const r = react(s, apply(s, { type: "session.ended", thread: "001", payload: { session: W } }), ctx());
  expect(r.events).toEqual([
    { type: "ticket.released", thread: "001", payload: { ticket: "T1", reason: "worker session ended" } },
    { type: "notice.queued", thread: "001", payload: { session: C, text: "Worker for T1 ended; the ticket is open again." } },
    expect.objectContaining({ type: "session.created", payload: expect.objectContaining({ ticket: "T2" }) }),
  ]);
});

test("a worker ended after its ticket is done releases nothing", () => {
  const s = base();
  apply(s, { type: "ticket.completed", thread: "001", payload: { ticket: "T1" } });
  const r = react(s, apply(s, { type: "session.ended", thread: "001", payload: { session: W } }), ctx());
  expect(r.events.filter((e) => e.type === "ticket.released" || e.type === "notice.queued")).toEqual([]);
});

test("with no live or lost coordinator, notices go to the latest non-rotated one (e.g. failed)", () => {
  const s = base();
  apply(s, { type: "session.failed", thread: "001", payload: { session: C, reason: "spawn failed" } });
  const r = react(s, apply(s, { type: "ticket.blocked", thread: "001", payload: { ticket: "T2", reason: "needs input" } }), ctx());
  expect(r.events).toEqual([{ type: "notice.queued", thread: "001", payload: { session: C, text: "Ticket T2 is blocked: needs input." } }]);
});

test("a repeated loss of an already-replaced coordinator spawns no second replacement", () => {
  const s = base();
  const r = react(s, apply(s, { type: "session.lost", thread: "001", payload: { session: C, reason: "x" } }), ctx());
  apply(s, ...r.events);
  expect(react(s, apply(s, { type: "session.lost", thread: "001", payload: { session: C, reason: "again" } }), ctx())).toEqual({ events: [], effects: [] });
});

test("a handoff older than the lost coordinator is replaced by a generated one; a newer one is kept", () => {
  const at = (s: State, ts: string, ...bodies: EventBody[]): StoredEvent[] =>
    bodies.map((b) => {
      const ev = { ...b, seq: s.lastSeq + 1, ts, actor: USER } as StoredEvent;
      applyEvent(s, ev);
      return ev;
    });
  const R = "rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr";
  const setup = (handoffTs: string) => {
    n = 0;
    const s = stateOf(INIT, threadCreated("001", { status: "in_progress" }), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
    at(s, "2026-10-11T09:00:00.000Z", { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } });
    at(s, handoffTs, { type: "handoff.submitted", thread: "001", payload: { content: "old", generated: false } });
    at(
      s,
      "2026-10-11T10:00:00.000Z",
      { type: "session.rotated", thread: "001", payload: { session: C, reason: "context" } },
      { type: "session.created", thread: "001", payload: { session: R, role: "coordinator", agent: "claude-code", name: "r", replaces: C } },
      { type: "session.attached", thread: "001", payload: { session: R, pane: "w1:p5" } },
    );
    return s;
  };
  const stale = setup("2026-10-11T09:30:00.000Z");
  const r = react(stale, at(stale, "2026-10-11T12:00:00.000Z", { type: "session.lost", thread: "001", payload: { session: R, reason: "x" } }), ctx());
  expect(r.events.map((e) => e.type)).toEqual(["handoff.submitted", "session.created"]);
  expect(r.events[0]).toMatchObject({ payload: { generated: true } });
  // written at the same time as the replacement was created (the rotation that consumed it): still current
  const same = setup("2026-10-11T10:00:00.000Z");
  expect(react(same, at(same, "2026-10-11T12:00:00.000Z", { type: "session.lost", thread: "001", payload: { session: R, reason: "x" } }), ctx()).events.map((e) => e.type)).toEqual(["session.created"]);
});
