import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { HerdrError, shellQuote, type HerdrBridge } from "../herdr/bridge.ts";
import { AGT_BIN } from "./claude.ts";

export interface SpawnJob {
  root: string;
  herdrBin: string;
  herdrSocket?: string;
  session: string;
  name: string;
  kind: string;
  pane?: string;
  /**
   * With `pane`: the agent's own process env, exported in that pane's shell before the agent starts (Herdr starts the
   * agent from the pane's shell, and that pane's env is the tab's). A split carries it in `split.env` instead.
   */
  exportEnv?: Record<string, string>;
  /** `fallbacks` are split from in order when `pane` is gone. */
  split?: { pane: string; fallbacks?: string[]; direction: "right" | "down"; cwd: string; env: Record<string, string> };
  args: string[];
  bootstrap: string;
}

export const encodeJob = (job: SpawnJob): string => Buffer.from(JSON.stringify(job)).toString("base64");
export const decodeJob = (s: string): SpawnJob => JSON.parse(Buffer.from(s, "base64").toString("utf8")) as SpawnJob;

/** The default report retry window, 20 × 500ms: well inside the minimum `session.spawn_timeout` (60s). */
const REPORT_ATTEMPTS = 20;
const REPORT_DELAY_MS = 500;

/** The report retry window, with AGT_SPAWN_REPORT_ATTEMPTS / AGT_SPAWN_REPORT_DELAY_MS overrides (tests keep it short). */
export function spawnReportRetry(env: Record<string, string | undefined>): { attempts: number; delayMs: number } {
  const int = (v: string | undefined, min: number, fallback: number) => {
    const n = v === undefined || v.trim() === "" ? NaN : Number(v);
    return Number.isInteger(n) && n >= min ? n : fallback;
  };
  return { attempts: int(env.AGT_SPAWN_REPORT_ATTEMPTS, 1, REPORT_ATTEMPTS), delayMs: int(env.AGT_SPAWN_REPORT_DELAY_MS, 0, REPORT_DELAY_MS) };
}

/**
 * Sends a spawn report, retrying while the daemon is down or shutting down (it may be restarting). Any other refusal is
 * final. Gives up quietly after `attempts`; the daemon's sweep then fails the session. Returns whether the report was
 * delivered and accepted.
 */
export async function reportWithRetry(
  send: () => Promise<{ ok: boolean; error?: string }>,
  o: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const attempts = o.attempts ?? REPORT_ATTEMPTS;
  const delayMs = o.delayMs ?? REPORT_DELAY_MS;
  for (let i = 1; i <= attempts; i++) {
    let error: string;
    try {
      const res = await send();
      if (res.ok) return true;
      error = res.error ?? "unknown error";
      if (error !== "daemon is shutting down") {
        console.error(`agt __spawn: ${error}`);
        return false;
      }
    } catch (e) {
      error = `cannot report to daemon: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (i === attempts) console.error(`agt __spawn: ${error}`);
    else await Bun.sleep(delayMs);
  }
  return false;
}

/** Runs in the `agt __spawn` child so the daemon never waits for an agent to boot. */
/** How often, every BUSY_RETRY_MS, an agent start is retried while the pane's shell is still starting (about 30s). */
const BUSY_RETRIES = 60;
const BUSY_RETRY_MS = 500;

export async function runSpawnJob(
  job: SpawnJob,
  deps: { herdr: HerdrBridge; report: (command: object) => Promise<boolean>; sleep?: (ms: number) => Promise<void>; busyRetries?: number },
): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  let created: string | undefined;
  let attached: { pane: string; pending?: string };
  try {
    const pane = job.pane ?? (created = splitWithFallbacks(deps.herdr, job.split!));
    // A leading space keeps the line out of shell history (HISTCONTROL=ignorespace, zsh's HIST_IGNORE_SPACE).
    const exported = job.pane ? Object.entries(job.exportEnv ?? {}) : [];
    if (exported.length) deps.herdr.runInPane(pane, ` export ${exported.map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ")}`);
    for (let attempt = 0; ; attempt++) {
      try {
        deps.herdr.agentStart({ name: job.name, kind: job.kind, pane, args: job.args });
        break;
      } catch (e) {
        // The agent is in the pane but waiting on a startup dialog (trust, MCP): it is started, just not ready yet.
        if (e instanceof HerdrError && e.code === "agent_not_ready") break;
        // Real Herdr refuses a freshly split pane until its shell reaches the prompt.
        if (e instanceof HerdrError && e.code === "agent_pane_busy" && attempt < (deps.busyRetries ?? BUSY_RETRIES)) {
          await sleep(BUSY_RETRY_MS);
          continue;
        }
        throw e;
      }
    }
    let pending: string | undefined;
    if (job.bootstrap) {
      try {
        deps.herdr.agentPrompt(job.name, job.bootstrap);
      } catch {
        pending = job.bootstrap; // the daemon queues it and delivers it at the agent's first idle
      }
    }
    attached = { pane, ...(pending ? { pending } : {}) };
  } catch (e) {
    if (created) closeQuietly(deps.herdr, created);
    await deps.report({ cmd: "session.failed", session: job.session, reason: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (await deps.report({ cmd: "session.attached", session: job.session, ...attached })) return;
  // The daemon refused the report (it failed the session: its spawn report was lost, and a replacement may be running),
  // or never got it (its sweep will fail the session). Either way nobody tracks this agent: stop it. Its pane is the
  // split this job made, or the thread root pane it was given (the daemon never hands a job main's pane).
  closeQuietly(deps.herdr, attached.pane);
  console.error(`agt __spawn: session ${job.session} was failed by the daemon; stopped its agent`);
}

function closeQuietly(herdr: HerdrBridge, pane: string): void {
  try {
    herdr.closePane(pane);
  } catch {
    // best effort: the pane may already be gone
  }
}

function splitWithFallbacks(herdr: HerdrBridge, split: NonNullable<SpawnJob["split"]>): string {
  const { fallbacks = [], ...o } = split;
  const sources = [o.pane, ...fallbacks];
  for (let i = 0; ; i++) {
    try {
      return herdr.splitPane({ ...o, pane: sources[i]! });
    } catch (e) {
      if (!(e instanceof HerdrError && e.code === "pane_not_found") || i === sources.length - 1) throw e;
    }
  }
}

/**
 * `/bin/sh` argv that runs `argv` with stdout and stderr appended to `logFile`. The child opens the log itself: in
 * Bun 1.1.34 an fd passed in `stdio` is closed again when the ChildProcess is garbage-collected, so closing it after
 * spawn (as Node requires) makes a later GC close whatever reused that fd number, such as a daemon socket.
 */
export function loggedArgv(logFile: string, argv: string[]): [string, string[]] {
  return ["/bin/sh", ["-c", 'log=$1; shift; exec "$@" >>"$log" 2>&1', "agt-log", logFile, ...argv]];
}

export function launchSpawnJob(job: SpawnJob, opts: { logFile: string; spawn?: typeof spawn }): void {
  const [cmd, args] = loggedArgv(opts.logFile, [process.execPath, AGT_BIN, "__spawn", encodeJob(job)]);
  const child = (opts.spawn ?? spawn)(cmd, args, { stdio: "ignore", env: { ...process.env, AGT_ROOT: job.root } });
  // An async spawn error must never crash the daemon; log it instead.
  child.on("error", (e) => {
    try {
      appendFileSync(opts.logFile, `spawn job for session ${job.session} failed: ${e.message}\n`);
    } catch {
      // nothing left to report to
    }
  });
  child.unref();
}
