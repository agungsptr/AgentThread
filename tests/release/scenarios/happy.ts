import { AGENT_KINDS, type AgentKind } from "../../../src/domain/types.ts";
import type { RoleAgents } from "../harness.ts";
import { happyFlow, tiers, type Scenario } from "./common.ts";

/** The daily combination: main and coordinator on Claude Code, workers on OpenCode. */
export const DAILY: RoleAgents = { main: "claude-code", coordinator: "claude-code", worker: "opencode" };

const happy = (id: string, agents: RoleAgents): Scenario => ({ id, agents, config: { agents: tiers(agents) }, run: happyFlow });

/**
 * §12.7 happy flow: every agent as coordinator (workers on the daily default) and every agent as worker (coordinator
 * on the daily default), minus duplicates. `happy-claude-code` is the single-vendor row (Claude Code everywhere).
 */
export function happyScenarios(): Scenario[] {
  const rows = new Map<string, Scenario>();
  const key = (a: RoleAgents) => `${a.main}/${a.coordinator}/${a.worker}`;
  const add = (id: string, agents: RoleAgents) => {
    if (![...rows.values()].some((s) => key(s.agents) === key(agents))) rows.set(id, happy(id, agents));
  };
  add("happy-claude-code", { main: "claude-code", coordinator: "claude-code", worker: "claude-code" });
  add("happy-daily", DAILY);
  for (const c of AGENT_KINDS as readonly AgentKind[]) add(`happy-coord-${c}`, { ...DAILY, coordinator: c });
  for (const w of AGENT_KINDS as readonly AgentKind[]) add(`happy-worker-${w}`, { ...DAILY, worker: w });
  return [...rows.values()];
}
