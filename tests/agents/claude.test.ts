import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGT_BIN, agentEnv, allowedTools, hookCommand, hookSettings } from "../../src/agents/claude.ts";
import { bootstrapPrompt, systemPrompt } from "../../src/agents/prompts.ts";
import { agentsMd } from "../../src/agents/agents-md.ts";
import { ConfigSchema, DEFAULT_CONFIG } from "../../src/config/config.ts";
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

  test("I1: a task-thread worker may git add and git commit; a legacy worker may not", () => {
    const read = "Read(//repo/.agentthread/**)";
    expect(allowedTools("worker", DEFAULT_CONFIG, "/repo", { legacy: false })).toEqual([
      "Bash(agt *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git add *)", "Bash(git commit *)", read,
    ]);
    expect(allowedTools("worker", DEFAULT_CONFIG, "/repo", { legacy: true })).toEqual(["Bash(agt *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", read]);
    expect(allowedTools("worker", DEFAULT_CONFIG, "/repo")).toEqual(["Bash(agt *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", read]);
  });

  test("§13: a task-thread worker may write its own ticket file only; a ticket without a doc gets no write rule", () => {
    const tools = allowedTools("worker", DEFAULT_CONFIG, "/ws", { legacy: false, doc: ".docs/shared/issues/kyc/02-api.md" });
    expect(tools).toContain("Edit(//ws/.docs/shared/issues/kyc/02-api.md)");
    expect(tools).toContain("Write(//ws/.docs/shared/issues/kyc/02-api.md)");
    expect(tools.filter((t) => t.startsWith("Edit(") || t.startsWith("Write("))).toHaveLength(2);
    expect(tools).toContain("Read(//ws/.docs/shared/issues/kyc/02-api.md)");
    expect(tools.join(",")).not.toContain(".docs/**");
    expect(tools.some((t) => t.includes("git switch") || t.includes("merge --squash") || t.includes("git -C"))).toBe(false);
    const none = allowedTools("worker", DEFAULT_CONFIG, "/ws", { legacy: false });
    expect(none.some((t) => t.startsWith("Edit(") || t.startsWith("Write("))).toBe(false);
    expect(none.filter((t) => t.startsWith("Read("))).toEqual(["Read(//ws/.agentthread/**)"]);
    // a legacy worker never gets one, even when handed a doc
    expect(allowedTools("worker", DEFAULT_CONFIG, "/ws", { legacy: true, doc: "x.md" })).toEqual(allowedTools("worker", DEFAULT_CONFIG, "/ws", { legacy: true }));
  });

  test("§13: a task-thread coordinator may edit and commit .docs, switch branches and squash; never push", () => {
    const tools = allowedTools("coordinator", DEFAULT_CONFIG, "/ws", { legacy: false });
    expect(tools).toEqual([
      "Bash(agt *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git add *)", "Bash(git commit *)",
      "Read(//ws/.docs/**)", "Edit(//ws/.docs/**)", "Write(//ws/.docs/**)",
      "Bash(git -C /ws/.docs add *)", "Bash(git -C /ws/.docs commit *)", "Bash(git -C /ws/.docs status*)", "Bash(git -C /ws/.docs diff*)", "Bash(git -C /ws/.docs log*)",
      "Bash(git switch *)", "Bash(git merge --squash *)",
      "Read(//ws/.agentthread/**)",
    ]);
    expect(tools.join(",")).not.toContain("push");
    // no catch-all git rule in .docs: push, a second -C or -c config would otherwise be auto-approved
    expect(tools).not.toContain("Bash(git -C /ws/.docs *)");
    expect(tools.filter((t) => t.startsWith("Bash(git -C")).every((t) => /^Bash\(git -C \/ws\/\.docs (add \*|commit \*|status\*|diff\*|log\*)\)$/.test(t))).toBe(true);
    // legacy coordinators keep the old rules
    expect(allowedTools("coordinator", DEFAULT_CONFIG, "/ws", { legacy: true })).toEqual([
      "Bash(agt *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git add *)", "Bash(git commit *)", "Read(//ws/.agentthread/**)",
    ]);
  });

  test("agent env puts agt on PATH and identifies the session", () => {
    const env = agentEnv({ root: "/repo", role: "worker", agent: "claude-code", session: "s-1", thread: "002", ticket: "T3" });
    expect(env).toMatchObject({ AGT_ROOT: "/repo", AGT_ROLE: "worker", AGT_SESSION: "s-1", AGT_AGENT: "claude-code", AGT_THREAD: "002", AGT_TICKET: "T3" });
    expect(agentEnv({ root: "/repo", role: "worker", agent: "codex", task: "t1" }).AGT_TASK).toBe("t1");
    expect(agentEnv({ root: "/repo", role: "main", agent: "codex", task: "t1" })).not.toHaveProperty("AGT_TASK");
    expect(agentEnv({ root: "/repo", role: "worker", agent: "codex" })).not.toHaveProperty("AGT_TASK");
    expect(env.PATH!.startsWith(`${dirname(AGT_BIN)}:`)).toBe(true);
    expect(agentEnv({ root: "/repo", role: "worker", agent: "codex", session: "s-1" }).AGT_AGENT).toBe("codex");
    expect(agentEnv({ root: "/repo", role: "main", agent: "claude-code", session: "m" })).not.toHaveProperty("AGT_THREAD");
  });
});

