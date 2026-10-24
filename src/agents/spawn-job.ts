import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { HerdrError, type HerdrBridge } from "../herdr/bridge.ts";
import { AGT_BIN } from "./claude.ts";

export interface SpawnJob {
  root: string;
  herdrBin: string;
  herdrSocket?: string;
  session: string;
  name: string;
  kind: string;
  pane?: string;
  /** `fallbacks` are split from in order when `pane` is gone. */
  split?: { pane: string; fallbacks?: string[]; direction: "right" | "down"; cwd: string; env: Record<string, string> };
  args: string[];
  bootstrap: string;
}

export const encodeJob = (job: SpawnJob): string => Buffer.from(JSON.stringify(job)).toString("base64");
export const decodeJob = (s: string): SpawnJob => JSON.parse(Buffer.from(s, "base64").toString("utf8")) as SpawnJob;

/** Runs in the `agt __spawn` child so the daemon never waits for an agent to boot. */
/** How often, every BUSY_RETRY_MS, an agent start is retried while the pane's shell is still starting (about 30s). */
const BUSY_RETRIES = 60;
const BUSY_RETRY_MS = 500;

export async function runSpawnJob(
  job: SpawnJob,
  deps: { herdr: HerdrBridge; report: (command: object) => Promise<void>; sleep?: (ms: number) => Promise<void>; busyRetries?: number },
): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  let created: string | undefined;
  try {
    const pane = job.pane ?? (created = splitWithFallbacks(deps.herdr, job.split!));
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
    await deps.report({ cmd: "session.attached", session: job.session, pane, ...(pending ? { pending } : {}) });
  } catch (e) {
    if (created) {
      try {
        deps.herdr.closePane(created);
      } catch {
        // best effort: the pane may already be gone
      }
    }
    await deps.report({ cmd: "session.failed", session: job.session, reason: e instanceof Error ? e.message : String(e) });
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
