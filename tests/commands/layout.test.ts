import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { handle, type HandleResult } from "../../src/commands/handler.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import type { Actor, EventBody, Layout } from "../../src/domain/types.ts";
import { INIT, USER, stateOf, threadCreated } from "../helpers.ts";

const LAYOUT: Layout = { workspace: "w7", mainTab: "w7:t1", managerPane: "w7:p1", loggerPane: "w7:p2", herdrBin: "/bin/herdr" };
const REGISTERED: EventBody = { type: "layout.registered", payload: LAYOUT };

function run(bodies: EventBody[], cmd: unknown, actor: Actor = USER, config = DEFAULT_CONFIG): HandleResult {
  return handle(stateOf(...bodies), CommandSchema.parse(cmd), actor, { root: "/repo", config });
}

describe("layout.register", () => {
  test("emits layout.registered and the projection stores it", () => {
    const r = run([INIT], { cmd: "layout.register", ...LAYOUT });
    expect(r).toEqual({ ok: true, events: [REGISTERED], effects: [], result: null, actor: { ...USER, via: "command" } });
    expect(stateOf(INIT, REGISTERED).layout).toEqual(LAYOUT);
  });

  test("is user-only and validates herdr ids", () => {
    const r = run([INIT], { cmd: "layout.register", ...LAYOUT }, { role: "main" });
    expect(r.ok ? "accepted" : r.error).toBe("role main may not run layout.register");
    expect(() => CommandSchema.parse({ cmd: "layout.register", ...LAYOUT, mainTab: "w7 t1" })).toThrow("invalid herdr id");
  });
});

describe("thread.new with and without a layout", () => {
  test("no layout: only the worktree effect", () => {
    const r = run([INIT], { cmd: "thread.new", title: "Fix race", type: "bug" });
    expect(r.ok && r.effects.map((e) => e.kind)).toEqual(["git.worktree.add"]);
  });

  test("with a layout: worktree, then tab ensure labelled <id>-<slug> in the worktree", () => {
    const r = run([INIT, REGISTERED], { cmd: "thread.new", title: "Fix race", type: "bug" });
    expect(r.ok && r.effects).toEqual([
      { kind: "git.worktree.add", branch: "thread/001-fix-race", path: "/repo/.worktrees/001-fix-race", thread: { id: "001", title: "Fix race", slug: "fix-race" } },
      { kind: "herdr.tab.ensure", thread: "001", label: "001-fix-race", cwd: "/repo/.worktrees/001-fix-race", env: expect.objectContaining({ AGT_THREAD: "001", AGT_ROLE: "coordinator", AGT_AGENT: "claude-code" }) },
    ]);
  });
});

describe("thread.status done", () => {
  const opened: EventBody = { type: "thread.tab_opened", thread: "001", payload: { tab: "w7:t3", rootPane: "w7:p5" } };

  test("closes the tab when configured", () => {
    const r = run([INIT, REGISTERED, threadCreated("001", { status: "review" }), opened], {
      cmd: "thread.status",
      thread: "001",
      status: "done",
    });
    expect(r.ok && r.effects).toEqual([{ kind: "herdr.tab.close", thread: "001", tab: "w7:t3" }]);
  });

  test("keeps the tab when close_tab_on_done is false", () => {
    const config = { ...DEFAULT_CONFIG, herdr: { ...DEFAULT_CONFIG.herdr, close_tab_on_done: false } };
    const r = run(
      [INIT, REGISTERED, threadCreated("001", { status: "review" }), opened],
      { cmd: "thread.status", thread: "001", status: "done" },
      USER,
      config,
    );
    expect(r.ok && r.effects).toEqual([]);
  });

  test("no tab, no close effect", () => {
    const r = run([INIT, threadCreated("001", { status: "review" })], { cmd: "thread.status", thread: "001", status: "done" });
    expect(r.ok && r.effects).toEqual([]);
  });
});

