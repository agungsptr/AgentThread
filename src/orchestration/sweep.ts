import type { Effect } from "../commands/handler.ts";
import { durationMs } from "../config/config.ts";
import type { EventBody } from "../domain/types.ts";
import type { State } from "../state/projection.ts";
import { generateHandoff } from "./handoff.ts";
import type { ReactorContext } from "./reactor.ts";
import { liveSessions, rotateCoordinator } from "./sessions.ts";

/** How long a resumed coordinator may take to attach and start before the resume counts as failed. */
const RESUME_TIMEOUT_MS = 3 * 60_000;

/** Time-based follow-ups the event stream cannot trigger by itself: overdue handoffs and stuck resumes. */
export function sweep(state: State, now: string, ctx: ReactorContext): { events: EventBody[]; effects: Effect[] } {
  const events: EventBody[] = [];
  const effects: Effect[] = [];
  const { timeout, fallback_generate } = ctx.config.session.handoff;
  for (const s of liveSessions(state, undefined, "coordinator")) {
    if (s.status === "starting") {
      // A resume that never completes would leave the thread without a working coordinator; the reactor replaces it.
      if (s.resumingAt && Date.parse(now) - Date.parse(s.resumingAt) > RESUME_TIMEOUT_MS) {
        events.push({ type: "session.resume_failed", thread: s.thread, payload: { session: s.id, reason: "resume did not complete within 3m" } });
      }
      continue;
    }
    if (!s.pane) continue; // not attached yet: it cannot have seen a handoff request
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
