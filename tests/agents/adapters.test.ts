import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterFor, prepareLaunch } from "../../src/agents/adapters.ts";
import { hookSettings } from "../../src/agents/claude.ts";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { AGENT_KINDS } from "../../src/domain/types.ts";
import { tabEnv } from "../../src/orchestration/sessions.ts";

const base = { role: "worker", config: DEFAULT_CONFIG, root: "/r" } as const;
const OMP_OVERLAY = "/r/.agentthread/omp-compaction.yml";
const nonAuto = { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents, autonomous: false } };

test("adapterFor covers every agent kind with its herdr kind and bin", () => {
  for (const k of AGENT_KINDS) expect(adapterFor(k).agent).toBe(k);
  expect(AGENT_KINDS.map((k) => adapterFor(k).herdrKind)).toEqual(["claude", "opencode", "codex", "omp", "agy"]);
  expect(AGENT_KINDS.map((k) => adapterFor(k).bin)).toEqual(["claude", "opencode", "codex", "omp", "agy"]);
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
  expect(adapterFor("agy").promptArgs("x")).toEqual(["-i", "x"]);
  expect(adapterFor("agy").prompt).toBe("flag");
});

const AGY_SETTINGS = JSON.stringify({ permissions: { deny: ["command(git push)"] } });

test("agy autonomous: skip permissions, push deny settings, no model or effort by default", () => {
  const l = adapterFor("agy").launch({ ...base, run: { agent: "agy" } });
  expect(l.args).toEqual(["--dangerously-skip-permissions", "--settings", AGY_SETTINGS]);
  expect(l.env).toEqual({});
  expect(l.processEnv).toEqual({ AGT_AGENT_PROCESS: "1" });
  expect(adapterFor("agy").capabilities).toEqual({ hooks: false, contextSize: false, preCompact: false });
  expect(adapterFor("agy").instructionFiles).toEqual([]);
});

test("agy with model and effort; not autonomous has no skip flag", () => {
  const { args } = adapterFor("agy").launch({ ...base, run: { agent: "agy", model: "gemini-4-neon-high", effort: "xhigh" } });
  expect(args).toEqual(["--model", "gemini-4-neon-high", "--effort", "xhigh", "--dangerously-skip-permissions", "--settings", AGY_SETTINGS]);
  expect(adapterFor("agy").launch({ ...base, config: nonAuto, run: { agent: "agy" } }).args).toEqual(["--settings", AGY_SETTINGS]);
});

test("claude autonomous: bypassPermissions, skip prompt setting, model and effort, no allowed-tools", () => {
  const { args, env } = adapterFor("claude-code").launch({ ...base, run: { agent: "claude-code", model: "claude-opus-5-5", effort: "high" } });
  expect(args).toEqual([
    "--permission-mode", "bypassPermissions",
    "--settings", JSON.stringify({ ...hookSettings(), permissions: { deny: ["Bash(git push:*)"] }, skipDangerousModePermissionPrompt: true }),
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
    "--settings", JSON.stringify({ ...hookSettings(), permissions: { deny: ["Bash(git push:*)"] } }),
  ]);
  const main = adapterFor("claude-code").launch({ ...base, role: "main", config: nonAuto, run: { agent: "claude-code", model: "opus" } }).args;
  expect(main.slice(2, 4)).toEqual(["--allowed-tools", "Bash(agt *)"]);
  expect(main.slice(-2)).toEqual(["--model", "opus"]);
});

test("I1: a claude worker of a task thread, not autonomous, may git add and git commit", () => {
  const tools = (legacy?: boolean) => {
    const args = adapterFor("claude-code").launch({ ...base, config: nonAuto, run: { agent: "claude-code" }, ...(legacy !== undefined ? { legacy } : {}) }).args;
    return args[args.indexOf("--allowed-tools") + 1];
  };
  expect(tools(false)).toBe("Bash(agt *),Bash(git status*),Bash(git diff*),Bash(git log*),Bash(git add *),Bash(git commit *),Read(//r/.agentthread/**)");
  expect(tools(true)).toBe("Bash(agt *),Bash(git status*),Bash(git diff*),Bash(git log*),Read(//r/.agentthread/**)");
  expect(tools()).toBe("Bash(agt *),Bash(git status*),Bash(git diff*),Bash(git log*),Read(//r/.agentthread/**)");
});