describe("layout.reconcile", () => {
  test("ensures a tab for every thread that is not done, passing known tab ids", () => {
    const r = run(
      [
        INIT,
        REGISTERED,
        threadCreated("001"),
        { type: "thread.tab_opened", thread: "001", payload: { tab: "w7:t3", rootPane: "w7:p5" } },
        threadCreated("002", { status: "done" }),
        threadCreated("003", { status: "blocked", dependsOn: ["001"] }),
      ],
      { cmd: "layout.reconcile" },
    );
    expect(r.ok && r.result).toEqual({ threads: 2 });
    expect(r.ok && r.effects.filter((e) => e.kind === "herdr.tab.ensure")).toEqual([
      { kind: "herdr.tab.ensure", thread: "001", label: "001-thread-001", cwd: "/repo/.worktrees/001-thread-001", env: expect.objectContaining({ AGT_THREAD: "001" }), tab: "w7:t3" },
      { kind: "herdr.tab.ensure", thread: "003", label: "003-thread-003", cwd: "/repo/.worktrees/003-thread-003", env: expect.objectContaining({ AGT_THREAD: "003" }) },
    ]);
  });

  test("closes tabs of done threads that still have one, when configured", () => {
    const bodies: EventBody[] = [
      INIT,
      REGISTERED,
      threadCreated("001"),
      threadCreated("002", { status: "done" }),
      { type: "thread.tab_opened", thread: "002", payload: { tab: "w7:t4", rootPane: "w7:p6" } },
    ];
    const r = run(bodies, { cmd: "layout.reconcile" });
    expect(r.ok && r.result).toEqual({ threads: 1 });
    expect(r.ok && r.effects.map((e) => e.kind)).toEqual(["herdr.tab.ensure", "herdr.tab.close"]);
    expect(r.ok && r.effects[1]).toEqual({ kind: "herdr.tab.close", thread: "002", tab: "w7:t4" });
    const config = { ...DEFAULT_CONFIG, herdr: { ...DEFAULT_CONFIG.herdr, close_tab_on_done: false } };
    const off = run(bodies, { cmd: "layout.reconcile" }, USER, config);
    expect(off.ok && off.effects.map((e) => e.kind)).toEqual(["herdr.tab.ensure"]);
  });

  test("rejects without a layout", () => {
    const r = run([INIT], { cmd: "layout.reconcile" });
    expect(r.ok ? "accepted" : r.error).toBe("no Herdr layout registered; run `agt start`");
  });
});

test("tab events update the projection and the log", () => {
  const s = stateOf(
    INIT,
    threadCreated("001"),
    { type: "thread.tab_opened", thread: "001", payload: { tab: "w7:t3", rootPane: "w7:p5" } },
  );
  expect(s.threads.get("001")).toMatchObject({ tab: "w7:t3", rootPane: "w7:p5" });
  const closed = stateOf(
    INIT,
    threadCreated("001"),
    { type: "thread.tab_opened", thread: "001", payload: { tab: "w7:t3", rootPane: "w7:p5" } },
    { type: "thread.tab_closed", thread: "001", payload: { tab: "w7:t3" } },
  ).threads.get("001")!;
  expect(closed.tab).toBeUndefined();
  expect(closed.rootPane).toBeUndefined();
  expect(closed.log.map((e) => e.message).slice(-2)).toEqual(["herdr tab w7:t3 opened", "herdr tab w7:t3 closed"]);
});

test("reconcile probes live coordinator and worker panes after tab effects", () => {
  const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const r = run(
    [
      INIT,
      REGISTERED,
      threadCreated("001"),
      { type: "thread.tab_opened", thread: "001", payload: { tab: "w7:t3", rootPane: "w7:p5" } },
      { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } },
      { type: "session.attached", thread: "001", payload: { session: C, pane: "w7:p5" } },
    ],
    { cmd: "layout.reconcile" },
  );
  expect(r.ok && r.effects.map((e) => e.kind)).toEqual(["herdr.tab.ensure", "session.probe"]);
  expect(r.ok && r.effects[1]).toEqual({ kind: "session.probe", session: C, thread: "001", pane: "w7:p5" });
});

test("reconcile does not probe main, non-live or pane-less sessions", () => {
  const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const W = "11111111-1111-4111-8111-111111111111";
  const W2 = "22222222-2222-4222-8222-222222222222";
  const M = "33333333-3333-4333-8333-333333333333";
  const r = run(
    [
      INIT,
      REGISTERED,
      threadCreated("001"),
      { type: "thread.tab_opened", thread: "001", payload: { tab: "w7:t3", rootPane: "w7:p5" } },
      { type: "session.created", payload: { session: M, role: "main", agent: "claude-code", name: "m" } },
      { type: "session.attached", payload: { session: M, pane: "w7:p1" } },
      { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } },
      { type: "session.created", thread: "001", payload: { session: W, role: "worker", agent: "claude-code", name: "w", ticket: "T1" } },
      { type: "session.attached", thread: "001", payload: { session: W, pane: "w7:p6" } },
      { type: "session.ended", thread: "001", payload: { session: W } },
      { type: "session.created", thread: "001", payload: { session: W2, role: "worker", agent: "claude-code", name: "w2", ticket: "T2" } },
      { type: "session.attached", thread: "001", payload: { session: W2, pane: "w7:p7" } },
    ],
    { cmd: "layout.reconcile" },
  );
  expect(r.ok && r.effects.filter((e) => e.kind === "session.probe")).toEqual([{ kind: "session.probe", session: W2, thread: "001", pane: "w7:p7" }]);
});

