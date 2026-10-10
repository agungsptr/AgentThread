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

test("lost coordinator is resumed into the root pane with the same session id", () => {
  const s = base();
  const r = react(s, apply(s, { type: "session.lost", thread: "001", payload: { session: C, reason: "no agent in pane w1:p2" } }), ctx());
  expect(r.events).toEqual([{ type: "session.resuming", thread: "001", payload: { session: C } }]);
  expect(r.effects).toEqual([
    { kind: "agent.spawn", session: C, role: "coordinator", name: "agt-ab12-c001", thread: "001", cwd: "/repo/.worktrees/001-thread-001", pane: "w1:p2", resume: true, bootstrap: "resume" },
  ]);
});

test("resume failure: generated handoff (only if none) and a fresh replacement in the same pane", () => {
  const s = base();
  apply(s, { type: "session.lost", thread: "001", payload: { session: C, reason: "x" } }, { type: "session.resuming", thread: "001", payload: { session: C } });
  const r = react(s, apply(s, { type: "session.resume_failed", thread: "001", payload: { session: C, reason: "no saved Claude session" } }), ctx());
  expect(r.events.map((e) => e.type)).toEqual(["handoff.submitted", "session.created"]);
  expect(r.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", pane: "w1:p2", bootstrap: "handoff" })]);
  // with an existing handoff, none is generated
  const s2 = base();
  apply(s2, { type: "handoff.submitted", thread: "001", payload: { content: "x", generated: false } });
  apply(s2, { type: "session.lost", thread: "001", payload: { session: C, reason: "x" } }, { type: "session.resuming", thread: "001", payload: { session: C } });
  expect(react(s2, apply(s2, { type: "session.resume_failed", thread: "001", payload: { session: C, reason: "y" } }), ctx()).events.map((e) => e.type)).toEqual(["session.created"]);
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

test("tab reopened in the same batch as a probe loss: resume once, no fresh coordinator", () => {
  const s = base();
  const evs = apply(
    s,
    { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t9", rootPane: "w1:p9" } },
    { type: "session.lost", thread: "001", payload: { session: C, reason: "no agent in pane w1:p2" } },
  );
  const r = react(s, evs, ctx());
  expect(r.events.filter((e) => e.type === "session.created")).toEqual([]);
  expect(r.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", session: C, pane: "w1:p9", resume: true })]);
});

const COORD = { role: "coordinator" as const, thread: "001", session: C };

test("a rotation pending at loss completes after resume: request delivered, coordinator handoff rotates", () => {
  const s = base();
  const req = react(s, apply(s, { type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "context" } }), ctx());
  apply(s, ...req.events); // the HANDOFF REQUEST notice, not yet delivered
  apply(s, { type: "session.lost", thread: "001", payload: { session: C, reason: "no agent in pane w1:p2" } }, { type: "session.resuming", thread: "001", payload: { session: C } });
  const r = react(s, apply(s, { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } }, { type: "session.started", thread: "001", payload: { session: C } }), ctx());
  expect(r.effects).toEqual([expect.objectContaining({ kind: "notice.deliver", session: C, text: expect.stringContaining("HANDOFF REQUEST") })]);
  const ev = { type: "handoff.submitted", thread: "001", payload: { content: "h", generated: false }, seq: s.lastSeq + 1, ts: "2026-10-11T10:00:00.000Z", actor: COORD } as StoredEvent;
  applyEvent(s, ev);
  const h = react(s, [ev], ctx());
  expect(h.events.map((e) => e.type)).toEqual(["session.rotated", "session.created"]);
  expect(h.events[1]).toMatchObject({ payload: { replaces: C } });
});

test("coordinator and worker lost in one batch: ticket released and the notice is queued to the lost coordinator", () => {
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
  expect(r.events).toEqual([
    { type: "session.resuming", thread: "001", payload: { session: C } },
    { type: "ticket.released", thread: "001", payload: { ticket: "T1", reason: "worker session lost" } },
    { type: "notice.queued", thread: "001", payload: { session: C, text: "Worker for T1 was lost; the ticket is open again." } },
  ]);
});

test("tab reopened path: the follow-up losses resume C and queue the worker notice to C", () => {
  const s = base();
  const first = react(s, apply(s, { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t9", rootPane: "w1:p9" } }), ctx());
  const r = react(s, apply(s, ...first.events), ctx());
  expect(r.events).toEqual([
    { type: "session.resuming", thread: "001", payload: { session: C } },
    { type: "ticket.released", thread: "001", payload: { ticket: "T1", reason: "worker session lost" } },
    { type: "notice.queued", thread: "001", payload: { session: C, text: "Worker for T1 was lost; the ticket is open again." } },
  ]);
  expect(r.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", session: C, pane: "w1:p9", resume: true })]);
  apply(s, ...r.events);
  expect(s.sessions.get(C)!.notices).toEqual(["Worker for T1 was lost; the ticket is open again."]);
});

test("resume_failed: notices queued later in the same call go to the replacement; feeding its events back does not rotate", () => {
  const s = base();
  apply(s, { type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "context" } });
  apply(s, { type: "session.lost", thread: "001", payload: { session: C, reason: "x" } }, { type: "session.resuming", thread: "001", payload: { session: C } });
  const r = react(
    s,
    apply(
      s,
      { type: "session.resume_failed", thread: "001", payload: { session: C, reason: "no saved Claude session" } },
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
