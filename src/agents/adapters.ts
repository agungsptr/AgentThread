import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config/config.ts";
import type { AgentKind, SessionRole } from "../domain/types.ts";
import { allowedTools, hookSettings } from "./claude.ts";
import { expandHome, profileDir } from "./profiles.ts";
import type { RoleAgent } from "./roles.ts";
import { AGY_TRUST_PROMPT, CLAUDE_TRUST_PROMPT, type TrustPrompt } from "./trust.ts";

export interface LaunchInput {
  role: SessionRole;
  run: RoleAgent;
  config: Config;
  root: string;
  worktree?: string;
  gitCommonDir?: string;
  /** False for a task thread (a thread directory with repo worktrees), whose workers commit; absent or true: legacy. */
  legacy?: boolean;
  /** A task-thread worker's ticket doc (workspace-root-relative): the one file outside its worktree it may write. */
  ticketDoc?: string;
  /** The Claude profile this launch runs on (2 or more configured): sets CLAUDE_CONFIG_DIR, the statusLine and the rate_limit hook. */
  profile?: string;
  /** The launching process's env (default process.env); only the release e2e's AGT_E2E_* overrides are read from it. */
  env?: Record<string, string | undefined>;
}

export interface AgentAdapter {
  agent: AgentKind;
  /** The agent's name as people know it, for log lines (e.g. "Claude Code"). */
  displayName: string;
  /** The `--kind` Herdr is given, e.g. "claude". */
  herdrKind: "claude" | "opencode" | "codex" | "omp" | "agy";
  /**
   * Default executable of main's launch by `agt start`, overridden there by AGT_<AGENT>_BIN. Coordinators and workers
   * are started by Herdr from `herdrKind`, which picks the executable itself; the override does not reach them.
   */
  bin: string;
  /** Extra symlinks to AGENTS.md this agent reads. */
  instructionFiles: string[];
  /** How a first message is passed on the command line (main only). */
  prompt: "positional" | "flag";
  /**
   * `env` is the adapter's own env (also merged into a thread tab's env); `processEnv` is set on the agent's own process
   * only (its split pane's env, exported in a root pane's shell, main's spawn env), never in a tab env.
   * Contract: neither may ever hold credentials: both may be typed onto a pane's screen (an export in a root pane).
   */
  launch(o: LaunchInput): { args: string[]; env: Record<string, string>; processEnv: Record<string, string> };
  promptArgs(text: string): string[];
  /** Writes files `launch()` names; run it just before the agent starts (launch itself stays pure). False: it failed. */
  prepare?(o: LaunchInput): boolean;
  /** The args to start with when `prepare` failed: `launch()`'s args minus whatever names the files it could not write. */
  degradedArgs?(args: string[]): string[];
  capabilities: { hooks: boolean; contextSize: boolean; preCompact: boolean };
  /**
   * The agent's one-time folder-trust dialog, which agt answers itself when the agent starts in a folder agt created
   * (under `<root>/.worktrees/`) and Herdr reports it blocked (see src/agents/trust.ts: the trusting option is confirmed
   * selected on screen before it is picked).
   */
  trustPrompt?: TrustPrompt;
}

const positional = (text: string): string[] => [text];

/**
 * Marks an agent's own process, so the git hooks apply role rules to agents only: a user's shell split in a thread tab
 * inherits the tab's AGT_ROLE=coordinator, and the first coordinator runs without AGT_SESSION.
 */
export const AGENT_PROCESS_ENV: Readonly<Record<string, string>> = { AGT_AGENT_PROCESS: "1" };
const processEnv = () => ({ ...AGENT_PROCESS_ENV });
const NO_HOOKS = { hooks: false, contextSize: false, preCompact: false };

