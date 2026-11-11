import { expect, test } from "bun:test";
import type { Effect } from "../../src/commands/handler.ts";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import type { EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { sweep } from "../../src/orchestration/sweep.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, threadCreated } from "../helpers.ts";

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const W = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const T0 = "2026-10-11T10:00:00.000Z";
const ctx = (config = DEFAULT_CONFIG) => ({ root: "/repo", config, newId: () => "00000000-0000-4000-8000-000000000001" });

function apply(state: State, ts: string, ...bodies: EventBody[]): StoredEvent[] {
  return bodies.map((b) => {
    const ev = { ...b, seq: state.lastSeq + 1, ts, actor: USER } as StoredEvent;
    applyEvent(state, ev);
    return ev;
  });
}

/** A worker on T1 that finished it at T0 (the ticket is done) and is still running. */
function finished(): State {
  const s = stateOf(INIT, threadCreated("001", { status: "in_progress" }), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
  apply(
    s,
    T0,
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    { type: "session.started", thread: "001", payload: { session: C } },
    { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "T1", scope: ["T1"] } },
    { type: "session.created", thread: "001", payload: { session: W, role: "worker", agent: "claude-code", name: "w", ticket: "T1" } },
    { type: "session.attached", thread: "001", payload: { session: W, pane: "w1:p3" } },
    { type: "session.started", thread: "001", payload: { session: W } },
    { type: "ticket.claimed", thread: "001", payload: { ticket: "T1", assignee: W } },
    { type: "ticket.completed", thread: "001", payload: { ticket: "T1", summary: "ok" } },
  );
  return s;
}

const HUNG = "The worker for ticket T1 finished its ticket but did not stop within 5m; closed it.";

test("the sweep closes a finished worker that did not stop within the grace, with one done notice", () => {
  const s = finished();
  expect(s.threads.get("001")!.tickets[0]!.completedAt).toBe(T0);
  const now = "2026-10-11T10:05:01.000Z";
  const r = sweep(s, now, ctx());
  expect(r.events).toEqual([
    { type: "notice.queued", thread: "001", payload: { session: C, text: HUNG } },
    { type: "session.ended", thread: "001", payload: { session: W } },
  ]);
  expect(r.effects).toEqual([{ kind: "pane.close", pane: "w1:p3" }]);
  // the reactor's session.ended handling sends the done notice, once
  const stored = apply(s, now, ...r.events);
  const after = react(s, stored, ctx());
  const done = after.events.filter((e) => e.type === "notice.queued" && e.payload.text.startsWith("Ticket T1 is done"));
  expect(done).toEqual([{ type: "notice.queued", thread: "001", payload: { session: C, text: "Ticket T1 is done: ok." } }]);
  // and a second sweep has nothing left to close
  expect(sweep(s, now, ctx()).events).toEqual([]);
});

test("the pane stays open when close_worker_pane_on_end is off", () => {
  const cfg = { ...DEFAULT_CONFIG, herdr: { ...DEFAULT_CONFIG.herdr, close_worker_pane_on_end: false } };
  const r = sweep(finished(), "2026-10-11T10:06:00.000Z", ctx(cfg));
  expect(r.events.map((e) => e.type)).toEqual(["notice.queued", "session.ended"]);
  expect(r.effects).toEqual([]);
});

test("the sweep does nothing one second before the grace ends", () => {
  expect(sweep(finished(), "2026-10-11T10:04:59.000Z", ctx())).toEqual({ events: [], effects: [] });
});

test("the sweep leaves a worker whose ticket is not done", () => {
  const s = finished();
  apply(s, T0, { type: "ticket.reopened", thread: "001", payload: { ticket: "T1" } });
  expect(s.threads.get("001")!.tickets[0]!.completedAt).toBeUndefined();
  expect(sweep(s, "2026-10-11T11:00:00.000Z", ctx())).toEqual({ events: [], effects: [] });
  const t = finished();
  t.threads.get("001")!.tickets[0]!.status = "in_progress";
  expect(sweep(t, "2026-10-11T11:00:00.000Z", ctx())).toEqual({ events: [], effects: [] });
});

test("finished_worker_grace is configurable and at least 30s", async () => {
  const { ConfigSchema } = await import("../../src/config/config.ts");
  expect(DEFAULT_CONFIG.session.finished_worker_grace).toBe("5m");
  const bad = { ...DEFAULT_CONFIG, session: { ...DEFAULT_CONFIG.session, finished_worker_grace: "10s" } };
  expect(ConfigSchema.safeParse(bad).success).toBe(false);
});

test("a starting, pane-less worker with a done ticket past both timeouts gets only the lost-spawn failure", () => {
  const s = stateOf(INIT, threadCreated("001", { status: "in_progress" }), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
  apply(
    s,
    T0,
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    { type: "session.started", thread: "001", payload: { session: C } },
    { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "T1", scope: ["T1"] } },
    { type: "session.created", thread: "001", payload: { session: W, role: "worker", agent: "claude-code", name: "w", ticket: "T1" } },
    { type: "ticket.claimed", thread: "001", payload: { ticket: "T1", assignee: W } },
    { type: "ticket.completed", thread: "001", payload: { ticket: "T1", summary: "ok" } },
  );
  expect(s.sessions.get(W)!.status).toBe("starting");
  expect(s.sessions.get(W)!.pane).toBeUndefined();
  const r = sweep(s, "2026-10-11T11:00:00.000Z", ctx());
  expect(r.events).toEqual([{ type: "session.failed", thread: "001", payload: { session: W, reason: "spawn report lost after 3m" } }]);
  expect(r.effects).toEqual([]);
});

test("an attached session still starting past spawn_timeout fails (the poller no longer ends it); one blocked on a dialog is left to its notice", () => {
  const s = stateOf(INIT, threadCreated("001", { status: "in_progress" }), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
  apply(
    s,
    T0,
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "T1", scope: ["T1"] } },
    { type: "session.created", thread: "001", payload: { session: W, role: "worker", agent: "claude-code", name: "w", ticket: "T1" } },
    { type: "session.attached", thread: "001", payload: { session: W, pane: "w1:p3" } },
    { type: "agent.blocked", thread: "001", payload: { session: W } },
  );
  expect(sweep(s, "2026-10-11T10:02:59.000Z", ctx()).events).toEqual([]);
  const r = sweep(s, "2026-10-11T10:03:01.000Z", ctx());
  expect(r.events).toEqual([{ type: "session.failed", thread: "001", payload: { session: C, reason: "agent did not start within 3m" } }]);
});

