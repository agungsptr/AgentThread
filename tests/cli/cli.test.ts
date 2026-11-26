import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helpRequest } from "../../src/cli/usage.ts";
import { isolatedConfigHome, repoName, tempRepo } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");

let root: string;
let xdg: string;

function agt(args: string[], opts: { env?: Record<string, string>; cwd?: string; root?: boolean } = {}) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: "/nonexistent", XDG_CONFIG_HOME: xdg, ...opts.env };
  if (opts.root !== false) env.AGT_ROOT = root;
  const r = Bun.spawnSync([process.execPath, BIN, ...args], { cwd: opts.cwd ?? root, env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

const COORD = { AGT_ROLE: "coordinator", AGT_THREAD: "001", AGT_SESSION: "c1" };
const WORKER = { AGT_ROLE: "worker", AGT_THREAD: "001", AGT_SESSION: "w1" };

beforeEach(() => {
  xdg = isolatedConfigHome();
  root = tempRepo();
  expect(agt(["init", "--name", "demo"]).code).toBe(0);
});

afterEach(() => {
  agt(["daemon", "stop"]);
});

test("ticket block without --reason is a usage error", () => {
  const r = agt(["ticket", "block", "001/001"]);
  expect(r.code).toBe(2);
  expect(r.err).toContain("--reason");
});

test("ticket return without what to fix is a usage error", () => {
  const r = agt(["ticket", "return", "001/T1"]);
  expect(r.code).toBe(2);
  expect(r.err).toContain("what to fix");
});

test("daemon lifecycle", () => {
  expect(agt(["daemon", "status"]).code).toBe(1);
  expect(agt(["daemon", "start"])).toMatchObject({ code: 0, out: "daemon started" });
  expect(agt(["daemon", "status"]).out).toMatch(/^running \(pid \d+\)$/);
  expect(agt(["daemon", "stop"])).toMatchObject({ code: 0, out: "daemon stopped" });
  expect(agt(["daemon", "status"]).code).toBe(1);
});

const AGENT = { AGT_AGENT_PROCESS: "1" };
const MAIN_HINT = "agt daemon is started from the project's main tab: run agt start there.";

test("a worktree shell with no AGT_* env is told to use the project root, and no daemon starts", () => {
  const wt = join(root, ".worktrees", "task", "web");
  mkdirSync(wt, { recursive: true });
  // No AGT_ROOT: the project is found by walking up from the worktree.
  for (const sub of ["start", "run"]) {
    const r = agt(["daemon", sub], { cwd: wt, root: false });
    expect(r.code).toBe(1);
    expect(r.err).toContain("project root");
    expect(r.err).toContain(root);
    expect(r.err).not.toContain("tell the user");
  }
  const down = agt(["log", "001", "hi"], { cwd: wt, root: false });
  expect(down.err).toBe(`agt: daemon is not running; ${MAIN_HINT}`);
  expect(agt(["daemon", "status"], { cwd: wt, root: false }).code).toBe(1);
  expect(agt(["daemon", "status"]).code).toBe(1); // still no daemon anywhere
});

test("an agent process is told not to start the daemon and to tell the user", () => {
  for (const env of [{ ...WORKER, ...AGENT }, { ...COORD, ...AGENT }]) {
    for (const sub of ["start", "run"]) {
      const r = agt(["daemon", sub], { env });
      expect(r.code).toBe(1);
      expect(r.err).toContain("do not start the daemon");
      expect(r.err).toContain("tell the user");
    }
    const down = agt(["log", "001", "hi"], { env });
    expect(down.code).toBe(1);
    expect(down.err).toBe("agt: daemon is not running; tell the user (only they start it, with `agt start` in the main tab)");
  }
  expect(agt(["daemon", "status"]).code).toBe(1);
});

test("a user shell in a thread or workers tab is pointed at the main tab, and no daemon starts", () => {
  for (const env of [WORKER, COORD, { AGT_ROLE: "main" }, { AGT_THREAD: "001" }] as Record<string, string>[]) {
    for (const sub of ["start", "run"]) {
      const r = agt(["daemon", sub], { env });
      expect(r.code).toBe(1);
      expect(r.err).toBe(`agt: ${MAIN_HINT}`);
      expect(r.err).not.toContain("tell the user");
    }
    const down = agt(["log", "001", "hi"], { env });
    expect(down.code).toBe(1);
    expect(down.err).toBe(`agt: daemon is not running; ${MAIN_HINT}`);
  }
  expect(agt(["daemon", "status"]).code).toBe(1);
});

test("commands without a daemon explain how to start it", () => {
  expect(agt(["log", "001", "hi"])).toMatchObject({ code: 1, err: "agt: daemon is not running; run `agt daemon start`" });
});

test("thread, ticket and log commands", () => {
  agt(["daemon", "start"]);
  expect(JSON.parse(agt(["thread", "new", "Fix", "race", "--type", "bug", "--criteria", "no double charge"]).out)).toMatchObject({
    thread: "001",
  });
  expect(agt(["ticket", "add", "001", "Lock", "fix", "--repo", repoName(root), "--file", "src/lock.ts"], { env: COORD }).out).toBe('{"ticket":"T1"}');
  expect(agt(["ticket", "claim", "001/T1"], { env: WORKER }).out).toBe("ok");
  expect(agt(["ticket", "done", "001/T1", "--summary", "fixed"], { env: WORKER }).out).toBe("ok");
  expect(agt(["ticket", "return", "001/T1", "add", "a", "test."], { env: COORD }).out).toBe("ok");
  expect(agt(["ticket", "done", "001/T1", "--summary", "fixed"], { env: WORKER }).out).toBe("ok");
  expect(agt(["ticket", "accept", "001/T1"], { env: COORD }).out).toBe("ok");
  expect(agt(["ticket", "accept", "001/T1"], { env: COORD })).toMatchObject({ code: 1, err: "agt: ticket T1 is done, not in review" });
  expect(agt(["log", "001", "all", "good"], { env: WORKER }).out).toBe("ok");
  const logs = agt(["logs"]).out.split("\n");
  expect(logs.at(-1)).toMatch(/^\d\d:\d\d:\d\d 001 worker log\.appended all good$/);
});

test("permission errors surface from the daemon", () => {
  agt(["daemon", "start"]);
  agt(["thread", "new", "X", "--type", "bug"]);
  expect(agt(["ticket", "add", "001", "T", "--scope", "a"])).toMatchObject({
    code: 1,
    err: "agt: role user may not run ticket.add",
  });
});

test("invalid AGT_ROLE is rejected locally", () => {
  expect(agt(["log", "001", "x"], { env: { AGT_ROLE: "boss" } })).toMatchObject({ code: 1, err: "agt: invalid AGT_ROLE boss" });
});

test("handoff reads the file", () => {
  agt(["daemon", "start"]);
  agt(["thread", "new", "X", "--type", "bug"]);
  const file = join(root, "handoff.md");
  writeFileSync(file, ["Goal status", "Work done", "Decisions", "Next steps", "Risks"].map((s) => `## ${s}\nx`).join("\n"));
  expect(agt(["handoff", "001", "--file", file], { env: COORD }).out).toBe("ok");
});

test("finds the project from a thread directory subdirectory without AGT_ROOT", () => {
  agt(["daemon", "start"]);
  agt(["thread", "new", "X", "--type", "bug"]);
  const sub = join(root, ".worktrees", "x", "src");
  mkdirSync(sub, { recursive: true });
  expect(agt(["log", "001", "from worktree"], { cwd: sub, root: false, env: WORKER }).out).toBe("ok");
});

test("unknown commands print the error and usage to stderr, exit 2", () => {
  const r = agt(["frobnicate"]);
  expect(r.code).toBe(2);
  expect(r.out).toBe("");
  expect(r.err).toContain("agt: unknown command 'frobnicate'");
  expect(r.err).toContain("usage: agt <command>");
});

test("agt, --help, -h and help print the full usage to stdout, exit 0", () => {
  for (const args of [[], ["--help"], ["-h"], ["help"]]) {
    const r = agt(args);
    expect(r.code).toBe(0);
    expect(r.out).toContain("usage: agt <command>");
    expect(r.out).toContain("stack restart");
    expect(r.err).toBe("");
  }
});

test("args after -- never trigger help", () => {
  expect(helpRequest(["tell", "main", "--", "-h"])).toBeUndefined();
  expect(helpRequest(["tell", "--help", "--", "x"])).toBeDefined();
});

test("agt help <cmd> and agt <cmd> --help print only that command's lines and never run it", () => {
  const thread = agt(["thread", "new", "--help"]);
  expect(thread.code).toBe(0);
  expect(thread.out).toStartWith("thread new <title...>");
  expect(thread.out).toContain("--tier <name>");
  expect(thread.out).not.toContain("thread choose");
  expect(thread.out).not.toContain("usage: agt");
  expect(agt(["help", "thread", "new"]).out).toBe(thread.out);
  expect(agt(["help", "ticket", "files"]).out).toStartWith("ticket files <thread>/<ticket>");
  expect(agt(["ticket", "files", "-h"]).out.split("\n")).toHaveLength(1);
  expect(agt(["stack", "restart", "--help"]).out).toStartWith("stack restart");
  expect(agt(["config", "apply", "-h"]).out).toStartWith("config apply <file|->");
  expect(agt(["config", "apply", "-h"]).out).not.toContain("config show");
  expect(agt(["ticket", "claim", "--help"]).out).toStartWith("ticket claim|reopen");
  expect(agt(["tell", "--help"]).out).toContain("tell <thread|main>");
  // nothing ran: no thread was created, no daemon needed
  expect(agt(["thread", "new", "X", "--type", "bug", "--help"]).out).toStartWith("thread new");
  expect(agt(["thread", "status", "001"]).code).not.toBe(0);
});

test("help for a command with no usage line prints the full usage", () => {
  const r = agt(["help", "frobnicate"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("usage: agt <command>");
  expect(agt(["frobnicate", "--help"]).out).toContain("usage: agt <command>");
});

test("agt init on a non-TTY prints the setup hint and succeeds", () => {
  const r2 = tempRepo();
  const r = agt(["init", "--name", "x"], { env: { AGT_ROOT: r2 }, root: false });
  expect(r.code).toBe(0);
  expect(r.err).toContain("run agt setup (or edit .agentthread/config.yaml) to choose agents per role; using the configured defaults (claude-code unless set)");
});

test("agt guide prints the role guide without a daemon", () => {
  const r = agt(["guide", "worker"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("agt ticket done <thread>/<ticket> --summary <text>");
  expect(agt(["daemon", "status"]).code).toBe(1);
  expect(agt(["guide"], { env: { AGT_ROLE: "main" } }).out).toContain("agt thread choose");
  const all = agt(["guide"]).out;
  for (const h of ["## Main", "## Coordinator", "## Worker"]) expect(all).toContain(h);
});

test("agt guide uses the legacy wording only when $AGT_THREAD is a legacy thread", () => {
  const threads = join(root, ".agentthread", "threads");
  mkdirSync(join(threads, "009-old"), { recursive: true });
  writeFileSync(join(threads, "009-old", "sub.thread.md"), "---\nid: \"009\"\nbranch: thread/009-old\nworktree: /repo/.worktrees/009-old\n---\n");
  mkdirSync(join(threads, "010-new"), { recursive: true });
  writeFileSync(join(threads, "010-new", "sub.thread.md"), "---\nid: \"010\"\ntask: new\ndir: /repo/.worktrees/new\n---\n");
  const NEW = "Work only inside <root>/.worktrees/<task>,";
  const OLD = "Work only inside <worktree>,";
  expect(agt(["guide", "worker"]).out).toContain(NEW);
  const legacy = agt(["guide", "worker"], { env: { AGT_THREAD: "009" } }).out;
  expect(legacy).toContain(OLD);
  expect(legacy).not.toContain(NEW);
  expect(agt(["guide", "worker"], { env: { AGT_THREAD: "010" } }).out).toContain(NEW);
  expect(agt(["guide", "worker"], { env: { AGT_THREAD: "042" } }).out).toContain(NEW);
});

test("agt guide with an unknown role is a usage error", () => {
  const r = agt(["guide", "nope"]);
  expect(r.code).toBe(2);
  expect(r.err).toContain("unknown role 'nope'");
});

test("agt guide worker works outside a project", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agt-noproj-")));
  const r = agt(["guide", "worker"], { cwd: dir, root: false });
  expect(r.code).toBe(0);
  expect(r.out).toContain("agt ticket done <thread>/<ticket> --summary <text>");
  expect(r.err).toBe("");
});

test("agt guide in a project with a broken config warns and prints the default guide", () => {
  writeFileSync(join(root, ".agentthread", "config.yaml"), "agents:\n  skill: 5\n");
  const r = agt(["guide", "worker"]);
  expect(r.code).toBe(0);
  expect(r.err).toContain("agt: warning: invalid config");
  expect(r.err).toContain("; showing the default guide");
  expect(r.out).toContain("agt ticket done <thread>/<ticket> --summary <text>");
});

test("agt worktree add: a coordinator is told it gets a notice; a user is pointed at agt logs or the brief", () => {
  agt(["daemon", "start"]);
  expect(agt(["thread", "new", "One", "--type", "bug", "--task", "one"]).code).toBe(0);
  expect(agt(["thread", "new", "Two", "--type", "bug", "--task", "two"]).code).toBe(0);
  const name = root.split("/").at(-1)!;
  expect(agt(["worktree", "add", "001", name, "--from", "HEAD"])).toMatchObject({ code: 0, out: `requested worktree for ${name}; check agt logs or the thread brief` });
  expect(agt(["worktree", "add", "002", name, "--from", "HEAD"], { env: { ...COORD, AGT_THREAD: "002" } })).toMatchObject({
    code: 0,
    out: `requested worktree for ${name}; you will get a notice when it is ready`,
  });
});

test("agt thread report: usage errors, then records a doc thread's path and checks it", () => {
  expect(agt(["thread", "report"])).toMatchObject({ code: 2 });
  expect(agt(["thread", "report", "001", "a.md", "--check"]).err).toContain("thread report needs <id> <path> or <id> --check");
  agt(["daemon", "start"]);
  expect(agt(["thread", "new", "Explain", "auth", "--type", "report"]).code).toBe(0);
  expect(agt(["thread", "report", "001", ".docs/shared/reports/auth.md"])).toMatchObject({ code: 0, out: JSON.stringify({ path: ".docs/shared/reports/auth.md" }) });
  mkdirSync(join(root, ".docs", "shared", "reports"), { recursive: true });
  writeFileSync(join(root, ".docs", "shared", "reports", "auth.md"), "# Auth\nClear.\n");
  expect(JSON.parse(agt(["thread", "report", "001", "--check"]).out)).toEqual({ path: ".docs/shared/reports/auth.md", ok: true, hits: [] });
});