const claudeAdapter: AgentAdapter = {
  agent: "claude-code",
  displayName: "Claude Code",
  herdrKind: "claude",
  bin: "claude",
  instructionFiles: ["CLAUDE.md"],
  prompt: "positional",
  launch({ role, run, config, root, legacy, ticketDoc, profile, env = process.env }) {
    // Pushing is the user's call: denied by Claude Code's own rules, whatever the permission mode.
    const settings = { ...hookSettings(profile ? { profile, root } : undefined), permissions: { deny: ["Bash(git push:*)"] } };
    const args = config.agents.autonomous
      ? ["--permission-mode", "bypassPermissions", "--settings", JSON.stringify({ ...settings, skipDangerousModePermissionPrompt: true })]
      : [
          "--permission-mode", config.agents.claude.permission_mode,
          "--allowed-tools", allowedTools(role, config, root, { ...(legacy === undefined ? {} : { legacy }), ...(ticketDoc === undefined ? {} : { doc: ticketDoc }) }).join(","),
          "--settings", JSON.stringify(settings),
        ];
    if (run.model) args.push("--model", run.model);
    if (run.effort) args.push("--effort", run.effort);
    const dir = profile ? profileDir(config, profile, env) : undefined;
    const out: Record<string, string> = dir !== undefined ? { CLAUDE_CONFIG_DIR: dir } : {};
    return { args, env: out, processEnv: processEnv() };
  },
  promptArgs: positional,
  capabilities: { hooks: true, contextSize: true, preCompact: true },
  // The cursor starts on "No, exit"; the second option trusts the folder. Claude's own config is never read or written.
  trustPrompt: CLAUDE_TRUST_PROMPT,
};

/** The git commands a task-thread role runs without asking in OpenCode's ask mode (§13): workers commit, the coordinator squashes. */
const OPENCODE_GIT: Record<SessionRole, Record<string, "allow">> = {
  main: {},
  worker: { "git add *": "allow", "git commit *": "allow" },
  coordinator: { "git switch *": "allow", "git merge --squash *": "allow", "git commit *": "allow" },
};

const opencodeAdapter: AgentAdapter = {
  agent: "opencode",
  displayName: "OpenCode",
  herdrKind: "opencode",
  bin: "opencode",
  instructionFiles: [],
  prompt: "flag",
  launch({ role, run, config, legacy, env = process.env }) {
    const model = run.model ? { model: run.effort ? `${run.model}#${run.effort}` : run.model } : {};
    // Not autonomous: OpenCode asks for every permission. Release e2e only (tests/release): AGT_E2E_OPENCODE_ASK=<role,...>
    // starts those roles asking too, so the blocked-worker scenario can see a real approval dialog.
    const ask = !config.agents.autonomous || (env.AGT_E2E_OPENCODE_ASK ?? "").split(",").includes(role);
    // Pushing is the user's call: denied by OpenCode's own bash rules (the last matching rule wins, so "*" comes first
    // and the push deny last). Asking, a task thread's roles may still run their own git work (§13) without approval.
    const permission = ask
      ? { "*": "ask", bash: { "*": "ask", ...(legacy === false ? OPENCODE_GIT[role] : {}), "git push*": "deny" } }
      : { "*": "allow", external_directory: "allow", doom_loop: "allow", bash: { "*": "allow", "git push*": "deny" } };
    // --standalone: a TUI attached to OpenCode's shared background service gets that service's config, and our
    // OPENCODE_CONFIG_CONTENT (model, permissions) would be ignored; a private server reads it.
    return { args: ask ? ["--standalone"] : ["--standalone", "--auto"], env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...model, permission }) }, processEnv: processEnv() };
  },
  promptArgs: (text) => ["--prompt", text],
  capabilities: NO_HOOKS,
};

/** The realpath of `p` when it exists and differs from `p`. */
function realpathOf(p: string): string[] {
  try {
    const real = realpathSync(p);
    return real === p ? [] : [real];
  } catch {
    return [];
  }
}

