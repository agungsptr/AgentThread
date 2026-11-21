import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { Config } from "../config/config.ts";
import { installCommand } from "../project/prefill.ts";
import { checkHealth, healthTarget, listeners, pidAlive, portHeld, procInfo, sleepMs, waitHealthy } from "./health.ts";
import { guardLinkedInstall } from "../project/worktree-copy.ts";
import { computeStamp, readStamp, writeStamp } from "./stamp.ts";
import { checkOnly, MAIN, readTask, resolveTarget, runDir, startOrder, writeTask, type ResolvedService } from "./target.ts";

export type StackOptions = {
  root: string;
  config: Config;
  only?: string[] | undefined;
  /** Prints one output line (default console.log). */
  out?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Health wait in ms (default 120000) and poll interval (default 1000). */
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  /** Wait for SIGTERM before SIGKILL, in ms (default 5000). */
  killGraceMs?: number;
  /** stop: also kill a port listener that does not run from the workspace. */
  force?: boolean;
};

export type StartOptions = StackOptions & { task?: string | undefined; main?: boolean | undefined; /** Run each selected service's `migrate` now. */ migrate?: boolean | undefined };

export type ServiceResult = { name: string; outcome: "started" | "skipped" | "failed" | "stopped"; detail?: string };

const files = (root: string, name: string) => ({
  pid: join(runDir(root), `${name}.pid`),
  log: join(runDir(root), `${name}.log`),
  stamp: join(runDir(root), `${name}.stamp`),
  /** The checkout state at the last migrate that actually ran (absent or older: a migrate is pending). */
  migrated: join(runDir(root), `${name}.migrated`),
});

/** The pid file: pid, process group and start time of the process, so a recycled pid is not mistaken for it. */
function writePidFile(root: string, name: string, pid: number): void {
  const info = procInfo(pid);
  writeFileSync(files(root, name).pid, `${pid}\n${info?.pgid ?? pid}\n${info?.start ?? ""}\n`);
}

/**
 * The pid of the service's own live process: the pid file's process must still exist with the recorded start time and
 * be its own group leader. Anything else (a dead pid, a recycled one, an old-format file) is stale: the file is
 * removed and the pid is never signalled.
 */
export function readPid(root: string, name: string): number | undefined {
  const file = files(root, name).pid;
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    return undefined;
  }
  const pid = Number(lines[0]);
  const info = Number.isInteger(pid) && pid > 0 ? procInfo(pid) : null;
  if (info && pidAlive(pid) && info.pgid === pid && lines[2] !== undefined && lines[2] !== "" && info.start === lines[2]) return pid;
  rmSync(file, { force: true });
  return undefined;
}

export function logTail(root: string, name: string, lines = 20): string[] {
  try {
    return readFileSync(files(root, name).log, "utf8").split("\n").filter((l, i, a) => l !== "" || i < a.length - 1).slice(-lines);
  } catch {
    return [];
  }
}

/** Runs a shell command in cwd with stdout and stderr appended to the service log. True when it exits 0. */
function runLogged(cmd: string, cwd: string, logFile: string, env: Record<string, string | undefined> = process.env): boolean {
  const fd = openSync(logFile, "a");
  try {
    return spawnSync("sh", ["-c", cmd], { cwd, stdio: ["ignore", fd, fd], env }).status === 0;
  } finally {
    closeSync(fd);
  }
}

function spawnDetached(cmd: string, cwd: string, logFile: string, env: Record<string, string | undefined> = process.env): number {
  const fd = openSync(logFile, "a");
  try {
    const child = spawn("sh", ["-c", cmd], { cwd, detached: true, stdio: ["ignore", fd, fd], env });
    child.on("error", () => {});
    child.unref();
    if (child.pid === undefined) throw new Error("spawn failed");
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return pidAlive(pid);
  }
};