// ---------- final review 2 ----------

/** An attached worker on open ticket T1 whose agent never started (status starting, never claimed). */
function neverStarted(): State {
  const s = stateOf(INIT, threadCreated("001", { status: "in_progress" }), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
  apply(
    s,
    T0,
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    { type: "session.started", thread: "001", payload: { session: C } },
    { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "T1", scope: ["T1"] } },
    { type: "session.created", thread: "001", payload: { session: W, role: "worker", agent: "claude-code", name: "w", ticket: "T1" } },
    { type: "session.attached", thread: "001", payload: { session: W, pane: "w1:p3" } },
  );
  return s;
}

test("a worker failed for not starting has its split closed before its early exit's fresh worker is spawned", () => {
  const s = neverStarted();
  const now = "2026-10-11T10:03:01.000Z";
  const r = sweep(s, now, ctx());
  expect(r.events).toEqual([{ type: "session.failed", thread: "001", payload: { session: W, reason: "agent did not start within 3m" } }]);
  // the daemon runs the sweep's effects before it applies its events: the pane closes before the reactor respawns
  expect(r.effects).toEqual([{ kind: "pane.close", pane: "w1:p3" }]);
  const after = react(s, apply(s, now, ...r.events), ctx());
  expect(after.effects.filter((e) => e.kind === "agent.spawn")).toHaveLength(1);
  // the coordinator hears one notice: the early exit, not the failure as well
  expect(after.events.filter((e) => e.type === "notice.queued").map((e) => (e.type === "notice.queued" ? e.payload.text : ""))).toEqual([
    "The worker for ticket T1 exited before starting (failed: agent did not start within 3m); agt started a fresh one.",
  ]);
});

