import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "./health.ts";
import { runDir } from "./target.ts";

/** Where `agt stack restart` (in the background) records its progress, and the pid of that background process. */
export const restartLog = (root: string): string => join(runDir(root), "restart.log");
export const restartPidFile = (root: string): string => join(runDir(root), "restart.pid");

/** Set on the background restart process: its parent already wrote the restart's first line. */
export const RESTART_CHILD_ENV = "AGT_STACK_RESTART_CHILD";
/** The first line of a restart, written by `agt stack restart` before it detaches. */
export const RESTART_REQUESTED = "restart requested";
/** The last line of a restart: `restart finished: ok`, `restart finished: failed (<services>)` or `restart failed: <why>`. */
export const RESTART_OK = "restart finished: ok";
const FINISHED = /^restart (finished|failed):/;

export interface LastRestart {
  state: "none" | "running" | "ok" | "failed";
  /** The latest restart's lines after its "restart requested" line. */
  lines: string[];
}

/** The latest restart in restart.log: still running (no final line yet), finished ok, or failed. */
export function lastRestart(root: string): LastRestart {
  let text: string;
  try {
    text = readFileSync(restartLog(root), "utf8");
  } catch {
    return { state: "none", lines: [] };
  }
  const all = text.split("\n").filter((l) => l !== "");
  const start = all.lastIndexOf(RESTART_REQUESTED);
  if (start < 0) return { state: "none", lines: [] };
  const lines = all.slice(start + 1);
  const end = lines.findIndex((l) => FINISHED.test(l));
  if (end < 0) return { state: "running", lines };
  return { state: lines[end] === RESTART_OK ? "ok" : "failed", lines: lines.slice(0, end + 1) };
}

/** The default `agt stack wait --timeout`: under the 10 minutes an agent's shell command may run. */
export const WAIT_TIMEOUT_MS = 540_000;
const POLL_MS = 1_000;

/**
 * `agt stack wait`: blocks until the latest background restart finishes. Exit code 0 (ok, or none was requested),
 * 1 (it failed, or its process died without finishing), 2 (still restarting at the timeout: run it again).
 */
export async function waitRestart(
  root: string,
  o: { timeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<{ code: 0 | 1 | 2; lines: string[] }> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const timeoutMs = o.timeoutMs ?? WAIT_TIMEOUT_MS;
  const until = now() + timeoutMs;
  for (;;) {
    const r = lastRestart(root);
    if (r.state === "none") return { code: 0, lines: ["no stack restart was requested"] };
    if (r.state === "ok") return { code: 0, lines: r.lines };
    if (r.state === "failed") return { code: 1, lines: r.lines };
    if (!restartAlive(root) && lastRestart(root).state === "running") {
      return { code: 1, lines: [...r.lines, "the restart process ended without finishing; see .local-run/restart.log"] };
    }
    if (now() >= until) return { code: 2, lines: [...r.lines, `still restarting after ${Math.round(timeoutMs / 1000)}s; run agt stack wait again`] };
    await sleep(POLL_MS);
  }
}

/** Whether the background restart process recorded in restart.pid still runs (no pid file: assumed running). */
function restartAlive(root: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(restartPidFile(root), "utf8").trim());
  } catch {
    return true;
  }
  return !Number.isInteger(pid) || pid <= 0 || pidAlive(pid);
}