async function untilGone(alive: () => boolean, graceMs: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  for (let waited = 0; waited < graceMs; waited += 100) {
    if (!alive()) return true;
    await sleep(100);
  }
  return !alive();
}

const inside = (dir: string, allowed: string[]): boolean => allowed.some((a) => dir === a || dir.startsWith(`${a}/`));

/**
 * Stops one service: its process group (SIGTERM, then SIGKILL), then a listener left on its port, but only one
 * running from the workspace (or any with --force). The pid file goes only when the process is gone.
 */
async function stopOne(o: StackOptions, name: string, port: number | undefined, allowed: string[] = []): Promise<boolean> {
  const sleep = o.sleep ?? sleepMs;
  const out = o.out ?? ((l: string) => console.log(l));
  const grace = o.killGraceMs ?? 5000;
  const f = files(o.root, name);
  let did = false;
  const pid = readPid(o.root, name);
  if (pid !== undefined) {
    did = true;
    killGroup(pid, "SIGTERM");
    if (!(await untilGone(() => groupAlive(pid), grace, sleep))) {
      killGroup(pid, "SIGKILL");
      await untilGone(() => groupAlive(pid), 2000, sleep);
    }
    if (!groupAlive(pid)) rmSync(f.pid, { force: true });
  }
  if (port !== undefined) {
    const mine: number[] = [];
    for (const p of listeners(port)) {
      const cwd = cwdOf(p);
      if (o.force || (cwd !== null && inside(cwd, allowed))) mine.push(p);
      else out(`${name}: port ${port} is held by another program (pid ${p}, ${cwd ?? "unknown cwd"}); not stopping it`);
    }
    if (mine.length) {
      did = true;
      for (const p of mine) killGroup(p, "SIGTERM");
      if (!(await untilGone(() => mine.some(pidAlive), Math.min(grace, 2000), sleep))) {
        for (const p of mine) killGroup(p, "SIGKILL");
        await untilGone(() => mine.some(pidAlive), 2000, sleep);
      }
    }
  }
  return did;
}

function selected(o: StackOptions, all: ResolvedService[], explicit: boolean): ResolvedService[] {
  checkOnly(o.config, o.only);
  return startOrder(all, o.only).filter((s) => explicit || s.service.enabled);
}