test("a coordinator failed for not starting keeps its pane (the thread's root pane)", () => {
  const s = stateOf(INIT, threadCreated("001", { status: "in_progress" }), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
  apply(s, T0, { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } }, { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } });
  const r = sweep(s, "2026-10-11T10:03:01.000Z", ctx());
  expect(r.events).toEqual([{ type: "session.failed", thread: "001", payload: { session: C, reason: "agent did not start within 3m" } }]);
  expect(r.effects).toEqual([]);
});

/** The coordinator idle at T0 with a notice whose delivery was held (a trust dialog, a slow read). */
function heldNotice(): State {
  const s = stateOf(INIT, threadCreated("001", { status: "in_progress" }));
  apply(
    s,
    T0,
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    { type: "session.started", thread: "001", payload: { session: C } },
    { type: "notice.queued", thread: "001", payload: { session: C, text: "Tell from main." } },
    { type: "notice.held", thread: "001", payload: { session: C, reason: "pane w1:p2 shows a trust dialog" } },
  );
  return s;
}
const DELIVER: Effect = { kind: "notice.deliver", session: C, thread: "001", agent: "claude-code", pane: "w1:p2", text: "Tell from main.", count: 1 };

test("a held notice is delivered again by the sweep once 10s have passed since the attempt, until it goes", () => {
  const s = heldNotice();
  expect(s.sessions.get(C)!.noticeHeldAt).toBe(T0);
  expect(sweep(s, "2026-10-11T10:00:09.000Z", ctx()).effects).toEqual([]);
  expect(sweep(s, "2026-10-11T10:00:11.000Z", ctx()).effects).toEqual([{ ...DELIVER, held: 1 }]);
  // held again: the clock restarts from that attempt
  apply(s, "2026-10-11T10:00:11.000Z", { type: "notice.held", thread: "001", payload: { session: C, reason: "slow read" } });
  expect(sweep(s, "2026-10-11T10:00:20.000Z", ctx()).effects).toEqual([]);
  const D2: Effect = { ...DELIVER, held: 2 };
  expect(sweep(s, "2026-10-11T10:00:30.000Z", ctx()).effects).toEqual([]);
  expect(sweep(s, "2026-10-11T10:00:32.000Z", ctx()).effects).toEqual([D2]);
  // delivered: nothing is left to retry
  apply(s, "2026-10-11T10:00:32.000Z", { type: "notice.delivered", thread: "001", payload: { session: C, count: 1 } });
  expect(s.sessions.get(C)!.noticeHeldAt).toBeUndefined();
  apply(s, "2026-10-11T10:00:40.000Z", { type: "agent.idle", thread: "001", payload: { session: C } });
  expect(sweep(s, "2026-10-11T10:01:40.000Z", ctx()).effects).toEqual([]);
});

test("the sweep retries no delivery into a session that is working, blocked on a dialog, or gone", () => {
  const working = heldNotice();
  apply(working, T0, { type: "session.active", thread: "001", payload: { session: C } });
  expect(sweep(working, "2026-10-11T10:01:00.000Z", ctx()).effects).toEqual([]);
  const blocked = heldNotice();
  apply(blocked, T0, { type: "agent.blocked", thread: "001", payload: { session: C } });
  expect(sweep(blocked, "2026-10-11T10:01:00.000Z", ctx()).effects).toEqual([]);
  const gone = heldNotice();
  apply(gone, T0, { type: "session.lost", thread: "001", payload: { session: C, reason: "x" } });
  expect(sweep(gone, "2026-10-11T10:01:00.000Z", ctx()).effects.filter((e) => e.kind === "notice.deliver")).toEqual([]);
});

const at = (sec: number) => new Date(Date.parse(T0) + sec * 1000).toISOString();
const hold = (s: State, sec: number, reason = "trust dialog") => apply(s, at(sec), { type: "notice.held", thread: "001", payload: { session: C, reason } });

