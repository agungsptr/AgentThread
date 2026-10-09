import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import type { EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, threadCreated } from "../helpers.ts";

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const W1 = "11111111-1111-4111-8111-111111111111";
const M = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
let n = 0;
const ctx = (config = DEFAULT_CONFIG) => ({ root: "/repo", config, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` });

/** Applies `bodies` to `state` and returns them as stored events, the way the daemon feeds react(). */
function apply(state: State, ...bodies: EventBody[]): StoredEvent[] {
  return bodies.map((b) => {
    const ev = { ...b, seq: state.lastSeq + 1, ts: "t", actor: USER } as StoredEvent;
    applyEvent(state, ev);
    return ev;
  });
}

function base(maxWorkers = 1): State {
  n = 0;
  const s = stateOf(INIT, threadCreated("001", { maxWorkers, title: "Login" }), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
  apply(
    s,
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    { type: "session.created", payload: { session: M, role: "main", agent: "claude-code", name: "m" } },
    { type: "session.attached", payload: { session: M, pane: "w1:p0" } },
  );
  for (const k of ["T1", "T2", "T3"]) apply(s, { type: "ticket.created", thread: "001", payload: { ticket: k, title: k, scope: [k] } });
  return s;
}

test("tab opened spawns exactly one coordinator", () => {
  n = 0;
  const s = stateOf(INIT, threadCreated("001"));
  const evs = apply(s, { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
  const r = react(s, evs, ctx());
  expect(r.events.map((e) => e.type)).toEqual(["session.created"]);
  expect(r.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", role: "coordinator", pane: "w1:p2" })]);
  apply(s, ...r.events);
  expect(react(s, evs, ctx()).events).toEqual([]);
});

test("ticket events notify the coordinator; delivery waits for idle and happens once", () => {
  const s = base();
  const done = apply(s, { type: "ticket.completed", thread: "001", payload: { ticket: "T1", summary: "ok" } });
  const r1 = react(s, done, ctx());
  expect(r1.events).toEqual([{ type: "notice.queued", thread: "001", payload: { session: C, text: "Ticket T1 is done: ok." } }]);
  // coordinator still starting → queued but not delivered
  expect(react(s, apply(s, ...r1.events), ctx()).effects).toEqual([]);
  const blocked = apply(s, { type: "ticket.blocked", thread: "001", payload: { ticket: "T2", reason: "no key" } });
  apply(s, ...react(s, blocked, ctx()).events);
  const idle = apply(s, { type: "agent.idle", thread: "001", payload: { session: C } });
  expect(react(s, idle, ctx()).effects).toEqual([
    { kind: "notice.deliver", session: C, thread: "001", pane: "w1:p2", text: "Ticket T1 is done: ok.\nTicket T2 is blocked: no key.", count: 2 },
  ]);
  const both = [...idle, ...apply(s, { type: "notice.queued", thread: "001", payload: { session: C, text: "x" } })];
  expect(react(s, both, ctx()).effects).toHaveLength(1);
});

test("idle worker with a done ticket ends, closes its pane, and the slot spawns the next queued ticket", () => {
  const s = base(1);
  apply(
    s,
    { type: "session.created", thread: "001", payload: { session: W1, role: "worker", agent: "claude-code", name: "w", ticket: "T1" } },
    { type: "session.attached", thread: "001", payload: { session: W1, pane: "w1:p3" } },
    { type: "worker.queued", thread: "001", payload: { ticket: "T2" } },
    { type: "worker.queued", thread: "001", payload: { ticket: "T3" } },
    { type: "ticket.claimed", thread: "001", payload: { ticket: "T1", assignee: W1 } },
    { type: "ticket.completed", thread: "001", payload: { ticket: "T1" } },
  );
  const r = react(s, apply(s, { type: "agent.idle", thread: "001", payload: { session: W1 } }), ctx());
  expect(r.events).toEqual([{ type: "session.ended", thread: "001", payload: { session: W1 } }]);
  expect(r.effects).toEqual([{ kind: "pane.close", pane: "w1:p3" }]);
  const next = react(s, apply(s, ...r.events), ctx());
  expect(next.events).toEqual([expect.objectContaining({ type: "session.created", payload: expect.objectContaining({ ticket: "T2" }) })]);
  expect(next.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", ticket: "T2", splitFrom: "w1:p2", direction: "right" })]);
});

test("two freed slots in one batch spawn two queued workers, never more", () => {
  const s = base(2);
  const W2 = "22222222-2222-4222-8222-222222222222";
  apply(
    s,
    { type: "session.created", thread: "001", payload: { session: W1, role: "worker", agent: "claude-code", name: "w1", ticket: "T1" } },
    { type: "session.created", thread: "001", payload: { session: W2, role: "worker", agent: "claude-code", name: "w2", ticket: "T2" } },
    { type: "worker.queued", thread: "001", payload: { ticket: "T3" } },
  );
  const ended = apply(
    s,
    { type: "session.ended", thread: "001", payload: { session: W1 } },
    { type: "session.failed", thread: "001", payload: { session: W2, reason: "agent_not_ready" } },
  );
  const r = react(s, ended, ctx());
  expect(r.events.filter((e) => e.type === "session.created")).toHaveLength(1);
  expect(r.events).toContainEqual({ type: "notice.queued", thread: "001", payload: { session: C, text: "Worker for T2 failed: agent_not_ready." } });
});

test("close_worker_pane_on_end: false ends the worker without closing the pane", () => {
  const s = base();
  apply(
    s,
    { type: "session.created", thread: "001", payload: { session: W1, role: "worker", agent: "claude-code", name: "w", ticket: "T1" } },
    { type: "session.attached", thread: "001", payload: { session: W1, pane: "w1:p3" } },
    { type: "ticket.claimed", thread: "001", payload: { ticket: "T1", assignee: W1 } },
    { type: "ticket.completed", thread: "001", payload: { ticket: "T1" } },
  );
  const config = { ...DEFAULT_CONFIG, herdr: { ...DEFAULT_CONFIG.herdr, close_worker_pane_on_end: false } };
  const r = react(s, apply(s, { type: "agent.idle", thread: "001", payload: { session: W1 } }), ctx(config));
  expect(r.effects).toEqual([]);
  expect(r.events.map((e) => e.type)).toEqual(["session.ended"]);
});

test("status changes: unblock notifies coordinator, review notifies main, done ends sessions", () => {
  const s = base();
  expect(react(s, apply(s, { type: "thread.status_changed", thread: "001", payload: { from: "open", to: "blocked" } }), ctx()).events).toEqual([]);
  expect(
    react(s, apply(s, { type: "thread.status_changed", thread: "001", payload: { from: "blocked", to: "open", reason: "dependencies done" } }), ctx()).events,
  ).toEqual([{ type: "notice.queued", thread: "001", payload: { session: C, text: "Thread 001 is unblocked: dependencies done." } }]);
  apply(s, { type: "thread.status_changed", thread: "001", payload: { from: "open", to: "in_progress" } });
  expect(react(s, apply(s, { type: "thread.status_changed", thread: "001", payload: { from: "in_progress", to: "review" } }), ctx()).events).toEqual([
    { type: "notice.queued", payload: { session: M, text: "Thread 001 (Login) is ready for review." } },
  ]);
  expect(react(s, apply(s, { type: "thread.status_changed", thread: "001", payload: { from: "review", to: "done" } }), ctx()).events).toEqual([
    { type: "session.ended", thread: "001", payload: { session: C } },
  ]);
});