/** Starts the stack. Returns one result per service; callers exit 1 when any failed. */
export async function startStack(o: StartOptions): Promise<ServiceResult[]> {
  const out = o.out ?? ((l: string) => console.log(l));
  const resolved = resolveTarget(o.root, o.config, { task: o.task, main: o.main });
  mkdirSync(runDir(o.root), { recursive: true });
  const recorded = readTask(o.root);
  if ((o.task !== undefined || o.main) && resolved.target !== recorded && resolved.services.some((r) => readPid(o.root, r.name) !== undefined)) {
    const detail = `already running on ${recorded}; use agt stack restart ${resolved.target === MAIN ? "--main" : `--task ${resolved.target}`}`;
    out(`stack: FAILED ${detail}`);
    return [{ name: "stack", outcome: "failed", detail }];
  }
  writeTask(o.root, resolved.target);
  out(`target: ${resolved.target}`);
  const list = selected(o, resolved.services, o.only !== undefined);
  const installed = new Set<string>();
  const results: ServiceResult[] = [];
  const sleep = o.sleep ?? sleepMs;
  for (const r of list) {
    const { name, service: s } = r;
    const f = files(o.root, name);
    const via = r.from === "worktree" ? "worktree" : resolved.target === MAIN ? "main checkout" : "main checkout, no worktree";
    const fail = (detail: string) => {
      out(`${name}: FAILED ${detail}`);
      results.push({ name, outcome: "failed", detail });
    };
    if (!existsSync(r.cwd)) {
      fail(`directory ${r.cwd} does not exist`);
      continue;
    }
    const pid = readPid(o.root, name);
    const alive = pid !== undefined;
    const held = s.port !== undefined ? await portHeld(s.port) : undefined;
    if (alive && (held === undefined || held)) {
      out(`${name}: already running (pid ${pid})`);
      results.push({ name, outcome: "skipped" });
      continue;
    }
    if (alive) await stopOne(o, name, undefined); // alive but not serving: replace it
    if (s.port !== undefined && (await portHeld(s.port))) {
      fail(`port ${s.port} is held by another process (pid ${listeners(s.port).join(", ") || "unknown"}); run agt stack stop`);
      continue;
    }
    const svcEnv = { ...process.env, ...(s.env ?? {}) };
    const stamp = computeStamp(r.repoDir, r.cwd);
    if (readStamp(f.stamp) !== stamp) {
      const cmd = installCommand(r.repoDir, o.config.workspace.repos?.[s.repo]?.install);
      const mainDir = resolve(o.root, o.config.workspace.repos?.[s.repo]?.path ?? s.repo);
      const guard = cmd && r.repoDir !== mainDir ? await guardLinkedInstall(mainDir, r.repoDir) : { skip: false };
      if ("note" in guard && guard.note) out(`${name}: ${guard.note}`);
      if (cmd && !guard.skip && !installed.has(r.repoDir)) {
        out(`${name}: installing (${cmd})`);
        if (!runLogged(cmd, r.repoDir, f.log)) {
          fail(`install failed (see agt stack logs ${name})`);
          continue;
        }
        installed.add(r.repoDir);
      }
      writeStamp(f.stamp, computeStamp(r.repoDir, r.cwd)); // after install, which may touch the tree
    }
    if (s.migrate) {
      // Opt-in: --migrate always runs it; migrate_on_start runs it when the state changed since the last migrate that ran.
      const pending = readStamp(f.migrated) !== stamp;
      if (o.migrate || (s.migrate_on_start && pending)) {
        out(`${name}: migrating (${s.migrate})`);
        if (!runLogged(s.migrate, r.cwd, f.log, svcEnv)) {
          fail(`migrate failed (see agt stack logs ${name})`);
          continue;
        }
        writeStamp(f.migrated, computeStamp(r.repoDir, r.cwd));
      } else if (pending) out(`${name}: migrate not run (opt-in); use --migrate to run it`);
    }
    const newPid = spawnDetached(s.start, r.cwd, f.log, svcEnv);
    writePidFile(o.root, name, newPid);
    const target = healthTarget(s);
    const t0 = (o.now ?? Date.now)();
    const ok = await waitHealthy(target, {
      timeoutMs: o.healthTimeoutMs ?? 120_000,
      intervalMs: o.healthIntervalMs ?? 1000,
      sleep,
      ...(o.now ? { now: o.now } : {}),
      alive: () => pidAlive(newPid),
    });
    if (ok) {
      const secs = (((o.now ?? Date.now)() - t0) / 1000).toFixed(1);
      out(`${name}: started pid ${newPid}${s.port !== undefined ? ` on :${s.port}` : ""}, healthy in ${secs}s (${via})`);
      results.push({ name, outcome: "started" });
    } else {
      const died = !pidAlive(newPid);
      out(`${name}: WARNING ${died ? "exited before it became healthy" : `not healthy after ${Math.round((o.healthTimeoutMs ?? 120_000) / 1000)}s`} (pid ${newPid}); last log lines:`);
      for (const l of logTail(o.root, name, 20)) out(`  ${l}`);
      results.push({ name, outcome: "failed", detail: died ? "exited" : "unhealthy" });
    }
  }
  return results;
}

/** Stops the stack (reverse start order). */
export async function stopStack(o: StackOptions): Promise<ServiceResult[]> {
  const out = o.out ?? ((l: string) => console.log(l));
  const resolved = resolveTarget(o.root, o.config, { main: true });
  const list = selected(o, resolved.services, true).reverse();
  const allowed = [...new Set([o.root, ...resolved.services.map((r) => r.repoDir)].flatMap((d) => [d, (() => { try { return realpathSync(d); } catch { return d; } })()]))];
  const results: ServiceResult[] = [];
  for (const r of list) {
    const did = await stopOne(o, r.name, r.service.port, allowed);
    out(`${r.name}: ${did ? "stopped" : "not running"}`);
    results.push({ name: r.name, outcome: "stopped" });
  }
  return results;
}