// OpenCode 2 TUIs attach to a shared background service by default, whose own config wins over the TUI's
// OPENCODE_CONFIG_CONTENT (seen in the release e2e: the model setting was ignored); --standalone runs a private server.
test("opencode: --auto and config content with model variant and permissions", () => {
  const { args, env } = adapterFor("opencode").launch({ ...base, run: { agent: "opencode", model: "myrouter/gemini-flash", effort: "high" } });
  expect(args).toEqual(["--standalone", "--auto"]);
  expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
    model: "myrouter/gemini-flash#high",
    permission: { "*": "allow", external_directory: "allow", doom_loop: "allow", bash: { "*": "allow", "git push*": "deny" } },
  });
  const none = adapterFor("opencode").launch({ ...base, run: { agent: "opencode" } });
  expect(JSON.parse(none.env.OPENCODE_CONFIG_CONTENT!)).not.toHaveProperty("model");
});

test("opencode: the release e2e's AGT_E2E_OPENCODE_ASK makes the named roles ask for every permission", () => {
  const env = { AGT_E2E_OPENCODE_ASK: "worker" };
  const asked = adapterFor("opencode").launch({ ...base, env, run: { agent: "opencode" } });
  expect(asked.args).toEqual(["--standalone"]);
  expect(JSON.parse(asked.env.OPENCODE_CONFIG_CONTENT!)).toEqual({ permission: { "*": "ask", bash: { "*": "ask", "git push*": "deny" } } });
  // other roles stay autonomous
  const coordinator = adapterFor("opencode").launch({ ...base, role: "coordinator", env, run: { agent: "opencode" } });
  expect(coordinator.args).toEqual(["--standalone", "--auto"]);
});

test("codex: exact sandbox args; only the coordinator may write the git dir", () => {
  const coordinator = adapterFor("codex").launch({ ...base, role: "coordinator", gitCommonDir: "/r/.git", run: { agent: "codex", model: "gpt-6.1-sol", effort: "medium" } });
  expect(coordinator.args).toEqual([
    "-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="medium"',
    "-s", "workspace-write", "-a", "never",
    "-c", "sandbox_workspace_write.network_access=true",
    "--add-dir", "/r/.git", "--search",
    "-c", 'projects={"/r"={trust_level="trusted"}}',
  ]);
  // A worker never commits; write access to the git dir would let it rewrite its worktree's config.worktree (the guard).
  for (const role of ["worker", "main"] as const) {
    const { args } = adapterFor("codex").launch({ ...base, role, gitCommonDir: "/r/.git", run: { agent: "codex" } });
    expect(args).not.toContain("--add-dir");
  }
  // without gitCommonDir the coordinator falls back to <root>/.git
  expect(adapterFor("codex").launch({ ...base, role: "coordinator", run: { agent: "codex" } }).args).toContain("/r/.git");
  expect(adapterFor("codex").launch({ ...base, run: { agent: "codex" } }).args.slice(0, 2)).toEqual(["-s", "workspace-write"]);
});

test("omp: model, thinking and yolo", () => {
  expect(adapterFor("omp").launch({ ...base, run: { agent: "omp", model: "opus", effort: "high" } }).args).toEqual([
    "--config", OMP_OVERLAY, "--model", "opus", "--thinking", "high", "--approval-mode", "yolo",
  ]);
  expect(adapterFor("omp").launch({ ...base, run: { agent: "omp" } }).args).toEqual(["--config", OMP_OVERLAY, "--approval-mode", "yolo"]);
});

test("autonomous false: every adapter keeps its approval prompts", () => {
  const claude = adapterFor("claude-code").launch({ ...base, config: nonAuto, run: { agent: "claude-code" } }).args;
  expect(claude.slice(0, 2)).toEqual(["--permission-mode", "acceptEdits"]);
  expect(claude).not.toContain("bypassPermissions");

  const oc = adapterFor("opencode").launch({ ...base, config: nonAuto, run: { agent: "opencode", model: "p/m" } });
  expect(oc.args).toEqual(["--standalone"]);
  const content = JSON.parse(oc.env.OPENCODE_CONFIG_CONTENT!);
  expect(content.model).toBe("p/m");
  expect(content.permission).toEqual({ "*": "ask", bash: { "*": "ask", "git push*": "deny" } });

  const codex = adapterFor("codex").launch({ ...base, config: nonAuto, run: { agent: "codex" } }).args;
  expect(codex.slice(codex.indexOf("-a"), codex.indexOf("-a") + 2)).toEqual(["-a", "on-request"]);
  expect(codex.slice(0, 2)).toEqual(["-s", "workspace-write"]);
  expect(codex).not.toContain("never");

  const omp = adapterFor("omp").launch({ ...base, config: nonAuto, run: { agent: "omp", effort: "low" } }).args;
  expect(omp).toEqual(["--config", OMP_OVERLAY, "--thinking", "low"]);
});

