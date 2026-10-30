import { AGENT_KINDS, type AgentKind } from "../../../src/domain/types.ts";
import { MIXED_MAIN_ROOT, type RoleAgents } from "../harness.ts";
import { happyFlow, tiers, type H, type Scenario } from "./common.ts";

/** The daily combination: main and coordinator on Claude Code, workers on OpenCode. */
export const DAILY: RoleAgents = { main: "claude-code", coordinator: "claude-code", worker: "opencode" };

const happy = (id: string, agents: RoleAgents): Scenario => ({ id, agents, config: { agents: tiers(agents) }, run: happyFlow });

/** `agt start` warns that Claude Code roles will ask to trust the root when main is another agent (README). */
async function trustWarned(h: H): Promise<void> {
  const want = `agt: warning: claude-code agents will ask to trust ${h.root}`;
  let seen = false;
  for (let i = 0; i < 15 && !seen; i++) {
    seen = (await h.herdr.read(h.mainPane, 400)).includes(want);
    if (!seen) await Bun.sleep(1_000);
  }
  h.check("agt start printed the trust warning", seen, want);
}

/**
 * §12.7 happy flow: every agent as coordinator (workers on the daily default) and every agent as worker (coordinator
 * on the daily default), minus duplicates. `happy-claude-code` is the single-vendor row (Claude Code everywhere);
 * `happy-mixed-main` puts main on OpenCode over Claude Code coordinator and worker (the trust-dialog case).
 */
export function happyScenarios(): Scenario[] {
  const rows = new Map<string, Scenario>();
  const key = (a: RoleAgents) => `${a.main}/${a.coordinator}/${a.worker}`;
  const add = (id: string, agents: RoleAgents) => {
    if (![...rows.values()].some((s) => key(s.agents) === key(agents))) rows.set(id, happy(id, agents));
  };
  add("happy-claude-code", { main: "claude-code", coordinator: "claude-code", worker: "claude-code" });
  add("happy-daily", DAILY);
  // Main is not Claude Code, so nothing trusts the project for the Claude Code coordinator and worker beforehand.
  const mixed: RoleAgents = { main: "opencode", coordinator: "claude-code", worker: "claude-code" };
  if (!rows.has("happy-mixed-main")) {
    rows.set("happy-mixed-main", {
      ...happy("happy-mixed-main", mixed),
      // The folder the user trusted once (docs/release-e2e.md): its .worktrees/ inherit the trust.
      scratchAt: MIXED_MAIN_ROOT,
      async run(h) {
        await trustWarned(h);
        await happyFlow(h);
      },
    });
  }
  for (const c of AGENT_KINDS as readonly AgentKind[]) add(`happy-coord-${c}`, { ...DAILY, coordinator: c });
  for (const w of AGENT_KINDS as readonly AgentKind[]) add(`happy-worker-${w}`, { ...DAILY, worker: w });
  return [...rows.values()];
}
