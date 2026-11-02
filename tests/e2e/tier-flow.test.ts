import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { request } from "../../src/daemon/client.ts";
import { initProject } from "../../src/project/init.ts";
import { paths } from "../../src/project/paths.ts";
import { FAKE_CLAUDE, FAKE_HERDR, fakeHerdrState, isolatedConfigHome, tempRepo, waitFor, SPAWN_TEST_ENV } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");
const M = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
let root: string;
let fake: ReturnType<typeof fakeHerdrState>;
const xdg = isolatedConfigHome();

function agt(args: string[], extra: Record<string, string> = {}) {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "", HOME: "/nonexistent", XDG_CONFIG_HOME: xdg, AGT_ROOT: root, FAKE_HERDR_STATE: fake.file, ...SPAWN_TEST_ENV,
      HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t0", HERDR_PANE_ID: "w1:p0", HERDR_BIN_PATH: FAKE_HERDR,
      AGT_CLAUDE_BIN: FAKE_CLAUDE, AGT_OPENCODE_BIN: "/nonexistent/opencode", AGT_CODEX_BIN: "/nonexistent/codex", AGT_OMP_BIN: "/nonexistent/omp",
      ...extra,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`agt ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function setup(timeout: string) {
  root = tempRepo();
  initProject(root, "tiers");
  writeFileSync(
    join(root, ".agentthread", "config.yaml"),
    `herdr:\n  poll_interval: 100ms\nagents:\n  complexity:\n    timeout: ${timeout}\n    tiers:\n      big: { agent: opencode, model: p/m }\n`,
  );
  fake = fakeHerdrState({ tabs: ["w1:t0"], panes: ["w1:p0"] });
}

afterEach(() => {
  try {
    agt(["daemon", "stop"]);
  } catch {
    // never started
  }
});

type Fm = { sessions: { id: string; role: string; status: string; pane?: string }[] };
const subDir = () => join(root, ".agentthread/threads/001-login");
const coordinator = () => {
  const fm = parse(readFileSync(join(subDir(), "sub.thread.md"), "utf8").split("---\n")[1]!) as Fm;
  return fm.sessions.find((s) => s.role === "coordinator" && s.pane);
};
const tabCreates = () => fake.read().calls.filter((x) => x[0] === "tab" && x[1] === "create").length;
const MAIN = { AGT_ROLE: "main", AGT_SESSION: M };

test("main is idle: the proposed tier auto-accepts after the timeout and its coordinator spawns", async () => {
  setup("1s");
  agt(["start", "--no-manager"]);
  const opened = await request(paths(root).socket, { op: "command", command: { cmd: "session.open_main", session: M, pane: "w1:p0" }, actor: { role: "user" } });
  expect(opened.ok).toBe(true);
  agt(["event", "started"], MAIN);
  const tabsBefore = tabCreates();
  const t0 = Date.now();
  agt(["thread", "new", "Login", "--type", "feature", "--tier", "big", "--reason", "touches auth"], MAIN);
  expect(tabCreates()).toBe(tabsBefore);

  const c = await waitFor(() => coordinator(), 3_000);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(1_000);
  expect(fake.read().kinds).toEqual({ [c.pane!]: "opencode" });
  expect(readFileSync(join(subDir(), "brief.md"), "utf8")).toContain("Tier: big (opencode p/m default), chosen by auto: touches auth");
  const prompts = await waitFor(() => fake.read().calls.filter((x) => x[0] === "agent" && x[1] === "prompt" && x[2] === "w1:p0").map((x) => x[3]).filter(Boolean));
  expect(prompts).toContain("Thread 001 started with tier big (opencode p/m default) after 1s without a choice.");
  expect(() => agt(["thread", "choose", "001", "--tier", "big"], MAIN)).toThrow("thread 001 is not waiting for a tier");
}, 20_000);

test("a proposed thread gets no tab on a daemon restart or reconcile; choose starts it; cancel ends one", async () => {
  setup("1h");
  agt(["start", "--no-manager"]);
  agt(["thread", "new", "Login", "--type", "feature", "--tier", "big", "--reason", "r"]);
  agt(["thread", "new", "Other", "--type", "chore", "--tier", "big", "--reason", "r"]);
  agt(["daemon", "stop"]);
  agt(["daemon", "start"]);
  agt(["start", "--no-manager"]);
  await Bun.sleep(400);
  expect(tabCreates()).toBe(0);

  agt(["thread", "cancel", "002"]);
  agt(["thread", "choose", "001", "--tier", "big"]);
  const c = await waitFor(() => coordinator(), 5_000);
  expect(fake.read().kinds).toEqual({ [c.pane!]: "opencode" });
  expect(tabCreates()).toBe(1);
  expect(readFileSync(join(subDir(), "brief.md"), "utf8")).toContain("Tier: big (opencode p/m default), chosen by user: r");
  expect(readFileSync(join(root, ".agentthread/threads/002-other/sub.thread.md"), "utf8")).toContain("status: done");
}, 30_000);

test("a running timer survives a daemon restart: an overdue proposal fires on the first tick after it", async () => {
  setup("1s");
  agt(["start", "--no-manager"]);
  agt(["thread", "new", "Login", "--type", "feature", "--tier", "big", "--reason", "r"]);
  agt(["daemon", "stop"]);
  await Bun.sleep(1_200);
  expect(tabCreates()).toBe(0);
  agt(["daemon", "start"]);
  const c = await waitFor(() => coordinator(), 1_500);
  expect(fake.read().kinds).toEqual({ [c.pane!]: "opencode" });
  expect(readFileSync(join(subDir(), "brief.md"), "utf8")).toContain("chosen by auto: r");
}, 20_000);

test("the CLI requires --reason with --tier, and --tier with --reason", () => {
  setup("1h");
  const r = (args: string[]) => Bun.spawnSync([process.execPath, BIN, ...args], { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", XDG_CONFIG_HOME: xdg, AGT_ROOT: root }, stdout: "pipe", stderr: "pipe" });
  const noReason = r(["thread", "new", "Login", "--type", "feature", "--tier", "big"]);
  expect(noReason.exitCode).toBe(2);
  expect(noReason.stderr.toString()).toContain('--tier needs --reason "<why>"');
  const noTier = r(["thread", "new", "Login", "--type", "feature", "--reason", "x"]);
  expect(noTier.exitCode).toBe(2);
  expect(noTier.stderr.toString()).toContain("--reason needs --tier");
});
