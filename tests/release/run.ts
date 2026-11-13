#!/usr/bin/env bun
// Release e2e runner: bun run e2e:release [--only <id,…>] [--agents <kind,…>] [--timeout <dur>] [--list] [--keep]
// Real Herdr (an isolated named session per row), real agents, real models. See docs/release-e2e.md.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { durationMs } from "../../src/config/config.ts";
import { AGENT_KINDS, type AgentKind } from "../../src/domain/types.ts";
import { shellQuote, spawnAsync } from "../../src/herdr/bridge.ts";
import { paths } from "../../src/project/paths.ts";
import { detectAgents } from "../../src/project/setup.ts";
import {
  AGT,
  agt,
  agtTrustedFolders,
  answerTrustIn,
  type Check,
  cleanEnv,
  cleanupProcesses,
  dumpPaneScreens,
  events,
  git,
  MIXED_MAIN_TRUST,
  removeConfigHome,
  removeScratch,
  rowConfigHome,
  report,
  say,
  stopAllServers,
  scratchRepo,
  scratchWorkspace,
  startHerdr,
  raceScenario,
  trustGate,
  waitForEvent,
  watchTrustDialogs,
  writeConfig,
  writeWorkspaceConfig,
  type HerdrServer,
} from "./harness.ts";
import { runClock } from "./stall-clock.ts";
import type { H, Scenario } from "./scenarios/common.ts";
import { allScenarios, listRows } from "./scenarios/index.ts";

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

runClock.start(); // row deadlines do not run while the machine sleeps
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