// Codex asks once per project whether to trust it, keyed by the main checkout (a worktree resolves to it). A `-c`
// dotted path splits on every '.', so a path key goes in as an inline table.
test("codex: trusts the project root and the worktree", () => {
  const { args } = adapterFor("codex").launch({ ...base, worktree: "/r/.worktrees/001-x", run: { agent: "codex" } });
  expect(args.slice(-2)).toEqual(["-c", 'projects={"/r"={trust_level="trusted"},"/r/.worktrees/001-x"={trust_level="trusted"}}']);
});

// Codex resolves a trust path through symlinks (/tmp is /private/tmp on macOS), so both spellings are trusted.
test("codex: also trusts the realpath of the root and the worktree when it differs", () => {
  const real = realpathSync("/tmp");
  const wt = mkdtempSync(join("/tmp", "agt-codex-trust-"));
  try {
    const { args } = adapterFor("codex").launch({ ...base, root: "/tmp", worktree: wt, run: { agent: "codex" } });
    const keys = [...new Set(["/tmp", real, wt, realpathSync(wt)])];
    expect(real).toBe(process.platform === "darwin" ? "/private/tmp" : real);
    expect(args.slice(-2)).toEqual(["-c", `projects={${keys.map((k) => `${JSON.stringify(k)}={trust_level="trusted"}`).join(",")}}`]);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("push is denied by the vendor's own rules in both modes (Claude Code, OpenCode)", () => {
  for (const config of [DEFAULT_CONFIG, nonAuto]) {
    const claude = adapterFor("claude-code").launch({ ...base, config, run: { agent: "claude-code" } }).args;
    expect(JSON.parse(claude[claude.indexOf("--settings") + 1]!).permissions).toEqual({ deny: ["Bash(git push:*)"] });
    const oc = JSON.parse(adapterFor("opencode").launch({ ...base, config, run: { agent: "opencode" } }).env.OPENCODE_CONFIG_CONTENT!);
    expect(oc.permission.bash["git push*"]).toBe("deny");
    // the catch-all comes first: the last matching rule wins
    expect(Object.keys(oc.permission.bash)).toEqual(["*", "git push*"]);
  }
});

test("§13: claude passes the worker's ticket doc into its allow rules (task threads, not autonomous)", () => {
  const args = adapterFor("claude-code").launch({ ...base, config: nonAuto, legacy: false, ticketDoc: ".docs/a/02.md", run: { agent: "claude-code" } }).args;
  const tools = args[args.indexOf("--allowed-tools") + 1]!.split(",");
  expect(tools).toContain("Edit(//r/.docs/a/02.md)");
  expect(tools).toContain("Write(//r/.docs/a/02.md)");
  expect(tools).toContain("Read(//r/.docs/a/02.md)");
  expect(JSON.parse(args[args.indexOf("--settings") + 1]!).permissions).toEqual({ deny: ["Bash(git push:*)"] });
});

test("§13: opencode ask mode lets a task-thread worker add and commit, the coordinator switch, squash and commit; push stays denied last", () => {
  const perm = (role: "worker" | "coordinator", o: { legacy?: boolean; env?: Record<string, string> } = {}, config = nonAuto) =>
    JSON.parse(adapterFor("opencode").launch({ ...base, role, config, ...o, run: { agent: "opencode" } }).env.OPENCODE_CONFIG_CONTENT!).permission;
  expect(perm("worker", { legacy: false })).toEqual({ "*": "ask", bash: { "*": "ask", "git add *": "allow", "git commit *": "allow", "git push*": "deny" } });
  expect(perm("coordinator", { legacy: false })).toEqual({
    "*": "ask",
    bash: { "*": "ask", "git switch *": "allow", "git merge --squash *": "allow", "git commit *": "allow", "git push*": "deny" },
  });
  for (const role of ["worker", "coordinator"] as const) {
    expect(Object.keys(perm(role, { legacy: false }).bash).at(-1)).toBe("git push*");
    // legacy threads keep asking for everything
    expect(perm(role, { legacy: true })).toEqual({ "*": "ask", bash: { "*": "ask", "git push*": "deny" } });
    expect(perm(role)).toEqual({ "*": "ask", bash: { "*": "ask", "git push*": "deny" } });
  }
  // the release-only ask mode follows the same rules; the autonomous default is unchanged
  expect(perm("worker", { legacy: false, env: { AGT_E2E_OPENCODE_ASK: "worker" } }, DEFAULT_CONFIG).bash["git commit *"]).toBe("allow");
  expect(perm("worker", { legacy: false }, DEFAULT_CONFIG)).toEqual({ "*": "allow", external_directory: "allow", doom_loop: "allow", bash: { "*": "allow", "git push*": "deny" } });
});

test("§13: codex and omp have no per-command allow list; their task-thread args equal the legacy ones", () => {
  for (const agent of ["codex", "omp"] as const) {
    for (const role of ["worker", "coordinator"] as const) {
      for (const config of [DEFAULT_CONFIG, nonAuto]) {
        const launch = (legacy: boolean) => adapterFor(agent).launch({ ...base, role, config, legacy, ticketDoc: "x.md", run: { agent } }).args;
        expect(launch(false)).toEqual(launch(true));
      }
    }
  }
});

test("every agent kind's launch marks the agent's own process, never its tab env", () => {
  const root = mkdtempSync(join(tmpdir(), "agt-launch-"));
  for (const agent of AGENT_KINDS) {
    for (const role of ["main", "coordinator", "worker"] as const) {
      const launched = adapterFor(agent).launch({ ...base, root, role, run: { agent } });
      expect(launched.processEnv).toEqual({ AGT_AGENT_PROCESS: "1" });
      expect(launched.env.AGT_AGENT_PROCESS).toBeUndefined();
    }
    const config = { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents, roles: { ...DEFAULT_CONFIG.agents.roles, coordinator: { agent } } } };
    for (const t of [{ id: "001" }, { id: "002", dir: "/r/.worktrees/t1", task: "t1" }]) {
      const env = tabEnv(t, { root, config });
      expect(env.AGT_ROLE).toBe("coordinator");
      expect(env.AGT_AGENT_PROCESS).toBeUndefined();
    }
  }
  rmSync(root, { recursive: true, force: true });
});

test("every adapter has a display name for log lines", () => {
  expect((["claude-code", "opencode", "codex", "omp"] as const).map((a) => adapterFor(a).displayName)).toEqual(["Claude Code", "OpenCode", "Codex", "omp"]);
});

test("omp launch is pure: it names the overlay and writes nothing; prepare writes and refreshes it", () => {
  const root = mkdtempSync(join(tmpdir(), "agt-omp-"));
  try {
    const adapter = adapterFor("omp");
    const input = { ...base, root, run: { agent: "omp" } } as const;
    const { context_threshold: th, context_window: win } = DEFAULT_CONFIG.session.rotation;
    const args = adapter.launch(input).args;
    const file = args[args.indexOf("--config") + 1]!;
    expect(file).toBe(join(root, ".agentthread", "omp-compaction.yml"));
    expect(existsSync(join(root, ".agentthread"))).toBe(false);
    expect(adapter.prepare!(input)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(`compaction:\n  thresholdTokens: ${Math.floor(th * win)}\n`);
    const changed = { ...input, config: { ...DEFAULT_CONFIG, session: { ...DEFAULT_CONFIG.session, rotation: { ...DEFAULT_CONFIG.session.rotation, context_window: 100_000 } } } };
    expect(adapter.prepare!(changed)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(`compaction:\n  thresholdTokens: ${Math.floor(th * 100_000)}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareLaunch starts omp without --config (and logs) when the overlay cannot be written", () => {
  const adapter = adapterFor("omp");
  const input = { ...base, root: "/nonexistent-agt-root/x", run: { agent: "omp", model: "m" } } as const;
  const msgs: string[] = [];
  const launched = prepareLaunch(adapter, input, adapter.launch(input), (m) => msgs.push(m));
  expect(launched.args).toEqual(["--model", "m", "--approval-mode", "yolo"]);
  expect(msgs).toHaveLength(1);
  expect(prepareLaunch(adapterFor("codex"), input, { args: ["a"] }).args).toEqual(["a"]);
});

test("a failing prepare is not mangled by omp's fallback: another adapter without its own fallback keeps its args", () => {
  const fake = { ...adapterFor("codex"), prepare: () => false };
  const msgs: string[] = [];
  expect(prepareLaunch(fake, base as never, { args: ["--config", "x", "--model", "m"] }, (m) => msgs.push(m)).args).toEqual(["--config", "x", "--model", "m"]);
  expect(msgs).toHaveLength(1);
  const own = { ...fake, degradedArgs: (a: string[]) => a.filter((x) => x !== "--flag") };
  expect(prepareLaunch(own, base as never, { args: ["--flag", "--model", "m"] }).args).toEqual(["--model", "m"]);
});