describe("prompts", () => {
  test("the coordinator's commit rule: legacy keeps git commit, a task thread squashes from wip/<task>", () => {
    const legacy = systemPrompt({ root: "/repo", role: "coordinator", thread: T });
    expect(legacy).toContain("then git add and git commit in the worktree.");
    const t = { id: "002", title: "Fix race", slug: "fix-race", dir: "/repo/.worktrees/fix-race", task: "fix-race" };
    const p = systemPrompt({ root: "/repo", role: "coordinator", thread: t });
    expect(p).toContain("- Workers commit their tickets on wip/fix-race. You never edit repo files; your only repo commit is the squash on feat/fix-race: in each repo worktree, git switch -c feat/fix-race <source>, git merge --squash wip/fix-race, then one plain commit.");
    expect(p).not.toContain("git add and git commit");
  });

  test("coordinator prompt names its thread, files and commands", () => {
    const p = systemPrompt({ root: "/repo", role: "coordinator", thread: T });
    for (const s of [`thread 002 ("Fix race")`, T.worktree, `${DIR}/sub.thread.md`, `${DIR}/board.md`, "agt ticket add 002", "agt worker spawn 002 --ticket <T>", "HANDOFF REQUEST", "git commit", "agt thread status 002 review", '- Plan before you spawn: split the work into the largest set of tickets that can run in parallel without touching the same files (usually 2–4). Use one ticket only when the work is genuinely a single change. Add each with: agt ticket add 002 "<title>" --scope <path> [--scope <path>].', "- Spawn a worker for every ticket that is ready, all at once, with agt worker spawn 002 --ticket <T>; the daemon queues any beyond max-workers.", "- Do not implement tickets yourself: every change to project files is made by a worker. You may read code and docs, run the tests and the stack, review and commit.", 'answer each with agt answer <thread> <Q> "<answer>". Only you and the main manager ever ask the user.']) {
      expect(p).toContain(s);
    }
    // the older planning and spawning lines are merged into the two above
    for (const s of ["- Split the work into tickets", "- Start one worker per ticket"]) expect(p).not.toContain(s);
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

  test("I1: a task-thread worker commits its own files on wip/<task>; the coordinator only reviews; legacy wording unchanged", () => {
    const RULE = 'Commit only your ticket\'s files, on wip/fix-race inside your repo worktree, with a pathspec: git add <new files> && git commit -m "<conventional message>" -- <your files>. Never git add -A, git add . or git commit -a; never amend, rebase, reset, stash or push. The coordinator squashes.';
    const t = { id: "002", title: "Fix race", slug: "fix-race", dir: "/repo/.worktrees/fix-race", task: "fix-race" };
    const worker = systemPrompt({ root: "/repo", role: "worker", thread: t, ticket: "T3" });
    expect(worker).toContain(RULE);
    expect(worker).not.toContain("Do not commit; the coordinator commits.");
    expect(worker).toContain("Never bypass the commit guard");
    const legacyWorker = systemPrompt({ root: "/repo", role: "worker", thread: T, ticket: "T3" });
    expect(legacyWorker).toContain("Do not commit; the coordinator commits. Never bypass the commit guard");
    expect(legacyWorker).not.toContain("Commit only your ticket's files");
    const coord = systemPrompt({ root: "/repo", role: "coordinator", thread: t });
    expect(coord).toContain("- Never edit a repo file, even one line: send the worker the exact change. You may read code and docs, run the tests and the stack, and review.");
    expect(coord).not.toContain("review and commit");
    expect(systemPrompt({ root: "/repo", role: "coordinator", thread: T })).toContain("run the tests and the stack, review and commit.");
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

  test("main adds --now only when the user named a tier, with the configured tier names", () => {
    const config = ConfigSchema.parse({ agents: { complexity: { tiers: { big: { agent: "omp" }, small: { agent: "opencode" } } } } });
    const p = systemPrompt({ root: "/repo", role: "main", config });
    expect(p).toContain(
      "Add --now only when the user's message names one of these tiers (big, small) by name. \"Start now\", \"don't ask me again\" or a confirmation is not a tier choice: still propose, tell the user, and end your turn.",
    );
    expect(p).not.toContain("If the user named a tier themselves, add --now.");
  });
});

describe("agt guide line", () => {
  test("AGENTS.md carries it for coordinator and worker", () => {
    const md = agentsMd({ root: "/repo", thread: T });
    expect(md).toContain("- When unsure how to do something with agt, run: agt guide coordinator");
    expect(md).toContain("\nWhen unsure how to do something with agt, run: agt guide worker");
    expect(md).not.toContain("- When unsure how to do something with agt, run: agt guide worker");
  });
});
