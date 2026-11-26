import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import { handle } from "../../src/commands/handler.ts";
import type { Actor, EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react, reviewNotice } from "../../src/orchestration/reactor.ts";
import { renderBrief } from "../../src/render/brief.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, threadCreated } from "../helpers.ts";

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const W1 = "11111111-1111-4111-8111-111111111111";
const M = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const COORD: Actor = { role: "coordinator", thread: "001", session: C };
const WORKER: Actor = { role: "worker", thread: "001", session: W1, ticket: "T1" };
let n = 0;
const ctx = () => ({ root: "/repo", config: DEFAULT_CONFIG, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` });

function apply(state: State, actor: Actor, ...bodies: EventBody[]): StoredEvent[] {
  return bodies.map((b) => {
    const ev = { ...b, seq: state.lastSeq + 1, ts: "t", actor } as StoredEvent;
    applyEvent(state, ev);
    return ev;
  });
}

function base(): State {
  n = 0;
  const s = stateOf(INIT, threadCreated("001"), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
  apply(
    s,
    USER,
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    { type: "session.created", payload: { session: M, role: "main", agent: "claude-code", name: "m" } },
    { type: "session.attached", payload: { session: M, pane: "w1:p0" } },
    { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "T1", scope: ["a"] } },
    { type: "session.created", thread: "001", payload: { session: W1, role: "worker", agent: "claude-code", name: "w", ticket: "T1" } },
    { type: "session.attached", thread: "001", payload: { session: W1, pane: "w1:p3" } },
  );
  return s;
}

/** Runs a command through the handler, applies its events with the actor, and returns the stored events. */
function run(s: State, actor: Actor, cmd: unknown): StoredEvent[] {
  const r = handle(s, CommandSchema.parse(cmd), actor, ctx());
  if (!r.ok) throw new Error(r.error);
  return apply(s, actor, ...r.events);
}

const notices = (evs: EventBody[]) => evs.filter((e) => e.type === "notice.queued").map((e) => (e as Extract<EventBody, { type: "notice.queued" }>).payload);

test("a worker's question notifies the coordinator and gets an id", () => {
  const s = base();
  const evs = run(s, WORKER, { cmd: "question", thread: "001", message: "which db?" });
  expect(evs[0]).toMatchObject({ type: "question.recorded", payload: { id: "Q1", message: "which db?" } });
  const r = react(s, evs, ctx());
  expect(notices(r.events)).toEqual([
    { session: C, text: 'Question Q1 from the worker for ticket T1: which db? Answer with: agt answer 001 Q1 "<answer>"' },
  ]);
  const second = run(s, WORKER, { cmd: "question", thread: "001", message: "again" });
  expect(second[0]).toMatchObject({ payload: { id: "Q2" } });
});

test("a coordinator's or main's question notifies nobody", () => {
  const s = base();
  expect(react(s, run(s, COORD, { cmd: "question", thread: "001", message: "q" }), ctx()).events).toEqual([]);
  expect(react(s, run(s, { role: "main" }, { cmd: "question", thread: "001", message: "q" }), ctx()).events).toEqual([]);
});

test("answer is for the coordinator only and needs a known question", () => {
  const s = base();
  run(s, WORKER, { cmd: "question", thread: "001", message: "q" });
  const ans = CommandSchema.parse({ cmd: "answer", thread: "001", question: "Q1", message: "sqlite" });
  expect(handle(s, ans, WORKER, ctx())).toEqual({ ok: false, error: "only the coordinator answers questions" });
  expect(handle(s, ans, { role: "main" }, ctx())).toEqual({ ok: false, error: "only the coordinator answers questions" });
  expect(handle(s, CommandSchema.parse({ cmd: "answer", thread: "001", question: "Q9", message: "x" }), COORD, ctx())).toEqual({
    ok: false,
    error: "unknown question Q9 in thread 001",
  });
  expect(handle(s, ans, COORD, ctx())).toMatchObject({ ok: true, events: [{ type: "question.answered", payload: { question: "Q1", answer: "sqlite" } }] });
});

test("an answer is delivered to the asking worker's session", () => {
  const s = base();
  run(s, WORKER, { cmd: "question", thread: "001", message: "q" });
  const evs = run(s, COORD, { cmd: "answer", thread: "001", question: "Q1", message: "use sqlite" });
  expect(s.threads.get("001")!.questions[0]).toMatchObject({ id: "Q1", answer: { message: "use sqlite" }, by: { role: "worker", ticket: "T1" } });
  expect(notices(react(s, evs, ctx()).events)).toEqual([{ session: W1, text: "Answer to Q1 from the coordinator: use sqlite" }]);
});

test("an answer for an ended worker is recorded, not delivered, and the coordinator is not told", () => {
  const s = base();
  run(s, WORKER, { cmd: "question", thread: "001", message: "q" });
  apply(s, USER, { type: "session.ended", thread: "001", payload: { session: W1 } });
  const evs = run(s, COORD, { cmd: "answer", thread: "001", question: "Q1", message: "use sqlite" });
  expect(s.threads.get("001")!.questions[0]!.answer?.message).toBe("use sqlite");
  expect(react(s, evs, ctx()).events).toEqual([]);
});

test("a blocked worker is reported to its coordinator, a blocked coordinator to main", () => {
  const s = base();
  const w = react(s, apply(s, USER, { type: "agent.blocked", thread: "001", payload: { session: W1 } }), ctx());
  expect(notices(w.events)).toEqual([
    { session: C, text: "The worker for ticket T1 is blocked in pane w1:p3. Check it, replace it with agt worker spawn 001 --ticket T1, or ask the user." },
  ]);
  const c = react(s, apply(s, USER, { type: "agent.blocked", thread: "001", payload: { session: C } }), ctx());
  expect(notices(c.events)).toEqual([{ session: M, text: "coordinator of thread 001 (Thread 001) is waiting for the user in its pane: it asked a question or needs a permission. Tell the user to answer it in the thread tab 001-thread-001.", wait: true }]);
});

test("old question events without an id get Q1.. in log order", () => {
  const s = stateOf(
    INIT,
    threadCreated("001"),
    { type: "question.recorded", thread: "001", payload: { message: "a" } },
    { type: "question.recorded", thread: "001", payload: { message: "b" } },
    { type: "question.answered", thread: "001", payload: { question: "Q2", answer: "yes" } },
  );
  expect(s.threads.get("001")!.questions.map((q) => [q.id, q.answer?.message])).toEqual([
    ["Q1", undefined],
    ["Q2", "yes"],
  ]);
});

test("the brief lists open questions with ids; answered ones leave and show their answer", () => {
  const s = base();
  run(s, WORKER, { cmd: "question", thread: "001", message: "which db?" });
  run(s, WORKER, { cmd: "question", thread: "001", message: "which port?" });
  const brief = () => renderBrief({ thread: s.threads.get("001")!, sessions: [], trail: undefined, dir: "/d" });
  const open = (md: string) => md.split("## Open questions")[1]!.split("\n## ")[0]!;
  expect(open(brief())).toContain("Q1");
  expect(open(brief())).toContain("which port?");
  run(s, COORD, { cmd: "answer", thread: "001", question: "Q1", message: "use sqlite" });
  const md = brief();
  expect(open(md)).not.toContain("which db?");
  expect(open(md)).toContain("Q2");
  expect(md).toContain("Q1");
  expect(md).toContain("use sqlite");
});

test("a repeated blocked event with no active or idle between raises no second notice", () => {
  const s = base();
  const first = react(s, apply(s, USER, { type: "agent.blocked", thread: "001", payload: { session: W1 } }), ctx());
  expect(notices(first.events)).toHaveLength(1);
  expect(notices(react(s, apply(s, USER, { type: "agent.blocked", thread: "001", payload: { session: W1 } }), ctx()).events)).toEqual([]);
  apply(s, USER, { type: "session.active", thread: "001", payload: { session: W1 } });
  expect(notices(react(s, apply(s, USER, { type: "agent.blocked", thread: "001", payload: { session: W1 } }), ctx()).events)).toHaveLength(1);
});

test("notices for a worker with no ticket say so and never contain undefined", () => {
  const s = base();
  const W2 = "22222222-2222-4222-8222-222222222222";
  apply(
    s,
    USER,
    { type: "session.created", thread: "001", payload: { session: W2, role: "worker", agent: "claude-code", name: "w2" } },
    { type: "session.attached", thread: "001", payload: { session: W2, pane: "w1:p4" } },
  );
  const texts: string[] = [];
  const collect = (evs: StoredEvent[]) => texts.push(...notices(react(s, evs, ctx()).events).map((x) => x.text));
  collect(apply(s, USER, { type: "agent.blocked", thread: "001", payload: { session: W2 } }));
  collect(apply(s, { role: "worker", thread: "001", session: W2 }, { type: "question.recorded", thread: "001", payload: { id: "Q1", message: "q" } }));
  // A worker that was never blocked can stall (a blocked one is reported as blocked instead).
  const W3 = "33333333-3333-4333-8333-333333333333";
  apply(
    s,
    USER,
    { type: "session.created", thread: "001", payload: { session: W3, role: "worker", agent: "claude-code", name: "w3" } },
    { type: "session.attached", thread: "001", payload: { session: W3, pane: "w1:p5" } },
  );
  for (const sig of ["idle", "active", "idle", "active", "idle"] as const) {
    const type = sig === "idle" ? "agent.idle" : "session.active";
    collect(apply(s, USER, { type, thread: "001", payload: { session: W3 } } as EventBody));
  }
  collect(apply(s, USER, { type: "session.lost", thread: "001", payload: { session: W2, reason: "gone" } }));
  expect(texts.length).toBeGreaterThanOrEqual(3);
  for (const x of texts) expect(x).not.toContain("undefined");
  expect(texts[0]).toStartWith("A worker with no ticket is blocked in pane w1:p4.");
  expect(texts.some((x) => x.includes("from a worker with no ticket:"))).toBe(true);
  expect(texts.some((x) => x.startsWith("A worker with no ticket was lost"))).toBe(true);
  expect(texts.some((x) => x.includes("finished its first turn without running any agt command"))).toBe(true);
});

test("a blocked coordinator that just said it waits (agt thread waiting) does not also notify main", () => {
  const s = base();
  apply(s, { ...COORD }, { type: "thread.waiting", thread: "001", payload: { what: "which db?" } });
  const out = react(s, apply(s, USER, { type: "agent.blocked", thread: "001", payload: { session: C } }), ctx());
  expect(notices(out.events)).toEqual([]);
});

test("the waiting dedupe also covers a wait that ended within 60s, but not an older one or another session", () => {
  const at = (ts: string, actor: Actor, ...b: EventBody[]) => b.map((x) => { const ev = { ...x, seq: s.lastSeq + 1, ts, actor } as StoredEvent; applyEvent(s, ev); return ev; });
  const s = base();
  at("2026-10-11T10:00:00.000Z", COORD, { type: "thread.waiting", thread: "001", payload: { what: "q" } });
  delete s.threads.get("001")!.waiting; // answered
  const soon = react(s, at("2026-10-11T10:00:50.000Z", USER, { type: "agent.blocked", thread: "001", payload: { session: C } }), ctx());
  expect(notices(soon.events)).toEqual([]);
  at("2026-10-11T10:00:55.000Z", USER, { type: "session.active", thread: "001", payload: { session: C } });
  const late = react(s, at("2026-10-11T10:02:00.000Z", USER, { type: "agent.blocked", thread: "001", payload: { session: C } }), ctx());
  expect(notices(late.events)).toHaveLength(1);
});

test("a repeated blocked event for the same block does not notify main again", () => {
  const s = base();
  expect(notices(react(s, apply(s, USER, { type: "agent.blocked", thread: "001", payload: { session: C } }), ctx()).events)).toHaveLength(1);
  expect(notices(react(s, apply(s, USER, { type: "agent.blocked", thread: "001", payload: { session: C } }), ctx()).events)).toEqual([]);
});

// A wait main is told about, and told again when it is over.
function stamped(s: State) {
  return (ts: string, actor: Actor, ...b: EventBody[]) => b.map((x) => { const ev = { ...x, seq: s.lastSeq + 1, ts, actor } as StoredEvent; applyEvent(s, ev); return ev; });
}
const BLOCKED_TEXT = "coordinator of thread 001 (Thread 001) is waiting for the user in its pane: it asked a question or needs a permission. Tell the user to answer it in the thread tab 001-thread-001.";
const ANSWERED = "Thread 001 (Thread 001): the user answered the coordinator in its tab; nothing to relay.";

test("a blocked pane answered before main got the notice drops it instead of sending both", () => {
  const s = base();
  const at = stamped(s);
  const b = react(s, at("2026-10-11T10:00:00.000Z", USER, { type: "agent.blocked", thread: "001", payload: { session: C } }), ctx());
  at("2026-10-11T10:00:00.000Z", USER, ...b.events);
  expect(s.sessions.get(M)!.notices).toEqual([BLOCKED_TEXT]);
  const a = react(s, at("2026-10-11T10:00:20.000Z", USER, { type: "session.active", thread: "001", payload: { session: C } }), ctx());
  expect(a.events).toEqual([{ type: "notice.dropped", payload: { session: M, texts: [BLOCKED_TEXT] } }]);
  at("2026-10-11T10:00:20.000Z", USER, ...a.events);
  expect(s.sessions.get(M)!.notices).toEqual([]);
});

test("a blocked pane answered after main heard it queues one short notice", () => {
  const s = base();
  const at = stamped(s);
  const b = react(s, at("2026-10-11T10:00:00.000Z", USER, { type: "agent.blocked", thread: "001", payload: { session: C } }), ctx());
  at("2026-10-11T10:00:00.000Z", USER, ...b.events);
  at("2026-10-11T10:00:05.000Z", USER, { type: "notice.delivered", payload: { session: M, count: 1, texts: [BLOCKED_TEXT] } });
  const a = react(s, at("2026-10-11T10:00:20.000Z", USER, { type: "session.active", thread: "001", payload: { session: C } }), ctx());
  expect(a.events).toEqual([{ type: "notice.queued", payload: { session: M, text: ANSWERED } }]);
  // a second active event is not the end of another wait
  expect(react(s, at("2026-10-11T10:00:30.000Z", USER, { type: "session.active", thread: "001", payload: { session: C } }), ctx()).events).toEqual([]);
});

test("a thread.waiting while the blocked pane is open, or within 60s of it, does not queue a second wait notice", () => {
  const s = base();
  const at = stamped(s);
  const b = react(s, at("2026-10-11T10:00:00.000Z", USER, { type: "agent.blocked", thread: "001", payload: { session: C } }), ctx());
  at("2026-10-11T10:00:00.000Z", USER, ...b.events);
  const open = react(s, at("2026-10-11T10:05:00.000Z", COORD, { type: "thread.waiting", thread: "001", payload: { what: "q" } }), ctx());
  expect(notices(open.events)).toEqual([]); // the pane is still blocked, however late
  at("2026-10-11T10:05:01.000Z", USER, { type: "agent.idle", thread: "001", payload: { session: C } });
  const s2 = base();
  const at2 = stamped(s2);
  at2("2026-10-11T10:00:00.000Z", USER, { type: "agent.blocked", thread: "001", payload: { session: C } });
  at2("2026-10-11T10:00:05.000Z", USER, { type: "session.active", thread: "001", payload: { session: C } });
  // the pane was answered at 10:00:05: a real question at 10:00:40 is told
  const soon = react(s2, at2("2026-10-11T10:00:40.000Z", COORD, { type: "thread.waiting", thread: "001", payload: { what: "q" } }), ctx());
  expect(notices(soon.events)).toEqual([{ session: M, text: "Thread 001 (Thread 001) is waiting for the user: q", wait: true }]);
});

test("an agt thread waiting answered by the user is dropped or followed up like a blocked pane", () => {
  const s = base();
  const at = stamped(s);
  const w = react(s, at("2026-10-11T10:00:00.000Z", COORD, { type: "thread.waiting", thread: "001", payload: { what: "which db?" } }), ctx());
  at("2026-10-11T10:00:00.000Z", COORD, ...w.events);
  at("2026-10-11T10:00:10.000Z", USER, { type: "agent.idle", thread: "001", payload: { session: C } });
  const a = react(s, at("2026-10-11T10:01:00.000Z", USER, { type: "session.active", thread: "001", payload: { session: C } }), ctx());
  expect(a.events).toEqual([{ type: "notice.dropped", payload: { session: M, texts: ["Thread 001 (Thread 001) is waiting for the user: which db?"] } }]);
});

test("the ready-for-review notice names the stages that were skipped or n/a, with reasons", () => {
  const s = base();
  const at = stamped(s);
  at("2026-10-11T10:00:00.000Z", USER, { type: "stage.recorded", thread: "001", payload: { stage: 8, state: "skipped", by: "user", reason: "user skipped it" } });
  at("2026-10-11T10:00:00.000Z", USER, { type: "stage.recorded", thread: "001", payload: { stage: 7, state: "na", by: "agt", reason: "no e2e commands configured" } });
  const r = react(s, at("2026-10-11T10:00:30.000Z", COORD, { type: "thread.status_changed", thread: "001", payload: { from: "in_progress", to: "review" } }), ctx());
  expect(notices(r.events)).toEqual([{ session: M, text: "Thread 001 (Thread 001) is ready for review. Not run: 7 e2e (n/a: no e2e commands configured); 8 browser check (skipped: user skipped it)." }]);
});

test("a wait notice that reaches main after the user answered is not queued", () => {
  const s = base();
  const at = stamped(s);
  const b = react(s, at("2026-10-11T10:00:00.000Z", USER, { type: "agent.blocked", thread: "001", payload: { session: C } }), ctx());
  at("2026-10-11T10:00:05.000Z", USER, { type: "session.active", thread: "001", payload: { session: C } });
  at("2026-10-11T10:00:05.000Z", USER, ...b.events);
  expect(s.sessions.get(M)!.notices).toEqual([]);
});

test("a wait asked again before the user answered, by the same or a rotated coordinator, is told to main once", () => {
  const s = base();
  const at = stamped(s);
  const C2 = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";
  const COORD2: Actor = { role: "coordinator", thread: "001", session: C2 };
  const first = react(s, at("2026-10-11T10:00:00.000Z", COORD, { type: "thread.waiting", thread: "001", payload: { what: "yes/no on full e2e?" } }), ctx());
  expect(notices(first.events)).toEqual([{ session: M, text: "Thread 001 (Thread 001) is waiting for the user: yes/no on full e2e?", wait: true }]);
  at("2026-10-11T10:00:00.000Z", COORD, ...first.events);
  at("2026-10-11T10:00:05.000Z", USER, { type: "notice.delivered", payload: { session: M, count: 1, texts: ["Thread 001 (Thread 001) is waiting for the user: yes/no on full e2e?"] } });
  // the coordinator rotates; its replacement asks the same thing in other words, then again later
  at("2026-10-11T10:01:00.000Z", USER,
    { type: "session.rotated", thread: "001", payload: { session: C, reason: "usage limit" } },
    { type: "session.created", thread: "001", payload: { session: C2, role: "coordinator", agent: "claude-code", name: "c2", replaces: C } },
    { type: "session.attached", thread: "001", payload: { session: C2, pane: "w1:p5" } },
  );
  const again = react(s, at("2026-10-11T10:01:30.000Z", COORD2, { type: "thread.waiting", thread: "001", payload: { what: "run the full e2e suite (~8.5 min)?" } }), ctx());
  expect(notices(again.events)).toEqual([]);
  const third = react(s, at("2026-10-11T10:03:00.000Z", COORD2, { type: "thread.waiting", thread: "001", payload: { what: "run the full e2e suite (~8.5 min)?" } }), ctx());
  expect(notices(third.events)).toEqual([]);
  // the latest wording is the thread's wait
  expect(s.threads.get("001")!.waiting?.what).toBe("run the full e2e suite (~8.5 min)?");
  // the user answers the replacement in its tab: the wait ends, and main hears that once
  at("2026-10-11T10:03:10.000Z", USER, { type: "agent.idle", thread: "001", payload: { session: C2 } });
  const answered = react(s, at("2026-10-11T10:04:00.000Z", USER, { type: "session.active", thread: "001", payload: { session: C2 } }), ctx());
  expect(notices(answered.events)).toEqual([{ session: M, text: ANSWERED }]);
  at("2026-10-11T10:04:00.000Z", USER, ...answered.events);
  // a later question is a new wait: told again
  const next = react(s, at("2026-10-11T10:10:00.000Z", COORD2, { type: "thread.waiting", thread: "001", payload: { what: "merged?" } }), ctx());
  expect(notices(next.events)).toEqual([{ session: M, text: "Thread 001 (Thread 001) is waiting for the user: merged?", wait: true }]);
});

test("a doc thread's ready-for-review notice names its own stages", () => {
  const s = base();
  s.threads.get("001")!.type = "review";
  const at = stamped(s);
  at("2026-10-11T10:00:00.000Z", USER, { type: "stage.recorded", thread: "001", payload: { stage: 2, state: "skipped", by: "user", reason: "no checks needed" } });
  const r = react(s, at("2026-10-11T10:00:30.000Z", COORD, { type: "thread.status_changed", thread: "001", payload: { from: "in_progress", to: "review" } }), ctx());
  expect(notices(r.events)).toEqual([{ session: M, text: "Thread 001 (Thread 001) is ready for review. Not run: 2 investigation (skipped: no checks needed)." }]);
});

test("a doc thread's ticket review notice asks to read the findings, not the commits", () => {
  expect(reviewNotice("001", "T1", "all pass", true)).toBe('Ticket T1 is ready for review: all pass. Read its findings, then agt ticket accept 001/T1 or agt ticket return 001/T1 "<what to check>".');
  expect(reviewNotice("001", "T1", "done", false)).toContain("Review its commits");
});
