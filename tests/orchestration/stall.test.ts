import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import type { Actor, EventBody, StoredEvent } from "../../src/domain/types.ts";
import { handle } from "../../src/commands/handler.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { COMMAND_OUTPUT_TYPES, applyEvent, project, type State } from "../../src/state/projection.ts";
import { INIT, USER, stored, threadCreated } from "../helpers.ts";

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
  log = stored([INIT, threadCreated("001", { status: "in_progress" }), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } }]);
  const s = project(log);
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


// ---- round 3: no false stalls ----

const NO_SESSION_COORD: Actor = { role: "coordinator", thread: "001" };

test("a root-pane coordinator (no AGT_SESSION) is attributed at intake: its thread status means no stall", () => {
  const s = base();
  const r = handle(s, { cmd: "thread.status", thread: "001", status: "review" }, NO_SESSION_COORD, ctx());
  expect(r.ok && r.actor).toEqual({ role: "coordinator", thread: "001", session: C, via: "command" });
  apply(s, (r.ok && r.actor) || NO_SESSION_COORD, ...(r.ok ? r.events : []));
  expect(react(s, turn(s, C, "coordinator"), ctx()).events.filter((e) => e.type === "session.stalled")).toEqual([]);
});

test("a worker command without a session is attributed to the ticket's live worker", () => {
  const s = base();
  const r = handle(s, { cmd: "ticket.add", thread: "001", title: "x", scope: ["x"] }, NO_SESSION_COORD, ctx());
  apply(s, (r.ok && r.actor) || NO_SESSION_COORD, ...(r.ok ? r.events : []));
  const w = handle(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, { role: "worker", thread: "001", ticket: "T1" }, ctx());
  expect(w.ok && w.actor).toEqual({ role: "worker", thread: "001", ticket: "T1", session: W, via: "command" });
  apply(s, (w.ok && w.actor) || NO_SESSION_COORD, ...(w.ok ? w.events : []));
  expect(react(s, turn(s, W, "worker"), ctx()).events.filter((e) => e.type === "session.stalled")).toEqual([]);
});

test("replaying an old log with session-less coordinator commands credits the acting coordinator", () => {
  const s = base();
  apply(s, NO_SESSION_COORD, { type: "thread.status_changed", thread: "001", payload: { from: "in_progress", to: "review" } });
  const replayed = project(log);
  expect(replayed.sessions.get(C)?.authored).toBe(true);
  expect(react(s, turn(s, C, "coordinator"), ctx()).events.filter((e) => e.type === "session.stalled")).toEqual([]);
});

test("a replacement coordinator is never reported", () => {
  const s = base();
  const R = "rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr";
  apply(
    s,
    USER,
    { type: "session.ended", thread: "001", payload: { session: C } },
    { type: "session.created", thread: "001", payload: { session: R, role: "coordinator", agent: "claude-code", name: "r", replaces: C } },
    { type: "session.attached", thread: "001", payload: { session: R, pane: "w1:p5" } },
  );
  expect(react(s, turn(s, R, "coordinator"), ctx()).events.filter((e) => e.type === "session.stalled")).toEqual([]);
});

test("a session blocked before its first idle is not reported again as stalled", () => {
  const s = base();
  apply(s, USER, { type: "agent.blocked", thread: "001", payload: { session: W } });
  expect(react(s, turn(s, W, "worker"), ctx()).events.filter((e) => e.type === "session.stalled")).toEqual([]);
});

test("an idle while the bootstrap is still undelivered does not count; the turn after its delivery does", () => {
  const s = base();
  apply(s, USER, { type: "notice.queued", thread: "001", payload: { session: C, text: "You are the coordinator of thread 001. Read …" } });
  // a startup spin: active then idle with the bootstrap still queued
  expect(react(s, turn(s, C, "coordinator"), ctx()).events.filter((e) => e.type === "session.stalled")).toEqual([]);
  // delivered: the turn it starts counts
  apply(s, USER, { type: "notice.delivered", thread: "001", payload: { session: C, count: 1 } });
  const r = react(s, apply(s, { role: "coordinator", thread: "001", session: C }, { type: "agent.idle", thread: "001", payload: { session: C } }), ctx());
  expect(r.events.filter((e) => e.type === "session.stalled")).toEqual([{ type: "session.stalled", thread: "001", payload: { session: C } }]);
});

// ---- round 4: only what handle() decided for a command counts as authored ----

const stalls = (evs: EventBody[]) => evs.filter((e) => e.type === "session.stalled");

/** A session's own signal through handle(), stored with its follow-ups the way the daemon stores them. */
const signal = (s: State, actor: Actor, session: string, sig: "started" | "active" | "idle"): StoredEvent[] => {
  const r = handle(s, { cmd: "session.signal", session, signal: sig }, actor, ctx());
  if (!r.ok) throw new Error(r.error);
  expect(r.actor).toBeUndefined();
  const evs = apply(s, actor, ...r.events);
  const follow = react(s, evs, ctx());
  // the reactor's follow-ups and the effects' output (a delivery) are stored with the signal's actor
  const delivered = follow.effects.flatMap((e) => (e.kind === "notice.deliver" ? [{ type: "notice.delivered", thread: e.thread, payload: { session: e.session, count: e.count } } as EventBody] : []));
  apply(s, actor, ...follow.events, ...delivered);
  return evs;
};

