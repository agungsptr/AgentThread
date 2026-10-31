import { describe, expect, test } from "bun:test";
import { handle, type HandleResult } from "../../src/commands/handler.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import type { Actor, StoredEvent } from "../../src/domain/types.ts";
import { applyEvent, emptyState, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, threadCreated } from "../helpers.ts";

const COORD: Actor = { role: "coordinator", thread: "001", session: "c1" };
const worker = (session: string, ticket?: string): Actor => ({ role: "worker", thread: "001", session, ticket });

function run(state: State, cmd: unknown, actor: Actor = USER): HandleResult {
  return handle(state, CommandSchema.parse(cmd), actor, { root: "/repo" });
}

/** Runs a command and, if accepted, applies its events to `state`. */
function exec(state: State, cmd: unknown, actor: Actor = USER): HandleResult {
  const r = run(state, cmd, actor);
  if (r.ok) {
    for (const body of r.events) {
      applyEvent(state, { ...body, seq: state.lastSeq + 1, ts: "2026-10-09T11:00:00.000Z", actor } as StoredEvent);
    }
  }
  return r;
}

const errorOf = (r: HandleResult) => (r.ok ? "accepted" : r.error);

function withTickets(): State {
  const s = stateOf(INIT, threadCreated("001"));
  exec(s, { cmd: "ticket.add", thread: "001", title: "Lock", scope: ["src/checkout"] }, COORD);
  exec(s, { cmd: "ticket.add", thread: "001", title: "Lock file", scope: ["src/checkout/lock.ts"] }, COORD);
  exec(s, { cmd: "ticket.add", thread: "001", title: "Cart", scope: ["src/checkout-ui"] }, COORD);
  return s;
}

describe("thread.new", () => {
  test("rejects before the project is initialized", () => {
    expect(errorOf(run(emptyState(), { cmd: "thread.new", title: "X", type: "bug" }))).toContain("not initialized");
  });

  test("--task names the thread directory: no git worktree, a thread.dir.ensure effect", () => {
    const r = run(stateOf(INIT), { cmd: "thread.new", title: "Fix login", type: "bug", task: "kyc-1" });
    if (!r.ok) throw new Error(r.error);
    expect(r.result).toEqual({ thread: "001", task: "kyc-1", dir: "/repo/.worktrees/kyc-1" });
    expect(r.effects).toEqual([
      { kind: "thread.dir.ensure", thread: { id: "001", title: "Fix login", slug: "fix-login", task: "kyc-1", dir: "/repo/.worktrees/kyc-1" } },
    ]);
    expect(r.effects.some((e) => e.kind === "git.worktree.add")).toBe(false);
    const payload = (r.events[0] as { payload: Record<string, unknown> }).payload;
    expect(payload).toMatchObject({ task: "kyc-1", dir: "/repo/.worktrees/kyc-1" });
    expect(payload).not.toHaveProperty("worktree");
    expect(payload).not.toHaveProperty("branch");
  });

  test("the default task is the title's slug", () => {
    const r = run(stateOf(INIT), { cmd: "thread.new", title: "Fix checkout race", type: "bug", goal: "no double charge" });
    if (!r.ok) throw new Error(r.error);
    expect(r.result).toEqual({ thread: "001", task: "fix-checkout-race", dir: "/repo/.worktrees/fix-checkout-race" });
    expect(r.events[0]).toMatchObject({ type: "thread.created", thread: "001", payload: { status: "open", goal: "no double charge", task: "fix-checkout-race" } });
  });

  test("an explicit task name in use is rejected", () => {
    const s = stateOf(INIT);
    exec(s, { cmd: "thread.new", title: "Fix login", type: "bug", task: "kyc-1" });
    expect(errorOf(run(s, { cmd: "thread.new", title: "Other", type: "bug", task: "kyc-1" }))).toBe("task kyc-1 is already used by thread 001");
  });

  test("a derived task name that is taken gets the first free numeric suffix", () => {
    const s = stateOf(INIT);
    exec(s, { cmd: "thread.new", title: "Same", type: "bug" });
    expect(run(s, { cmd: "thread.new", title: "Same", type: "bug" })).toMatchObject({ ok: true, result: { task: "same-2", dir: "/repo/.worktrees/same-2" } });
    exec(s, { cmd: "thread.new", title: "Same", type: "bug" });
    exec(s, { cmd: "thread.new", title: "Other", type: "bug", task: "same-3" });
    expect(run(s, { cmd: "thread.new", title: "Same", type: "bug" })).toMatchObject({ ok: true, result: { task: "same-4" } });
  });

  test("a task name that would reuse a legacy thread's worktree is rejected", () => {
    const s = stateOf(INIT, threadCreated("001"));
    expect(errorOf(run(s, { cmd: "thread.new", title: "X", type: "bug", task: "001-thread-001" }))).toBe("task 001-thread-001 is already used by thread 001");
  });

  test("a derived task name that collides with a legacy worktree gets a suffix", () => {
    const s = stateOf(INIT, threadCreated("001", { slug: "fix-race", worktree: "/repo/.worktrees/fix-race" }));
    expect(run(s, { cmd: "thread.new", title: "Fix race", type: "bug" })).toMatchObject({ ok: true, result: { task: "fix-race-2", dir: "/repo/.worktrees/fix-race-2" } });
  });

  test("an invalid task name is rejected", () => {
    for (const task of ["Kyc", "-x", "a/b", "", "x y"]) {
      expect(errorOf(run(stateOf(INIT), { cmd: "thread.new", title: "X", type: "bug", task }))).toBe("task name must match ^[a-z0-9][a-z0-9._-]*$");
    }
  });

  test("continues numbering after existing threads", () => {
    const r = run(stateOf(INIT, threadCreated("001")), { cmd: "thread.new", title: "Next", type: "feature" });
    expect(r.ok && r.result).toMatchObject({ thread: "002" });
  });

  test("starts blocked when a dependency is not done", () => {
    const r = run(stateOf(INIT, threadCreated("001")), { cmd: "thread.new", title: "B", type: "feature", dependsOn: ["001"] });
    expect(r.ok && r.events[0]).toMatchObject({ payload: { status: "blocked", dependsOn: ["001"] } });
  });

  test("rejects an unknown dependency", () => {
    expect(errorOf(run(stateOf(INIT), { cmd: "thread.new", title: "B", type: "bug", dependsOn: ["042"] }))).toContain(
      "unknown dependency 042",
    );
  });

  test("workers may not create threads", () => {
    expect(errorOf(run(stateOf(INIT), { cmd: "thread.new", title: "B", type: "bug" }, worker("w1")))).toContain(
      "role worker may not run thread.new",
    );
  });
});

