import type { Effect } from "../commands/handler.ts";
import type { Config } from "../config/config.ts";
import type { EventBody, StoredEvent } from "../domain/types.ts";
import { isLive, type Session, type State } from "../state/projection.ts";
import { liveSessions, spawnCoordinator, spawnWorker, workerLimit } from "./sessions.ts";

export interface ReactorContext {
  root: string;
  config: Config;
  newId: () => string;
}

/** Pure follow-ups for freshly applied events: spawns, notifications, deliveries, worker teardown. */
export function react(state: State, events: StoredEvent[], ctx: ReactorContext): { events: EventBody[]; effects: Effect[] } {
  const out: EventBody[] = [];
  const effects: Effect[] = [];
  const delivered = new Set<string>();
  const spawnedPerThread = new Map<string, number>();
  const spawnedTickets = new Set<string>();
  const ended = new Set<string>();

  const take = (r: { events: EventBody[]; effects: Effect[] }) => {
    out.push(...r.events);
    effects.push(...r.effects);
  };
  const notify = (target: Session | undefined, text: string) => {
    if (target) out.push({ type: "notice.queued", ...(target.thread ? { thread: target.thread } : {}), payload: { session: target.id, text } });
  };
  const coordinatorOf = (thread: string | undefined) => (thread ? liveSessions(state, thread, "coordinator")[0] : undefined);
  const deliver = (s: Session | undefined) => {
    if (!s || delivered.has(s.id) || !isLive(s) || s.status !== "idle" || !s.pane || s.notices.length === 0) return;
    delivered.add(s.id);
    effects.push({ kind: "notice.deliver", session: s.id, thread: s.thread, pane: s.pane, text: s.notices.join("\n"), count: s.notices.length });
  };
  /** Emits session.ended at most once per session per call; returns whether it did. */
  const end = (s: Session): boolean => {
    if (ended.has(s.id)) return false;
    ended.add(s.id);
    out.push({ type: "session.ended", thread: s.thread, payload: { session: s.id } } as EventBody);
    return true;
  };
  const fillWorkers = (threadId: string | undefined) => {
    const t = threadId ? state.threads.get(threadId) : undefined;
    if (!t || t.status === "done" || !t.rootPane) return;
    let free = workerLimit(t, ctx.config) - liveSessions(state, t.id, "worker").length - (spawnedPerThread.get(t.id) ?? 0);
    for (const ticket of t.workerQueue) {
      if (free <= 0) break;
      if (spawnedTickets.has(`${t.id}/${ticket}`)) continue; // already spawned earlier in this call; state isn't updated yet
      if (t.tickets.find((k) => k.id === ticket)?.status !== "open") continue;
      spawnedTickets.add(`${t.id}/${ticket}`);
      take(spawnWorker(state, t, ticket, ctx));
      spawnedPerThread.set(t.id, (spawnedPerThread.get(t.id) ?? 0) + 1);
      free--;
    }
  };

  for (const ev of events) {
    switch (ev.type) {
      case "thread.tab_opened": {
        const t = state.threads.get(ev.thread);
        if (t && t.status !== "done" && t.rootPane && !coordinatorOf(t.id)) take(spawnCoordinator(t, ctx));
        break;
      }
      case "ticket.completed":
        notify(coordinatorOf(ev.thread), `Ticket ${ev.payload.ticket} is done${ev.payload.summary ? `: ${ev.payload.summary}` : ""}.`);
        break;
      case "ticket.blocked":
        notify(coordinatorOf(ev.thread), `Ticket ${ev.payload.ticket} is blocked: ${ev.payload.reason}.`);
        break;
      case "thread.status_changed": {
        const t = state.threads.get(ev.thread);
        if (ev.payload.from === "blocked" && ev.payload.to === "open") {
          notify(coordinatorOf(ev.thread), `Thread ${ev.thread} is unblocked: ${ev.payload.reason ?? "no reason given"}.`);
        } else if (ev.payload.to === "review") {
          notify(liveSessions(state, undefined, "main")[0], `Thread ${ev.thread} (${t?.title ?? ""}) is ready for review.`);
        } else if (ev.payload.to === "done") {
          for (const s of liveSessions(state, ev.thread)) end(s);
        }
        break;
      }
      case "session.failed": {
        const s = state.sessions.get(ev.payload.session);
        if (s?.role === "worker") notify(coordinatorOf(s.thread), `Worker for ${s.ticket} failed: ${ev.payload.reason}.`);
        if (s?.role === "coordinator") notify(liveSessions(state, undefined, "main")[0], `Coordinator for thread ${s.thread} failed: ${ev.payload.reason}.`);
        fillWorkers(s?.thread);
        break;
      }
      case "session.ended":
        fillWorkers(state.sessions.get(ev.payload.session)?.thread);
        break;
      case "notice.queued":
      case "session.attached":
        deliver(state.sessions.get(ev.payload.session));
        break;
      case "agent.idle": {
        const s = state.sessions.get(ev.payload.session);
        const ticketStatus = s?.thread ? state.threads.get(s.thread)?.tickets.find((k) => k.id === s.ticket)?.status : undefined;
        // A worker whose ticket is done or blocked has nothing left to do; ending it frees its slot.
        const finished = s && isLive(s) && s.role === "worker" && (ticketStatus === "done" || ticketStatus === "blocked");
        if (!finished) {
          deliver(s);
        } else if (end(s) && ctx.config.herdr.close_worker_pane_on_end && s.pane) {
          effects.push({ kind: "pane.close", pane: s.pane });
        }
        break;
      }
    }
  }
  return { events: out, effects };
}
