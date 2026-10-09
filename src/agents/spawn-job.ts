import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import type { HerdrBridge } from "../herdr/bridge.ts";
import { AGT_BIN } from "./claude.ts";

export interface SpawnJob {
  root: string;
  herdrBin: string;
  herdrSocket?: string;
  session: string;
  name: string;
  kind: "claude";
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
    deps.herdr.agentStart({ name: job.name, kind: job.kind, pane, args: job.args });
    if (job.bootstrap) deps.herdr.agentPrompt(job.name, job.bootstrap);
    await deps.report({ cmd: "session.attached", session: job.session, pane });
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

export function launchSpawnJob(job: SpawnJob, opts: { logFile: string }): void {
  const fd = openSync(opts.logFile, "a");
  try {
    spawn(process.execPath, [AGT_BIN, "__spawn", encodeJob(job)], { stdio: ["ignore", fd, fd], env: { ...process.env, AGT_ROOT: job.root } }).unref();
  } finally {
    closeSync(fd);
  }
}
