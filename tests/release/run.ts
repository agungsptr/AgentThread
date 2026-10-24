#!/usr/bin/env bun
// Release e2e runner: bun run e2e:release [--only <id,…>] [--agents <kind,…>] [--timeout <dur>] [--list] [--keep]
// Real Herdr (an isolated named session per row), real agents, real models. See docs/release-e2e.md.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { durationMs } from "../../src/config/config.ts";
import { AGENT_KINDS, type AgentKind } from "../../src/domain/types.ts";
import { shellQuote, spawnAsync } from "../../src/herdr/bridge.ts";
import { detectAgents } from "../../src/project/setup.ts";
import {
  AGT,
  agt,
  answerTrustIn,
  type Check,
  cleanEnv,
  cleanupProcesses,
  events,
  git,
  removeScratch,
  report,
  say,
  scratchRepo,
  startHerdr,
  TimeoutError,
  waitForEvent,
  watchTrustDialogs,
  writeConfig,
  type HerdrServer,
} from "./harness.ts";
import type { H, Scenario } from "./scenarios/common.ts";
import { allScenarios } from "./scenarios/index.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    only: { type: "string" },
    agents: { type: "string" },
    timeout: { type: "string" },
    list: { type: "boolean" },
    keep: { type: "boolean" },
  },
  strict: true,
});

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

let scenarios = allScenarios();
if (values.list) {
  for (const s of scenarios) console.log(`${s.id.padEnd(28)} main=${s.agents.main} coordinator=${s.agents.coordinator} worker=${s.agents.worker}`);
  process.exit(0);
}
if (values.only) {
  const ids = values.only.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !scenarios.some((s) => s.id === id));
  if (unknown.length) {
    console.error(`unknown scenario ${unknown.join(", ")}; see --list`);
    process.exit(2);
  }
  scenarios = scenarios.filter((s) => ids.includes(s.id));
}
if (values.agents) {
  const kinds = values.agents.split(",").map((s) => s.trim());
  const bad = kinds.filter((k) => !(AGENT_KINDS as readonly string[]).includes(k));
  if (bad.length) {
    console.error(`unknown agent ${bad.join(", ")}; choose from ${AGENT_KINDS.join(", ")}`);
    process.exit(2);
  }
  scenarios = scenarios.filter((s) => [s.agents.main, s.agents.coordinator, s.agents.worker].every((a) => kinds.includes(a)));
}
const timeoutMs = durationMs(values.timeout ?? "20m");

/** Why an installed agent cannot run here (not logged in, no model), or undefined. */
const loginCache = new Map<AgentKind, Promise<string | undefined>>();
function loginProblem(agent: AgentKind): Promise<string | undefined> {
  const assumed = (process.env.AGT_E2E_ASSUME_LOGIN ?? "").split(",");
  if (assumed.includes(agent)) return Promise.resolve(undefined);
  if (!loginCache.has(agent)) {
    loginCache.set(
      agent,
      (async () => {
        if (agent === "codex") {
          const r = await spawnAsync("codex", ["login", "status"], cleanEnv(), 20_000);
          return r.exitCode === 0 && !/not logged in/i.test(r.stdout + r.stderr) ? undefined : "not logged in";
        }
        if (agent === "omp") return existsSync(join(homedir(), ".omp", "agent")) ? undefined : "not logged in";
        if (agent === "opencode") {
          const r = await spawnAsync("opencode", ["models"], cleanEnv(), 60_000);
          return r.exitCode === 0 && r.stdout.trim() ? undefined : "no usable model";
        }
        return undefined;
      })(),
    );
  }
  return loginCache.get(agent)!;
}

let teardown: (() => Promise<void>) | undefined;
let running: { sc: Scenario; t0: number } | undefined;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`${sig}: cleaning up`);
    void (teardown?.() ?? Promise.resolve()).finally(() => {
      if (running) report(running.sc, { status: "FAIL", reason: `interrupted by ${sig}`, durationS: Math.round((Date.now() - running.t0) / 1000), checks: [], notes: [] });
      process.exit(130);
    });
  });
}

