import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type Config } from "../../src/config/config.ts";
import { handle, type HandleResult } from "../../src/commands/handler.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import type { Actor, EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { renderBrief } from "../../src/render/brief.ts";
import { renderMain } from "../../src/render/markdown.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, taskThreadCreated, threadCreated } from "../helpers.ts";

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const W = "11111111-1111-4111-8111-111111111111";
const M = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const COORD: Actor = { role: "coordinator", thread: "001", session: C };
const FULL: Config = {
  ...DEFAULT_CONFIG,
  workflow: {
    ...DEFAULT_CONFIG.workflow,
    stack: { restart: "make up {task}" },
    e2e: { stage2: "make e2e2" },
    browser: { urls: ["http://localhost:3000"] },
    migration: { tool: "goose" },
  },
};
const run = (state: State, cmd: unknown, actor: Actor = COORD, config: Config = DEFAULT_CONFIG): HandleResult =>
  handle(state, CommandSchema.parse(cmd), actor, { root: "/repo", config });
const apply = (state: State, bodies: EventBody[], actor: Actor = USER): StoredEvent[] =>
  bodies.map((b) => {
    const ev = { ...b, seq: state.lastSeq + 1, ts: "2026-10-09T11:00:00.000Z", actor } as StoredEvent;
    applyEvent(state, ev);
    return ev;
  });
const exec = (state: State, cmd: unknown, actor: Actor = COORD, config: Config = DEFAULT_CONFIG): HandleResult => {
  const r = run(state, cmd, actor, config);
  if (r.ok) apply(state, r.events, actor);
  return r;
};
const errorOf = (r: HandleResult) => (r.ok ? "accepted" : r.error);
const thread = (s: State) => s.threads.get("001")!;
const world = (status: "open" | "in_progress" = "in_progress"): State => {
  const s = stateOf(INIT, taskThreadCreated("001", "pay-1", { status, title: "Login" }));
  apply(s, [
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    { type: "session.created", payload: { session: M, role: "main", agent: "claude-code", name: "m" } },
    { type: "session.attached", payload: { session: M, pane: "w1:p0" } },
  ]);
  return s;
};
const waiting = (what = "which table?") => ({ cmd: "thread.waiting", thread: "001", what });
const newThread = { cmd: "thread.new", title: "Login", type: "feature" };

describe("auto na stages", () => {
  test("a new task thread with an empty workflow config records stages 7 and 8 as na by agt", () => {
    const r = run(stateOf(INIT), newThread, USER);
    expect(r.ok && r.events.filter((e) => e.type === "stage.recorded")).toEqual([
      { type: "stage.recorded", thread: "001", payload: { stage: 7, state: "na", by: "agt", reason: "no e2e commands configured" } },
      { type: "stage.recorded", thread: "001", payload: { stage: 8, state: "na", by: "agt", reason: "no browser URL or stack restart configured" } },
    ]);
  });

  test("the brief skips them: stages 1-6 done make the current stage 9", () => {
    const s = stateOf(INIT);
    exec(s, newThread, USER);
    for (let n = 1; n <= 6; n++) exec(s, { cmd: "stage", thread: "001", stage: n, state: "done" });
    expect(renderBrief({ thread: thread(s), sessions: [] })).toContain("Stage: 9 ");
    expect(thread(s).stages[7]?.by).toBe("agt");
  });

  test("a full workflow config records nothing", () => {
    const r = run(stateOf(INIT), newThread, USER, FULL);
    expect(r.ok && r.events.some((e) => e.type === "stage.recorded")).toBe(false);
  });
});

describe("migration line", () => {
  const LINE = "Migration SQL: not needed (no migration tool configured).";
  test("present without a migration tool, absent with one", () => {
    const s = world();
    expect(renderBrief({ thread: thread(s), sessions: [] })).toContain(LINE);
    expect(renderBrief({ thread: thread(s), sessions: [], config: FULL })).not.toContain(LINE);
  });
  test("absent on a legacy thread", () => {
    const s = stateOf(INIT, threadCreated("001"));
    expect(renderBrief({ thread: thread(s), sessions: [] })).not.toContain(LINE);
  });
});

