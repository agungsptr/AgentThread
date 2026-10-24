import { join } from "node:path";
import type { Config } from "../config/config.ts";
import type { AgentKind, SessionRole } from "../domain/types.ts";
import { allowedTools, hookSettings } from "./claude.ts";
import type { RoleAgent } from "./roles.ts";

export interface LaunchInput {
  role: SessionRole;
  run: RoleAgent;
  config: Config;
  root: string;
  worktree?: string;
  gitCommonDir?: string;
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
  launch(o: LaunchInput): { args: string[]; env: Record<string, string> };
  promptArgs(text: string): string[];
  capabilities: { hooks: boolean; contextSize: boolean; preCompact: boolean };
}

const positional = (text: string): string[] => [text];
const NO_HOOKS = { hooks: false, contextSize: false, preCompact: false };

const claudeAdapter: AgentAdapter = {
  agent: "claude-code",
  herdrKind: "claude",
  bin: "claude",
  instructionFiles: ["CLAUDE.md"],
  prompt: "positional",
  launch({ role, run, config, root }) {
    // Pushing is the user's call: denied by Claude Code's own rules, whatever the permission mode.
    const settings = { ...hookSettings(), permissions: { deny: ["Bash(git push:*)"] } };
    const args = config.agents.autonomous
      ? ["--permission-mode", "bypassPermissions", "--settings", JSON.stringify({ ...settings, skipDangerousModePermissionPrompt: true })]
      : [
          "--permission-mode", config.agents.claude.permission_mode,
          "--allowed-tools", allowedTools(role, config, root).join(","),
          "--settings", JSON.stringify(settings),
        ];
    if (run.model) args.push("--model", run.model);
    if (run.effort) args.push("--effort", run.effort);
    return { args, env: {} };
  },
  promptArgs: positional,
  capabilities: { hooks: true, contextSize: true, preCompact: true },
};

const opencodeAdapter: AgentAdapter = {
  agent: "opencode",
  herdrKind: "opencode",
  bin: "opencode",
  instructionFiles: [],
  prompt: "flag",
  launch({ role, run, config, env = process.env }) {
    const model = run.model ? { model: run.effort ? `${run.model}#${run.effort}` : run.model } : {};
    // Not autonomous: OpenCode asks for every permission. Release e2e only (tests/release): AGT_E2E_OPENCODE_ASK=<role,...>
    // starts those roles asking too, so the blocked-worker scenario can see a real approval dialog.
    const ask = !config.agents.autonomous || (env.AGT_E2E_OPENCODE_ASK ?? "").split(",").includes(role);
    // Pushing is the user's call: denied by OpenCode's own bash rules (the last matching rule wins, so "*" comes first).
    const permission = ask
      ? { "*": "ask", bash: { "*": "ask", "git push*": "deny" } }
      : { "*": "allow", external_directory: "allow", doom_loop: "allow", bash: { "*": "allow", "git push*": "deny" } };
    // --standalone: a TUI attached to OpenCode's shared background service gets that service's config, and our
    // OPENCODE_CONFIG_CONTENT (model, permissions) would be ignored; a private server reads it.
    return { args: ask ? ["--standalone"] : ["--standalone", "--auto"], env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...model, permission }) } };
  },
  promptArgs: (text) => ["--prompt", text],
  capabilities: NO_HOOKS,
};

const codexAdapter: AgentAdapter = {
  agent: "codex",
  herdrKind: "codex",
  bin: "codex",
  instructionFiles: [],
  prompt: "positional",
  launch({ run, config, root, worktree, gitCommonDir }) {
    // Codex asks once per project whether to trust it, keyed by the main checkout (a worktree resolves to it), and
    // would stall a pane on that dialog. A `-c` dotted path splits on every '.', so the path keys go in an inline table.
    const trusted = [...new Set([root, ...(worktree ? [worktree] : [])])].map((p) => `${JSON.stringify(p)}={trust_level="trusted"}`);
    return {
      args: [
        ...(run.model ? ["-m", run.model] : []),
        ...(run.effort ? ["-c", `model_reasoning_effort="${run.effort}"`] : []),
        "-s", "workspace-write",
        "-a", config.agents.autonomous ? "never" : "on-request",
        "-c", "sandbox_workspace_write.network_access=true",
        "--add-dir", gitCommonDir ?? join(root, ".git"),
        "--add-dir", join(root, ".agentthread"),
        "--search",
        "-c", `projects={${trusted.join(",")}}`,
      ],
      env: {},
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
