import { isHandoffRequest } from "../agents/prompts.ts";
import type { Effect } from "../commands/handler.ts";
import { durationMs } from "../config/config.ts";
import type { EventBody } from "../domain/types.ts";
import { isLive, type Session, type State } from "../state/projection.ts";
import { generateHandoff } from "./handoff.ts";
import { NOTICE_HELD_REPORT_AFTER, noticeDelivery, noticeRetryMs, type ReactorContext } from "./reactor.ts";
import { liveSessions, rotateCoordinator } from "./sessions.ts";

/**
 * How long a worker must sit idle with its ticket unfinished before the coordinator hears of it: a hookless agent's
 * poll flickers to idle mid-turn, and a real stop lasts.
 */
export const IDLE_NOTICE_AFTER_MS = 20_000;
/** Idle notices per ticket; past them the coordinator gets IDLE_CAP_NOTICE once, then nothing more. */
export const MAX_IDLE_NOTICES = 3;
/**
 * How long a busy coordinator's notices may stay queued before main hears of it: a coordinator in a long wait of its own
 * (a shell loop, a background watcher) never goes idle, so they are never delivered.
 */
export const NOTICE_STUCK_AFTER_MS = 10 * 60_000;
/**
 * How long a busy Claude Code agent's notices wait for its idle before they go in anyway: Claude Code takes a message
 * while it works and reads it at its next step, waking from a wait on background work (verified with Herdr 2026-11-25).
 */
export const NOTICE_BUSY_DELIVER_AFTER_MS = 3 * 60_000;
/** A coordinator is rotated for its Claude profile usage at most once per thread within this long. */
export const USAGE_ROTATION_GAP_MS = 10 * 60_000;

const idleNotice = (thread: string, ticket: string, report: string | undefined) => {
  const line = report?.split("\n")[0]?.trim() ?? "";
  const last = (line.length > 200 ? `${line.slice(0, 199)}…` : line).replace(/[.!?]+$/, "");
  return `The worker for ticket ${ticket} went idle without reporting${last ? `: ${last}` : ""}. Tell it what to do with agt tell ${thread}/${ticket} "<text>", or return or block the ticket.`;
};
const IDLE_CAP_NOTICE = (ticket: string) => `The worker for ticket ${ticket} keeps stopping without reporting; return or block the ticket.`;

/**
 * Who receives notices meant for a thread's coordinator: the live one, else the latest lost one, else the latest one
 * that was not rotated (as the reactor's coordinatorToNotify).
 */
function coordinatorTarget(state: State, thread: string): Session | undefined {
  const coordinators = [...state.sessions.values()].filter((x) => x.thread === thread && x.role === "coordinator");
  return liveSessions(state, thread, "coordinator")[0] ?? coordinators.filter((x) => x.status === "lost").at(-1) ?? coordinators.filter((x) => x.status !== "rotated").at(-1);
}

/**
 * Time-based follow-ups the event stream cannot trigger by itself: lost spawns and agents that never start, finished
 * workers that linger, idle workers with unfinished tickets, held notice deliveries, overdue handoffs, a dead stack lock.
 */