describe("thread waiting", () => {
  test("only the thread's coordinator may run it", () => {
    const s = world();
    expect(errorOf(run(s, waiting(), { role: "worker", thread: "001", session: W, ticket: "T1" }))).toContain("may not run");
    expect(errorOf(run(s, waiting(), USER))).toContain("may not run");
    expect(errorOf(run(s, waiting(), { role: "coordinator", thread: "002", session: C }))).toBe("coordinator is bound to thread 002");
    expect(errorOf(run(s, waiting()))).toBe("accepted");
  });

  test("records the event, main hears it, and main.thread.md shows it in the row", () => {
    const s = world();
    const r = exec(s, waiting());
    expect(r.ok && r.events).toEqual([{ type: "thread.waiting", thread: "001", payload: { what: "which table?" } }]);
    const row = renderMain(s).split("\n").find((l) => l.startsWith("| 001 "))!;
    expect(row).toContain("waiting: which table?");
  });

  test("the notice to main is exact, and a second waiting replaces the text and tells main again", () => {
    const s = world();
    const ctx = { root: "/repo", config: DEFAULT_CONFIG, newId: () => "00000000-0000-4000-8000-000000000001" };
    const first = react(s, apply(s, [{ type: "thread.waiting", thread: "001", payload: { what: "which table?" } }], COORD), ctx);
    expect(first.events).toEqual([{ type: "notice.queued", thread: "001", payload: { session: M, text: "Thread 001 (Login) is waiting for the user: which table?", wait: true } }]);
    const second = react(s, apply(s, [{ type: "thread.waiting", thread: "001", payload: { what: "which schema?" } }], COORD), ctx);
    expect(second.events).toEqual([{ type: "notice.queued", thread: "001", payload: { session: M, text: "Thread 001 (Login) is waiting for the user: which schema?", wait: true } }]);
    expect(thread(s).waiting?.what).toBe("which schema?");
  });

  test("cleared by the coordinator's idle followed by a turn start, not by the idle alone", () => {
    const s = world();
    apply(s, [{ type: "thread.waiting", thread: "001", payload: { what: "which table?" } }], COORD);
    apply(s, [{ type: "session.active", thread: "001", payload: { session: C } }]);
    expect(thread(s).waiting).toBeDefined();
    apply(s, [{ type: "agent.idle", thread: "001", payload: { session: C } }]);
    expect(thread(s).waiting).toMatchObject({ what: "which table?", idleSeen: true });
    expect(renderMain(s)).toContain("waiting: which table?");
    apply(s, [{ type: "session.active", thread: "001", payload: { session: C } }]);
    expect(thread(s).waiting).toBeUndefined();
    expect(renderMain(s)).not.toContain("waiting:");
  });

  const waitingIdle = (): State => {
    const s = world();
    apply(s, [
      { type: "session.started", thread: "001", payload: { session: C } },
      { type: "thread.waiting", thread: "001", payload: { what: "x" } },
      { type: "agent.idle", thread: "001", payload: { session: C } },
    ], COORD);
    return s;
  };
  const NOTICE = { type: "notice.queued", thread: "001", payload: { session: C, text: "Ticket T1 is done." } } as const;
  const DELIVERED = { type: "notice.delivered", thread: "001", payload: { session: C, count: 1 } } as const;
  const ACTIVE = { type: "session.active", thread: "001", payload: { session: C } } as const;

  test("a user prompt at the idle coordinator's empty queue clears it", () => {
    const s = waitingIdle();
    apply(s, [ACTIVE]);
    expect(thread(s).waiting).toBeUndefined();
  });

  test("a delivered notice is not the user answering: hook before notice.delivered", () => {
    const s = waitingIdle();
    apply(s, [NOTICE, ACTIVE, DELIVERED]);
    expect(thread(s).waiting).toBeDefined();
  });

  test("a delivered notice is not the user answering: notice.delivered before the hook", () => {
    const s = waitingIdle();
    apply(s, [NOTICE, DELIVERED, ACTIVE]);
    expect(thread(s).waiting).toBeDefined();
  });

  test("another session's idle or turn start does not clear it", () => {
    const s = world();
    apply(s, [{ type: "thread.waiting", thread: "001", payload: { what: "x" } }], COORD);
    apply(s, [{ type: "agent.idle", payload: { session: M } }, { type: "session.active", payload: { session: M } }]);
    expect(thread(s).waiting?.idleSeen).toBe(false);
  });
});

describe("stage 10 done", () => {
  test("moves an in_progress thread to review with the status event", () => {
    const s = world();
    const r = exec(s, { cmd: "stage", thread: "001", stage: 10, state: "done" });
    expect(r.ok && r.events.map((e) => e.type)).toEqual(["stage.recorded", "thread.status_changed"]);
    expect(thread(s).status).toBe("review");
  });
  test("leaves other statuses alone, and other stages do not move it", () => {
    const s = world("open");
    exec(s, { cmd: "stage", thread: "001", stage: 10, state: "done" });
    expect(thread(s).status).toBe("open");
    const t = world();
    exec(t, { cmd: "stage", thread: "001", stage: 9, state: "done" });
    expect(thread(t).status).toBe("in_progress");
  });
});