export type ServiceStatus = {
  service: string;
  state: "running" | "stopped" | "unhealthy";
  port: number | null;
  pid: number | null;
  cwd: string | null;
  branch: string | null;
  target: string | null;
};

function cwdOf(pid: number): string | null {
  const r = spawnSync("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], { encoding: "utf8" });
  const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("n"));
  return line ? line.slice(1) : null;
}

function branchOf(cwd: string): string | null {
  const r = spawnSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() || "(detached)" : null;
}

/** The target of a running service, from where it runs: a task slug when under .worktrees/<slug>/, else main. */
function targetOf(root: string, cwd: string): string {
  const rel = relative(join(root, ".worktrees"), cwd);
  return rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel.split("/")[0]! : MAIN;
}

export async function stackStatus(o: StackOptions): Promise<ServiceStatus[]> {
  const resolved = resolveTarget(o.root, o.config, { main: true });
  const rows: ServiceStatus[] = [];
  for (const r of startOrder(resolved.services, o.only)) {
    const port = r.service.port ?? null;
    const filePid = readPid(o.root, r.name);
    let pid: number | null = filePid ?? null;
    if (pid === null && port !== null) pid = listeners(port)[0] ?? null;
    const healthy = pid === null ? false : await checkHealth(healthTarget(r.service));
    const cwd = pid === null ? null : cwdOf(pid);
    rows.push({
      service: r.name,
      state: pid === null ? "stopped" : healthy ? "running" : "unhealthy",
      port,
      pid,
      cwd,
      branch: cwd ? branchOf(cwd) : null,
      target: cwd ? targetOf(o.root, cwd) : null,
    });
  }
  return rows;
}

export function formatStatus(rows: ServiceStatus[], root: string, recorded: string = readTask(root)): string[] {
  const head = ["service", "state", "port", "pid", "cwd", "branch", "target"];
  const cell = (v: string | number | null) => (v === null ? "-" : String(v));
  const body = rows.map((r) => [r.service, r.state, cell(r.port), cell(r.pid), cell(r.cwd === null ? null : r.cwd.startsWith(`${root}/`) ? r.cwd.slice(root.length + 1) : r.cwd), cell(r.branch), cell(r.target)]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [`recorded target: ${recorded}`, line(head), ...body.map(line)];
}

/** Prints the tail of a service log; with follow, keeps following until interrupted. */
export async function stackLogs(root: string, config: Config, name: string, opts: { lines?: number; follow?: boolean }): Promise<number> {
  if (!(name in (config.workspace.services ?? {}))) throw new Error(`unknown service "${name}"`);
  const log = files(root, name).log;
  if (!existsSync(log)) throw new Error(`no log for ${name} yet (${log})`);
  const n = String(opts.lines ?? 50);
  const proc = Bun.spawn(["tail", "-n", n, ...(opts.follow ? ["-f"] : []), log], { stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

export async function restartStack(o: StartOptions): Promise<ServiceResult[]> {
  // Validate before stopping anything: a bad --task/--only must not leave the stack down.
  const resolved = resolveTarget(o.root, o.config, { task: o.task, main: o.main });
  selected(o, resolved.services, o.only !== undefined);
  mkdirSync(runDir(o.root), { recursive: true });
  const log = join(runDir(o.root), "restart.log");
  const out = (l: string) => {
    appendFileSync(log, `${l}\n`);
    (o.out ?? ((x: string) => console.log(x)))(l);
  };
  await stopStack({ ...o, out });
  return await startStack({ ...o, out });
}
