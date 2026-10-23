import type { Effect } from "../commands/handler.ts";
import { durationMs } from "../config/config.ts";
import type { EventBody } from "../domain/types.ts";
import type { State } from "../state/projection.ts";
import { generateHandoff } from "./handoff.ts";
import type { ReactorContext } from "./reactor.ts";
import { liveSessions, rotateCoordinator } from "./sessions.ts";

/** Time-based follow-ups the event stream cannot trigger by itself: overdue handoffs. */
export function sweep(state: State, now: string, ctx: ReactorContext): { events: EventBody[]; effects: Effect[] } {
  const events: EventBody[] = [];
  const effects: Effect[] = [];
  const { timeout, fallback_generate } = ctx.config.session.handoff;
  for (const s of liveSessions(state, undefined, "coordinator")) {
    if (s.status === "starting") continue;
    if (!s.pane) continue; // not attached yet: it cannot have seen a handoff request
    const t0 = s.thread ? state.threads.get(s.thread) : undefined;
    // Age only matters for a coordinator that has worked; a parked one (0 turns) or one waiting on review or an
    // unblock would just be replaced by another idle coordinator.
    const working = s.turns > 0 && t0?.status !== "review" && t0?.status !== "blocked";
    if (!s.rotation && t0 && working && liveSessions(state, t0.id, "coordinator")[0] === s && Date.parse(now) - Date.parse(s.createdAt) > durationMs(ctx.config.session.rotation.max_age)) {
      events.push({ type: "session.rotation_requested", thread: t0.id, payload: { session: s.id, reason: "age" } });
      continue;
    }
    if (!s.rotation || Date.parse(now) - Date.parse(s.rotation.requestedAt) <= durationMs(timeout)) continue;
    const t = s.thread ? state.threads.get(s.thread) : undefined;
    if (!t || liveSessions(state, t.id, "coordinator")[0] !== s) continue; // only the thread's acting coordinator
    if (fallback_generate) {
      events.push({ type: "handoff.submitted", thread: t.id, payload: { content: generateHandoff(t, `the coordinator did not write a handoff within ${timeout}`), generated: true } });
    } else {
      const r = rotateCoordinator(state, s, "handoff_timeout", ctx);
      events.push(...r.events);
      effects.push(...r.effects);
    }
  }
  return { events, effects };
}
