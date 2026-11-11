import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config/config.ts";
import type { AgentKind, SessionRole } from "../domain/types.ts";
import { allowedTools, hookSettings } from "./claude.ts";
import type { RoleAgent } from "./roles.ts";
import { CLAUDE_TRUST_PROMPT, type TrustPrompt } from "./trust.ts";

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
  /** The launching process's env (default process.env); only the release e2e's AGT_E2E_* overrides are read from it. */
  env?: Record<string, string | undefined>;
}

export interface AgentAdapter {
  agent: AgentKind;
  /** The `--kind` Herdr is given, e.g. "claude". */
  herdrKind: "claude" | "opencode" | "codex" | "omp";
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
   */
  launch(o: LaunchInput): { args: string[]; env: Record<string, string>; processEnv: Record<string, string> };
  promptArgs(text: string): string[];
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
  herdrKind: "claude",
  bin: "claude",
  instructionFiles: ["CLAUDE.md"],
  prompt: "positional",
  launch({ role, run, config, root, legacy, ticketDoc }) {
    // Pushing is the user's call: denied by Claude Code's own rules, whatever the permission mode.
    const settings = { ...hookSettings(), permissions: { deny: ["Bash(git push:*)"] } };
    const args = config.agents.autonomous
      ? ["--permission-mode", "bypassPermissions", "--settings", JSON.stringify({ ...settings, skipDangerousModePermissionPrompt: true })]
      : [
          "--permission-mode", config.agents.claude.permission_mode,
          "--allowed-tools", allowedTools(role, config, root, { ...(legacy === undefined ? {} : { legacy }), ...(ticketDoc === undefined ? {} : { doc: ticketDoc }) }).join(","),
          "--settings", JSON.stringify(settings),
        ];
    if (run.model) args.push("--model", run.model);
    if (run.effort) args.push("--effort", run.effort);
    return { args, env: {}, processEnv: processEnv() };
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

const ompAdapter: AgentAdapter = {
  agent: "omp",
  herdrKind: "omp",
  bin: "omp",
  instructionFiles: [],
  prompt: "positional",
  launch({ run, config }) {
    return {
      args: [
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

const ADAPTERS: Record<AgentKind, AgentAdapter> = {
  "claude-code": claudeAdapter,
  opencode: opencodeAdapter,
  codex: codexAdapter,
  omp: ompAdapter,
};

export function adapterFor(agent: AgentKind): AgentAdapter {
  const a = (ADAPTERS as Partial<Record<string, AgentAdapter>>)[agent];
  if (!a) throw new Error(`no adapter for agent ${agent}`);
  return a;
}

/** Every adapter's trust dialog: the daemon, which delivers notices by pane, checks a screen against them all. */
export function trustPrompts(): TrustPrompt[] {
  return Object.values(ADAPTERS).flatMap((a) => (a.trustPrompt ? [a.trustPrompt] : []));
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
};

/**
 * The executable `agt start` runs for main: AGT_<AGENT>_BIN, else the adapter's default. Coordinators and workers
 * start through `herdr agent start --kind`, so Herdr picks their executable.
 */
export function agentBin(agent: AgentKind, env: Record<string, string | undefined> = process.env): string {
  return env[BIN_ENV[agent]] || adapterFor(agent).bin;
}
