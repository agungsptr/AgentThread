import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { systemPrompt } from "../../src/agents/prompts.ts";
import { shellQuote } from "../../src/herdr/bridge.ts";
import { initProject } from "../../src/project/init.ts";
import { FAKE_AGENT, FAKE_HERDR, fakeHerdrState, isolatedConfigHome, loggerStandIn, tempRepo, SPAWN_TEST_ENV } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");

let root: string;
let fake: ReturnType<typeof fakeHerdrState>;
let xdg: string;

function agt(args: string[], extra: Record<string, string> = {}, opts: { herdr?: boolean; stdin?: string } = {}) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: "/nonexistent",
    XDG_CONFIG_HOME: xdg,
    AGT_ROOT: root,
    ...SPAWN_TEST_ENV,
    FAKE_HERDR_STATE: fake.file,
    // never the real agent binaries
    AGT_CLAUDE_BIN: "/nonexistent/claude",
    AGT_OPENCODE_BIN: "/nonexistent/opencode",
    AGT_CODEX_BIN: "/nonexistent/codex",
    AGT_OMP_BIN: "/nonexistent/omp",
    AGT_AGY_BIN: "/nonexistent/agy",
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
  const r = Bun.spawnSync([process.execPath, BIN, ...args], { cwd: root, env, stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin), stdout: "pipe", stderr: "pipe" });
  // The claude-code account info line (covered by its own tests) is dropped from out.
  const out = r.stdout.toString().trim().split("\n").filter((l) => !l.startsWith("claude-code agents use ")).join("\n");
  return { code: r.exitCode, out, err: r.stderr.toString().trim(), raw: r.stdout.toString().trim() };
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
  expect(agt(["start", "--no-manager"], {}, { herdr: false })).toMatchObject({ code: 1, err: "agt: agt start must run inside a Herdr pane" });
});

test("builds the main tab: rename, split a logger running agt logs -f, register, reconcile", () => {
  const r = agt(["start", "--no-manager"]);
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
  agt(["start", "--no-manager"]);
  const before = fake.read().calls.length;
  const r = agt(["start", "--no-manager"]);
  expect(r.out.split("\n")[0]).toBe("layout already set up (main tab w1:t0)");
  const after = fake.read().calls.slice(before);
  expect(after.slice(0, 2)).toEqual([["tab", "get", "w1:t0"], ["pane", "get", "w1:p1"]]);
});

const LOGGER_CMD = () => `${shellQuote(process.execPath)} ${shellQuote(BIN)} logs -f`;

