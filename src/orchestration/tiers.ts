import { tierAgent } from "../agents/roles.ts";
import type { Config } from "../config/config.ts";
import type { State } from "../state/projection.ts";

/** Threads whose tier proposal has run (unpaused) for at least `timeoutMs` by `now`: the daemon auto-accepts them. */
export function dueProposals(state: State, now: number, timeoutMs: number): string[] {
  return [...state.threads.values()]
    .filter((t) => t.status !== "done" && t.tierProposal?.runningSince !== undefined && now - Date.parse(t.tierProposal.runningSince) >= timeoutMs)
    .map((t) => t.id);
}

/** `<agent> <model|default> <effort|default>` of a tier, as the config resolves it now. */
export function tierRun(config: Config, tier: string): string {
  const run = tierAgent(config, tier);
  return `${run.agent} ${run.model ?? "default"} ${run.effort ?? "default"}`;
}

/** Each configured tier as `<name> (<agent> <model|default> <effort|default>)`. */
export function tierList(config: Config): string[] {
  return Object.keys(config.agents.complexity.tiers).map((name) => `${name} (${tierRun(config, name)})`);
}