let scenarios = allScenarios();
if (values.list) {
  for (const line of listRows(scenarios)) console.log(line);
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
/** The row in progress; `reported` is set once its report row is written, so an interrupt never writes a second one. */
let running: { sc: Scenario; t0: number; reported: boolean; done?: Promise<unknown> } | undefined;
let interruptedBy: string | undefined;
let interrupted: Promise<void> | undefined;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`${sig}: cleaning up`);
    // A second signal waits for the cleanup the first one started.
    interruptedBy ??= sig;
    interrupted ??= (async () => {
      await (teardown?.() ?? Promise.resolve()).catch(() => {});
      await stopAllServers(); // e.g. one still starting inside startHerdr
      // The row's own flow writes its (interrupted) report row once its teardown returns; give it the chance first.
      const row = running;
      if (row?.done) await Promise.race([row.done.catch(() => {}), Bun.sleep(30_000)]);
      if (row && !row.reported) report(row.sc, { status: "FAIL", reason: `interrupted by ${sig}`, durationS: Math.round((Date.now() - row.t0) / 1000), checks: [], notes: [] });
      process.exit(130);
    })();
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
  // Every agt call of the row (and the daemon and main that agt start launches) reads this XDG_CONFIG_HOME. It is made
  // inside the row's try, so a failure to make it fails the row (with its teardown) instead of the whole run.
  let xdg: string | undefined;
  const withXdg = (env: Record<string, string> = {}) => ({ ...(xdg ? { XDG_CONFIG_HOME: xdg } : {}), ...env });
  let watcher: ReturnType<typeof watchTrustDialogs> | undefined;
  let failure: string | undefined;
  let cleaning: Promise<void> | undefined;
  const cleanup = () =>
    (cleaning ??= (async () => {
      watcher?.stop();
      // The trust dialogs agt answered itself, from its spawn jobs' daemon log lines.
      if (root && existsSync(paths(root).daemonLog)) {
        for (const folder of agtTrustedFolders(readFileSync(paths(root).daemonLog, "utf8"))) note(`agt trusted ${folder}`);
      }
      // The daemon first (it would react to the agents vanishing), then Herdr with every pane, then any straggler.
      if (root) await cleanupProcesses(root, note, { sweepCwd: false }).catch((e) => note(`cleanup: ${e}`));
      if (server) await server.stop().catch((e) => note(`herdr stop: ${e}`));
      if (xdg) {
        try {
          removeConfigHome(xdg);
        } catch (e) {
          note(`removing ${xdg}: ${e}`);
        }
      }
      if (root) {
        const leaked = await cleanupProcesses(root, note).catch((e) => (note(`cleanup: ${e}`), [] as string[]));
        // A process outliving the Herdr shutdown is a product leak (e.g. a private agent server left running).
        checks.push({ name: "harness: no process left in the scratch repo after Herdr stopped", ok: leaked.length === 0, ...(leaked.length ? { detail: leaked.join("; ") } : {}) });
      }
    })());
  teardown = cleanup;
  const deadline = runClock.now() + timeoutMs;
  try {
    xdg = rowConfigHome();
    server = await startHerdr();
    const socketLine = server.proof.split("\n").find((l) => l.startsWith("socket:"));
    note(`isolated Herdr session ${server.session}, ${socketLine} (live: ${process.env.HERDR_SOCKET_PATH ?? "none inherited"})`);
    if (sc.workspace) {
      // Two repos (api, web) under a root that is no repo; the builder already ran agt init there.
      root = await scratchWorkspace(sc.wsHints, undefined, xdg);
      writeWorkspaceConfig(root, sc.agents, sc.config);
      note(`scratch workspace ${root}`);
    } else {
      root = await scratchRepo(sc.hints, sc.scratchAt);
      writeConfig(root, sc.agents, sc.config);
      const init = await agt(root, ["init", "--name", "e2e"], withXdg());
      if (init.exitCode !== 0) throw new Error(`agt init failed: ${init.stderr}`);
      await git(root, "add", ".gitignore");
      await git(root, "commit", "-q", "-m", "agt init");
      note(`scratch repo ${root}`);
    }

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
      agt: (args, env = {}) => agt(r, args, withXdg(env)),
      async agtOk(args, env = {}) {
        const res = await agt(r, args, withXdg(env));
        if (res.exitCode !== 0) throw new Error(`agt ${args.join(" ")} failed: ${res.stderr.trim()}`);
        return res.stdout.trim();
      },
      events: () => events(r),
      waitFor: (type, pred, ms, what) => waitForEvent(r, type, pred, Math.max(1_000, Math.min(ms ?? 120_000, deadline - runClock.now())), what),
      say: (text) => say(h.herdr, h.mainPane, sc.agents.main, text),
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
        const envPart = Object.entries(withXdg(env)).map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ");
        const cmd = `cd ${shellQuote(r)} && ${envPart ? `env ${envPart} ` : ""}${shellQuote(process.execPath)} ${shellQuote(AGT)} start ${args.map(shellQuote).join(" ")}`;
        await h.herdr.run(["pane", "run", h.mainPane, cmd]);
      },
      check(name, ok, detail) {
        checks.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
        log(`[${sc.id}] ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
      },
      note,
      left: () => deadline - runClock.now(),
    };
    // A fixed-root row's folder is trusted once by the user; a dialog there means that step is missing, so say how.
    const trustCheck = sc.scratchAt ? MIXED_MAIN_TRUST : "no trust dialog in a coordinator/worker pane";
    // agt answers it in the folders it created; one still showing after the grace ends the row at once (teardown as on
    // a timeout) instead of at its deadline.
    const trustAbort = trustGate();
    watcher = watchTrustDialogs(server.herdr, () => h.mainPane, note, (pane) => {
      h.check(trustCheck, false, `trust dialog in pane ${pane}`);
      trustAbort.fail(pane, trustCheck);
    });
    const manager = sc.manager !== false;
    await h.startAgt(manager ? [] : ["--no-manager"], sc.startEnv);
    const layout = await h.waitFor("layout.registered", () => true, 60_000, "agt start registered the layout");
    h.check("harness: the layout names the isolated Herdr socket", layout.payload.herdrSocket === server.socket, layout.payload.herdrSocket);
    // Main is a bare process in its pane: answer its first-run trust dialog by screen as well.
    if (manager) void answerTrustIn(server.herdr, h.mainPane, sc.agents.main, 60_000, note).then((a) => a && note(`answered the trust dialog in main's pane ${h.mainPane}`));
    await raceScenario(sc.run(h), trustAbort.promise, deadline - runClock.now(), `scenario timed out after ${values.timeout ?? "20m"}`);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
    log(`[${sc.id}] error: ${failure}`);
  } finally {
    // A failed or timed-out row (a startup timeout included) keeps what every pane showed; the server stops in cleanup.
    if (server && !cleaning && (failure || checks.some((c) => !c.ok))) await dumpPaneScreens(server.herdr, note);
    await cleanup();
  }
  // A row must assert something of its own; the harness checks every row gets do not count.
  const own = checks.filter((c) => !c.name.startsWith("harness:")).length;
  const status = failure || checks.some((c) => !c.ok) || own === 0 ? "FAIL" : "PASS";
  return { status, ...(failure ? { reason: failure } : own === 0 ? { reason: "no checks ran" } : {}), checks, notes, ...(server ? { server } : {}), ...(root ? { root } : {}) };
}

const detected = detectAgents((bin) => Bun.which(bin, { PATH: process.env.PATH ?? "" }), cleanEnv());
let mdPath = "";
const summary: string[] = [];
for (const sc of scenarios) {
  if (interrupted) break;
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
  const row: NonNullable<typeof running> = { sc, t0, reported: false };
  running = row;
  const pending = runRow(sc);
  row.done = pending;
  const r = await pending;
  if (interruptedBy) {
    r.status = "FAIL";
    r.reason = `interrupted by ${interruptedBy}${r.reason ? `: ${r.reason}` : ""}`;
  }
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
  row.reported = true;
  running = undefined;
  summary.push(`${sc.id}: ${r.status}${r.reason ? ` (${r.reason})` : ""}`);
  log(`[${sc.id}] ${r.status}`);
}
// An interrupt mid-row lets that row finish its own teardown; the interrupt handler then exits once it is done.
if (interrupted) await interrupted;
teardown = undefined;
console.log(`\n${summary.join("\n")}\n\nreport: ${mdPath || "(no rows)"}`);
// Skipped rows block a release as much as failed ones.
process.exit(summary.length > 0 && summary.every((s) => s.endsWith(": PASS")) ? 0 : 1);
