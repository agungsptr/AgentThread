import { expect, test } from "bun:test";
import { adapterFor } from "../../src/agents/adapters.ts";
import { hookSettings } from "../../src/agents/claude.ts";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { AGENT_KINDS } from "../../src/domain/types.ts";

const base = { role: "worker", config: DEFAULT_CONFIG, root: "/r" } as const;
const nonAuto = { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents, autonomous: false } };

test("adapterFor covers every agent kind with its herdr kind and bin", () => {
  for (const k of AGENT_KINDS) expect(adapterFor(k).agent).toBe(k);
  expect(AGENT_KINDS.map((k) => adapterFor(k).herdrKind)).toEqual(["claude", "opencode", "codex", "omp"]);
  expect(AGENT_KINDS.map((k) => adapterFor(k).bin)).toEqual(["claude", "opencode", "codex", "omp"]);
  expect(adapterFor("claude-code").instructionFiles).toEqual(["CLAUDE.md"]);
  expect(adapterFor("codex").instructionFiles).toEqual([]);
  expect(adapterFor("claude-code").capabilities).toEqual({ hooks: true, contextSize: true, preCompact: true });
});

test("adapterFor an unknown agent throws", () => {
  expect(() => adapterFor("nope" as never)).toThrow("no adapter for agent nope");
});

test("promptArgs", () => {
  for (const k of ["claude-code", "codex", "omp"] as const) expect(adapterFor(k).promptArgs("x")).toEqual(["x"]);
  expect(adapterFor("opencode").promptArgs("x")).toEqual(["--prompt", "x"]);
  expect(adapterFor("opencode").prompt).toBe("flag");
});

test("claude autonomous: bypassPermissions, skip prompt setting, model and effort, no allowed-tools", () => {
  const { args, env } = adapterFor("claude-code").launch({ ...base, run: { agent: "claude-code", model: "claude-opus-5-5", effort: "high" } });
  expect(args).toEqual([
    "--permission-mode", "bypassPermissions",
    "--settings", JSON.stringify({ ...hookSettings(), skipDangerousModePermissionPrompt: true }),
    "--model", "claude-opus-5-5",
    "--effort", "high",
  ]);
  expect(args).not.toContain("--allowed-tools");
  expect(env).toEqual({});
});

test("claude non-autonomous keeps permission mode and allowed tools", () => {
  const { args } = adapterFor("claude-code").launch({ ...base, config: nonAuto, run: { agent: "claude-code" } });
  expect(args).toEqual([
    "--permission-mode", "acceptEdits",
    "--allowed-tools", "Bash(agt *),Bash(git status*),Bash(git diff*),Bash(git log*),Read(//r/.agentthread/**)",
    "--settings", JSON.stringify(hookSettings()),
  ]);
  const main = adapterFor("claude-code").launch({ ...base, role: "main", config: nonAuto, run: { agent: "claude-code", model: "opus" } }).args;
  expect(main.slice(2, 4)).toEqual(["--allowed-tools", "Bash(agt *)"]);
  expect(main.slice(-2)).toEqual(["--model", "opus"]);
});

// OpenCode 2 TUIs attach to a shared background service by default, whose own config wins over the TUI's
// OPENCODE_CONFIG_CONTENT (seen in the release e2e: the model setting was ignored); --standalone runs a private server.
test("opencode: --auto and config content with model variant and permissions", () => {
  const { args, env } = adapterFor("opencode").launch({ ...base, run: { agent: "opencode", model: "myrouter/gemini-flash", effort: "high" } });
  expect(args).toEqual(["--standalone", "--auto"]);
  expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
    model: "myrouter/gemini-flash#high",
    permission: { "*": "allow", external_directory: "allow", doom_loop: "allow" },
  });
  const none = adapterFor("opencode").launch({ ...base, run: { agent: "opencode" } });
  expect(JSON.parse(none.env.OPENCODE_CONFIG_CONTENT!)).not.toHaveProperty("model");
});

test("opencode: the release e2e's AGT_E2E_OPENCODE_ASK makes the named roles ask for every permission", () => {
  const env = { AGT_E2E_OPENCODE_ASK: "worker" };
  const asked = adapterFor("opencode").launch({ ...base, env, run: { agent: "opencode" } });
  expect(asked.args).toEqual(["--standalone"]);
  expect(JSON.parse(asked.env.OPENCODE_CONFIG_CONTENT!)).toEqual({ permission: { "*": "ask" } });
  // other roles stay autonomous
  const coordinator = adapterFor("opencode").launch({ ...base, role: "coordinator", env, run: { agent: "opencode" } });
  expect(coordinator.args).toEqual(["--standalone", "--auto"]);
});

test("codex: exact sandbox args", () => {
  const { args } = adapterFor("codex").launch({ ...base, gitCommonDir: "/r/.git", run: { agent: "codex", model: "gpt-6.1-sol", effort: "medium" } });
  expect(args).toEqual([
    "-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="medium"',
    "-s", "workspace-write", "-a", "never",
    "-c", "sandbox_workspace_write.network_access=true",
    "--add-dir", "/r/.git", "--add-dir", "/r/.agentthread", "--search",
    "-c", 'projects={"/r"={trust_level="trusted"}}',
  ]);
  expect(adapterFor("codex").launch({ ...base, run: { agent: "codex" } }).args.slice(0, 2)).toEqual(["-s", "workspace-write"]);
});

test("omp: model, thinking and yolo", () => {
  expect(adapterFor("omp").launch({ ...base, run: { agent: "omp", model: "opus", effort: "high" } }).args).toEqual([
    "--model", "opus", "--thinking", "high", "--approval-mode", "yolo",
  ]);
  expect(adapterFor("omp").launch({ ...base, run: { agent: "omp" } }).args).toEqual(["--approval-mode", "yolo"]);
});

test("autonomous false: every adapter keeps its approval prompts", () => {
  const claude = adapterFor("claude-code").launch({ ...base, config: nonAuto, run: { agent: "claude-code" } }).args;
  expect(claude.slice(0, 2)).toEqual(["--permission-mode", "acceptEdits"]);
  expect(claude).not.toContain("bypassPermissions");

  const oc = adapterFor("opencode").launch({ ...base, config: nonAuto, run: { agent: "opencode", model: "p/m" } });
  expect(oc.args).toEqual(["--standalone"]);
  const content = JSON.parse(oc.env.OPENCODE_CONFIG_CONTENT!);
  expect(content.model).toBe("p/m");
  expect(content.permission["*"]).toBe("ask");

  const codex = adapterFor("codex").launch({ ...base, config: nonAuto, run: { agent: "codex" } }).args;
  expect(codex.slice(codex.indexOf("-a"), codex.indexOf("-a") + 2)).toEqual(["-a", "on-request"]);
  expect(codex.slice(0, 2)).toEqual(["-s", "workspace-write"]);
  expect(codex).not.toContain("never");

  const omp = adapterFor("omp").launch({ ...base, config: nonAuto, run: { agent: "omp", effort: "low" } }).args;
  expect(omp).toEqual(["--thinking", "low"]);
});

// Codex asks once per project whether to trust it, keyed by the main checkout (a worktree resolves to it). A `-c`
// dotted path splits on every '.', so a path key goes in as an inline table.
test("codex: trusts the project root and the worktree", () => {
  const { args } = adapterFor("codex").launch({ ...base, worktree: "/r/.worktrees/001-x", run: { agent: "codex" } });
  expect(args.slice(-2)).toEqual(["-c", 'projects={"/r"={trust_level="trusted"},"/r/.worktrees/001-x"={trust_level="trusted"}}']);
});
