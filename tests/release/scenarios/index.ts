import type { Scenario } from "./common.ts";
import { dailyScenarios } from "./daily.ts";
import { edgeScenarios } from "./edge.ts";
import { happyScenarios } from "./happy.ts";
import { smokeScenarios } from "./smoke.ts";
import { workspaceScenarios } from "./workspace.ts";

/** Every release e2e row, in run order. */
export function allScenarios(): Scenario[] {
  return [...smokeScenarios(), ...happyScenarios(), ...dailyScenarios(), ...edgeScenarios(), ...workspaceScenarios()];
}

/** The `--list` lines: id, then each role's agent. */
export function listRows(scenarios: Scenario[] = allScenarios()): string[] {
  return scenarios.map((s) => `${s.id.padEnd(28)} main=${s.agents.main} coordinator=${s.agents.coordinator} worker=${s.agents.worker}`);
}
