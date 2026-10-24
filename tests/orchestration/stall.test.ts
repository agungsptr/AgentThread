import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import type { Actor, EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { applyEvent, project, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, threadCreated } from "../helpers.ts";

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const W = "11111111-1111-4111-8111-111111111111";
const M = "mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm";
const ctx = () => ({ root: "/repo", config: DEFAULT_CONFIG, newId: () => "00000000-0000-4000-8000-000000000001" });
/** Every event applied since base(), so a replay can be checked. */
let log: StoredEvent[] = [];
const apply = (s: State, actor: Actor, ...bodies: EventBody[]): StoredEvent[] =>
  bodies.map((b) => {
    const ev = { ...b, seq: s.lastSeq + 1, ts: "2026-10-24T10:00:00.000Z", actor } as StoredEvent;
    applyEvent(s, ev);
    log.push(ev);
    return ev;
  });

function base(): State {
  log = [];
  const s = stateOf(INIT, threadCreated("001", { status: "in_progress" }), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
  apply(
    s,
    USER,
    { type: "session.created", payload: { session: M, role: "main", agent: "claude-code", name: "m" } },
    { type: "session.attached", payload: { session: M, pane: "w1:p0" } },
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", model: "nope-9", name: "c" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    { type: "session.created", thread: "001", payload: { session: W, role: "worker", agent: "opencode", name: "w", ticket: "T1" } },
    { type: "session.attached", thread: "001", payload: { session: W, pane: "w1:p3" } },
  );
  return s;
}

/** One finished turn of `session`, signalled by its own hook (actor carries the session, as `agt event` does). */
const turn = (s: State, session: string, role: "coordinator" | "worker") => {
  const actor: Actor = { role, thread: "001", session };
  return [
    ...apply(s, actor, { type: "session.active", thread: "001", payload: { session } }),
    ...apply(s, actor, { type: "agent.idle", thread: "001", payload: { session } }),
  ];
};

const COORD_STALL = `Session ${C} (claude-code nope-9) finished its first turn without running any agt command; it may be misconfigured (for example a wrong model). Check pane w1:p2.`;
const WORKER_STALL = `Session ${W} (opencode default) finished its first turn without running any agt command; it may be misconfigured (for example a wrong model). Check pane w1:p3.`;

test("a coordinator that finishes its first turn without any agt command is reported once, to main", () => {
  const s = base();
  // started at its prompt (no turn yet): nothing
  expect(react(s, apply(s, { role: "coordinator", thread: "001", session: C }, { type: "session.started", thread: "001", payload: { session: C } }), ctx()).events.filter((e) => e.type === "session.stalled")).toEqual([]);
  const r = react(s, turn(s, C, "coordinator"), ctx());
  expect(r.events.filter((e) => e.type === "session.stalled" || e.type === "notice.queued")).toEqual([
    { type: "session.stalled", thread: "001", payload: { session: C } },
    { type: "notice.queued", payload: { session: M, text: COORD_STALL } },
  ]);
  // recorded: a third turn does not report again, and neither does a replay
  apply(s, USER, ...r.events);
  expect(react(s, turn(s, C, "coordinator"), ctx()).events.filter((e) => e.type === "session.stalled")).toEqual([]);
  const replayed = project(log);
  expect(replayed.sessions.get(C)?.stalled).toBe(true);
});

test("a stalled worker is reported to its coordinator", () => {
  const s = base();
  const r = react(s, turn(s, W, "worker"), ctx());
  expect(r.events.filter((e) => e.type === "session.stalled" || e.type === "notice.queued")).toEqual([
    { type: "session.stalled", thread: "001", payload: { session: W } },
    { type: "notice.queued", thread: "001", payload: { session: C, text: WORKER_STALL } },
  ]);
});

test("a session that ran any agt command is never reported", () => {
  const s = base();
  apply(s, { role: "coordinator", thread: "001", session: C }, { type: "thread.status_changed", thread: "001", payload: { from: "in_progress", to: "in_progress" } });
  const r = react(s, turn(s, C, "coordinator"), ctx());
  expect(r.events.filter((e) => e.type === "session.stalled")).toEqual([]);
  expect(r.events.some((e) => e.type === "notice.queued" && e.payload.text.includes("misconfigured"))).toBe(false);
});

