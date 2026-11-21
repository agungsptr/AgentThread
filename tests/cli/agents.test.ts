import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { systemPrompt } from "../../src/agents/prompts.ts";
import { initProject } from "../../src/project/init.ts";
import { FAKE_CLAUDE, FAKE_HERDR, fakeHerdrState, isolatedConfigHome, repoName, tempRepo, waitFor, waitWorktreeAdded, SPAWN_TEST_ENV } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");
let root: string;
let fake: ReturnType<typeof fakeHerdrState>;
let xdg: string;
let claudeLog: string;

function agt(args: string[], extra: Record<string, string> = {}, stdin?: string, cwd = root) {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "", HOME: "/nonexistent", XDG_CONFIG_HOME: xdg, AGT_ROOT: root, FAKE_HERDR_STATE: fake.file, ...SPAWN_TEST_ENV,
      HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t0", HERDR_PANE_ID: "w1:p0", HERDR_BIN_PATH: FAKE_HERDR,
      AGT_CLAUDE_BIN: FAKE_CLAUDE, AGT_OPENCODE_BIN: "/nonexistent/opencode", AGT_CODEX_BIN: "/nonexistent/codex", AGT_OMP_BIN: "/nonexistent/omp", AGT_AGY_BIN: "/nonexistent/agy", FAKE_CLAUDE_LOG: claudeLog,
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

test("agt start runs the main manager in the foreground with hooks, role and the main prompt as first message", () => {
  const r = agt(["start"]);
  expect(r.code).toBe(0);
  const id = /main manager session ([0-9a-f-]{36})/.exec(r.out)![1]!;
  const run = JSON.parse(readFileSync(claudeLog, "utf8").trim()) as { argv: string[]; env: Record<string, string> };
  expect(run.argv.slice(0, 2)).toEqual(["--permission-mode", "bypassPermissions"]);
  expect(run.argv).not.toContain("--session-id");
  expect(run.argv).not.toContain("--append-system-prompt");
  expect(run.argv[run.argv.length - 1]).toBe(systemPrompt({ root, role: "main", config: DEFAULT_CONFIG }));
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

test("thread new --max-workers, worker spawn and tell", async () => {
  agt(["start", "--no-manager"]);
  expect(agt(["thread", "new", "X", "--type", "bug", "--max-workers", "x"]).code).toBe(2);
  agt(["thread", "new", "X", "--type", "bug", "--max-workers", "1"]);
  const coord = { AGT_ROLE: "coordinator", AGT_THREAD: "001" };
  agt(["worktree", "add", "001", repoName(root), "--from", "main"], coord);
  await waitWorktreeAdded(root);
  agt(["ticket", "add", "001", "A", "--repo", repoName(root), "--file", "a"], coord);
  agt(["ticket", "add", "001", "B", "--repo", repoName(root), "--file", "b"], coord);
  expect(JSON.parse(agt(["worker", "spawn", "001", "--ticket", "T1"], coord).out)).toMatchObject({ queued: false });
  expect(agt(["worker", "spawn", "001", "--ticket", "T2", "--agent", "omp"], coord).out).toBe('{"queued":true}');
  const bad = agt(["worker", "spawn", "001", "--ticket", "T2", "--agent", "gpt"], coord);
  expect(bad.code).toBe(2);
  expect(bad.err).toContain("--agent must be one of claude-code, opencode, codex, omp, agy");
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

test("agt handoff --stdin", () => {
  agt(["start", "--no-manager"]);
  agt(["thread", "new", "X", "--type", "bug"]);
  const content = ["Goal status", "Work done", "Decisions", "Next steps", "Risks"].map((s) => `## ${s}\nx`).join("\n");
  expect(agt(["handoff", "001", "--stdin"], { AGT_ROLE: "coordinator", AGT_THREAD: "001" }, content)).toMatchObject({ code: 0, out: "ok" });
  expect(agt(["handoff", "001"], { AGT_ROLE: "coordinator", AGT_THREAD: "001" }).code).toBe(2);
});

test("agt event idle reports context tokens from the hook transcript", () => {
  agt(["start", "--no-manager"]);
  agt(["thread", "new", "X", "--type", "bug"]);
  const fm = () => parse(readFileSync(join(root, ".agentthread/threads/001-x/sub.thread.md"), "utf8").split("---\n")[1]!) as { sessions: { id: string; role: string; context_tokens?: number }[] };
  const c = fm().sessions.find((s) => s.role === "coordinator")!;
  const status = () => (fm().sessions.find((s) => s.id === c.id) as { status?: string }).status;
  const transcript = join(xdg, "t.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 5, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 } } })}\n`);
  expect(agt(["event", "idle"], { AGT_ROLE: "coordinator", AGT_THREAD: "001", AGT_SESSION: c.id }, JSON.stringify({ session_id: "00000000-0000-4000-8000-000000000000", transcript_path: transcript })).code).toBe(0);
  expect(fm().sessions.find((s) => s.id === c.id)!.context_tokens).toBe(55);
  // a huge garbage transcript still exits 0 quickly
  writeFileSync(transcript, "y".repeat(5_000_000));
  const t0 = Date.now();
  expect(agt(["event", "idle"], { AGT_ROLE: "coordinator", AGT_THREAD: "001", AGT_SESSION: c.id }, JSON.stringify({ session_id: "00000000-0000-4000-8000-000000000000", transcript_path: transcript })).code).toBe(0);
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(fm().sessions.find((s) => s.id === c.id)!.context_tokens).toBe(55);
  expect(status()).toBe("idle");
  // malformed usage must not drop the idle signal
  const hook = (sig: string) => agt(["event", sig], { AGT_ROLE: "coordinator", AGT_THREAD: "001", AGT_SESSION: c.id }, JSON.stringify({ session_id: "00000000-0000-4000-8000-000000000000", transcript_path: transcript }));
  expect(hook("active").code).toBe(0);
  expect(status()).toBe("active");
  writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 5, cache_read_input_tokens: "x" } } })}\n`);
  expect(hook("idle").code).toBe(0);
  expect(status()).toBe("idle");
  expect(fm().sessions.find((s) => s.id === c.id)!.context_tokens).toBe(55);
});

test("agt event identifies the session by AGT_SESSION or pane, never by the vendor session_id", async () => {
  agt(["start", "--no-manager"]);
  agt(["thread", "new", "X", "--type", "bug"]);
  const fm = () => parse(readFileSync(join(root, ".agentthread/threads/001-x/sub.thread.md"), "utf8").split("---\n")[1]!) as { sessions: { id: string; role: string; pane?: string; status?: string; turns?: number }[] };
  const c = await waitFor(() => fm().sessions.find((s) => s.role === "coordinator" && s.pane));
  expect(c.pane).toBeTruthy();
  const vendor = JSON.stringify({ session_id: "00000000-0000-4000-8000-000000000000" });
  const env = (extra: Record<string, string>) => ({ AGT_ROLE: "coordinator", AGT_THREAD: "001", ...extra });
  const status = () => fm().sessions.find((s) => s.id === c.id)!.status;
  // by AGT_SESSION, with a different vendor session_id on stdin
  expect(agt(["event", "active"], env({ AGT_SESSION: c.id }), vendor)).toMatchObject({ code: 0, err: "" });
  expect(status()).toBe("active");
  // by pane only
  expect(agt(["event", "idle"], { HERDR_PANE_ID: c.pane! }, vendor)).toMatchObject({ code: 0, err: "" });
  expect(status()).toBe("idle");
  // an unknown pane reports on stderr and still exits 0
  const bad = agt(["event", "active"], { HERDR_PANE_ID: "w9:p9" }, vendor);
  expect(bad.code).toBe(0);
  expect(bad.err).toContain("no live session in pane w9:p9");
  expect(status()).toBe("idle");
});

test("SessionStart after /clear or compaction gives the main manager its role prompt back on stdout", () => {
  agt(["daemon", "start"]);
  const main = { AGT_ROLE: "main", AGT_SESSION: "00000000-0000-4000-8000-0000000000aa" };
  const prompt = systemPrompt({ root, role: "main", config: DEFAULT_CONFIG });
  for (const source of ["clear", "compact"]) {
    const r = agt(["event", "started"], main, JSON.stringify({ session_id: "x", source }));
    expect(r.code).toBe(0);
    expect(r.out).toBe(prompt);
  }
  // a fresh start already has the prompt as its first message; other roles get their rules from AGENTS.md
  expect(agt(["event", "started"], main, JSON.stringify({ session_id: "x", source: "startup" })).out).toBe("");
  expect(agt(["event", "started"], { AGT_ROLE: "coordinator", AGT_THREAD: "001", AGT_SESSION: main.AGT_SESSION }, JSON.stringify({ source: "clear" })).out).toBe("");
  expect(agt(["event", "idle"], main, JSON.stringify({ source: "clear" })).out).toBe("");
  // even with the daemon down the role prompt is printed
  agt(["daemon", "stop"]);
  expect(agt(["event", "started"], main, JSON.stringify({ source: "compact" })).out).toBe(prompt);
});
