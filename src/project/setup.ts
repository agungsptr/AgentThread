import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { parse, parseDocument } from "yaml";
import { adapterFor, agentBin } from "../agents/adapters.ts";
import { EFFORTS } from "../agents/roles.ts";
import { configPaths, deepMerge, durationMs } from "../config/config.ts";
import { AGENT_KINDS, type AgentKind } from "../domain/types.ts";

export const SETUP_HINT =
  "run agt setup (or edit .agentthread/config.yaml) to choose agents per role; using the configured defaults (claude-code unless set)";

type Env = Record<string, string | undefined>;
type Pick = { agent: AgentKind; model?: string; effort?: string };

/** Agents whose executable (AGT_<AGENT>_BIN, else the adapter's default) is on PATH. */
export function detectAgents(which: (bin: string) => string | null = Bun.which, env: Env = process.env): AgentKind[] {
  return AGENT_KINDS.filter((a) => which(agentBin(a, env)) !== null);
}

/** True when the merged config (user, then project) sets no `agents.roles`. The wizard still writes only the project file. */
export function needsSetup(root: string, env: Env = process.env): boolean {
  const p = configPaths(root, env);
  const read = (file: string): Record<string, unknown> => {
    if (!existsSync(file)) return {};
    const v = parse(readFileSync(file, "utf8")) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  };
  try {
    const roles = (deepMerge(read(p.user), read(p.project)) as { agents?: { roles?: unknown } }).agents?.roles;
    return !(typeof roles === "object" && roles !== null && Object.keys(roles).length > 0);
  } catch {
    return true;
  }
}

export async function runSetup(o: {
  root: string;
  ask: (q: string, def?: string) => Promise<string>;
  detected: AgentKind[];
  env?: Env;
}): Promise<void> {
  const { ask, detected } = o;
  if (detected.length === 0) throw new Error("no supported agent found on PATH (claude, opencode, codex or omp)");
  const defAgent: AgentKind = detected.includes("claude-code") ? "claude-code" : detected[0]!;

  const pick = async (label: string): Promise<Pick> => {
    let agent: AgentKind;
    for (;;) {
      const a = (await ask(`${label} agent (${detected.join(", ")})`, defAgent)).trim();
      if (!(AGENT_KINDS as readonly string[]).includes(a)) {
        console.error(`unknown agent '${a}'; choose one of ${AGENT_KINDS.join(", ")}`);
      } else if (!detected.includes(a as AgentKind)) {
        console.error(`${a} is not installed (looked for ${adapterFor(a as AgentKind).bin} on PATH)`);
      } else {
        agent = a as AgentKind;
        break;
      }
    }
    const model = (await ask(`${label} model (blank for the agent default)`)).trim();
    const list = EFFORTS[agent];
    let effort = "";
    for (;;) {
      effort = (await ask(`${label} effort (blank for the default${list.length ? `; ${list.join(", ")}` : ""})`)).trim();
      if (effort !== "" && agent === "opencode" && !model) console.error("opencode effort needs a model");
      else if (effort === "" || list.length === 0 || list.includes(effort)) break;
      else console.error(`${agent} accepts ${list.join(", ")}`);
    }
    return { agent, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  };

  const roles: Record<string, Pick> = {};
  for (const role of ["main", "coordinator", "worker"]) roles[role] = await pick(role);

  const tiers: Record<string, Pick> = {};
  for (;;) {
    const name = (await ask("complexity tier name (blank to finish)")).trim();
    if (name === "") break;
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
      console.error("tier name must match /^[a-z][a-z0-9_-]*$/");
    } else if (tiers[name]) {
      console.error(`tier ${name} already defined`);
    } else {
      tiers[name] = await pick(`tier ${name}`);
    }
  }

  let timeout: string;
  for (;;) {
    timeout = (await ask("seconds-to-choose timeout for a proposed tier (e.g. 10s)", "10s")).trim() || "10s";
    if (/^\d+(ms|[smhd])$/.test(timeout) && durationMs(timeout) >= 1000) break;
    console.error("timeout must look like 10s, 5m or 1h and be at least 1s");
  }

  const file = configPaths(o.root).project;
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const doc = parseDocument(parse(existing) == null ? `${existing}\nagents: {}\n` : existing);
  doc.setIn(["agents", "roles"], doc.createNode(roles));
  doc.setIn(["agents", "complexity"], doc.createNode({ timeout, tiers }));
  doc.setIn(["agents", "autonomous"], true);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, doc.toString());
}

/** Asks on the terminal with node:readline. Returns the answer function and a closer. */
export function ttyAsk(): { ask: (q: string, def?: string) => Promise<string>; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: async (q, def) => (await rl.question(def !== undefined ? `${q} [${def}]: ` : `${q}: `)).trim() || def || "",
    close: () => rl.close(),
  };
}

export async function setupOnTty(root: string, env: Env): Promise<void> {
  const t = ttyAsk();
  try {
    await runSetup({ root, ask: t.ask, detected: detectAgents(Bun.which, env), env });
  } finally {
    t.close();
  }
}

/** For `agt init` / `agt start`: run setup on a TTY, else print the hint and carry on with defaults. */
export async function setupIfNeeded(root: string, env: Env, isTTY: boolean = !!process.stdin.isTTY): Promise<void> {
  if (!needsSetup(root, env)) return;
  if (isTTY) await setupOnTty(root, env);
  else console.error(SETUP_HINT);
}
