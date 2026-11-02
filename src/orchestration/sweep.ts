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
  // A spawn report the daemon never received (it restarted at that moment) would leave the session `starting` forever.
  const spawnTimeout = ctx.config.session.spawn_timeout;
  const failed = new Set<string>();
  // An attached agent that never starts (the poller does not end a starting session it misses) fails the same way,
  // unless it is blocked on a startup dialog: its blocked notice has asked for a person.
  for (const s of liveSessions(state)) {
    if (s.role === "main" || s.status !== "starting" || (s.pane && s.blockedNotified)) continue;
    if (Date.parse(now) - Date.parse(s.resumingAt ?? s.createdAt) > durationMs(spawnTimeout)) {
      const reason = s.pane ? `agent did not start within ${spawnTimeout}` : `spawn report lost after ${spawnTimeout}`;
      events.push({ type: "session.failed", ...(s.thread ? { thread: s.thread } : {}), payload: { session: s.id, reason } } as EventBody);
      failed.add(s.id);
    }
  }
  // A worker whose ticket is done but that never goes idle would hold its slot forever: close it. The ended event makes
  // the reactor send the coordinator's done notice, so the hung-worker notice goes first.
  const grace = ctx.config.session.finished_worker_grace;
  for (const w of liveSessions(state, undefined, "worker")) {
    // One failure per worker per tick: a lost spawn is already failing, and a pane-less one has nothing running to hang.
    if (failed.has(w.id) || w.status === "starting" || !w.pane) continue;
    const t = w.thread ? state.threads.get(w.thread) : undefined;
    const k = t?.tickets.find((x) => x.id === w.ticket);
    if (!t || t.status === "done" || k?.status !== "done" || k.assignee !== w.id || !k.completedAt) continue;
    if (Date.parse(now) - Date.parse(k.completedAt) <= durationMs(grace)) continue;
    const coordinators = [...state.sessions.values()].filter((x) => x.thread === t.id && x.role === "coordinator");
    const target = liveSessions(state, t.id, "coordinator")[0] ?? coordinators.filter((x) => x.status === "lost").at(-1) ?? coordinators.filter((x) => x.status !== "rotated").at(-1);
    if (target) events.push({ type: "notice.queued", thread: t.id, payload: { session: target.id, text: `The worker for ticket ${k.id} finished its ticket but did not stop within ${grace}; closed it.` } });
    events.push({ type: "session.ended", thread: t.id, payload: { session: w.id } });
    if (ctx.config.herdr.close_worker_pane_on_end && w.pane) effects.push({ kind: "pane.close", pane: w.pane });
  }
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
  // The stack lock needs a live coordinator to release it: one without is dropped, and the queue moves on (the reactor
  // hands the freed lock to the next). A dead queued thread is dropped too, so it never receives the lock.
  const dead = (thread: string) => state.threads.get(thread)?.status === "done" || liveSessions(state, thread, "coordinator").length === 0;
  const { holder, queue } = state.stack;
  if (holder && dead(holder.thread)) events.push({ type: "stack.released", thread: holder.thread, payload: { thread: holder.thread, reason: "holder thread has no live coordinator" } });
  for (const q of queue) if (dead(q.thread)) events.push({ type: "stack.released", thread: q.thread, payload: { thread: q.thread, reason: "left the queue" } });
  return { events, effects };
}
