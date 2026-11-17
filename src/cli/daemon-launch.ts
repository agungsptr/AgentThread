import { spawn } from "node:child_process";
import { isAlive } from "../daemon/client.ts";

export interface LaunchOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  socket: string;
  logFile: string;
  /** How long to wait for the socket to answer. */
  timeoutMs?: number;
  /** How long a daemon that ignored SIGTERM gets before SIGKILL. */
  graceMs?: number;
}

/**
 * Spawns a detached daemon and waits until its socket answers. The spawn execs, so the child's pid is the daemon's.
 * A child that exits early fails the start at once; one that has not answered in time is killed (SIGTERM, then
 * SIGKILL) before the error, so a failed start never leaves a daemon that comes up later with nobody to stop it.
 * SQLite's lock dies with the process and a new daemon removes the old socket file, so a killed start blocks nothing.
 */
export async function launchDaemon(o: LaunchOptions): Promise<void> {
  let exited: string | undefined;
  let child;
  try {
    child = spawn(o.cmd, o.args, { detached: true, stdio: "ignore", cwd: o.cwd, env: o.env });
  } catch {
    throw new Error("failed to launch daemon");
  }
  child.on("error", (e) => (exited ??= `could not launch (${e.message})`));
  child.on("exit", (code, signal) => (exited ??= `exited with ${signal ?? `code ${code}`}`));
  child.unref();
  const until = Date.now() + (o.timeoutMs ?? 15_000);
  while (Date.now() < until) {
    if (await isAlive(o.socket)) return;
    if (exited !== undefined) throw new Error(`daemon failed to start (${exited}); see ${o.logFile}`);
    await Bun.sleep(100);
  }
  if (await isAlive(o.socket)) return;
  await kill(child, o.graceMs ?? 2_000);
  throw new Error(`daemon failed to start; see ${o.logFile}`);
}

async function kill(child: ReturnType<typeof spawn>, graceMs: number): Promise<void> {
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  if (gone()) return;
  try {
    child.kill("SIGTERM");
  } catch {}
  for (let waited = 0; waited < graceMs && !gone(); waited += 50) await Bun.sleep(50);
  if (!gone()) {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}