async function runRow(sc: Scenario): Promise<{ status: "PASS" | "FAIL"; reason?: string; checks: Check[]; notes: string[]; server?: HerdrServer; root?: string }> {
  const checks: Check[] = [];
  const notes: string[] = [];
  const note = (m: string) => {
    notes.push(m);
    log(`[${sc.id}] ${m}`);
  };
  let server: HerdrServer | undefined;
  let root: string | undefined;
  let watcher: ReturnType<typeof watchTrustDialogs> | undefined;
  let failure: string | undefined;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    watcher?.stop();
    // The daemon first (it would react to the agents vanishing), then Herdr with every pane, then any straggler.
    if (root) await cleanupProcesses(root, note, { sweepCwd: false }).catch((e) => note(`cleanup: ${e}`));
    if (server) await server.stop().catch((e) => note(`herdr stop: ${e}`));
    if (root) await cleanupProcesses(root, note).catch((e) => note(`cleanup: ${e}`));
  };
  teardown = cleanup;
  const deadline = Date.now() + timeoutMs;
  try {
    server = await startHerdr();
    const socketLine = server.proof.split("\n").find((l) => l.startsWith("socket:"));
    note(`isolated Herdr session ${server.session}, ${socketLine} (live: ${process.env.HERDR_SOCKET_PATH ?? "none inherited"})`);
    root = await scratchRepo(sc.hints);
    writeConfig(root, sc.agents, sc.config);
    const init = await agt(root, ["init", "--name", "e2e"]);
    if (init.exitCode !== 0) throw new Error(`agt init failed: ${init.stderr}`);
    await git(root, "add", ".gitignore");
    await git(root, "commit", "-q", "-m", "agt init");
    note(`scratch repo ${root}`);

    const ws = await server.herdr.ok(["workspace", "create", "--cwd", root, "--label", `e2e-${sc.id}`, "--no-focus"]);
    const r = root;
    const h: H = {
      id: sc.id,
      root: r,
      agents: sc.agents,
      herdr: server.herdr,
      server,
      workspace: ws.workspace.workspace_id,
      mainPane: ws.root_pane.pane_id,
      deadline,
      agt: (args, env = {}) => agt(r, args, env),
      async agtOk(args, env = {}) {
        const res = await agt(r, args, env);
        if (res.exitCode !== 0) throw new Error(`agt ${args.join(" ")} failed: ${res.stderr.trim()}`);
        return res.stdout.trim();
      },
      events: () => events(r),
      waitFor: (type, pred, ms, what) => waitForEvent(r, type, pred, Math.max(1_000, Math.min(ms ?? 120_000, deadline - Date.now())), what),
      say: (text) => say(h.herdr, h.mainPane, text),
      async restartHerdr() {
        await h.server.stop();
        const again = await startHerdr(h.server.session);
        server = again;
        h.server = again;
        note(`Herdr restarted: ${again.proof.split("\n").find((l) => l.startsWith("socket:"))}`);
        const w = await again.herdr.ok(["workspace", "create", "--cwd", r, "--label", `e2e-${sc.id}`, "--no-focus"]);
        h.mainPane = w.root_pane.pane_id;
        h.workspace = w.workspace.workspace_id;
      },
      async startAgt(args = [], env = {}) {
        const envPart = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ");
        const cmd = `cd ${shellQuote(r)} && ${envPart ? `env ${envPart} ` : ""}${shellQuote(process.execPath)} ${shellQuote(AGT)} start ${args.map(shellQuote).join(" ")}`;
        await h.herdr.run(["pane", "run", h.mainPane, cmd]);
      },
      check(name, ok, detail) {
        checks.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
        log(`[${sc.id}] ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
      },
      note,
      left: () => deadline - Date.now(),
    };
    watcher = watchTrustDialogs(server.herdr, note);
    const manager = sc.manager !== false;
    await h.startAgt(manager ? [] : ["--no-manager"], sc.startEnv);
    await h.waitFor("layout.registered", () => true, 60_000, "agt start registered the layout");
    // Main is a bare process in its pane: answer its first-run trust dialog by screen as well.
    if (manager) void answerTrustIn(server.herdr, h.mainPane, 60_000, () => {}).then((a) => a && note(`answered the trust dialog in main's pane ${h.mainPane}`));
    let timer: Timer | undefined;
    await Promise.race([
      sc.run(h),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new TimeoutError(`scenario timed out after ${values.timeout ?? "20m"}`)), deadline - Date.now()))),
    ]).finally(() => clearTimeout(timer));
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
    log(`[${sc.id}] error: ${failure}`);
  } finally {
    await cleanup();
  }
  const status = failure || checks.some((c) => !c.ok) || checks.length === 0 ? "FAIL" : "PASS";
  return { status, ...(failure ? { reason: failure } : checks.length === 0 ? { reason: "no checks ran" } : {}), checks, notes, ...(server ? { server } : {}), ...(root ? { root } : {}) };
}

const detected = detectAgents((bin) => Bun.which(bin, { PATH: process.env.PATH ?? "" }), cleanEnv());
let mdPath = "";
const summary: string[] = [];
for (const sc of scenarios) {
  const t0 = Date.now();
  const kinds = [...new Set([sc.agents.main, sc.agents.coordinator, sc.agents.worker])];
  const missing = kinds.filter((k) => !detected.includes(k));
  let skipped: string | undefined;
  if (missing.length) skipped = `not installed: ${missing.join(", ")}`;
  else {
    const problems = (await Promise.all(kinds.map(async (k) => [k, await loginProblem(k)] as const))).filter(([, p]) => p);
    if (problems.length) skipped = problems.map(([k, p]) => `${k} ${p}`).join(", ");
  }
  if (skipped) {
    log(`[${sc.id}] SKIPPED (${skipped})`);
    mdPath = report(sc, { status: "SKIPPED", reason: skipped, durationS: 0, checks: [], notes: [] });
    summary.push(`${sc.id}: SKIPPED (${skipped})`);
    continue;
  }
  log(`[${sc.id}] start (main=${sc.agents.main} coordinator=${sc.agents.coordinator} worker=${sc.agents.worker})`);
  running = { sc, t0 };
  const r = await runRow(sc);
  running = undefined;
  if (r.root && r.status === "PASS" && !values.keep) removeScratch(r.root);
  else if (r.root) r.notes.push(`scratch repo kept at ${r.root}`);
  mdPath = report(sc, {
    status: r.status,
    ...(r.reason ? { reason: r.reason } : {}),
    durationS: Math.round((Date.now() - t0) / 1000),
    checks: r.checks,
    notes: r.notes,
    ...(r.server ? { herdrSession: r.server.session, herdrSocket: r.server.socket } : {}),
    ...(r.root ? { scratch: r.root } : {}),
  });
  summary.push(`${sc.id}: ${r.status}${r.reason ? ` (${r.reason})` : ""}`);
  log(`[${sc.id}] ${r.status}`);
}
teardown = undefined;
console.log(`\n${summary.join("\n")}\n\nreport: ${mdPath || "(no rows)"}`);
// Skipped rows block a release as much as failed ones.
process.exit(summary.length > 0 && summary.every((s) => s.endsWith(": PASS")) ? 0 : 1);
