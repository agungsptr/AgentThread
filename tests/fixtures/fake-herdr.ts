#!/usr/bin/env bun
// Test double for the herdr CLI. State lives in the JSON file named by $FAKE_HERDR_STATE.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

interface FakeState {
  next: number;
  tabs: string[];
  panes: string[];
  calls: string[][];
  fail?: string[];
  /** Error code to fail with per "group sub" in `fail`; defaults to server_unavailable. */
  failCode?: Record<string, string>;
  hang?: string[];
  envs: (string | null)[];
  agents?: string[];
  agentPanes?: string[];
  status?: Record<string, string>;
  kinds?: Record<string, string>;
  /** The tab each pane is in; panes seeded without one belong to no tab. */
  paneTab?: Record<string, string>;
  /** When set, tab create fails workspace_not_found for any other workspace. */
  workspaces?: string[];
  /** The pane each entry of `agents` started in. */
  agentStartPanes?: string[];
  /** The next this-many agent starts fail agent_pane_busy, as real Herdr does before a new pane's shell is at its prompt. */
  busyStarts?: number;
}

const file = process.env.FAKE_HERDR_STATE;
if (!file) {
  console.error(JSON.stringify({ error: { code: "fake_misconfigured", message: "FAKE_HERDR_STATE not set" } }));
  process.exit(1);
}
// Calls run concurrently (the poller, spawn jobs, the test itself): every read-modify-write holds a lock, and writes
// are atomic, so no call loses another's change and no reader sees a half-written file. See withFakeLock in helpers.ts.
const lock = `${file}.lock`;
for (let i = 0; ; i++) {
  try {
    mkdirSync(lock);
    break;
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > 5000) rmSync(lock, { recursive: true, force: true }); // a killed holder
    } catch {}
    Bun.sleepSync(2);
  }
}
const save = (s: FakeState) => {
  writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(s));
  renameSync(`${file}.${process.pid}.tmp`, file);
  rmSync(lock, { recursive: true, force: true });
};
const state: FakeState = existsSync(file)
  ? { next: 0, tabs: [], panes: [], calls: [], envs: [], ...JSON.parse(readFileSync(file, "utf8")) }
  : { next: 0, tabs: [], panes: [], calls: [], envs: [] };
const args = process.argv.slice(2);
state.calls.push(args);
state.envs.push(process.env.HERDR_SOCKET_PATH ?? null);

function ok(result: unknown): never {
  save(state);
  console.log(JSON.stringify({ id: "fake", result }));
  process.exit(0);
}

function fail(code: string, message: string): never {
  save(state);
  console.error(JSON.stringify({ error: { code, message } }));
  process.exit(1);
}

const [group, sub, target] = args;

if (state.hang?.includes(`${group} ${sub}`)) {
  save(state);
  await Bun.sleep(1e9);
}
if (state.fail?.includes(`${group} ${sub}`)) {
  const code = state.failCode?.[`${group} ${sub}`];
  // Real Herdr keeps an agent that is blocked at a startup dialog: it is listed (blocked) and its name resolves.
  if (group === "agent" && sub === "start" && code === "agent_not_ready") {
    const pane = args[args.indexOf("--pane") + 1] ?? "";
    state.agents = [...(state.agents ?? []), target ?? ""];
    state.agentStartPanes = [...(state.agentStartPanes ?? []), pane];
    state.agentPanes = [...(state.agentPanes ?? []), pane];
    state.status = { ...state.status, [pane]: "blocked" };
  }
  fail(code ?? "server_unavailable", code ? `herdr ${group} ${sub} failed: ${code}` : "herdr server unavailable");
}

const wsOf = (id: string) => id.split(":")[0] || "w1";
const removePanes = (gone: string[]) => {
  state.panes = state.panes.filter((p) => !gone.includes(p));
  state.agentPanes = (state.agentPanes ?? []).filter((p) => !gone.includes(p));
  for (const p of gone) delete state.paneTab?.[p];
};
/** The pane an agent target (a pane id or a live agent name) resolves to; the name follows its latest start. */
const agentTarget = (t: string) => {
  if ((state.agentPanes ?? []).includes(t)) return t;
  const i = (state.agents ?? []).lastIndexOf(t);
  return i >= 0 ? (state.agentStartPanes?.[i] ?? t) : t;
};
const isAgent = (t: string) => (state.agentPanes ?? []).includes(agentTarget(t));

