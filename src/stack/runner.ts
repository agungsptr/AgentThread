import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Config } from "../config/config.ts";
import { installCommand } from "../project/prefill.ts";
import { checkHealth, healthTarget, listeners, pidAlive, portHeld, sleepMs, waitHealthy } from "./health.ts";
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
};

export type StartOptions = StackOptions & { task?: string | undefined; main?: boolean | undefined };

export type ServiceResult = { name: string; outcome: "started" | "skipped" | "failed" | "stopped"; detail?: string };

const files = (root: string, name: string) => ({
  pid: join(runDir(root), `${name}.pid`),
  log: join(runDir(root), `${name}.log`),
  stamp: join(runDir(root), `${name}.stamp`),
});

export function readPid(root: string, name: string): number | undefined {
  try {
    const n = Number(readFileSync(files(root, name).pid, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

export function logTail(root: string, name: string, lines = 20): string[] {
  try {
    return readFileSync(files(root, name).log, "utf8").split("\n").filter((l, i, a) => l !== "" || i < a.length - 1).slice(-lines);
  } catch {
    return [];
  }
}

/** Runs a shell command in cwd with stdout and stderr appended to the service log. True when it exits 0. */
function runLogged(cmd: string, cwd: string, logFile: string): boolean {
  const fd = openSync(logFile, "a");
  try {
    return spawnSync("sh", ["-c", cmd], { cwd, stdio: ["ignore", fd, fd] }).status === 0;
  } finally {
    closeSync(fd);
  }
}

function spawnDetached(cmd: string, cwd: string, logFile: string): number {
  const fd = openSync(logFile, "a");
  try {
    const child = spawn("sh", ["-c", cmd], { cwd, detached: true, stdio: ["ignore", fd, fd], env: process.env });
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

/** Stops one service: its process group (SIGTERM, then SIGKILL), then any listener left on its port; removes the pid file. */
async function stopOne(o: StackOptions, name: string, port: number | undefined): Promise<boolean> {
  const sleep = o.sleep ?? sleepMs;
  const grace = o.killGraceMs ?? 5000;
  const f = files(o.root, name);
  let did = false;
  const pid = readPid(o.root, name);
  if (pid !== undefined && groupAlive(pid)) {
    did = true;
    killGroup(pid, "SIGTERM");
    if (!(await untilGone(() => groupAlive(pid), grace, sleep))) {
      killGroup(pid, "SIGKILL");
      await untilGone(() => groupAlive(pid), 2000, sleep);
    }
  }
  if (port !== undefined) {
    const pids = listeners(port);
    if (pids.length) {
      did = true;
      for (const p of pids) killGroup(p, "SIGTERM");
      if (!(await untilGone(() => listeners(port).length > 0, Math.min(grace, 2000), sleep))) {
        for (const p of listeners(port)) killGroup(p, "SIGKILL");
        await untilGone(() => listeners(port).length > 0, 2000, sleep);
      }
    }
  }
  rmSync(f.pid, { force: true });
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
    const alive = pid !== undefined && pidAlive(pid);
    const held = s.port !== undefined ? await portHeld(s.port) : undefined;
    if (alive && (held === undefined || held)) {
      out(`${name}: already running (pid ${pid})`);
      results.push({ name, outcome: "skipped" });
      continue;
    }
    if (alive) await stopOne(o, name, undefined); // alive but not serving: replace it
    else rmSync(f.pid, { force: true });
    if (s.port !== undefined && (await portHeld(s.port))) {
      fail(`port ${s.port} is held by another process (pid ${listeners(s.port).join(", ") || "unknown"}); run agt stack stop`);
      continue;
    }
    const stamp = computeStamp(r.cwd);
    if (readStamp(f.stamp) !== stamp) {
      const cmd = installCommand(r.repoDir, o.config.workspace.repos?.[s.repo]?.install);
      if (cmd && !installed.has(r.repoDir)) {
        out(`${name}: installing (${cmd})`);
        if (!runLogged(cmd, r.repoDir, f.log)) {
          fail(`install failed (see agt stack logs ${name})`);
          continue;
        }
        installed.add(r.repoDir);
      }
      if (s.migrate) {
        out(`${name}: migrating (${s.migrate})`);
        if (!runLogged(s.migrate, r.cwd, f.log)) {
          fail(`migrate failed (see agt stack logs ${name})`);
          continue;
        }
      }
      writeStamp(f.stamp, stamp);
    }
    const newPid = spawnDetached(s.start, r.cwd, f.log);
    writeFileSync(f.pid, `${newPid}\n`);
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
  const results: ServiceResult[] = [];
  for (const r of list) {
    const did = await stopOne(o, r.name, r.service.port);
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
    let pid: number | null = filePid !== undefined && pidAlive(filePid) ? filePid : null;
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
  mkdirSync(runDir(o.root), { recursive: true });
  const lines: string[] = [];
  const out = (l: string) => {
    lines.push(l);
    (o.out ?? ((x: string) => console.log(x)))(l);
  };
  const save = () => writeFileSync(join(runDir(o.root), "restart.log"), `${lines.join("\n")}\n`);
  try {
    await stopStack({ ...o, out });
    return await startStack({ ...o, out });
  } finally {
    save();
  }
}
