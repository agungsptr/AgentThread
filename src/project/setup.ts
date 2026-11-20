import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { isMap, parse, parseDocument } from "yaml";
import { adapterFor, agentBin } from "../agents/adapters.ts";
import { EFFORTS } from "../agents/roles.ts";
import { refreshRootSkill } from "../agents/skill.ts";
import { configOrDefault, initProject } from "./init.ts";
import { writeBannedWords } from "../render/write.ts";
import { prefill, stackPrefill } from "./prefill.ts";
import { discoverRepos, isWorkspaceProject } from "./workspace.ts";
import { configPaths, deepMerge, durationMs } from "../config/config.ts";
import { AGENT_KINDS, type AgentKind } from "../domain/types.ts";

export const SETUP_HINT =
  "run agt setup (or edit .agentthread/config.yaml) to choose agents per role; using the configured defaults (claude-code unless set)";

export const NO_AGENT_HINT = "no supported agent found; install one (see README) and run agt setup";

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
  if (detected.length === 0) throw new Error("no supported agent found on PATH (claude, opencode, codex, omp or agy)");
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
    let model = "";
    let effort = "";
    const list = EFFORTS[agent];
    for (;;) {
      model = (await ask(`${label} model (blank for the agent default)`)).trim();
      let back = false;
      for (;;) {
        effort = (await ask(`${label} effort (blank for the default${list.length ? `; ${list.join(", ")}` : ""})`)).trim();
        if (effort !== "" && agent === "opencode" && !model) {
          console.error("opencode effort needs a model");
          back = true;
          break;
        }
        if (effort === "" || list.length === 0 || list.includes(effort)) break;
        console.error(`${agent} accepts ${list.join(", ")}`);
      }
      if (!back) break;
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
  const doc = parseDocument(existing);
  if (doc.contents == null) (doc as { contents: unknown }).contents = doc.createNode({});

  // A workspace records its repos and each one's default source branch (blank: keep the current one, else ask per
  // task). Answers are merged per repo and field: entries discovery does not find, and fields not asked, are kept.
  if (isWorkspaceProject(o.root)) {
    for (const [name, r] of Object.entries(discoverRepos(o.root))) {
      const current = doc.getIn(["workspace", "repos", name, "source_branch"]);
      const branch = (await ask(`${name} source branch (blank to ask per task)`, typeof current === "string" && current ? current : undefined)).trim();
      if (!isMap(doc.get("workspace"))) doc.set("workspace", doc.createNode({}));
      if (!isMap(doc.getIn(["workspace", "repos"]))) doc.setIn(["workspace", "repos"], doc.createNode({}));
      if (!isMap(doc.getIn(["workspace", "repos", name]))) doc.setIn(["workspace", "repos", name], doc.createNode({}));
      if (typeof doc.getIn(["workspace", "repos", name, "path"]) !== "string") doc.setIn(["workspace", "repos", name, "path"], r.path);
      if (branch) doc.setIn(["workspace", "repos", name, "source_branch"], branch);
    }
  }

  // Workflow values: each is asked once, defaulting to the current value, else a prefill read from the repos' files.
  // Blank keeps the default; a value cannot be cleared here (edit the file for that).
  const inPath = (path: string[]): void => {
    for (let i = 1; i <= path.length; i++) {
      const p = path.slice(0, i);
      if (!isMap(doc.getIn(p))) doc.setIn(p, doc.createNode({}));
    }
  };
  const put = (path: string[], v: unknown): void => {
    inPath(path.slice(0, -1));
    doc.setIn(path, v);
  };
  const text = async (label: string, path: string[], fallback?: string): Promise<void> => {
    const cur = doc.getIn(path);
    const def = typeof cur === "string" && cur ? cur : fallback;
    const a = (await ask(label, def)).trim();
    if (a) put(path, a);
  };
  const list = async (label: string, path: string[]): Promise<void> => {
    const cur = doc.getIn(path, true);
    const items = cur && typeof cur === "object" && "toJSON" in cur ? (cur as { toJSON(): unknown }).toJSON() : [];
    const def = Array.isArray(items) && items.length ? items.join(", ") : undefined;
    const got = (await ask(label, def)).split(",").map((x) => x.trim()).filter((x) => x !== "");
    if (got.length) put(path, doc.createNode(got));
  };
  const flag = async (label: string, path: string[]): Promise<void> => {
    const cur = doc.getIn(path);
    const def = typeof cur === "boolean" ? (cur ? "yes" : "no") : undefined;
    for (;;) {
      const a = (await ask(label, def)).trim().toLowerCase();
      if (a === "") return;
      if (["y", "yes", "true"].includes(a)) return put(path, true);
      if (["n", "no", "false"].includes(a)) return put(path, false);
      console.error("answer yes or no");
    }
  };
  const order = async (label: string, path: string[]): Promise<void> => {
    const cur = doc.getIn(path);
    const def = typeof cur === "number" ? String(cur) : undefined;
    for (;;) {
      const a = (await ask(label, def)).trim();
      if (a === "") return;
      if (/^\d+$/.test(a)) return put(path, Number(a));
      console.error("PR order must be a whole number");
    }
  };

  // Per repo (a single-repo project has one: the root itself).
  for (const [name, r] of Object.entries(discoverRepos(o.root))) {
    const base = ["workspace", "repos", name];
    const p = prefill(join(o.root, r.path));
    await text(`${name} prod branch`, [...base, "prod_branch"]);
    await text(`${name} staging branch`, [...base, "staging_branch"]);
    await order(`${name} PR order`, [...base, "pr_order"]);
    await text(`${name} unit command`, [...base, "unit"], p.unit);
    await text(`${name} typecheck command`, [...base, "typecheck"], p.typecheck);
    if (isMap(doc.getIn(base)) && typeof doc.getIn([...base, "path"]) !== "string") doc.setIn([...base, "path"], r.path);
  }

  const rootPrefill = prefill(o.root);
  const stack = stackPrefill(rootPrefill.makeTargets);
  await text("chat language", ["workflow", "chat_language"]);
  await text("file language", ["workflow", "file_language"]);
  await text("stack restart command ({task} = the task id)", ["workflow", "stack", "restart"], stack.restart);
  await text("stack status command", ["workflow", "stack", "status"], stack.status);
  await text("e2e stage 2 command", ["workflow", "e2e", "stage2"], rootPrefill.e2e);
  await text("e2e stage 3 command", ["workflow", "e2e", "stage3"]);
  await text("e2e stage 4 command", ["workflow", "e2e", "stage4"]);
  await text("e2e baseline path", ["workflow", "e2e", "baseline"]);
  await text("migration tool", ["workflow", "migration", "tool"]);
  await text("migration table", ["workflow", "migration", "table"]);
  await flag("production migrates on start (yes/no)", ["workflow", "migration", "prod_migrates_on_start"]);
  await text("production read command", ["workflow", "prod_read"]);
  await list("browser URLs (comma-separated)", ["workflow", "browser", "urls"]);
  await text("browser login note path", ["workflow", "browser", "login_note"]);
  await list("banned words (comma-separated)", ["workflow", "banned_words"]);
  await list("never-commit paths (comma-separated)", ["workflow", "never_commit"]);
  await list("read-first paths (comma-separated)", ["workflow", "read_first"]);
  await text("report word for done", ["workflow", "report_words", "done"]);
  await text("report word for blocked", ["workflow", "report_words", "blocked"]);

  if (!isMap(doc.get("agents"))) doc.set("agents", doc.createNode({}));
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

/**
 * For `agt init` / `agt start`: run setup on a TTY, else print the hint and carry on with defaults. With no agent
 * installed there is nothing to choose, so a TTY gets the no-agent hint and the defaults too (never a wizard that
 * cannot finish).
 */
export async function setupIfNeeded(root: string, env: Env, isTTY: boolean = !!process.stdin.isTTY): Promise<void> {
  if (!needsSetup(root, env)) return;
  if (!isTTY) console.error(SETUP_HINT);
  else if (detectAgents(Bun.which, env).length === 0) console.error(NO_AGENT_HINT);
  else await setupOnTty(root, env);
}

/** `agt init`: create the project, print `initialized`, then offer setup. Init succeeds even with no agent installed. */
export async function initCommand(root: string, env: Env, name: string | undefined, isTTY: boolean = !!process.stdin.isTTY): Promise<number> {
  initProject(root, name, env);
  console.log("initialized");
  await setupIfNeeded(root, env, isTTY);
  // Setup may have just written banned_words.
  writeBannedWords(root, configOrDefault(root, env));
  refreshRootSkill(root, env);
  return 0;
}