describe("thread binding", () => {
  test("coordinator of another thread is rejected", () => {
    const s = stateOf(INIT, threadCreated("001"), threadCreated("002"));
    const r = run(s, { cmd: "decide", thread: "002", message: "x" }, COORD);
    expect(errorOf(r)).toContain("coordinator is bound to thread 001");
  });
});

describe("tickets", () => {
  test("worker ticket commands require a session", () => {
    const s = withTickets();
    const sessionless: Actor = { role: "worker", thread: "001" };
    expect(errorOf(run(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, sessionless))).toBe(
      "worker commands require AGT_SESSION",
    );
    exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, worker("w1"));
    expect(errorOf(run(s, { cmd: "ticket.done", thread: "001", ticket: "T1", summary: "ok" }, sessionless))).toBe(
      "worker commands require AGT_SESSION",
    );
  });

  test("ticket ids are sequential", () => {
    const s = withTickets();
    expect(s.threads.get("001")!.tickets.map((k) => k.id)).toEqual(["T1", "T2", "T3"]);
  });

  test("claim is rejected when scope overlaps an in-progress ticket", () => {
    const s = withTickets();
    expect(errorOf(exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, worker("w1")))).toBe("accepted");
    expect(errorOf(exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T2" }, worker("w2")))).toBe(
      "scope of T2 overlaps in-progress ticket T1",
    );
    expect(errorOf(exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T3" }, worker("w3")))).toBe("accepted");
  });

  test("worker bound to a ticket cannot claim another", () => {
    const s = withTickets();
    expect(errorOf(run(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, worker("w1", "T3")))).toBe(
      "worker is bound to ticket T3",
    );
  });

  test("only the assignee can complete a ticket", () => {
    const s = withTickets();
    exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, worker("w1"));
    expect(errorOf(run(s, { cmd: "ticket.done", thread: "001", ticket: "T1", summary: "ok" }, worker("w2")))).toBe(
      "ticket T1 is assigned to w1",
    );
    expect(errorOf(exec(s, { cmd: "ticket.done", thread: "001", ticket: "T1", summary: "ok" }, worker("w1")))).toBe("accepted");
  });

  test("illegal ticket transition is rejected", () => {
    const s = withTickets();
    expect(errorOf(run(s, { cmd: "ticket.done", thread: "001", ticket: "T1", summary: "ok" }, worker("w1")))).toBe(
      "ticket T1 cannot go open → done",
    );
  });

  test("coordinator reopens a blocked ticket", () => {
    const s = withTickets();
    exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, worker("w1"));
    exec(s, { cmd: "ticket.block", thread: "001", ticket: "T1", reason: "need API key" }, worker("w1"));
    expect(errorOf(exec(s, { cmd: "ticket.reopen", thread: "001", ticket: "T1" }, COORD))).toBe("accepted");
    expect(s.threads.get("001")!.tickets[0]!.status).toBe("open");
  });

  test("unknown ticket is rejected", () => {
    expect(errorOf(run(withTickets(), { cmd: "ticket.claim", thread: "001", ticket: "T9" }, worker("w1")))).toBe(
      "unknown ticket T9 in thread 001",
    );
  });
});

describe("thread.status", () => {
  test("illegal transition is rejected", () => {
    expect(errorOf(run(stateOf(INIT, threadCreated("001")), { cmd: "thread.status", thread: "001", status: "done" }))).toBe(
      "thread 001 cannot go open → done",
    );
  });

  test("done unblocks dependents whose dependencies are all done", () => {
    const s = stateOf(
      INIT,
      threadCreated("001", { status: "review" }),
      threadCreated("002", { status: "blocked", dependsOn: ["001"] }),
    );
    const r = exec(s, { cmd: "thread.status", thread: "001", status: "done" });
    expect(r.ok && r.events.map((e) => [e.thread, e.type])).toEqual([
      ["001", "thread.status_changed"],
      ["002", "thread.status_changed"],
    ]);
    expect(s.threads.get("002")!.status).toBe("open");
  });

  test("cannot open a thread whose dependencies are unfinished", () => {
    const s = stateOf(INIT, threadCreated("001"), threadCreated("002", { status: "blocked", dependsOn: ["001"] }));
    expect(errorOf(run(s, { cmd: "thread.status", thread: "002", status: "open" }))).toBe(
      "thread 002 has unfinished dependencies: 001",
    );
  });
});

describe("handoff", () => {
  test("rejects a handoff with missing sections", () => {
    const r = run(stateOf(INIT, threadCreated("001")), { cmd: "handoff", thread: "001", content: "## Goal status\nok" }, COORD);
    expect(errorOf(r)).toBe("handoff missing sections: Work done, Decisions, Next steps, Risks");
  });
});
