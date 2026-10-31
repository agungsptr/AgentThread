import { expect, test } from "bun:test";
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