test("a root-pane coordinator whose hook-driven bootstrap delivery is followed by a silent turn is reported", () => {
  const s = base();
  apply(s, USER, { type: "notice.queued", thread: "001", payload: { session: C, text: "You are the coordinator of thread 001." } });
  // its started hook: AGT_ROLE + AGT_THREAD, no AGT_SESSION; the daemon delivers the bootstrap under that actor
  signal(s, NO_SESSION_COORD, C, "started");
  expect(log.some((e) => e.type === "notice.delivered" && e.payload.session === C)).toBe(true);
  expect(s.sessions.get(C)?.authored).toBeFalsy();
  signal(s, NO_SESSION_COORD, C, "active");
  const idle = handle(s, { cmd: "session.signal", session: C, signal: "idle" }, NO_SESSION_COORD, ctx());
  const r = react(s, apply(s, NO_SESSION_COORD, ...(idle.ok ? idle.events : [])), ctx());
  expect(stalls(r.events)).toEqual([{ type: "session.stalled", thread: "001", payload: { session: C } }]);
  expect(project(log).sessions.get(C)?.authored).toBeFalsy();
});

test("a worker (with AGT_SESSION) is not credited by its own signals' follow-ups", () => {
  const s = base();
  const hook: Actor = { role: "worker", thread: "001", ticket: "T1", session: W };
  apply(s, USER, { type: "notice.queued", thread: "001", payload: { session: W, text: "You are a worker on ticket T1." } });
  signal(s, hook, W, "started");
  expect(log.some((e) => e.type === "notice.delivered" && e.payload.session === W && e.actor === hook)).toBe(true);
  signal(s, hook, W, "active");
  const idle = handle(s, { cmd: "session.signal", session: W, signal: "idle" }, hook, ctx());
  const r = react(s, apply(s, hook, ...(idle.ok ? idle.events : [])), ctx());
  expect(stalls(r.events)).toEqual([{ type: "session.stalled", thread: "001", payload: { session: W } }]);
});

for (const [name, actor] of [
  ["without", NO_SESSION_COORD],
  ["with", { role: "coordinator", thread: "001", session: C }],
] as const) {
  test(`a healthy coordinator that runs thread status (${name} a session on its actor) is not reported`, () => {
    const s = base();
    const r = handle(s, { cmd: "thread.status", thread: "001", status: "review" }, actor, ctx());
    if (!r.ok) throw new Error(r.error);
    expect(r.actor).toEqual({ role: "coordinator", thread: "001", session: C, via: "command" });
    apply(s, r.actor!, ...r.events);
    expect(s.sessions.get(C)?.authored).toBe(true);
    expect(stalls(react(s, turn(s, C, "coordinator"), ctx()).events)).toEqual([]);
    expect(project(log).sessions.get(C)?.authored).toBe(true);
  });
}

test("replaying an old log (no via) credits session-less command output by type only", () => {
  const credited = (body: EventBody, actor: Actor = NO_SESSION_COORD) => {
    const s = base();
    apply(s, actor, body);
    return project(log).sessions.get(C)?.authored === true;
  };
  for (const body of [
    { type: "thread.status_changed", thread: "001", payload: { from: "in_progress", to: "review" } },
    { type: "ticket.created", thread: "001", payload: { id: "T9", title: "x", scope: ["x"] } },
    { type: "log.appended", thread: "001", payload: { message: "m" } },
    { type: "decision.recorded", thread: "001", payload: { message: "m" } },
    { type: "progress.recorded", thread: "001", payload: { message: "m" } },
    { type: "worker.queued", thread: "001", payload: { ticket: "T1" } },
    { type: "handoff.submitted", thread: "001", payload: { content: "h", generated: false } },
  ] as EventBody[]) expect([body.type, credited(body)]).toEqual([body.type, true]);
  for (const body of [
    { type: "notice.delivered", thread: "001", payload: { session: C, count: 1 } },
    { type: "notice.queued", payload: { session: M, text: "t" } },
    { type: "handoff.submitted", thread: "001", payload: { content: "h", generated: true } },
    { type: "session.started", thread: "001", payload: { session: C } },
  ] as EventBody[]) expect([body.type, credited(body)]).toEqual([body.type, false]);
  // a marked (new) event counts whatever its type
  expect(credited({ type: "notice.queued", payload: { session: M, text: "t" } } as EventBody, { ...NO_SESSION_COORD, session: C, via: "command" })).toBe(true);
});

/** The allowlisted event types a source emits, found by its `type: "<t>"` literals. */
const emittedAllowlisted = (src: string) => [...src.matchAll(/type:\s*"([a-z_.]+)"/g)].map((m) => m[1]!).filter((t) => COMMAND_OUTPUT_TYPES.has(t));

// Old logs credit a session by event type alone, which holds only while no follow-up (reactor, sweep, effect) emits an
// allowlisted type: one that did would mark every session it follows as authored and hide a stall.
test("no allowlisted command-output type is emitted by the reactor, the sweep or the effects", () => {
  expect(emittedAllowlisted('{ type: "ticket.created", payload: {} } { type: "notice.queued" }')).toEqual(["ticket.created"]);
  expect(COMMAND_OUTPUT_TYPES.size).toBeGreaterThan(0);
  const src = join(import.meta.dir, "../../src");
  for (const f of ["orchestration/reactor.ts", "orchestration/sweep.ts", "daemon/effects.ts"]) {
    expect([f, emittedAllowlisted(readFileSync(join(src, f), "utf8"))]).toEqual([f, []]);
  }
});
