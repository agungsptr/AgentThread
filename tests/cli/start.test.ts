import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "../../src/herdr/bridge.ts";
import { initProject } from "../../src/project/init.ts";
import { FAKE_HERDR, fakeHerdrState, isolatedConfigHome, tempRepo } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");

let root: string;
let fake: ReturnType<typeof fakeHerdrState>;
let xdg: string;

function agt(args: string[], extra: Record<string, string> = {}, opts: { herdr?: boolean } = {}) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: "/nonexistent",
    XDG_CONFIG_HOME: xdg,
    AGT_ROOT: root,
    FAKE_HERDR_STATE: fake.file,
  };
  if (opts.herdr !== false) {
    Object.assign(env, {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t0",
      HERDR_PANE_ID: "w1:p0",
      HERDR_BIN_PATH: FAKE_HERDR,
      HERDR_SOCKET_PATH: "/tmp/fake-herdr.sock",
    });
  }
  Object.assign(env, extra);
  const r = Bun.spawnSync([process.execPath, BIN, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

beforeEach(() => {
  const parent = tempRepo();
  // A project root with a space and a quote exercises the logger command's shell quoting.
  root = join(parent, "my 'proj'");
  mkdirSync(root);
  Bun.spawnSync(["git", "-C", root, "init", "-q", "-b", "main"]);
  Bun.spawnSync(["git", "-C", root, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init"]);
  initProject(root, "demo");
  fake = fakeHerdrState({ tabs: ["w1:t0"], panes: ["w1:p0"] });
  xdg = isolatedConfigHome();
});

afterEach(() => {
  agt(["daemon", "stop"]);
});

test("refuses to run outside Herdr", () => {
  expect(agt(["start"], {}, { herdr: false })).toMatchObject({ code: 1, err: "agt: agt start must run inside a Herdr pane" });
});

test("builds the main tab: rename, split a logger running agt logs -f, register, reconcile", () => {
  const r = agt(["start"]);
  expect(r.code).toBe(0);
  expect(r.out.split("\n")).toEqual([
    "main tab w1:t0: main manager w1:p0, logger w1:p1",
    "subthread tabs reconciled (0 open threads)",
  ]);
  const calls = fake.read().calls;
  expect(calls.slice(0, 5)).toEqual([
    ["tab", "rename", "w1:t0", "main"],
    ["pane", "rename", "w1:p0", "main manager"],
    ["pane", "split", "w1:p0", "--direction", "right", "--cwd", root, "--no-focus", "--env", `AGT_ROOT=${root}`],
    ["pane", "rename", "w1:p1", "logger"],
    ["pane", "run", "w1:p1", `${shellQuote(process.execPath)} ${shellQuote(BIN)} logs -f`],
  ]);
});

test("a second start keeps the existing layout", () => {
  agt(["start"]);
  const before = fake.read().calls.length;
  const r = agt(["start"]);
  expect(r.out.split("\n")[0]).toBe("layout already set up (main tab w1:t0)");
  const after = fake.read().calls.slice(before);
  expect(after).toEqual([["tab", "get", "w1:t0"]]);
});

test("uses the configured main tab label", () => {
  mkdirSync(join(xdg, "agentthread"), { recursive: true });
  writeFileSync(join(xdg, "agentthread", "config.yaml"), "herdr:\n  main_tab_label: home\n");
  agt(["start"]);
  expect(fake.read().calls[0]).toEqual(["tab", "rename", "w1:t0", "home"]);
});

test("subthreads created after start get their own tab", () => {
  agt(["start"]);
  expect(JSON.parse(agt(["thread", "new", "Fix", "--type", "bug"]).out)).toMatchObject({ thread: "001" });
  expect(fake.read().tabs).toEqual(["w1:t0", "w1:t2"]);
});

test("refuses to run from a subthread pane and touches nothing in Herdr", () => {
  const r = agt(["start"], { AGT_ROLE: "coordinator", AGT_THREAD: "001" });
  expect(r).toMatchObject({ code: 1, err: "agt: agt start must run from the main tab, not a subthread pane" });
  expect(fake.read().calls).toEqual([]);
  expect(agt(["start"], { AGT_ROLE: "worker" }).code).toBe(1);
  expect(fake.read().calls).toEqual([]);
});

test("runs from a pane whose AGT_ROLE is main", () => {
  expect(agt(["start"], { AGT_ROLE: "main" }).code).toBe(0);
});

test("the daemon's herdr calls carry HERDR_SOCKET_PATH", () => {
  agt(["start"]);
  agt(["thread", "new", "Fix", "--type", "bug"]);
  const s = fake.read();
  const i = s.calls.findIndex((c) => c[0] === "tab" && c[1] === "create");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(s.envs[i]).toBe("/tmp/fake-herdr.sock");
});

test("rebuilds a stale layout after Herdr restarted with a new main tab", () => {
  agt(["start"]);
  const stale = fake.read();
  writeFileSync(fake.file, JSON.stringify({ ...stale, tabs: ["w1:t9"], panes: ["w1:p9"], calls: [] }));
  const r = agt(["start"], { HERDR_TAB_ID: "w1:t9", HERDR_PANE_ID: "w1:p9" });
  expect(r.code).toBe(0);
  const calls = fake.read().calls;
  expect(calls.filter((c) => c[0] === "tab" && c[1] === "rename")).toEqual([["tab", "rename", "w1:t9", "main"]]);
  expect(calls.filter((c) => c[0] === "pane" && c[1] === "split")).toHaveLength(1);
  expect(r.out.split("\n")[0]).toMatch(/^main tab w1:t9: main manager w1:p9, logger /);
  // the new layout is registered: a third start sees it and leaves Herdr alone
  const again = agt(["start"], { HERDR_TAB_ID: "w1:t9", HERDR_PANE_ID: "w1:p9" });
  expect(again.out.split("\n")[0]).toBe("layout already set up (main tab w1:t9)");
});

test("the daemon runs in its own session, not the caller's", () => {
  expect(agt(["daemon", "start"]).out).toBe("daemon started");
  const pid = /pid (\d+)/.exec(agt(["daemon", "status"]).out)![1]!;
  const ps = (p: string | number) => Bun.spawnSync(["ps", "-o", "pgid=,sess=", "-p", String(p)]).stdout.toString().trim();
  const daemonPgid = ps(pid).split(/\s+/)[0];
  expect(daemonPgid).toBe(pid);
  expect(daemonPgid).not.toBe(String(Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(process.pid)]).stdout.toString().trim()));
});
