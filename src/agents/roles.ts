import type { Config, RoleAgent } from "../config/config.ts";
import type { AgentKind, SessionRole } from "../domain/types.ts";

export type { RoleAgent };

/** Accepted effort values per agent. OpenCode variants are provider-defined, so any non-empty string is allowed. */
export const EFFORTS: Record<AgentKind, readonly string[]> = {
  "claude-code": ["low", "medium", "high", "xhigh", "max"],
  opencode: [],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  omp: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"],
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
