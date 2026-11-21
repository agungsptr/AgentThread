import type { StoredEvent } from "../domain/types.ts";

/** Heartbeat-like events: `agt logs` hides them unless --all. */
const NOISY = new Set(["session.active", "agent.idle", "session.compacting", "checkpoint.reminded", "notice.delivered", "notice.held", "notice.held_reported"]);

export const isNoisy = (type: string): boolean => NOISY.has(type);

const MAX_TEXT = 160;

const clip = (s: string): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > MAX_TEXT ? `${one.slice(0, MAX_TEXT - 1)}…` : one;
};

/** A short summary of an event's payload: ticket, stage, status change, session and message text. Empty when it has none. */
export function summarize(e: { type: string; payload?: unknown }): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === "string" && p[k] ? (p[k] as string) : undefined);
  const parts: string[] = [];
  if (str("ticket")) parts.push(str("ticket")!);
  if (typeof p.stage === "number") parts.push(`stage ${p.stage}${str("state") ? ` ${str("state")}` : ""}`);
  if (str("from") && str("to")) parts.push(`${str("from")}→${str("to")}`);
  const session = str("session");
  if (session) parts.push(session.slice(0, 8));
  const text = ["title", "message", "text", "summary", "note", "what", "answer", "reason", "tier", "content"].map(str).find((v) => v !== undefined);
  if (text !== undefined) parts.push(clip(text));
  return parts.join(" ");
}

function clock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** `HH:MM:SS <thread|main> <actor role> <type> <summary>` */
export function formatEvent(e: StoredEvent): string {
  const line = `${clock(e.ts)} ${e.thread ?? "main"} ${e.actor.role} ${e.type}`;
  const s = summarize(e);
  return s ? `${line} ${s}` : line;
}

export const WAITING = "waiting for the agt daemon…";

export interface LogsIo {
  fetch(seq: number): Promise<StoredEvent[]>;
  print(line: string): void;
  sleep(ms: number): Promise<void>;
  /** True when the loop should end (tests); the real loop ends with its process. */
  stop?(): boolean;
}

/**
 * Prints the event log. Without `follow` it prints once and a daemon error propagates. With it, an unavailable daemon
 * or a failed read prints one waiting line and retries every 2s, so a daemon restart never ends the logger.
 */
export async function runLogs(io: LogsIo, o: { follow: boolean; all: boolean; pollMs?: number; retryMs?: number }): Promise<number> {
  let seq = 0;
  let waiting = false;
  for (;;) {
    try {
      const events = await io.fetch(seq);
      waiting = false;
      for (const e of events) {
        if (o.all || !isNoisy(e.type)) io.print(formatEvent(e));
        seq = e.seq;
      }
    } catch (e) {
      if (!o.follow) throw e;
      if (!waiting) io.print(WAITING);
      waiting = true;
      if (io.stop?.()) return 0;
      await io.sleep(o.retryMs ?? 2000);
      continue;
    }
    if (!o.follow || io.stop?.()) return 0;
    await io.sleep(o.pollMs ?? 500);
  }
}
