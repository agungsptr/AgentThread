import type { AgentStatus } from "../herdr/bridge.ts";
import { isLive, type Session } from "../state/projection.ts";

export type PollSignal = "started" | "active" | "idle" | "blocked" | "ended";

const MISSES_TO_END = 2;

/** started, active or idle from a listed status, when it changes the session's state. */
function turnSignal(s: Session, status: AgentStatus, hooks: boolean): PollSignal | undefined {
  // A hooked agent's turns come from its hooks; counting the poller's too would double every turn.
  // No agent reports "resumed after approval": a poll seeing a blocked session work again reopens the block notice (no turn).
  if (status === "working" && s.status === "active" && s.blockedNotified) return "active";
  if (hooks) return (status === "idle" || status === "done") && s.status === "starting" ? "started" : undefined;
  if (status === "working") return s.status !== "active" ? "active" : undefined;
  if (status === "idle" || status === "done") return s.status === "starting" ? "started" : s.status === "active" ? "idle" : undefined;
  return undefined;
}

/**
 * Turns one `herdr agent list` snapshot into session signals. `misses` is owned and mutated by the caller:
 * `<pane>` counts consecutive polls that did not list the pane; `blocked:<pane>` marks a pane already reported blocked.
 */
export function diffAgentStatus(o: {
  sessions: Session[];
  listed: { pane: string; status: AgentStatus }[];
  misses: Map<string, number>;
  /** True when the session's agent reports active and idle through hooks: the poller then leaves those signals to the hooks. */
  hooks: (session: Session) => boolean;
}): { session: string; signal: PollSignal }[] {
  const byPane = new Map(o.listed.map((a) => [a.pane, a.status]));
  const out: { session: string; signal: PollSignal }[] = [];
  const live = new Set<string>();
  for (const s of o.sessions) {
    if (!isLive(s) || !s.pane) continue;
    const status = byPane.get(s.pane);
    // Main is polled only for started, active and idle (its tier timers pause while it works): `agt start` owns its end.
    if (s.role === "main") {
      const signal = status && turnSignal(s, status, o.hooks(s));
      if (signal) out.push({ session: s.id, signal });
      continue;
    }
    live.add(s.pane);
    if (status === undefined) {
      const n = (o.misses.get(s.pane) ?? 0) + 1;
      if (n >= MISSES_TO_END) {
        o.misses.delete(s.pane);
        o.misses.delete(`blocked:${s.pane}`);
        out.push({ session: s.id, signal: "ended" });
      } else o.misses.set(s.pane, n);
      continue;
    }
    o.misses.set(s.pane, 0);
    if (status !== "blocked") o.misses.delete(`blocked:${s.pane}`);
    const signal = turnSignal(s, status, o.hooks(s));
    if (signal) out.push({ session: s.id, signal });
    else if (status === "blocked" && !o.misses.has(`blocked:${s.pane}`)) {
      o.misses.set(`blocked:${s.pane}`, 1);
      out.push({ session: s.id, signal: "blocked" });
    }
  }
  // Counters of panes no live session owns any more would otherwise leak.
  for (const k of [...o.misses.keys()]) if (!live.has(k.replace(/^blocked:/, ""))) o.misses.delete(k);
  return out;
}
