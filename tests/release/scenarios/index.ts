import type { Scenario } from "./common.ts";
import { dailyScenarios } from "./daily.ts";
import { edgeScenarios } from "./edge.ts";
import { happyScenarios } from "./happy.ts";
import { smokeScenarios } from "./smoke.ts";

/** Every release e2e row, in run order. */
export function allScenarios(): Scenario[] {
  return [...smokeScenarios(), ...happyScenarios(), ...dailyScenarios(), ...edgeScenarios()];
}