test("held notices back off 10s, 20s, 40s … up to 5 minutes, derived from the events", () => {
  const s = heldNotice();
  const waits: number[] = [];
  let t = 0;
  for (let n = 1; n <= 8; n++) {
    const want = Math.min(10 * 2 ** (n - 1), 300);
    expect(s.sessions.get(C)!.noticeHeldCount).toBe(n);
    expect(sweep(s, at(t + want - 1), ctx()).effects).toEqual([]);
    expect(sweep(s, at(t + want + 1), ctx()).effects.length).toBe(1);
    waits.push(want);
    t += want + 1;
    hold(s, t);
  }
  expect(waits).toEqual([10, 20, 40, 80, 160, 300, 300, 300]);
});

test("the backoff resets on a delivery, and on an active or started session; replaying the events gives the same state", () => {
  const s = heldNotice();
  const evs: StoredEvent[] = [];
  const step = (...e: StoredEvent[]) => evs.push(...e);
  step(...hold(s, 11), ...hold(s, 32));
  expect(s.sessions.get(C)!.noticeHeldCount).toBe(3);
  expect(s.sessions.get(C)!.noticeHeldReason).toBe("trust dialog");
  step(...apply(s, at(40), { type: "session.active", thread: "001", payload: { session: C } }));
  expect(s.sessions.get(C)!.noticeHeldCount).toBeUndefined();
  step(...hold(s, 50));
  expect(s.sessions.get(C)!.noticeHeldCount).toBe(1);
  step(...apply(s, at(51), { type: "notice.delivered", thread: "001", payload: { session: C, count: 1 } }));
  expect(s.sessions.get(C)!.noticeHeldCount).toBeUndefined();
  expect(s.sessions.get(C)!.noticeHeldReported).toBeUndefined();
  // replay: a fresh state fed the same events, stopped after two holds, matches the live state at that point
  const live = heldNotice();
  hold(live, 11);
  const replayed = heldNotice();
  for (const ev of evs.slice(0, 1)) applyEvent(replayed, { ...ev, seq: replayed.lastSeq + 1 });
  expect(replayed.sessions.get(C)!.noticeHeldCount).toBe(live.sessions.get(C)!.noticeHeldCount);
  expect(replayed.sessions.get(C)!.noticeHeldAt).toBe(live.sessions.get(C)!.noticeHeldAt);
});

test("a session held three times in a row has its coordinator told once per stretch, outside its own queue", () => {
  const s = stateOf(INIT, threadCreated("001", { status: "in_progress" }));
  apply(
    s,
    T0,
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    { type: "session.started", thread: "001", payload: { session: C } },
    { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "T1", scope: ["T1"] } },
    { type: "session.created", thread: "001", payload: { session: W, role: "worker", agent: "claude-code", name: "w", ticket: "T1" } },
    { type: "session.attached", thread: "001", payload: { session: W, pane: "w1:p3" } },
    { type: "session.started", thread: "001", payload: { session: W } },
    { type: "agent.idle", thread: "001", payload: { session: W } },
    { type: "notice.queued", thread: "001", payload: { session: W, text: "Hi." } },
  );
  const wHold = (sec: number) => apply(s, at(sec), { type: "notice.held", thread: "001", payload: { session: W, reason: "slow read" } });
  wHold(1);
  wHold(12);
  expect(sweep(s, at(100), ctx()).events.filter((e) => e.type === "notice.held_reported")).toEqual([]);
  wHold(100);
  const r = sweep(s, at(100 + 41), ctx());
  expect(r.events).toEqual([
    { type: "notice.held_reported", thread: "001", payload: { session: W } },
    { type: "notice.queued", thread: "001", payload: { session: C, text: "Messages to worker ticket T1 keep being held (slow read); check its pane." } },
  ]);
  expect(r.effects.map((e) => e.kind)).toEqual(["notice.deliver"]);
  apply(s, at(141), ...(r.events as EventBody[]));
  wHold(141);
  expect(sweep(s, at(141 + 81), ctx()).events.filter((e) => e.type === "notice.queued")).toEqual([]);
  expect(s.sessions.get(W)!.notices).toEqual(["Hi."]);
});
