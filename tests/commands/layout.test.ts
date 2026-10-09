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
    expect(r).toEqual({ ok: true, events: [REGISTERED], effects: [], result: null });
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
      { kind: "git.worktree.add", branch: "thread/001-fix-race", path: "/repo/.worktrees/001-fix-race" },
      { kind: "herdr.tab.ensure", thread: "001", label: "001-fix-race", cwd: "/repo/.worktrees/001-fix-race" },
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
    expect(r.ok && r.effects).toEqual([
      { kind: "herdr.tab.ensure", thread: "001", label: "001-thread-001", cwd: "/repo/.worktrees/001-thread-001", tab: "w7:t3" },
      { kind: "herdr.tab.ensure", thread: "003", label: "003-thread-003", cwd: "/repo/.worktrees/003-thread-003" },
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
