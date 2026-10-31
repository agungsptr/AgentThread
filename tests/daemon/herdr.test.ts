import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGT_BIN } from "../../src/agents/claude.ts";
import { parse } from "yaml";
import { request } from "../../src/daemon/client.ts";
import { startDaemon, type Daemon } from "../../src/daemon/server.ts";
import type { Actor, StoredEvent } from "../../src/domain/types.ts";
import { initProject } from "../../src/project/init.ts";
import { paths } from "../../src/project/paths.ts";
import { FAKE_HERDR, fakeHerdrState, isolatedConfigHome, tempRepo } from "../helpers.ts";

let root: string;
let daemon: Daemon;
let fake: ReturnType<typeof fakeHerdrState>;
let logged: string[];
const savedEnv = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, FAKE_HERDR_STATE: process.env.FAKE_HERDR_STATE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };

beforeAll(() => {
  process.env.XDG_CONFIG_HOME = isolatedConfigHome();
  process.env.CLAUDE_CONFIG_DIR = "/claude-config";
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(async () => {
  root = tempRepo();
  initProject(root, "demo");
  fake = fakeHerdrState();
  process.env.FAKE_HERDR_STATE = fake.file;
  logged = [];
  daemon = await startDaemon(root, { log: (m) => logged.push(m), launch: () => {} });
});

afterEach(async () => {
  await daemon.stop();
});

const cmd = (command: object, actor: Actor = { role: "user" }) => request(paths(root).socket, { op: "command", command, actor });
const register = (herdrBin = FAKE_HERDR) =>
  cmd({ cmd: "layout.register", workspace: "w1", mainTab: "w1:t0", managerPane: "w1:p0", loggerPane: "w1:p00", herdrBin });
const frontmatter = (dir: string) => parse(readFileSync(join(root, ".agentthread/threads", dir, "sub.thread.md"), "utf8").split("---\n")[1]!);
const events = async () => {
  const r = await request(paths(root).socket, { op: "events.since", seq: 0 });
  return (r.ok ? (r.result as StoredEvent[]) : []).map((e) => e.type);
};

test("layout.get returns null, then the registered layout", async () => {
  expect(await request(paths(root).socket, { op: "layout.get" })).toEqual({ ok: true, result: null });
  await register();
  expect(await request(paths(root).socket, { op: "layout.get" })).toMatchObject({ ok: true, result: { workspace: "w1", mainTab: "w1:t0" } });
});

test("thread.new opens a tab in the thread directory and records it", async () => {
  await register();
  expect(await cmd({ cmd: "thread.new", title: "Fix race", type: "bug" })).toMatchObject({ ok: true });
  const create = fake.read().calls.find((c) => c[0] === "tab" && c[1] === "create")!;
  expect(create).toEqual([
    "tab", "create", "--workspace", "w1", "--cwd", join(root, ".worktrees", "fix-race"), "--label", "001-fix-race", "--no-focus",
    "--env", `AGT_ROOT=${root}`, "--env", "AGT_THREAD=001", "--env", "AGT_ROLE=coordinator",
    "--env", "AGT_AGENT=claude-code", "--env", "CLAUDE_CONFIG_DIR=/claude-config", "--env", `PATH=${dirname(AGT_BIN)}:${process.env.PATH ?? ""}`,
    "--env", `GIT_CEILING_DIRECTORIES=${join(root, ".worktrees")}`,
  ]);
  expect(frontmatter("001-fix-race")).toMatchObject({ tab: "w1:t1" });
  expect(await events()).toEqual(["project.initialized", "layout.registered", "thread.created", "thread.tab_opened", "session.created"]);
});

test("done closes the tab", async () => {
  await register();
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  for (const status of ["in_progress", "review", "done"]) await cmd({ cmd: "thread.status", thread: "001", status });
  expect(fake.read().tabs).toEqual([]);
  expect(frontmatter("001-x")).toMatchObject({ status: "done", tab: null });
  expect(await events()).toContain("thread.tab_closed");
});

test("close_tab_on_done: false keeps the tab", async () => {
  await daemon.stop();
  writeFileSync(join(root, ".agentthread", "config.yaml"), "herdr:\n  close_tab_on_done: false\n");
  daemon = await startDaemon(root, { log: (m) => logged.push(m), launch: () => {} });
  await register();
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  for (const status of ["in_progress", "review", "done"]) await cmd({ cmd: "thread.status", thread: "001", status });
  expect(fake.read().tabs).toEqual(["w1:t1"]);
});

test("herdr failure does not fail the command; reconcile opens the tab later", async () => {
  await register("/nonexistent/herdr");
  const r = await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  expect(r).toMatchObject({ ok: true, result: { thread: "001" } });
  expect(existsSync(join(root, ".worktrees", "x"))).toBe(true);
  expect(frontmatter("001-x")).toMatchObject({ tab: null });
  expect(logged.join("\n")).toMatch(/herdr herdr\.tab\.ensure for thread 001 failed/);

  await register();
  expect(await cmd({ cmd: "layout.reconcile" })).toEqual({ ok: true, result: { threads: 1 } });
  expect(frontmatter("001-x")).toMatchObject({ tab: "w1:t1" });
});

test("reconcile reopens only tabs that were closed by hand", async () => {
  await register();
  await cmd({ cmd: "thread.new", title: "A", type: "bug" });
  await cmd({ cmd: "thread.new", title: "B", type: "bug" });
  fake.update((s) => ({ tabs: s.tabs.filter((t) => t !== "w1:t2") }));
  await cmd({ cmd: "layout.reconcile" });
  expect(fake.read().tabs.sort()).toEqual(["w1:t1", "w1:t3"]);
  expect(fake.read().calls.filter((c) => c[1] === "create")).toHaveLength(3);
  expect(frontmatter("002-b")).toMatchObject({ tab: "w1:t3" });
});

test("an invalid config stops the daemon from starting", async () => {
  await daemon.stop();
  writeFileSync(join(root, ".agentthread", "config.yaml"), "workers:\n  max_workers: 0\n");
  await expect(startDaemon(root)).rejects.toThrow(/invalid config .*workers\.max_workers/);
  writeFileSync(join(root, ".agentthread", "config.yaml"), "");
  daemon = await startDaemon(root, { log: (m) => logged.push(m), launch: () => {} });
});

test("a herdr error other than not-found neither closes nor records the close", async () => {
  await register();
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  fake.update(() => ({ fail: ["tab get"] }));
  for (const status of ["in_progress", "review", "done"]) expect(await cmd({ cmd: "thread.status", thread: "001", status })).toMatchObject({ ok: true });
  expect(fake.read().tabs).toContain("w1:t1");
  expect(frontmatter("001-x")).toMatchObject({ status: "done", tab: "w1:t1" });
  expect(await events()).not.toContain("thread.tab_closed");
  expect(logged.join("\n")).toMatch(/herdr\.tab\.close for thread 001 failed/);
});

test("reconcile does not create a duplicate tab while herdr errors", async () => {
  await register();
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  fake.update(() => ({ fail: ["tab get"] }));
  await cmd({ cmd: "layout.reconcile" });
  expect(fake.read().calls.filter((c) => c[1] === "create")).toHaveLength(1);
});
