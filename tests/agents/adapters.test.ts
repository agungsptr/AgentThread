import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterFor, claudeSettings, claudeSettingsFile, prepareLaunch } from "../../src/agents/adapters.ts";
import { hookSettings } from "../../src/agents/claude.ts";
import { ConfigSchema, DEFAULT_CONFIG } from "../../src/config/config.ts";
import { shellQuote } from "../../src/herdr/bridge.ts";
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

/** The settings a Claude launch names: the file `--settings` points at, as prepare writes it. */
const claudeSettingsOf = (input: Parameters<typeof claudeSettings>[0]) => claudeSettings(input) as { permissions: { allow?: string[]; deny: string[] } } & Record<string, unknown>;

test("claude autonomous: bypassPermissions, the settings file, model and effort, no allow rules", () => {
  const input = { ...base, run: { agent: "claude-code", model: "claude-opus-5-5", effort: "high" } } as const;
  const { args, env } = adapterFor("claude-code").launch(input);
  const settings = { ...hookSettings(), permissions: { deny: ["Bash(git push:*)"] }, skipDangerousModePermissionPrompt: true };
  expect(claudeSettings(input)).toEqual(settings);
  expect(args).toEqual(["--permission-mode", "bypassPermissions", "--settings", claudeSettingsFile("/r", settings), "--model", "claude-opus-5-5", "--effort", "high"]);
  expect(args).not.toContain("--allowed-tools");
  expect(env).toEqual({});
});

test("claude non-autonomous keeps the permission mode; its allowed tools are the settings' allow rules", () => {
  const input = { ...base, config: nonAuto, run: { agent: "claude-code" } } as const;
  const { args } = adapterFor("claude-code").launch(input);
  const settings = { ...hookSettings(), permissions: { allow: ["Bash(agt *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Read(//r/.agentthread/**)"], deny: ["Bash(git push:*)"] } };
  expect(claudeSettings(input)).toEqual(settings);
  expect(args).toEqual(["--permission-mode", "acceptEdits", "--settings", claudeSettingsFile("/r", settings)]);
  const mainInput = { ...base, role: "main", config: nonAuto, run: { agent: "claude-code", model: "opus" } } as const;
  expect(claudeSettingsOf(mainInput).permissions.allow).toEqual(["Bash(agt *)"]);
  expect(adapterFor("claude-code").launch(mainInput).args.slice(-2)).toEqual(["--model", "opus"]);
});

test("I1: a claude worker of a task thread, not autonomous, may git add and git commit", () => {
  const tools = (legacy?: boolean) => claudeSettingsOf({ ...base, config: nonAuto, run: { agent: "claude-code" }, ...(legacy !== undefined ? { legacy } : {}) }).permissions.allow!.join(",");
  expect(tools(false)).toBe("Bash(agt *),Bash(git status*),Bash(git diff*),Bash(git log*),Bash(git add *),Bash(git commit *),Read(//r/.agentthread/**)");
  expect(tools(true)).toBe("Bash(agt *),Bash(git status*),Bash(git diff*),Bash(git log*),Read(//r/.agentthread/**)");
  expect(tools()).toBe("Bash(agt *),Bash(git status*),Bash(git diff*),Bash(git log*),Read(//r/.agentthread/**)");
});

/** Herdr types the agent's command line into the pane's shell: past the canonical limit (1024 bytes on macOS) it is refused. */
test("a claude launch line stays well under the terminal's canonical limit, with a profile, in both modes, for every role", () => {
  const root = "/Users/someone/Projects/Some Client/A Rather Long Workspace Name-agt";
  const profiles = ConfigSchema.parse({ agents: { claude: { profiles: [{ name: "claude-a-long-profile-name", config_dir: "/a" }, { name: "b", config_dir: "/b" }] } } });
  for (const autonomous of [true, false])
    for (const role of ["main", "coordinator", "worker"] as const) {
      const config = { ...profiles, agents: { ...profiles.agents, autonomous } };
      const input = { role, config, root, legacy: false, ticketDoc: ".docs/shared/issues/some-feature/03-a-long-ticket-name.md", profile: "claude-a-long-profile-name", run: { agent: "claude-code", model: "claude-opus-5-5", effort: "xhigh" } } as const;
      const line = ["claude", ...adapterFor("claude-code").launch(input).args].map(shellQuote).join(" ");
      expect({ role, autonomous, bytes: Buffer.byteLength(line) < 512 }).toEqual({ role, autonomous, bytes: true });
    }
});