describe("layout.reconcile recovers threads without a live coordinator", () => {
  const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const NEW = "00000000-0000-4000-8000-000000000001";
  const opened: EventBody = { type: "thread.tab_opened", thread: "001", payload: { tab: "w7:t3", rootPane: "w7:p5" } };
  const created: EventBody = { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } };
  const attached: EventBody = { type: "session.attached", thread: "001", payload: { session: C, pane: "w7:p5" } };
  const reconcile = (...bodies: EventBody[]) =>
    handle(stateOf(INIT, REGISTERED, ...bodies), CommandSchema.parse({ cmd: "layout.reconcile" }), USER, { root: "/repo", config: DEFAULT_CONFIG, newId: () => NEW });

  test("an ended coordinator is reported lost (so the reactor replaces it), after the tab effects", () => {
    const r = reconcile(threadCreated("001"), opened, created, attached, { type: "session.ended", thread: "001", payload: { session: C } });
    expect(r.ok && r.events).toEqual([{ type: "session.lost", thread: "001", payload: { session: C, reason: "coordinator exited" } }]);
    expect(r.ok && r.effects.map((e) => e.kind)).toEqual(["herdr.tab.ensure"]);
    // the projection lets the loss apply to the ended coordinator
    const s = stateOf(INIT, threadCreated("001"), opened, created, attached, { type: "session.ended", thread: "001", payload: { session: C } }, ...(r.ok ? r.events : []));
    expect(s.sessions.get(C)!.status).toBe("lost");
  });

  test("a failed coordinator is replaced by a split from the root pane, carrying its notices", () => {
    const r = reconcile(
      threadCreated("001"),
      opened,
      created,
      { type: "notice.queued", thread: "001", payload: { session: C, text: "Ticket T1 is done." } },
      { type: "session.failed", thread: "001", payload: { session: C, reason: "boom" } },
    );
    expect(r.ok && r.events).toEqual([
      { type: "session.created", thread: "001", payload: { session: NEW, role: "coordinator", agent: "claude-code", name: expect.any(String), replaces: C, retirePane: "w7:p5" } },
      { type: "notice.queued", thread: "001", payload: { session: NEW, text: "Ticket T1 is done." } },
    ]);
    expect(r.ok && r.effects.map((e) => e.kind)).toEqual(["herdr.tab.ensure", "agent.spawn"]);
    expect(r.ok && r.effects[1]).toMatchObject({ kind: "agent.spawn", session: NEW, role: "coordinator", splitFrom: "w7:p5", bootstrap: "start" });
  });

  test("a failed coordinator with a recorded handoff is replaced with the handoff bootstrap", () => {
    const r = reconcile(
      threadCreated("001"),
      opened,
      created,
      { type: "handoff.submitted", thread: "001", payload: { content: "h", generated: true } },
      { type: "session.failed", thread: "001", payload: { session: C, reason: "boom" } },
    );
    expect(r.ok && r.effects[1]).toMatchObject({ kind: "agent.spawn", splitFrom: "w7:p5", bootstrap: "handoff" });
  });

  test("a thread with a tab and no coordinator session gets a fresh one split from the root pane", () => {
    const r = reconcile(threadCreated("001"), opened);
    expect(r.ok && r.events).toEqual([
      { type: "session.created", thread: "001", payload: { session: NEW, role: "coordinator", agent: "claude-code", name: expect.any(String), retirePane: "w7:p5" } },
    ]);
    expect(r.ok && r.effects[1]).toMatchObject({ kind: "agent.spawn", session: NEW, splitFrom: "w7:p5", bootstrap: "start" });
  });

  test("nothing when a live coordinator exists, the thread is done, or it has no root pane", () => {
    const live = reconcile(threadCreated("001"), opened, created, attached);
    expect(live.ok && live.events).toEqual([]);
    expect(live.ok && live.effects.map((e) => e.kind)).toEqual(["herdr.tab.ensure", "session.probe"]);
    const done = reconcile(threadCreated("001", { status: "done" }), opened, created, attached, { type: "session.ended", thread: "001", payload: { session: C } });
    expect(done.ok && done.events).toEqual([]);
    expect(done.ok && done.effects.filter((e) => e.kind === "agent.spawn")).toEqual([]);
    const noTab = reconcile(threadCreated("001"));
    expect(noTab.ok && noTab.events).toEqual([]);
  });
});
