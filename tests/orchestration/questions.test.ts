import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import { handle } from "../../src/commands/handler.ts";
import type { Actor, EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
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
  expect(notices(c.events)).toEqual([{ session: M, text: "coordinator for thread 001 is waiting for approval in pane w1:p2." }]);
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
