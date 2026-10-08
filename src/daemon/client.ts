import { LineReader, LineWriter } from "./framing.ts";
import type { Request, Response } from "./protocol.ts";

export class DaemonUnavailable extends Error {
  constructor() {
    super("daemon is not running; run `agt daemon start`");
  }
}

export function request(socketPath: string, req: Request, timeoutMs = 10_000): Promise<Response> {
  return new Promise((resolve, reject) => {
    const reader = new LineReader();
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("daemon did not respond in time"))), timeoutMs);

    Bun.connect<{ writer: LineWriter }>({
      unix: socketPath,
      socket: {
        open(s) {
          s.data = { writer: new LineWriter((b) => s.write(b)) };
          s.data.writer.send(req);
        },
        drain(s) {
          s.data.writer.flush();
        },
        data(s, chunk) {
          const [line] = reader.push(chunk);
          if (line === undefined) return;
          // Settle before ending: on Bun 1.1.x s.end() fires close() synchronously.
          finish(() => resolve(JSON.parse(line) as Response));
          s.end();
        },
        close() {
          finish(() => reject(new Error("daemon closed the connection")));
        },
        connectError() {
          finish(() => reject(new DaemonUnavailable()));
        },
        error(_s, err) {
          finish(() => reject(err));
        },
      },
    }).catch(() => finish(() => reject(new DaemonUnavailable())));
  });
}

export async function isAlive(socketPath: string): Promise<boolean> {
  try {
    return (await request(socketPath, { op: "ping" }, 1_000)).ok;
  } catch {
    return false;
  }
}
