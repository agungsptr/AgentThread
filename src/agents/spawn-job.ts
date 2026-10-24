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
  split?: { pane: string; direction: "right" | "down"; cwd: string; env: Record<string, string> };
  args: string[];
  bootstrap: string;
}

export const encodeJob = (job: SpawnJob): string => Buffer.from(JSON.stringify(job)).toString("base64");
export const decodeJob = (s: string): SpawnJob => JSON.parse(Buffer.from(s, "base64").toString("utf8")) as SpawnJob;

/** Runs in the `agt __spawn` child so the daemon never waits for an agent to boot. */
export async function runSpawnJob(job: SpawnJob, deps: { herdr: HerdrBridge; report: (command: object) => Promise<void> }): Promise<void> {
  let created: string | undefined;
  try {
    const pane = job.pane ?? (created = deps.herdr.splitPane(job.split!));
    try {
      deps.herdr.agentStart({ name: job.name, kind: job.kind, pane, args: job.args });
    } catch (e) {
      // The agent is in the pane but waiting on a startup dialog (trust, MCP): it is started, just not ready yet.
      if (!(e instanceof HerdrError && e.code === "agent_not_ready")) throw e;
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
