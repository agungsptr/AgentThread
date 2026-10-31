import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGT_BIN, agentEnv, allowedTools, hookCommand, hookSettings } from "../../src/agents/claude.ts";
import { bootstrapPrompt, systemPrompt } from "../../src/agents/prompts.ts";
import { agentsMd } from "../../src/agents/agents-md.ts";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { shellQuote } from "../../src/herdr/bridge.ts";

const T = { id: "002", title: "Fix race", slug: "fix-race", worktree: "/repo/.worktrees/002-fix-race" };
const DIR = "/repo/.agentthread/threads/002-fix-race";

describe("claude adapter", () => {
  test("AGT_BIN points at bin/agt", () => {
    expect(AGT_BIN.endsWith(join("bin", "agt"))).toBe(true);
    expect(existsSync(AGT_BIN)).toBe(true);
  });

  test("hooks call agt event with the mapped signal", () => {
    expect(hookCommand("idle")).toBe(`${shellQuote(process.execPath)} ${shellQuote(AGT_BIN)} event idle`);
    const h = hookSettings().hooks;
    expect(Object.keys(h)).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "PreCompact", "SessionEnd"]);
    expect(h.Stop).toEqual([{ hooks: [{ type: "command", command: hookCommand("idle") }] }]);
    expect(h.SessionEnd![0]!.hooks[0]!.command.endsWith(" event ended")).toBe(true);
  });

  test("allowed tools per role, plus configured extras", () => {
    expect(allowedTools("main", DEFAULT_CONFIG)).toEqual(["Bash(agt *)"]);
    expect(allowedTools("worker", DEFAULT_CONFIG)).toEqual(["Bash(agt *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)"]);
    const cfg = { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents, claude: { ...DEFAULT_CONFIG.agents.claude, extra_allowed_tools: ["Bash(bun test*)"] } } };
    expect(allowedTools("coordinator", cfg)).toEqual([
      "Bash(agt *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git add *)", "Bash(git commit *)", "Bash(bun test*)",
    ]);
  });

  test("with a root, coordinator and worker may read the project's .agentthread files", () => {
    const read = "Read(//repo/.agentthread/**)";
    expect(allowedTools("worker", DEFAULT_CONFIG, "/repo")).toEqual(["Bash(agt *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", read]);
    expect(allowedTools("coordinator", DEFAULT_CONFIG, "/repo")).toEqual([
      "Bash(agt *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git add *)", "Bash(git commit *)", read,
    ]);
    expect(allowedTools("main", DEFAULT_CONFIG, "/repo")).toEqual(["Bash(agt *)"]);
  });

  test("agent env puts agt on PATH and identifies the session", () => {
    const env = agentEnv({ root: "/repo", role: "worker", agent: "claude-code", session: "s-1", thread: "002", ticket: "T3" });
    expect(env).toMatchObject({ AGT_ROOT: "/repo", AGT_ROLE: "worker", AGT_SESSION: "s-1", AGT_AGENT: "claude-code", AGT_THREAD: "002", AGT_TICKET: "T3" });
    expect(env.PATH!.startsWith(`${dirname(AGT_BIN)}:`)).toBe(true);
    expect(agentEnv({ root: "/repo", role: "worker", agent: "codex", session: "s-1" }).AGT_AGENT).toBe("codex");
    expect(agentEnv({ root: "/repo", role: "main", agent: "claude-code", session: "m" })).not.toHaveProperty("AGT_THREAD");
  });
});

describe("prompts", () => {
  test("coordinator prompt names its thread, files and commands", () => {
    const p = systemPrompt({ root: "/repo", role: "coordinator", thread: T });
    for (const s of [`thread 002 ("Fix race")`, T.worktree, `${DIR}/sub.thread.md`, `${DIR}/board.md`, "agt ticket add 002", "agt worker spawn 002 --ticket <T>", "HANDOFF REQUEST", "git commit", "agt thread status 002 review", "- Plan before you spawn: split the work into the largest set of tickets that can run in parallel without touching the same files (usually 2–4). Use one ticket only when the work is genuinely a single change.", "- Spawn a worker for every ticket that is ready, all at once; the daemon queues any beyond max-workers.", "- Do not implement tickets yourself: every change to project files is made by a worker. You may read code and docs, run the tests and the stack, review and commit.", 'answer each with agt answer <thread> <Q> "<answer>". Only you and the main manager ever ask the user.']) {
      expect(p).toContain(s);
    }
    expect(bootstrapPrompt({ root: "/repo", role: "coordinator", thread: T })).toBe(
      `You are the coordinator of thread 002. Read ${DIR}/brief.md, then follow AGENTS.md.`,
    );
  });

  test("worker prompt is scoped to its ticket and forbids commits", () => {
    const p = systemPrompt({ root: "/repo", role: "worker", thread: T, ticket: "T3" });
    for (const s of ["ticket T3 of thread 002", "agt ticket claim 002/T3", '3. agt ticket done 002/T3 --summary "<one line>" is your last action: make no edits after it — or, if you cannot finish, agt ticket block 002/T3 --reason "<why>".', "Do not commit", "Never bypass the commit guard (no git commit --no-verify, no changing core.hooksPath or AGT_ROLE).", `You may run any command the work needs (tests, the dev stack, installs) inside the worktree. When you need a decision you cannot make, run agt question 002 "<question>", end your turn and wait for the answer.`]) {
      expect(p).toContain(s);
    }
    expect(bootstrapPrompt({ root: "/repo", role: "worker", thread: T, ticket: "T3" })).toBe(`You are the worker for ticket T3 of thread 002. Read ${DIR}/brief.md, then follow AGENTS.md.`);
  });

  test("worker step 2 follows agents.autonomous", () => {
    const AUTO = `2. Implement the ticket. You may run any command the work needs (tests, the dev stack, installs) inside the worktree.`;
    const ASK = "2. Implement the ticket. Run tests only with commands you are allowed to run without asking for approval; if a command you need requires approval, block the ticket and name the command in the reason.";
    const nonAuto = { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents, autonomous: false } };
    const auto = systemPrompt({ root: "/repo", role: "worker", thread: T, ticket: "T3", config: DEFAULT_CONFIG });
    expect(auto).toContain(AUTO);
    expect(auto).not.toContain(ASK);
    const asking = systemPrompt({ root: "/repo", role: "worker", thread: T, ticket: "T3", config: nonAuto });
    expect(asking).toContain(ASK);
    expect(asking).not.toContain("You may run any command");
    expect(asking).toContain('run agt question 002 "<question>", end your turn and wait for the answer.');
    expect(agentsMd({ root: "/repo", thread: T, config: nonAuto })).toContain(ASK);
    expect(agentsMd({ root: "/repo", thread: T })).toContain(AUTO);
  });

  test("main prompt requires user confirmation before creating threads", () => {
    const p = systemPrompt({ root: "/repo", role: "main" });
    for (const s of ["/repo/.agentthread/main.thread.md", "Only after the user confirms", "agt thread new", "agt tell"]) expect(p).toContain(s);
    expect(bootstrapPrompt({ root: "/repo", role: "main" })).toBe("");
  });
});