test("claude's prepare writes the settings file the launch names, the same file for the same settings", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agt-claude-")));
  try {
    const adapter = adapterFor("claude-code");
    const input = { ...base, root, config: nonAuto, run: { agent: "claude-code" } } as const;
    const args = adapter.launch(input).args;
    const file = args[args.indexOf("--settings") + 1]!;
    expect(file.startsWith(join(root, ".agentthread", "claude-settings") + "/")).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(adapter.prepare!(input)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(claudeSettings(input));
    expect(adapter.prepare!(input)).toBe(true);
    expect(readdirSync(join(root, ".agentthread", "claude-settings"))).toHaveLength(1);
    // other settings, another file
    const coordinator = { ...input, role: "coordinator" } as const;
    expect(adapter.prepare!(coordinator)).toBe(true);
    const other = adapter.launch(coordinator).args;
    expect(other[other.indexOf("--settings") + 1]).not.toBe(file);
    expect(readdirSync(join(root, ".agentthread", "claude-settings"))).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareLaunch starts claude with the settings inline (and logs) when the file cannot be written", () => {
  const adapter = adapterFor("claude-code");
  const input = { ...base, root: "/nonexistent-agt-root/x", run: { agent: "claude-code", model: "m" } } as const;
  const msgs: string[] = [];
  const launched = prepareLaunch(adapter, input, adapter.launch(input), (m) => msgs.push(m));
  expect(launched.args).toEqual(["--permission-mode", "bypassPermissions", "--settings", JSON.stringify(claudeSettings(input)), "--model", "m"]);
  expect(msgs).toHaveLength(1);
});

// OpenCode 2 TUIs attach to a shared background service by default, whose own config wins over the TUI's
// OPENCODE_CONFIG_CONTENT (seen in the release e2e: the model setting was ignored); --standalone runs a private server.
test("opencode: --auto and config content with model variant and permissions", () => {
  const { args, env } = adapterFor("opencode").launch({ ...base, run: { agent: "opencode", model: "myrouter/gemini-flash-3.8", effort: "high" } });
  expect(args).toEqual(["--standalone", "--auto"]);
  expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
    model: "myrouter/gemini-flash-3.8#high",
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
    expect(claudeSettingsOf({ ...base, config, run: { agent: "claude-code" } }).permissions.deny).toEqual(["Bash(git push:*)"]);
    const oc = JSON.parse(adapterFor("opencode").launch({ ...base, config, run: { agent: "opencode" } }).env.OPENCODE_CONFIG_CONTENT!);
    expect(oc.permission.bash["git push*"]).toBe("deny");
    // the catch-all comes first: the last matching rule wins
    expect(Object.keys(oc.permission.bash)).toEqual(["*", "git push*"]);
  }
});