const codexAdapter: AgentAdapter = {
  agent: "codex",
  displayName: "Codex",
  herdrKind: "codex",
  bin: "codex",
  instructionFiles: [],
  prompt: "positional",
  launch({ role, run, config, root, worktree, gitCommonDir }) {
    // Codex asks once per project whether to trust it, keyed by the main checkout (a worktree resolves to it), and
    // would stall a pane on that dialog. A `-c` dotted path splits on every '.', so the path keys go in an inline table.
    // Codex may key a path by its realpath (/tmp is /private/tmp on macOS), so a differing realpath is trusted too.
    const paths = [root, ...(worktree ? [worktree] : [])].flatMap((p) => [p, ...realpathOf(p)]);
    const trusted = [...new Set(paths)].map((p) => `${JSON.stringify(p)}={trust_level="trusted"}`);
    return {
      args: [
        ...(run.model ? ["-m", run.model] : []),
        ...(run.effort ? ["-c", `model_reasoning_effort="${run.effort}"`] : []),
        "-s", "workspace-write",
        "-a", config.agents.autonomous ? "never" : "on-request",
        "-c", "sandbox_workspace_write.network_access=true",
        // Commits from a worktree write the main repository's git dir, outside the sandbox. Only the coordinator commits:
        // a worker that could write it could also rewrite its worktree's config.worktree and unhook the commit guard.
        // No add-dir for <root>/.agentthread: agents only read it, and the daemon socket is in /tmp/agt-<uid>.
        ...(role === "coordinator" ? ["--add-dir", gitCommonDir ?? join(root, ".git")] : []),
        "--search",
        "-c", `projects={${trusted.join(",")}}`,
      ],
      env: {},
      processEnv: processEnv(),
    };
  },
  promptArgs: positional,
  capabilities: NO_HOOKS,
};

const OMP_OVERLAY = "omp-compaction.yml";
const ompOverlayPath = (root: string) => join(root, ".agentthread", OMP_OVERLAY);

/**
 * omp's `compaction.thresholdTokens` (documented in omp's docs/compaction.md) is a fixed trigger in tokens. Writes the
 * overlay `launch()` names under `<root>/.agentthread/` when its content is missing or stale; false when it cannot be written.
 */
function prepareOmp({ root, config }: LaunchInput): boolean {
  const { context_threshold, context_window } = config.session.rotation;
  const text = `compaction:\n  thresholdTokens: ${Math.floor(context_threshold * context_window)}\n`;
  const file = ompOverlayPath(root);
  try {
    let current: string | undefined;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      // Not written yet (or unreadable): treated as stale and rewritten below.
    }
    if (current !== text) {
      mkdirSync(join(root, ".agentthread"), { recursive: true });
      writeFileSync(file, text);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs the adapter's prepare step (if any) just before its agent starts, and returns the launch with the files it names
 * dropped when preparing failed (the agent then starts without them; `onFail` logs once).
 */
export function prepareLaunch<L extends { args: string[] }>(adapter: AgentAdapter, input: LaunchInput, launched: L, onFail: (msg: string) => void = () => {}): L {
  if (!adapter.prepare || adapter.prepare(input)) return launched;
  onFail(`cannot write the ${adapter.displayName} launch files under ${join(input.root, ".agentthread")}; starting without them`);
  return adapter.degradedArgs ? { ...launched, args: adapter.degradedArgs([...launched.args]) } : launched;
}

const ompAdapter: AgentAdapter = {
  agent: "omp",
  displayName: "omp",
  herdrKind: "omp",
  bin: "omp",
  instructionFiles: [],
  prompt: "positional",
  prepare: prepareOmp,
  degradedArgs(args) {
    const i = args.indexOf("--config");
    if (i >= 0) args.splice(i, 2);
    return args;
  },
  launch({ run, config, root }) {
    return {
      args: [
        "--config", ompOverlayPath(root),
        ...(run.model ? ["--model", run.model] : []),
        ...(run.effort ? ["--thinking", run.effort] : []),
        // Not autonomous: no flag, so omp's own default approval mode applies.
        ...(config.agents.autonomous ? ["--approval-mode", "yolo"] : []),
      ],
      env: {},
      processEnv: processEnv(),
    };
  },
  promptArgs: positional,
  capabilities: NO_HOOKS,
};

const agyAdapter: AgentAdapter = {
  agent: "agy",
  displayName: "Antigravity",
  herdrKind: "agy",
  bin: "agy",
  // agy reads AGENTS.md itself (and GEMINI.md, .agents/rules/*.md), but not CLAUDE.md.
  instructionFiles: [],
  prompt: "flag",
  // The cursor starts on "Yes, I trust this folder", the first option. agy's own config is never read or written.
  trustPrompt: AGY_TRUST_PROMPT,
  launch({ run, config }) {
    // Pushing is the user's call: a deny rule in the session-only settings (precedence deny > ask > allow). Whether it
    // still holds under --dangerously-skip-permissions is not stated by the docs; the pre-push hook backs it up.
    const settings = { permissions: { deny: ["command(git push)"] } };
    return {
      args: [
        ...(run.model ? ["--model", run.model] : []),
        ...(run.effort ? ["--effort", run.effort] : []),
        // Not autonomous: no flag, so agy's default mode asks for edits and commands.
        ...(config.agents.autonomous ? ["--dangerously-skip-permissions"] : []),
        "--settings", JSON.stringify(settings),
      ],
      env: {},
      processEnv: processEnv(),
    };
  },
  promptArgs: (text) => ["-i", text],
  capabilities: NO_HOOKS,
};

export { expandHome };

/**
 * The user's agents.env for a launch: agents.env, then the role's env, then the run's own env (a complexity tier's),
 * each over the last, with `~/` and $HOME expanded.
 */
export function userAgentEnv(config: Config, role: SessionRole, run: RoleAgent, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const home = env.HOME || homedir();
  const merged = { ...config.agents.env, ...config.agents.roles[role].env, ...run.env };
  return Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, expandHome(v, home)]));
}

