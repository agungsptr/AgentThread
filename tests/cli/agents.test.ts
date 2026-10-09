import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { initProject } from "../../src/project/init.ts";
import { FAKE_CLAUDE, FAKE_HERDR, fakeHerdrState, isolatedConfigHome, tempRepo } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");
let root: string;
let fake: ReturnType<typeof fakeHerdrState>;
let xdg: string;
let claudeLog: string;

function agt(args: string[], extra: Record<string, string> = {}, stdin?: string, cwd = root) {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "", HOME: "/nonexistent", XDG_CONFIG_HOME: xdg, AGT_ROOT: root, FAKE_HERDR_STATE: fake.file,
      HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t0", HERDR_PANE_ID: "w1:p0", HERDR_BIN_PATH: FAKE_HERDR,
      AGT_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_LOG: claudeLog,
      ...extra,
    },
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

beforeEach(() => {
  root = tempRepo();
  initProject(root, "demo");
  fake = fakeHerdrState({ tabs: ["w1:t0"], panes: ["w1:p0"] });
  xdg = isolatedConfigHome();
  claudeLog = join(xdg, "claude.jsonl");
});

afterEach(() => {
  agt(["daemon", "stop"]);
});

test("agt start runs the main manager in the foreground with session, hooks and role", () => {
  const r = agt(["start"]);
  expect(r.code).toBe(0);
  const id = /main manager session ([0-9a-f-]{36})/.exec(r.out)![1]!;
  const run = JSON.parse(readFileSync(claudeLog, "utf8").trim()) as { argv: string[]; env: Record<string, string> };
  expect(run.argv.slice(0, 4)).toEqual(["--session-id", id, "--permission-mode", "acceptEdits"]);
  expect(run.argv).toContain("--settings");
  expect(run.env).toMatchObject({ AGT_ROLE: "main", AGT_SESSION: id, AGT_ROOT: root, AGT_AGENT: "claude-code" });
  const fm = readFileSync(join(root, ".agentthread", "main.thread.md"), "utf8");
  expect(fm).toContain("# Main Thread");
});

test("the main manager runs in the project root even when agt start runs from a subdirectory", () => {
  const sub = join(root, "src", "deep");
  mkdirSync(sub, { recursive: true });
  expect(agt(["start"], {}, undefined, sub).code).toBe(0);
  const run = JSON.parse(readFileSync(claudeLog, "utf8").trim()) as { cwd: string };
  expect(realpathSync(run.cwd)).toBe(realpathSync(root));
});

test("--no-manager skips Claude", () => {
  expect(agt(["start", "--no-manager"]).code).toBe(0);
  expect(existsSync(claudeLog)).toBe(false);
});

test("thread new --max-workers, worker spawn and tell", () => {
  agt(["start", "--no-manager"]);
  expect(agt(["thread", "new", "X", "--type", "bug", "--max-workers", "x"]).code).toBe(2);
  agt(["thread", "new", "X", "--type", "bug", "--max-workers", "1"]);
  const coord = { AGT_ROLE: "coordinator", AGT_THREAD: "001" };
  agt(["ticket", "add", "001", "A", "--scope", "a"], coord);
  agt(["ticket", "add", "001", "B", "--scope", "b"], coord);
  expect(JSON.parse(agt(["worker", "spawn", "001", "--ticket", "T1"], coord).out)).toMatchObject({ queued: false });
  expect(agt(["worker", "spawn", "001", "--ticket", "T2"], coord).out).toBe('{"queued":true}');
  expect(agt(["tell", "001", "please", "hurry"]).out).toBe("ok");
});

test("agt event always exits 0, reading the session from hook stdin", () => {
  // daemon not running yet
  const down = agt(["event", "idle"], {}, JSON.stringify({ session_id: "00000000-0000-4000-8000-000000000000" }));
  expect(down.code).toBe(0);
  expect(down.err).toStartWith("agt event:");
  expect(down.err.toLowerCase()).toContain("daemon");
  agt(["daemon", "start"]);
  const bad = agt(["event", "idle"], {}, "not json");
  expect(bad.code).toBe(0);
  expect(bad.err).toStartWith("agt event:");
  expect(agt(["event", "idle"], {}, JSON.stringify({ session_id: "00000000-0000-4000-8000-000000000000" }))).toMatchObject({ code: 0 });
  expect(agt(["event", "bogus"]).code).toBe(0);
});

test("agt event does not hang when stdin is never closed", async () => {
  const proc = Bun.spawn([process.execPath, BIN, "event", "idle"], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", XDG_CONFIG_HOME: xdg, AGT_ROOT: root, AGT_SESSION: "00000000-0000-4000-8000-000000000000" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const code = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => "timeout" as const)]);
    expect(code).toBe(0);
  } finally {
    proc.kill();
  }
});

test("a missing Claude binary ends the main session and fails", () => {
  const r = agt(["start"], { AGT_CLAUDE_BIN: "/nonexistent/claude" });
  expect(r.code).toBe(1);
  expect(r.err).toContain("cannot start Claude Code");
  const tell = agt(["tell", "main", "x"]);
  expect(tell.code).toBe(1);
  expect(tell.err).toContain("no live main manager session");
});

test("agt start returns Claude's exit code", () => {
  expect(agt(["start"], { FAKE_CLAUDE_EXIT: "3" }).code).toBe(3);
});
