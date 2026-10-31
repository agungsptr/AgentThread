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
  for (const k of ["T1", "T2", "T3", "T4", "T5"]) apply(s, { type: "ticket.created", thread: "001", payload: { ticket: k, title: k, scope: [k] } });
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

test("a fresh session.started delivers the notices queued before it", () => {
  const s = base();
  apply(s, { type: "notice.queued", thread: "001", payload: { session: C, text: "Start coordinating." } });
  const started = apply(s, { type: "session.started", thread: "001", payload: { session: C } });
  expect(react(s, started, ctx()).effects).toEqual([
    { kind: "notice.deliver", session: C, thread: "001", pane: "w1:p2", text: "Start coordinating.", count: 1 },
  ]);
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
  // the worker's turn is over: the coordinator now hears that its ticket is done
  expect(next.events).toEqual([
    { type: "notice.queued", thread: "001", payload: { session: C, text: "Ticket T1 is done." } },
    expect.objectContaining({ type: "session.created", payload: expect.objectContaining({ ticket: "T2" }) }),
  ]);
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
    { type: "worker.queued", thread: "001", payload: { ticket: "T4" } },
    { type: "worker.queued", thread: "001", payload: { ticket: "T5" } },
  );
  const ended = apply(
    s,
    { type: "session.ended", thread: "001", payload: { session: W1 } },
    { type: "session.failed", thread: "001", payload: { session: W2, reason: "agent_not_ready" } },
  );
  const r = react(s, ended, ctx());
  const created = r.events.filter((e) => e.type === "session.created");
  expect(created.map((e) => (e.payload as { ticket?: string }).ticket)).toEqual(["T3", "T4"]);
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

test("no delivery to a busy agent across rounds", () => {
  const s = base();
  const r1 = react(s, apply(s, { type: "notice.queued", thread: "001", payload: { session: C, text: "a" } }, { type: "agent.idle", thread: "001", payload: { session: C } }), ctx());
  const eff = r1.effects[0] as { count: number };
  expect(r1.effects).toHaveLength(1);
  const evs = apply(
    s,
    { type: "notice.delivered", thread: "001", payload: { session: C, count: eff.count } },
    { type: "notice.queued", thread: "001", payload: { session: C, text: "b" } },
  );
  expect(react(s, evs, ctx()).effects).toEqual([]);
});

test("duplicate idle events for a done worker end it and close its pane once, without delivering", () => {
  const s = base();
  apply(
    s,
    { type: "session.created", thread: "001", payload: { session: W1, role: "worker", agent: "claude-code", name: "w", ticket: "T1" } },
    { type: "session.attached", thread: "001", payload: { session: W1, pane: "w1:p3" } },
    { type: "ticket.claimed", thread: "001", payload: { ticket: "T1", assignee: W1 } },
    { type: "ticket.completed", thread: "001", payload: { ticket: "T1" } },
    { type: "notice.queued", thread: "001", payload: { session: W1, text: "x" } },
  );
  const idle = { type: "agent.idle", thread: "001", payload: { session: W1 } } as const;
  const r = react(s, apply(s, idle, idle), ctx());
  expect(r.events).toEqual([{ type: "session.ended", thread: "001", payload: { session: W1 } }]);
  expect(r.effects).toEqual([{ kind: "pane.close", pane: "w1:p3" }]);
});

test("idle worker with a blocked ticket ends, closes its pane, and the slot spawns the next queued ticket", () => {
  const s = base(1);
  apply(
    s,
    { type: "session.created", thread: "001", payload: { session: W1, role: "worker", agent: "claude-code", name: "w", ticket: "T1" } },
    { type: "session.attached", thread: "001", payload: { session: W1, pane: "w1:p3" } },
    { type: "worker.queued", thread: "001", payload: { ticket: "T2" } },
    { type: "ticket.claimed", thread: "001", payload: { ticket: "T1", assignee: W1 } },
    { type: "ticket.blocked", thread: "001", payload: { ticket: "T1", reason: "needs approval for bun test" } },
  );
  const r = react(s, apply(s, { type: "agent.idle", thread: "001", payload: { session: W1 } }), ctx());
  expect(r.events).toEqual([{ type: "session.ended", thread: "001", payload: { session: W1 } }]);
  expect(r.effects).toEqual([{ kind: "pane.close", pane: "w1:p3" }]);
  const next = react(s, apply(s, ...r.events), ctx());
  expect(next.events).toEqual([expect.objectContaining({ type: "session.created", payload: expect.objectContaining({ ticket: "T2" }) })]);
});

test("a failed coordinator notifies the live main session", () => {
  const s = base();
  const r = react(s, apply(s, { type: "session.failed", thread: "001", payload: { session: C, reason: "pane_not_found" } }), ctx());
  expect(r.events).toEqual([{ type: "notice.queued", payload: { session: M, text: "Coordinator for thread 001 failed: pane_not_found." } }]);
});

test("a queued worker keeps its --agent override when its slot frees", () => {
  const s = base(1);
  apply(
    s,
    { type: "session.created", thread: "001", payload: { session: W1, role: "worker", agent: "claude-code", name: "w", ticket: "T1" } },
    { type: "session.attached", thread: "001", payload: { session: W1, pane: "w1:p3" } },
    { type: "worker.queued", thread: "001", payload: { ticket: "T2", agent: "omp" } },
    { type: "ticket.claimed", thread: "001", payload: { ticket: "T1", assignee: W1 } },
    { type: "ticket.completed", thread: "001", payload: { ticket: "T1" } },
  );
  const r = react(s, apply(s, { type: "agent.idle", thread: "001", payload: { session: W1 } }), ctx());
  const next = react(s, apply(s, ...r.events), ctx());
  expect(next.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", ticket: "T2", run: { agent: "omp" } })]);
  apply(s, ...next.events);
  expect(s.threads.get("001")!.workerAgents).toEqual({});
});

/** Feeds `evs` and every follow-up back through react() the way the daemon does; returns all follow-up events. */
function settle(s: State, evs: StoredEvent[], log?: StoredEvent[]): EventBody[] {
  const all: EventBody[] = [];
  for (let i = 0; i < 10 && evs.length > 0; i++) {
    const r = react(s, evs, ctx());
    all.push(...r.events);
    evs = apply(s, ...r.events);
    log?.push(...evs);
  }
  return all;
}
const doneNotices = (events: EventBody[]) =>
  events.filter((e) => e.type === "notice.queued" && e.payload.session === C && e.payload.text.startsWith("Ticket T1 is done")).map((e) => (e as { payload: { text: string } }).payload.text);

/** A thread whose worker W1 claimed T1 and is working on it. */
function working(log?: StoredEvent[]): State {
  const s = base();
  const evs = apply(
    s,
    { type: "session.created", thread: "001", payload: { session: W1, role: "worker", agent: "claude-code", name: "w", ticket: "T1" } },
    { type: "session.attached", thread: "001", payload: { session: W1, pane: "w1:p3" } },
    { type: "ticket.claimed", thread: "001", payload: { ticket: "T1", assignee: W1 } },
    { type: "session.active", thread: "001", payload: { session: W1 } },
  );
  log?.push(...evs);
  return s;
}

test("the coordinator hears that a ticket is done only once its worker's turn ends (at the idle that ends the worker)", () => {
  const s = working();
  const after = settle(s, apply(s, { type: "ticket.completed", thread: "001", payload: { ticket: "T1", summary: "ok" } }));
  expect(doneNotices(after)).toEqual([]); // the worker may still be editing
  const idle = settle(s, apply(s, { type: "agent.idle", thread: "001", payload: { session: W1 } }));
  expect(idle.some((e) => e.type === "session.ended" && e.payload.session === W1)).toBe(true);
  expect(doneNotices(idle)).toEqual(["Ticket T1 is done: ok."]);
  expect(doneNotices(s.sessions.get(C)!.notices.map((text) => ({ type: "notice.queued", payload: { session: C, text } }) as EventBody))).toEqual(["Ticket T1 is done: ok."]);
  // nothing more later
  expect(doneNotices(settle(s, apply(s, { type: "agent.idle", thread: "001", payload: { session: W1 } })))).toEqual([]);
});

test("a worker that ends or is lost after ticket done sends the done notice exactly once instead", () => {
  for (const end of ["ended", "lost"] as const) {
    const s = working();
    expect(doneNotices(settle(s, apply(s, { type: "ticket.completed", thread: "001", payload: { ticket: "T1", summary: "ok" } })))).toEqual([]);
    const ev: EventBody = end === "ended"
      ? { type: "session.ended", thread: "001", payload: { session: W1 } }
      : { type: "session.lost", thread: "001", payload: { session: W1, reason: "no agent in pane w1:p3" } };
    expect(doneNotices(settle(s, apply(s, ev)))).toEqual(["Ticket T1 is done: ok."]);
    expect(s.threads.get("001")!.tickets.find((k) => k.id === "T1")!.status).toBe("done"); // not released
  }
});

test("a ticket done with no live worker notifies the coordinator at once", () => {
  const s = working();
  apply(s, { type: "session.ended", thread: "001", payload: { session: W1 } }); // e.g. replayed from an old log
  expect(doneNotices(react(s, apply(s, { type: "ticket.completed", thread: "001", payload: { ticket: "T1" } }), ctx()).events)).toEqual(["Ticket T1 is done."]);
});

test("replaying the log gives the same coordinator notices as the live run", () => {
  const log: StoredEvent[] = [];
  const s = working(log);
  const step = (b: EventBody) => {
    const evs = apply(s, b);
    log.push(...evs);
    settle(s, evs, log);
  };
  step({ type: "ticket.completed", thread: "001", payload: { ticket: "T1", summary: "ok" } });
  step({ type: "agent.idle", thread: "001", payload: { session: W1 } });
  // a fresh projection of the same log (base() is deterministic), with no reactor involved
  const replayed = base();
  for (const e of log) applyEvent(replayed, e);
  expect(replayed.sessions.get(C)!.notices).toEqual(s.sessions.get(C)!.notices);
  expect(replayed.sessions.get(W1)!.status).toBe("ended");
  expect(s.sessions.get(C)!.notices.filter((x) => x.startsWith("Ticket T1 is done"))).toEqual(["Ticket T1 is done: ok."]);
});
