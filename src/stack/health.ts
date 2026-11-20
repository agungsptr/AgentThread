import { connect } from "node:net";
import type { ServiceConfig } from "../config/config.ts";

export const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** True when the process exists and is not a zombie. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const r = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 && !r.stdout.toString().trim().startsWith("Z");
}

function tcpOnce(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** True when something accepts TCP connections on the port (IPv4 or IPv6 loopback). */
export async function portHeld(port: number): Promise<boolean> {
  return (await tcpOnce("127.0.0.1", port)) || (await tcpOnce("::1", port));
}

/** The pids listening on a TCP port. */
export function listeners(port: number): number[] {
  const r = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { stdout: "pipe", stderr: "pipe" });
  return r.stdout
    .toString()
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** The health target of a service: its `health`, else tcp:<port>, else none. */
export function healthTarget(s: Pick<ServiceConfig, "health" | "port">): string | undefined {
  return s.health ?? (s.port !== undefined ? `tcp:${s.port}` : undefined);
}

/** One health probe: HTTP 2xx-4xx, or a TCP connect. A service with no target is healthy. */
export async function checkHealth(target: string | undefined): Promise<boolean> {
  if (target === undefined) return true;
  if (target.startsWith("tcp:")) return portHeld(Number(target.slice(4)));
  try {
    const res = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(2000) });
    return res.status >= 200 && res.status < 500;
  } catch {
    return false;
  }
}

export type WaitOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Returns false when the service died, ending the wait early. */
  alive?: () => boolean;
};

/** Polls until healthy (true), the timeout passes or the service dies (false). */
export async function waitHealthy(target: string | undefined, o: WaitOptions = {}): Promise<boolean> {
  const { timeoutMs = 120_000, intervalMs = 1000, now = Date.now, sleep = sleepMs, alive = () => true } = o;
  const deadline = now() + timeoutMs;
  for (;;) {
    if (await checkHealth(target)) return true;
    if (!alive() || now() >= deadline) return false;
    await sleep(intervalMs);
  }
}
