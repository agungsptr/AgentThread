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
    ...extra,
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