test("§13: claude passes the worker's ticket doc into its allow rules (task threads, not autonomous)", () => {
  const { permissions } = claudeSettingsOf({ ...base, config: nonAuto, legacy: false, ticketDoc: ".docs/a/02.md", run: { agent: "claude-code" } });
  const tools = permissions.allow!;
  expect(tools).toContain("Edit(//r/.docs/a/02.md)");
  expect(tools).toContain("Write(//r/.docs/a/02.md)");
  expect(tools).toContain("Read(//r/.docs/a/02.md)");
  expect(permissions.deny).toEqual(["Bash(git push:*)"]);
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

// agents.env / roles.<role>.env: the user's env for every agent agt launches, under the adapter's own env.
import { claudeAccountNote } from "../../src/agents/roles.ts";
import { expandHome } from "../../src/agents/adapters.ts";

const envConfig = (agents: object) => ConfigSchema.parse({ agents });

test("agents.env schema: keys must be identifiers and may not be AGT_* or HERDR_*", () => {
  expect(ConfigSchema.safeParse({ agents: { env: { "1X": "a" } } }).success).toBe(false);
  expect(ConfigSchema.safeParse({ agents: { env: { A: 1 } } }).success).toBe(false);
  const bad = ConfigSchema.safeParse({ agents: { env: { AGT_ROOT: "x" } } });
  expect(bad.success ? "" : bad.error.issues[0]!.message).toContain("owned by agt");
  expect(ConfigSchema.safeParse({ agents: { roles: { worker: { agent: "codex", env: { HERDR_PANE_ID: "x" } } } } }).success).toBe(false);
  expect(ConfigSchema.safeParse({ agents: { complexity: { tiers: { big: { agent: "codex", env: { AGT_X: "x" } } } } } }).success).toBe(false);
  expect(ConfigSchema.safeParse({ agents: { env: { CLAUDE_CONFIG_DIR: "~/a" } } }).success).toBe(true);
  expect(DEFAULT_CONFIG.agents).not.toHaveProperty("env");
});

test("expandHome expands a leading ~/ and $HOME", () => {
  expect(expandHome("~/a/b", "/h")).toBe("/h/a/b");
  expect(expandHome("~", "/h")).toBe("/h");
  expect(expandHome("$HOME/x:${HOME}/y", "/h")).toBe("/h/x:/h/y");
  expect(expandHome("/abs/~/x", "/h")).toBe("/abs/~/x");
  expect(expandHome("$HOMEX", "/h")).toBe("$HOMEX");
});

test("env precedence: agents.env < role env < tier env; adapter env wins for its keys; ~ expands", () => {
  const config = envConfig({
    env: { CLAUDE_CONFIG_DIR: "~/acct-a", A: "1", OPENCODE_CONFIG_CONTENT: "user" },
    roles: { worker: { agent: "opencode", env: { A: "2", B: "w" } }, main: { agent: "claude-code" } },
    complexity: { tiers: { big: { agent: "claude-code", env: { A: "3" } } } },
  });
  const home = { HOME: "/home/u" };
  const worker = adapterFor("opencode").launch({ role: "worker", run: config.agents.roles.worker, config, root: "/r", env: home });
  expect(worker.env).toMatchObject({ CLAUDE_CONFIG_DIR: "/home/u/acct-a", A: "2", B: "w" });
  expect(JSON.parse(worker.env.OPENCODE_CONFIG_CONTENT!)).toHaveProperty("permission");
  const main = adapterFor("claude-code").launch({ role: "main", run: config.agents.roles.main, config, root: "/r", env: home });
  expect(main.env).toMatchObject({ CLAUDE_CONFIG_DIR: "/home/u/acct-a", A: "1" });
  expect(main.env).not.toHaveProperty("B");
  const tier = adapterFor("claude-code").launch({ role: "coordinator", run: config.agents.complexity.tiers.big!, config, root: "/r", env: home });
  expect(tier.env.A).toBe("3");
  // never typed onto a pane: not in processEnv
  expect(main.processEnv).toEqual({ AGT_AGENT_PROCESS: "1" });
});

test("every adapter passes agents.env, and the first coordinator's tab env carries it", () => {
  const config = envConfig({ env: { CLAUDE_CONFIG_DIR: "/acct" } });
  for (const agent of AGENT_KINDS) {
    for (const role of ["main", "coordinator", "worker"] as const) expect(adapterFor(agent).launch({ ...base, role, run: { agent }, config }).env.CLAUDE_CONFIG_DIR).toBe("/acct");
  }
  expect(tabEnv({ id: "001" }, { root: "/r", config }).CLAUDE_CONFIG_DIR).toBe("/acct");
});

test("claudeAccountNote: agents.env, else the start env, else the default; none without claude-code", () => {
  expect(claudeAccountNote(envConfig({ env: { CLAUDE_CONFIG_DIR: "/acct" } }), {})).toBe("claude-code agents use CLAUDE_CONFIG_DIR=/acct");
  expect(claudeAccountNote(envConfig({}), { CLAUDE_CONFIG_DIR: "/shell" })).toBe("claude-code agents use CLAUDE_CONFIG_DIR=/shell");
  expect(claudeAccountNote(envConfig({}), {})).toBe("claude-code agents use the default Claude config (~/.claude); set agents.env.CLAUDE_CONFIG_DIR to pick an account");
  const none = envConfig({ roles: { main: { agent: "codex" }, coordinator: { agent: "codex" }, worker: { agent: "codex" } } });
  expect(claudeAccountNote(none, {})).toBeUndefined();
  const tier = envConfig({ roles: { main: { agent: "codex" }, coordinator: { agent: "codex" }, worker: { agent: "codex" } }, complexity: { tiers: { big: { agent: "claude-code", env: { CLAUDE_CONFIG_DIR: "/t" } } } } });
  expect(claudeAccountNote(tier, {})).toBe("claude-code agents use CLAUDE_CONFIG_DIR=/t");
});