export function sweep(state: State, now: string, ctx: ReactorContext): { events: EventBody[]; effects: Effect[] } {
  const events: EventBody[] = [];
  const effects: Effect[] = [];
  const { timeout, fallback_generate } = ctx.config.session.handoff;
  // A spawn report the daemon never received (it restarted at that moment) would leave the session `starting` forever.
  const spawnTimeout = ctx.config.session.spawn_timeout;
  /** Sessions this tick fails or ends: no other follow-up for them. */
  const failed = new Set<string>();
  // An attached agent that never starts (the poller does not end a starting session it misses) fails the same way,
  // unless it is blocked on a startup dialog: its blocked notice has asked for a person.
  for (const s of liveSessions(state)) {
    if (s.role === "main" || s.status !== "starting" || (s.pane && s.blockedNotified)) continue;
    if (Date.parse(now) - Date.parse(s.resumingAt ?? s.createdAt) > durationMs(spawnTimeout)) {
      const reason = s.pane ? `agent did not start within ${spawnTimeout}` : `spawn report lost after ${spawnTimeout}`;
      // A worker's agent may still be starting in its split: stop it (the effect runs before the failure is applied), so
      // the fresh worker its early exit gets is never a second agent on the ticket.
      if (s.pane && s.role === "worker") effects.push({ kind: "pane.close", pane: s.pane });
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
    const target = coordinatorTarget(state, t.id);
    if (target) events.push({ type: "notice.queued", thread: t.id, payload: { session: target.id, text: `The worker for ticket ${k.id} finished its ticket but did not stop within ${grace}; closed it.` } });
    events.push({ type: "session.ended", thread: t.id, payload: { session: w.id } });
    failed.add(w.id); // ending: nothing more for it in this tick
    if (ctx.config.herdr.close_worker_pane_on_end && w.pane) effects.push({ kind: "pane.close", pane: w.pane });
  }
  // A worker whose turn ended with its ticket still in_progress (no done, no block) would sit silent: once its idle has
  // lasted IDLE_NOTICE_AFTER_MS, the coordinator hears it, once per idle stretch and at most MAX_IDLE_NOTICES times per
  // ticket. Not while it waits for an answer to its question or for a notice on its way, nor before it ran any agt
  // command (the stall watchdog's case).
  for (const w of liveSessions(state, undefined, "worker")) {
    if (failed.has(w.id) || w.status !== "idle" || !w.pane || !w.idleAt || w.idleReported || !w.authored || !w.ticket || !w.thread) continue;
    if (Date.parse(now) - Date.parse(w.idleAt) <= IDLE_NOTICE_AFTER_MS || w.notices.length > 0) continue;
    const t = state.threads.get(w.thread);
    const k = t?.tickets.find((x) => x.id === w.ticket);
    if (!t || t.status === "done" || k?.status !== "in_progress" || k.assignee !== w.id) continue;
    if (t.questions.some((q) => q.actor.session === w.id && !q.answer)) continue;
    const sent = k.idleNotices ?? 0;
    if (sent > MAX_IDLE_NOTICES) continue;
    const target = coordinatorTarget(state, t.id);
    events.push({ type: "worker.idle_reported", thread: t.id, payload: { session: w.id } });
    if (target) events.push({ type: "notice.queued", thread: t.id, payload: { session: target.id, text: sent < MAX_IDLE_NOTICES ? idleNotice(t.id, k.id, w.lastReport) : IDLE_CAP_NOTICE(k.id) } });
  }
  // A held or failed notice delivery is not retried by any event: an agent that is already idle may never go idle again.
  // A live idle session with notices still queued is delivered to again once NOTICE_RETRY_MS have passed since the last
  // attempt (or since it went idle, when no attempt was recorded). Never into an agent blocked on a dialog.
  for (const s of state.sessions.values()) {
    if (!isLive(s) || failed.has(s.id) || s.blockedNotified) continue;
    const since = s.noticeHeldAt ?? s.idleAt ?? s.lastActiveAt ?? s.createdAt;
    // A queued handoff request is retried on every sweep, whatever the backoff of the notices behind it.
    const urgent = s.notices[0] !== undefined && isHandoffRequest(s.notices[0]);
    if (!urgent && Date.parse(now) - Date.parse(since) <= noticeRetryMs(s.noticeHeldCount ?? 1)) continue;
    // Held again and again: the coordinator hears once per stretch (never through the held session's own queue).
    if ((s.noticeHeldCount ?? 0) >= NOTICE_HELD_REPORT_AFTER && !s.noticeHeldReported && s.notices.length > 0) {
      const line = s.noticeHeldReason?.split("\n")[0]?.trim() ?? "";
      const reason = line.length > 120 ? `${line.slice(0, 119)}…` : line;
      const target = s.role === "worker" && s.thread ? coordinatorTarget(state, s.thread) : s.role === "coordinator" ? liveSessions(state, undefined, "main")[0] : undefined;
      // Marked only with someone to tell: a coordinator that appears later (a replacement) still hears of the stretch.
      if (target && target.id !== s.id) {
        events.push({ type: "notice.held_reported", ...(s.thread ? { thread: s.thread } : {}), payload: { session: s.id } });
        events.push({ type: "notice.queued", ...(target.thread ? { thread: target.thread } : {}), payload: { session: target.id, text: `Messages to ${s.role} ${s.role === "worker" && s.ticket ? `ticket ${s.ticket}` : s.id.slice(0, 8)} keep being held${reason ? ` (${reason})` : ""}; check its pane.` } });
      }
    }
    const e = noticeDelivery(s);
    if (e) effects.push(e);
  }
  // A busy Claude Code coordinator or worker whose notices have waited NOTICE_BUSY_DELIVER_AFTER_MS gets them now, on the
  // held backoff. Not main (the user types in its pane), not another agent kind, never into a dialog.
  for (const s of state.sessions.values()) {
    if (!isLive(s) || failed.has(s.id) || s.role === "main" || s.agent !== "claude-code" || s.status !== "active" || s.blockedNotified) continue;
    if (!s.noticesSince || !s.notices.length || Date.parse(now) - Date.parse(s.noticesSince) <= NOTICE_BUSY_DELIVER_AFTER_MS) continue;
    if (s.noticeHeldAt && Date.parse(now) - Date.parse(s.noticeHeldAt) <= noticeRetryMs(s.noticeHeldCount ?? 1)) continue;
    const e = noticeDelivery(s, { busy: true });
    if (e) effects.push(e);
  }
  // A busy coordinator that has not read its notices for NOTICE_STUCK_AFTER_MS: main hears once per stretch (not for an
  // idle one, whose delivery is retried above, nor one blocked on a dialog, which main heard of already).
  const main = liveSessions(state, undefined, "main")[0];
  for (const s of liveSessions(state, undefined, "coordinator")) {
    if (!main || failed.has(s.id) || s.status !== "active" || s.blockedNotified || s.noticeStuckReported || !s.noticesSince || !s.notices.length) continue;
    const busy = Date.parse(now) - Date.parse(s.noticesSince);
    if (busy <= NOTICE_STUCK_AFTER_MS) continue;
    const t = s.thread ? state.threads.get(s.thread) : undefined;
    if (!t || t.status === "done") continue;
    const first = s.notices[0]!.split("\n")[0]!.trim();
    const oldest = first.length > 120 ? `${first.slice(0, 119)}…` : first;
    const n = s.notices.length;
    events.push(
      { type: "notice.stuck_reported", thread: t.id, payload: { session: s.id } },
      {
        type: "notice.queued",
        thread: t.id,
        payload: { session: main.id, text: `The coordinator of thread ${t.id} has been busy for ${Math.floor(busy / 60_000)} min without reading ${n} message${n === 1 ? "" : "s"} (the oldest: "${oldest}"); it may be stuck in a long wait. Tell the user to check the thread tab ${t.id}-${t.slug} (Esc there interrupts it so it reads them).` },
      },
    );
  }
  // A coordinator whose Claude profile passed its threshold (or hit a rate limit) hands over to a replacement on the newly
  // chosen profile: never one already rotating (a handoff in progress), and at most one replacement per thread per 10 minutes.
  const usageRotating = new Set<string>();
  const picker = ctx.profile;
  if (picker) {
    for (const s of liveSessions(state, undefined, "coordinator")) {
      const t = s.thread ? state.threads.get(s.thread) : undefined;
      if (failed.has(s.id) || s.status === "starting" || !s.pane || s.rotation || !s.profile || !t || t.status === "done" || liveSessions(state, t.id, "coordinator")[0] !== s) continue;
      // Moving to another over-threshold profile gains nothing (and would ping-pong between them).
      if (!picker.exhausted(s.profile) || picker.name() === s.profile || picker.selection().allLimited) continue;
      const recent = [...state.sessions.values()].some((x) => x.thread === t.id && x.role === "coordinator" && x.replaces && Date.parse(now) - Date.parse(x.createdAt) <= USAGE_ROTATION_GAP_MS);
      if (recent) continue;
      usageRotating.add(s.id);
      events.push(...picker.take(), { type: "session.rotation_requested", thread: t.id, payload: { session: s.id, reason: "usage limit" } });
    }
    // Main is the user's pane: it is only told, once, and restarts when the user chooses.
    for (const m of liveSessions(state, undefined, "main")) {
      if (!m.profile || m.profileNotified || !picker.exhausted(m.profile)) continue;
      events.push(
        { type: "profile.notified", payload: { session: m.id, profile: m.profile } },
        { type: "notice.queued", payload: { session: m.id, text: `Claude profile ${m.profile} (main) is near its usage limit. Restart main later with agt start so it moves to ${picker.name() === m.profile ? "another profile" : `profile ${picker.name()}`}; it is not restarted automatically.` } },
      );
    }
  }
  for (const s of liveSessions(state, undefined, "coordinator")) {
    if (s.status === "starting") continue;
    if (!s.pane) continue; // not attached yet: it cannot have seen a handoff request
    const t0 = s.thread ? state.threads.get(s.thread) : undefined;
    // Age only matters for a coordinator that has worked; a parked one (0 turns) or one waiting on review or an
    // unblock would just be replaced by another idle coordinator.
    const working = s.turns > 0 && t0?.status !== "review" && t0?.status !== "blocked";
    if (!s.rotation && !usageRotating.has(s.id) && t0 && working && liveSessions(state, t0.id, "coordinator")[0] === s && Date.parse(now) - Date.parse(s.createdAt) > durationMs(ctx.config.session.rotation.max_age)) {
      events.push({ type: "session.rotation_requested", thread: t0.id, payload: { session: s.id, reason: "age" } });
      continue;
    }
    if (!s.rotation) continue;
    // The window runs from the request's delivery to the pane; a request not yet delivered waits, up to 2x the timeout
    // from the request (the hard cap).
    const limit = durationMs(timeout);
    const expired = s.rotation.deliveredAt
      ? Date.parse(now) - Date.parse(s.rotation.deliveredAt) > limit || Date.parse(now) - Date.parse(s.rotation.requestedAt) > 2 * limit
      : Date.parse(now) - Date.parse(s.rotation.requestedAt) > 2 * limit;
    if (!expired) continue;
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
