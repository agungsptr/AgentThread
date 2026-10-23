import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import type { Actor, EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, threadCreated } from "../helpers.ts";

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const W = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ctx = () => ({ root: "/repo", config: DEFAULT_CONFIG, newId: () => "00000000-0000-4000-8000-000000000001" });
const T0 = Date.parse("2026-10-11T10:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function apply(state: State, ts: string, ...bodies: EventBody[]): StoredEvent[] {
  return bodies.map((b) => {
    const actor: Actor = b.type === "progress.recorded" ? { role: "coordinator", thread: "001", session: C } : USER;
    const ev = { ...b, seq: state.lastSeq + 1, ts, actor } as StoredEvent;
    applyEvent(state, ev);
    return ev;
  });
}

function base(): State {
  const s = stateOf(INIT, threadCreated("001", { status: "in_progress" }), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
  apply(
    s,
    at(0),
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    { type: "session.started", thread: "001", payload: { session: C } },
  );
  return s;
}

/** One finished turn at minute `min`. */
function turn(s: State, min: number, id = C) {
  apply(s, at(min), { type: "session.active", thread: "001", payload: { session: id } });
  return react(s, apply(s, at(min), { type: "agent.idle", thread: "001", payload: { session: id } }), ctx());
}
const reminders = (r: { events: EventBody[] }) => r.events.filter((e) => e.type === "checkpoint.reminded");

test("reminder fires once after reminder_turns turns, then progress resets it", () => {
  const s = base();
  for (let i = 1; i < 8; i++) expect(turn(s, i * 0.1).events).toEqual([]);
  const r = turn(s, 1);
  expect(r.events).toEqual([
    { type: "checkpoint.reminded", thread: "001", payload: { session: C } },
    { type: "notice.queued", thread: "001", payload: { session: C, text: 'CHECKPOINT: record where you are with: agt progress 001 "<what is done, what is next>"' } },
  ]);
  apply(s, at(1), ...r.events);
  expect(s.sessions.get(C)!.remindedSinceProgress).toBe(true);
  expect(reminders(turn(s, 1.1))).toEqual([]);
  apply(s, at(2), { type: "progress.recorded", thread: "001", payload: { message: "x" } });
  expect(s.sessions.get(C)!.remindedSinceProgress).toBeUndefined();
  for (let i = 0; i < 7; i++) expect(turn(s, 2 + i * 0.1).events).toEqual([]);
  expect(reminders(turn(s, 3))).toHaveLength(1);
});

test("reminder fires by time since progress (or creation)", () => {
  const s = base();
  expect(turn(s, 29).events).toEqual([]);
  expect(reminders(turn(s, 31))).toHaveLength(1);
  const s2 = base();
  apply(s2, at(10), { type: "progress.recorded", thread: "001", payload: { message: "x" } });
  expect(turn(s2, 39).events).toEqual([]);
  expect(reminders(turn(s2, 41))).toHaveLength(1);
});

test("no reminder while a rotation is pending", () => {
  const s = base();
  apply(s, at(1), { type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "context" } });
  expect(reminders(turn(s, 40))).toEqual([]);
});

test("no reminder for a worker being torn down; reminder for a live worker", () => {
  const s = base();
  apply(
    s,
    at(1),
    { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "t", scope: [] } },
    { type: "session.created", thread: "001", payload: { session: W, role: "worker", agent: "claude-code", name: "w", ticket: "T1" } },
    { type: "session.attached", thread: "001", payload: { session: W, pane: "w1:p3" } },
    { type: "session.started", thread: "001", payload: { session: W } },
  );
  expect(reminders(turn(s, 40, W))).toHaveLength(1);
  apply(s, at(41), { type: "ticket.claimed", thread: "001", payload: { ticket: "T1", assignee: W } }, { type: "ticket.completed", thread: "001", payload: { ticket: "T1", summary: "d" } });
  const s2 = s.sessions.get(W)!;
  delete s2.remindedSinceProgress;
  const r = turn(s, 80, W);
  expect(reminders(r)).toEqual([]);
});
