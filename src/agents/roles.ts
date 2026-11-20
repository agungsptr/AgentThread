import { adapterFor, agentBin } from "./adapters.ts";
import type { Config, RoleAgent } from "../config/config.ts";
import type { AgentKind, SessionRole } from "../domain/types.ts";

export type { RoleAgent };

/** Accepted effort values per agent. OpenCode variants are provider-defined, so any non-empty string is allowed. */
export const EFFORTS: Record<AgentKind, readonly string[]> = {
  "claude-code": ["low", "medium", "high", "xhigh", "max"],
  opencode: [],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  omp: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"],
  agy: ["low", "medium", "high", "xhigh", "max"],
};

export function roleAgent(config: Config, role: SessionRole): RoleAgent {
  return config.agents.roles[role];
}

/** The named tier, else the coordinator role (unknown or missing tier). */
export function tierAgent(config: Config, tier: string | undefined): RoleAgent {
  return (tier !== undefined ? config.agents.complexity.tiers[tier] : undefined) ?? config.agents.roles.coordinator;
}

export function configWarnings(config: Config): string[] {
  const c = config.agents.claude;
  if (config.agents.autonomous && (c.permission_mode !== "acceptEdits" || c.extra_allowed_tools.length > 0)) {
    return ["agents.claude.permission_mode/extra_allowed_tools are ignored while agents.autonomous is true"];
  }
  return [];
}

/**
 * One warning per role or tier whose agent's executable is missing. Main runs through agt's launch, which honours
 * AGT_<AGENT>_BIN; Herdr starts coordinators, workers and tiers by kind with the adapter's default binary.
 */
export function installWarnings(
  config: Config,
  which: (bin: string) => string | null = Bun.which,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const runs: [string, RoleAgent, string][] = [
    ...Object.entries(config.agents.roles).map(([r, run]): [string, RoleAgent, string] => [
      `agents.roles.${r}`,
      run,
      r === "main" ? agentBin(run.agent, env) : adapterFor(run.agent).bin,
    ]),
    ...Object.entries(config.agents.complexity.tiers).map(([t, run]): [string, RoleAgent, string] => [
      `agents.complexity.tiers.${t}`,
      run,
      adapterFor(run.agent).bin,
    ]),
  ];
  return runs.filter(([, , bin]) => which(bin) === null).map(([path, run]) => `${path}: ${run.agent} is not installed`);
}

/**
 * Claude Code asks once whether to trust a project directory. Main runs in the root and answers that dialog when it is
 * Claude Code; when it is not, the first Claude Code coordinator or worker would stall on the dialog in its pane.
 */
export function trustWarning(config: Config, root: string): string | undefined {
  const runs = [...Object.values(config.agents.roles), ...Object.values(config.agents.complexity.tiers)];
  if (config.agents.roles.main.agent === "claude-code" || !runs.some((r) => r.agent === "claude-code")) return undefined;
  return `claude-code agents will ask to trust ${root}; open claude once in ${root} and accept, or use claude-code for main`;
}