// The user's agents.env sits under the adapter's own env: an adapter wins for the keys it owns.
const withUserEnv = (a: AgentAdapter): AgentAdapter => ({
  ...a,
  launch(o) {
    const l = a.launch(o);
    return { ...l, env: { ...userAgentEnv(o.config, o.role, o.run, o.env), ...l.env } };
  },
});

const ADAPTERS: Record<AgentKind, AgentAdapter> = {
  "claude-code": withUserEnv(claudeAdapter),
  opencode: withUserEnv(opencodeAdapter),
  codex: withUserEnv(codexAdapter),
  omp: withUserEnv(ompAdapter),
  agy: withUserEnv(agyAdapter),
};

export function adapterFor(agent: AgentKind): AgentAdapter {
  const a = (ADAPTERS as Partial<Record<string, AgentAdapter>>)[agent];
  if (!a) throw new Error(`no adapter for agent ${agent}`);
  return a;
}

/** Every adapter's display name: the release e2e harness reads agt's "trusted <folder> for <name>" log lines. */
export function agentDisplayNames(): string[] {
  return Object.values(ADAPTERS).map((a) => a.displayName);
}

/** The adapter Herdr starts as `--kind <herdrKind>` (a spawn job knows only that). */
export function adapterForHerdrKind(kind: string): AgentAdapter | undefined {
  return Object.values(ADAPTERS).find((a) => a.herdrKind === kind);
}

const BIN_ENV: Record<AgentKind, string> = {
  "claude-code": "AGT_CLAUDE_BIN",
  opencode: "AGT_OPENCODE_BIN",
  codex: "AGT_CODEX_BIN",
  omp: "AGT_OMP_BIN",
  agy: "AGT_AGY_BIN",
};

/**
 * The executable `agt start` runs for main: AGT_<AGENT>_BIN, else the adapter's default. Coordinators and workers
 * start through `herdr agent start --kind`, so Herdr picks their executable.
 */
export function agentBin(agent: AgentKind, env: Record<string, string | undefined> = process.env): string {
  return env[BIN_ENV[agent]] || adapterFor(agent).bin;
}