test("a second start recreates a missing logger pane", () => {
  agt(["start", "--no-manager"]);
  fake.update((s) => ({ panes: s.panes.filter((p) => p !== "w1:p1"), calls: [] }));
  const r = agt(["start", "--no-manager"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("logger pane was gone; recreated it as w1:p2");
  const calls = fake.read().calls;
  expect(calls.filter((c) => c[1] === "split")).toEqual([["pane", "split", "w1:p0", "--direction", "right", "--cwd", root, "--no-focus", "--env", `AGT_ROOT=${root}`]]);
  expect(calls).toContainEqual(["pane", "rename", "w1:p2", "logger"]);
  expect(calls).toContainEqual(["pane", "run", "w1:p2", LOGGER_CMD()]);
  // the new pane is the registered one: the next start finds it and its (stub) process
  writeFileSync(join(root, ".agentthread", "logger.pid"), String(loggerStandIn()));
  fake.update(() => ({ calls: [] }));
  agt(["start", "--no-manager"]);
  expect(fake.read().calls.filter((c) => c[1] === "split" || c[1] === "run")).toEqual([]);
});

test("a second start re-runs the logger command when its process ended", () => {
  agt(["start", "--no-manager"]);
  fake.update(() => ({ calls: [] }));
  // no live logger pid: the pane exists but nothing runs in it
  const r = agt(["start", "--no-manager"]);
  expect(r.out).toContain("logger pane w1:p1 was not running; restarted it");
  expect(fake.read().calls.filter((c) => c[1] === "run")).toEqual([["pane", "run", "w1:p1", LOGGER_CMD()]]);
  expect(fake.read().calls.filter((c) => c[1] === "split")).toEqual([]);
});

test("a second start leaves a running logger alone", () => {
  agt(["start", "--no-manager"]);
  writeFileSync(join(root, ".agentthread", "logger.pid"), String(loggerStandIn()));
  fake.update(() => ({ calls: [] }));
  agt(["start", "--no-manager"]);
  expect(fake.read().calls.filter((c) => c[1] === "run" || c[1] === "split")).toEqual([]);
});

test("uses the configured main tab label", () => {
  mkdirSync(join(xdg, "agentthread"), { recursive: true });
  writeFileSync(join(xdg, "agentthread", "config.yaml"), "herdr:\n  main_tab_label: home\n");
  agt(["start", "--no-manager"]);
  expect(fake.read().calls[0]).toEqual(["tab", "rename", "w1:t0", "home"]);
});

test("subthreads created after start get their own tab", () => {
  agt(["start", "--no-manager"]);
  expect(JSON.parse(agt(["thread", "new", "Fix", "--type", "bug"]).out)).toMatchObject({ thread: "001" });
  expect(fake.read().tabs).toEqual(["w1:t0", "w1:t2"]);
});

test("refuses to run from a subthread pane and touches nothing in Herdr", () => {
  const r = agt(["start", "--no-manager"], { AGT_ROLE: "coordinator", AGT_THREAD: "001" });
  expect(r).toMatchObject({ code: 1, err: "agt: agt start must run from the main tab, not a subthread pane" });
  expect(fake.read().calls).toEqual([]);
  expect(agt(["start", "--no-manager"], { AGT_ROLE: "worker" }).code).toBe(1);
  expect(agt(["start", "--no-manager"], { AGT_ROLE: "main" })).toMatchObject({ code: 1, err: "agt: agt start must run from the main tab, not a subthread pane" });
  expect(fake.read().calls).toEqual([]);
});

test("the daemon's herdr calls carry HERDR_SOCKET_PATH", () => {
  agt(["start", "--no-manager"]);
  agt(["thread", "new", "Fix", "--type", "bug"]);
  const s = fake.read();
  const i = s.calls.findIndex((c) => c[0] === "tab" && c[1] === "create");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(s.envs[i]).toBe("/tmp/fake-herdr.sock");
});

test("rebuilds a stale layout after Herdr restarted with a new main tab", () => {
  agt(["start", "--no-manager"]);
  fake.update(() => ({ tabs: ["w1:t9"], panes: ["w1:p9"], calls: [] }));
  const r = agt(["start", "--no-manager"], { HERDR_TAB_ID: "w1:t9", HERDR_PANE_ID: "w1:p9" });
  expect(r.code).toBe(0);
  const calls = fake.read().calls;
  expect(calls.filter((c) => c[0] === "tab" && c[1] === "rename")).toEqual([["tab", "rename", "w1:t9", "main"]]);
  expect(calls.filter((c) => c[0] === "pane" && c[1] === "split")).toHaveLength(1);
  expect(r.out.split("\n")[0]).toMatch(/^main tab w1:t9: main manager w1:p9, logger /);
  // the new layout is registered: a third start sees it and leaves Herdr alone
  const again = agt(["start", "--no-manager"], { HERDR_TAB_ID: "w1:t9", HERDR_PANE_ID: "w1:p9" });
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

test("agt start launches main with adapterFor(roles.main)", () => {
  writeFileSync(join(root, ".agentthread", "config.yaml"), "agents:\n  roles:\n    main: { agent: opencode }\n");
  const log = join(xdg, "agent.jsonl");
  const r = agt(["start"], { AGT_OPENCODE_BIN: FAKE_AGENT, FAKE_AGENT_LOG: log, AGT_CLAUDE_BIN: "/nonexistent/claude" });
  expect(r.code).toBe(0);
  const run = JSON.parse(readFileSync(log, "utf8").trim()) as { argv: string[]; cwd: string; env: Record<string, string> };
  expect(run.argv).toEqual(["--standalone", "--auto", "--prompt", systemPrompt({ root, role: "main", config: DEFAULT_CONFIG })]);
  expect(realpathSync(run.cwd)).toBe(realpathSync(root));
  expect(run.env).toMatchObject({ AGT_ROLE: "main", AGT_AGENT: "opencode", AGT_AGENT_PROCESS: "1" });
  expect(JSON.parse(run.env.OPENCODE_CONFIG_CONTENT!)).toMatchObject({ permission: { "*": "allow" } });
}, 15_000);

test("the AGT_<AGENT>_BIN override applies to codex and omp main launches", () => {
  for (const [agent, key] of [["codex", "AGT_CODEX_BIN"], ["omp", "AGT_OMP_BIN"]] as const) {
    writeFileSync(join(root, ".agentthread", "config.yaml"), `agents:\n  roles:\n    main: { agent: ${agent} }\n`);
    const log = join(xdg, `${agent}.jsonl`);
    expect(agt(["start"], { [key]: FAKE_AGENT, FAKE_AGENT_LOG: log }).code).toBe(0);
    const run = JSON.parse(readFileSync(log, "utf8").trim()) as { argv: string[] };
    expect(run.argv.at(-1)).toBe(systemPrompt({ root, role: "main", config: DEFAULT_CONFIG }));
  }
}, 15_000);

test("agt start prints configWarnings once to stderr", () => {
  writeFileSync(join(root, ".agentthread", "config.yaml"), "agents:\n  claude:\n    extra_allowed_tools: [\"Bash(x)\"]\n");
  const r = agt(["start", "--no-manager"]);
  expect(r.code).toBe(0);
  expect(r.err.split("\n").filter((l) => l.includes("ignored"))).toEqual(["agt: warning: agents.claude.permission_mode/extra_allowed_tools are ignored while agents.autonomous is true"]);
});

test("the SessionStart re-print stays claude-only", () => {
  agt(["daemon", "start"]);
  const main = { AGT_ROLE: "main", AGT_SESSION: "00000000-0000-4000-8000-0000000000aa" };
  const prompt = systemPrompt({ root, role: "main", config: DEFAULT_CONFIG });
  expect(agt(["event", "started"], { ...main, AGT_AGENT: "claude-code" }, { stdin: JSON.stringify({ source: "clear" }) }).out).toBe(prompt);
  for (const agent of ["opencode", "codex", "omp"]) {
    expect(agt(["event", "started"], { ...main, AGT_AGENT: agent }, { stdin: JSON.stringify({ source: "clear" }) }).out).toBe("");
  }
});

const daemonPid = () => /pid (\d+)/.exec(agt(["daemon", "status"]).out)?.[1];

test("agt start restarts a running daemon whose config differs from the fresh one", () => {
  expect(agt(["daemon", "start"]).out).toBe("daemon started");
  const before = daemonPid();
  writeFileSync(join(root, ".agentthread", "config.yaml"), "agents:\n  complexity:\n    tiers:\n      small: { agent: claude-code }\n");
  const r = agt(["start", "--no-manager"]);
  expect(r.code).toBe(0);
  expect(r.out.split("\n")[0]).toBe("config changed; restarted the daemon");
  const after = daemonPid();
  expect(after).toBeDefined();
  expect(after).not.toBe(before);
  // the restarted daemon knows the new tier
  expect(JSON.parse(agt(["thread", "new", "Fix", "--type", "bug", "--tier", "small", "--reason", "tiny", "--now"]).out)).toMatchObject({ tier: "small" });
}, 20_000);

test("agt start keeps a running daemon whose config is unchanged", () => {
  agt(["daemon", "start"]);
  const before = daemonPid();
  const r = agt(["start", "--no-manager"]);
  expect(r.code).toBe(0);
  expect(r.out).not.toContain("config changed");
  expect(daemonPid()).toBe(before);
});

test("agt start warns that claude-code agents will ask to trust the root when main is not claude-code", () => {
  const line = `agt: warning: claude-code agents will ask to trust ${root}; open claude once in ${root} and accept, or use claude-code for main`;
  writeFileSync(join(root, ".agentthread", "config.yaml"), "agents:\n  roles:\n    main: { agent: opencode }\n");
  expect(agt(["start", "--no-manager"]).err.split("\n")).toContain(line);
  writeFileSync(join(root, ".agentthread", "config.yaml"), "agents:\n  roles:\n    main: { agent: claude-code }\n");
  expect(agt(["start", "--no-manager"]).err).not.toContain("ask to trust");
}, 15_000);

test("agt start warns once per role or tier whose agent is not installed", () => {
  writeFileSync(
    join(root, ".agentthread", "config.yaml"),
    "agents:\n  roles:\n    main: { agent: claude-code }\n    coordinator: { agent: codex }\n    worker: { agent: omp }\n  complexity:\n    tiers:\n      big: { agent: codex }\n",
  );
  // a PATH holding only git, bun and sleep: no real agent binary can be found
  const bare = join(tempRepo(), "bin");
  mkdirSync(bare, { recursive: true });
  symlinkSync(Bun.which("git")!, join(bare, "git"));
  // the fake herdr starts through `env bun`, and herdr calls through sleep
  symlinkSync(process.execPath, join(bare, "bun"));
  symlinkSync(Bun.which("sleep")!, join(bare, "sleep"));
  const r = agt(["start", "--no-manager"], { AGT_OMP_BIN: FAKE_AGENT, PATH: bare });
  expect(r.code).toBe(0);
  expect(r.err.split("\n").filter((l) => l.includes("is not installed"))).toEqual([
    "agt: warning: agents.roles.main: claude-code is not installed",
    "agt: warning: agents.roles.coordinator: codex is not installed",
    // herdr starts workers with omp's default binary, so AGT_OMP_BIN does not count
    "agt: warning: agents.roles.worker: omp is not installed",
    "agt: warning: agents.complexity.tiers.big: codex is not installed",
  ]);
});

test("start prints which Claude account the claude-code agents use", () => {
  const def = agt(["start", "--no-manager"], { CLAUDE_CONFIG_DIR: "" });
  expect(def.raw.split("\n")[0]).toBe("claude-code agents use the default Claude config (~/.claude); set agents.env.CLAUDE_CONFIG_DIR to pick an account");
  agt(["daemon", "stop"]);
  const fromShell = agt(["start", "--no-manager"], { CLAUDE_CONFIG_DIR: "/shell/acct" });
  expect(fromShell.raw.split("\n")[0]).toBe("claude-code agents use CLAUDE_CONFIG_DIR=/shell/acct");
  agt(["daemon", "stop"]);
  writeFileSync(join(root, ".agentthread", "config.yaml"), "agents:\n  env: { CLAUDE_CONFIG_DIR: /cfg/acct }\n");
  const cfg = agt(["start", "--no-manager"], { CLAUDE_CONFIG_DIR: "/shell/acct" });
  expect(cfg.raw.split("\n")[0]).toBe("claude-code agents use CLAUDE_CONFIG_DIR=/cfg/acct");
});

test("the main manager is launched with agents.env in its process env", () => {
  const dump = join(root, "env-dump.txt");
  const bin = join(root, "fake-claude.sh");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$CLAUDE_CONFIG_DIR" "$MAIN_ONLY" > ${shellQuote(dump)}\n`, { mode: 0o755 });
  writeFileSync(join(root, ".agentthread", "config.yaml"), "agents:\n  env: { CLAUDE_CONFIG_DIR: ~/acct }\n  roles:\n    main: { agent: claude-code, env: { MAIN_ONLY: m } }\n");
  const r = agt(["start"], { AGT_CLAUDE_BIN: bin, HOME: "/home/u" });
  expect(r.code).toBe(0);
  expect(readFileSync(dump, "utf8")).toBe("/home/u/acct\nm\n");
});

test("agt start records the main agent's pid and binary in main.pid while it runs, and removes it after", () => {
  const dump = join(root, "pid-dump.txt");
  const bin = join(root, "fake-claude.sh");
  const pidFile = join(root, ".agentthread", "main.pid");
  writeFileSync(bin, `#!/bin/sh\necho "$$" > ${shellQuote(dump)}\ncat ${shellQuote(pidFile)} >> ${shellQuote(dump)}\n`, { mode: 0o755 });
  const r = agt(["start"], { AGT_CLAUDE_BIN: bin });
  expect(r.code).toBe(0);
  const [self, recorded, recordedBin] = readFileSync(dump, "utf8").trim().split("\n");
  expect(recorded).toBe(self);
  expect(recordedBin).toBe(bin);
  expect(existsSync(pidFile)).toBe(false);
});

test("agt start exits 0 when agt stop ended the main manager (SIGTERM, its pid file taken)", () => {
  const bin = join(root, "fake-claude.sh");
  const pidFile = join(root, ".agentthread", "main.pid");
  writeFileSync(bin, `#!/bin/sh\nrm -f ${shellQuote(pidFile)}\nkill -TERM $$\n`, { mode: 0o755 });
  expect(agt(["start"], { AGT_CLAUDE_BIN: bin }).code).toBe(0);
});