// Real Herdr numbers ids per server but prefixes them with their workspace, e.g. w7:t3 and w7:p9.
if (group === "tab" && sub === "create") {
  const ws = args[args.indexOf("--workspace") + 1] ?? "w1";
  if (state.workspaces && !state.workspaces.includes(ws)) fail("workspace_not_found", `workspace ${ws} not found`);
  const n = ++state.next;
  const tab = `${ws}:t${n}`;
  const pane = `${ws}:p${n}`;
  state.tabs.push(tab);
  state.panes.push(pane);
  state.paneTab = { ...state.paneTab, [pane]: tab };
  ok({ type: "tab_created", tab: { tab_id: tab, workspace_id: ws }, root_pane: { pane_id: pane, tab_id: tab, workspace_id: ws } });
}
if (group === "tab" && sub === "get") {
  if (!state.tabs.includes(target ?? "")) fail("tab_not_found", `tab ${target} not found`);
  ok({ type: "tab_info", tab: { tab_id: target } });
}
if (group === "tab" && sub === "close") {
  if (!state.tabs.includes(target ?? "")) fail("tab_not_found", `tab ${target} not found`);
  state.tabs = state.tabs.filter((t) => t !== target);
  // Closing a tab ends every pane in it, and the agents in them.
  removePanes(Object.entries(state.paneTab ?? {}).filter(([, t]) => t === target).map(([p]) => p));
  ok({ type: "ok" });
}
if (group === "pane" && sub === "get") {
  if (!state.panes.includes(target ?? "")) fail("pane_not_found", `pane ${target} not found`);
  ok({ type: "pane_info", pane: { pane_id: target } });
}
if (group === "pane" && sub === "split") {
  const from = args.includes("--pane") ? args[args.indexOf("--pane") + 1] : target;
  if (!state.panes.includes(from ?? "")) fail("pane_not_found", "pane not found");
  const n = ++state.next;
  const pane = `${wsOf(from!)}:p${n}`;
  state.panes.push(pane);
  const tab = state.paneTab?.[from!];
  if (tab) state.paneTab = { ...state.paneTab, [pane]: tab };
  ok({ type: "pane_info", pane: { pane_id: pane, ...(tab ? { tab_id: tab } : {}), workspace_id: wsOf(from!) } });
}
if (group === "pane" && sub === "run") {
  if (!state.panes.includes(target ?? "")) fail("pane_not_found", `pane ${target} not found`);
  // Real Herdr prints nothing for a successful pane run.
  save(state);
  process.exit(0);
}
if (group === "agent" && sub === "start") {
  const pane = args[args.indexOf("--pane") + 1] ?? "";
  if (!state.panes.includes(pane)) fail("agent_pane_not_found", `agent target pane ${pane} not found`);
  if ((state.busyStarts ?? 0) > 0) {
    state.busyStarts! -= 1;
    fail("agent_pane_busy", `agent target pane ${pane} is not an available shell`);
  }
  state.agents = [...(state.agents ?? []), target ?? ""];
  state.agentStartPanes = [...(state.agentStartPanes ?? []), pane];
  state.agentPanes = [...(state.agentPanes ?? []), pane];
  state.status = { ...state.status, [pane]: "idle" };
  const kind = args.indexOf("--kind");
  if (kind >= 0) state.kinds = { ...state.kinds, [pane]: args[kind + 1] ?? "" };
  ok({ type: "agent_started", agent: { name: target, pane_id: pane } });
}
if (group === "agent" && sub === "prompt") {
  if (!isAgent(target ?? "")) fail("agent_not_found", `agent target ${target} not found`);
  if (state.status?.[agentTarget(target!)] === "blocked") fail("agent_blocked", `agent ${target} is blocked`);
  ok({ type: "ok" });
}
if (group === "pane" && sub === "close") {
  if (!state.panes.includes(target ?? "")) fail("pane_not_found", `pane ${target} not found`);
  const tab = state.paneTab?.[target!];
  removePanes([target!]);
  // A tab whose last pane closes is closed with it.
  if (tab && !Object.values(state.paneTab ?? {}).includes(tab)) state.tabs = state.tabs.filter((t) => t !== tab);
  ok({ type: "ok" });
}
if (group === "agent" && sub === "list") {
  ok({
    type: "agent_list",
    agents: (state.agentPanes ?? []).map((p) => ({ pane_id: p, agent_status: state.status?.[p] ?? "idle", agent: state.kinds?.[p] ?? "claude" })),
  });
}
if (group === "agent" && sub === "get") {
  // A name follows its live agent only: once the agent's pane is gone, neither the pane nor the name resolves.
  if (!isAgent(target ?? "")) fail("agent_not_found", `agent target ${target} not found`);
  ok({ type: "agent_info", agent: { pane_id: agentTarget(target!) } });
}
ok({ type: "ok" });
