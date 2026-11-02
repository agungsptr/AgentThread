import { handoffRequestPrompt, returnNotice } from "../agents/prompts.ts";
import { roleAgent } from "../agents/roles.ts";
import type { Effect } from "../commands/handler.ts";
import { type Config, durationMs } from "../config/config.ts";
import type { EventBody, StoredEvent } from "../domain/types.ts";
import { isLive, type Session, type State, type Thread } from "../state/projection.ts";
import { generateHandoff } from "./handoff.ts";
import { awaitsRespawn, awaitsWorker, conflictingTicket, exitedBeforeStart, liveSessions, rotateCoordinator, spawnCoordinator, spawnReplacement, spawnWorker, tabEnsure, workerCwd, workerLimit } from "./sessions.ts";
import { tierRun } from "./tiers.ts";

const CHECKPOINT_NOTICE = (thread: string | undefined) =>
  `CHECKPOINT: record where you are with: agt progress ${thread ?? "<thread>"} "<what is done, what is next>"`;

/** At most this many automatic coordinator replacements per thread within AUTO_REPLACE_WINDOW_MS. */
const MAX_AUTO_REPLACEMENTS = 3;
/**
 * Finished turns without any agt command after which a coordinator or worker is reported as stalled: a healthy one's
 * first turn runs one (agt thread status … in_progress, agt ticket claim); a bad model errors and idles instead.
 */
const STALL_TURNS = 1;
const AUTO_REPLACE_WINDOW_MS = 10 * 60_000;

export interface ReactorContext {
  root: string;
  config: Config;
  newId: () => string;
}

/** Pure follow-ups for freshly applied events: spawns, notifications, deliveries, worker teardown, coordinator rotation, recovery. */
const NO_TICKET = "a worker with no ticket";
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
/** A worker in a notice: `<lead> for <ticket>`, or "a worker with no ticket" when it has none. */
function workerRef(ticket: string | undefined, lead: string, noun = ""): string {
  return ticket ? `${lead} for ${noun}${ticket}` : NO_TICKET;
}

/** The coordinator's notice when a returned ticket's worker is gone while fixing it. */
const FRESH = "a fresh worker takes over the returned ticket.";
/** Fresh workers a returned ticket gets (since its latest return) before one more exit releases it to the coordinator. */
const MAX_FRESH_WORKERS = 2;
const KEEPS_EXITING = "returned ticket's workers keep exiting";
/** The coordinator's notice when a returned ticket is released because its fresh workers keep exiting. */
const EXITING = "the returned ticket's workers keep exiting, so the ticket is open again.";
const earlyNotice = (ticket: string) => `The worker for ticket ${ticket} exited before starting; agt started a fresh one.`;
const earlyTwiceNotice = (thread: string, ticket: string) =>
  `The worker for ticket ${ticket} exited before starting, twice; check its pane or spawn it again with agt worker spawn ${thread} --ticket ${ticket}.`;
const doneNotice = (ticket: string, summary: string | undefined) => `Ticket ${ticket} is done${summary ? `: ${summary}` : ""}.`;
const reviewNotice = (thread: string, ticket: string, summary: string | undefined) =>
  `Ticket ${ticket} is ready for review: ${summary ?? ""}. Review its commits, then agt ticket accept ${thread}/${ticket} or agt ticket return ${thread}/${ticket} "<what to fix>".`;

export function react(state: State, events: StoredEvent[], ctx: ReactorContext): { events: EventBody[]; effects: Effect[] } {
  const out: EventBody[] = [];
  const effects: Effect[] = [];
  const delivered = new Set<string>();
  const rotated = new Set<string>();
  const spawnedPerThread = new Map<string, number>();
  const spawnedTickets = new Set<string>();
  const ended = new Set<string>();

  const take = (r: { events: EventBody[]; effects: Effect[] }) => {
    out.push(...r.events);
    effects.push(...r.effects);
  };
  /** Coordinators rotated earlier in this call, old id → replacement id. State does not know about them yet. */
  const rotatedTo = new Map<string, string>();
  const notify = (target: Session | undefined, text: string) => {
    const to = target && rotatedTo.get(target.id);
    if (target && to) out.push({ type: "notice.queued", ...(target.thread ? { thread: target.thread } : {}), payload: { session: to, text } });
    else if (target) out.push({ type: "notice.queued", ...(target.thread ? { thread: target.thread } : {}), payload: { session: target.id, text } });
  };
  const coordinatorOf = (thread: string | undefined) => (thread ? liveSessions(state, thread, "coordinator")[0] : undefined);
  const lostSet = new Set<string>();
  /**
   * Who receives notices meant for a thread's coordinator: the live one, else the latest lost one, else the latest
   * one that was not rotated (e.g. failed or ended). Notices persist on such a session; a replacement carries them over.
   */
  const coordinatorToNotify = (thread: string | undefined): Session | undefined => {
    const live = coordinatorOf(thread);
    if (live || !thread) return live;
    const coordinators = [...state.sessions.values()].filter((s) => s.thread === thread && s.role === "coordinator");
    return coordinators.filter((s) => s.status === "lost" || lostSet.has(s.id)).at(-1) ?? coordinators.filter((s) => s.status !== "rotated").at(-1);
  };
  /** Records that `oldId` was replaced in this call and moves notices queued for it earlier in this call to `newId`. */
  const redirect = (oldId: string, newId: string) => {
    rotatedTo.set(oldId, newId);
    for (let i = 0; i < out.length; i++) {
      const e = out[i]!;
      if (e.type === "notice.queued" && e.payload.session === oldId) out[i] = { ...e, payload: { ...e.payload, session: newId } };
    }
  };
  const deliver = (s: Session | undefined) => {
    if (!s || delivered.has(s.id) || rotated.has(s.id) || !isLive(s) || s.status !== "idle" || !s.pane || s.notices.length === 0) return;
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
  /** Tickets released earlier in this call: state still shows them in_progress, and the coordinator decides on them. */
  const released = new Set<string>();
  const releaseTicket = (thread: string, ticket: string, reason: string) => {
    released.add(`${thread}/${ticket}`);
    out.push({ type: "ticket.released", thread, payload: { ticket, reason } });
  };
  const fillWorkers = (threadId: string | undefined) => {
    const t = threadId ? state.threads.get(threadId) : undefined;
    if (!t || t.status === "done" || !t.rootPane) return;
    // Workers ended earlier in this call (an accepted ticket's) no longer hold a slot; state does not know yet.
    let free = workerLimit(t, ctx.config) - liveSessions(state, t.id, "worker").filter((w) => !ended.has(w.id)).length - (spawnedPerThread.get(t.id) ?? 0);
    // Returned tickets whose worker is gone go first (they were running), then the queue, then open tickets whose
    // worker exited before starting (they wait like a queued spawn).
    const returned = t.tickets.filter((k) => k.status === "in_progress" && awaitsWorker(state, t, k.id)).map((k) => k.id);
    const respawns = t.tickets.filter((k) => awaitsRespawn(state, t, k.id)).map((k) => k.id);
    for (const ticket of new Set([...returned, ...t.workerQueue, ...respawns])) {
      if (free <= 0) break;
      if (spawnedTickets.has(`${t.id}/${ticket}`) || released.has(`${t.id}/${ticket}`)) continue; // spawned or released earlier in this call; state isn't updated yet
      if (!awaitsWorker(state, t, ticket)) continue;
      if (workerCwd(t, ticket) === undefined) continue; // its repo has no worktree (yet)
      if (conflictingTicket(state, t, ticket, new Set([...spawnedTickets].filter((x) => x.startsWith(`${t.id}/`)).map((x) => x.slice(t.id.length + 1))))) continue; // shares a file with a running ticket
      spawnedTickets.add(`${t.id}/${ticket}`);
      // A fresh worker for an early exit keeps the agent of the one it replaces when that was not roles.worker (--agent).
      const early = t.workerAgents[ticket] ? undefined : exitedBeforeStart(state, t, ticket);
      const agent = t.workerAgents[ticket] ?? (early && early.agent !== roleAgent(ctx.config, "worker").agent ? early.agent : undefined);
      take(spawnWorker(state, t, ticket, ctx, agent, ended));
      spawnedPerThread.set(t.id, (spawnedPerThread.get(t.id) ?? 0) + 1);
      free--;
    }
  };
  /**
   * A worker that exited before starting (Session.earlyExitSeq: it never claimed, and its ticket was still open) must
   * not strand its ticket: fillWorkers gives the ticket a fresh one through the queue (awaitsRespawn: max_workers, file
   * conflicts), and the coordinator hears it. Past MAX_EARLY_RESPAWNS the ticket stays open and the coordinator decides.
   * Only the event that counted the exit (`seq`) tells it: a later loss or failure is the same exit. Returns whether
   * the coordinator was told.
   */
  const earlyExitNotice = (s: Session, t: Thread, seq: number): boolean => {
    if (s.earlyExitSeq !== seq || !s.ticket || t.status === "done" || exitedBeforeStart(state, t, s.ticket)?.id !== s.id) return false;
    notify(coordinatorToNotify(t.id), awaitsRespawn(state, t, s.ticket) ? earlyNotice(s.ticket) : earlyTwiceNotice(t.id, s.ticket));
    return true;
  };
  /** The coordinator hears a ticket is ready for review at the event the projection picked (Ticket.reviewNoticeSeq). */
  const reviewReady = (ev: StoredEvent) => {
    const session = "session" in ev.payload && typeof ev.payload.session === "string" ? state.sessions.get(ev.payload.session) : undefined;
    const t = state.threads.get(ev.thread ?? session?.thread ?? "");
    const k = t?.tickets.find((x) => x.reviewNoticeSeq === ev.seq);
    if (t && k) notify(coordinatorToNotify(t.id), reviewNotice(t.id, k.id, k.summary));
  };
  /** Rotates a coordinator at most once per call; `first` is emitted just before the rotation. Returns whether it rotated. */
  const rotate = (s: Session, reason: string, first?: EventBody): boolean => {
    if (rotated.has(s.id)) return false;
    const r = rotateCoordinator(state, s, reason, ctx);
    const created = r.events.find((e) => e.type === "session.created");
    if (!created || created.type !== "session.created") return false;
    rotated.add(s.id);
    // Notices queued for the old session earlier in this call were not part of the carry-over; send them to the replacement.
    redirect(s.id, created.payload.session);
    if (first) out.push(first);
    take(r);
    return true;
  };
  let stackGiven = false;
  const requested = new Set<string>();
  const reminded = new Set<string>();
  const requestRotation = (s: Session | undefined, reason: string) => {
    if (s && isLive(s) && s.role === "coordinator" && !s.rotation && !requested.has(s.id) && !rotated.has(s.id)) {
      requested.add(s.id);
      out.push({ type: "session.rotation_requested", thread: s.thread, payload: { session: s.id, reason } } as EventBody);
    }
  };
  const { rotation } = ctx.config.session;
  /** Emits session.lost at most once per session per call. */
  const lose = (s: Session, reason: string) => {
    if (!lostSet.has(s.id)) {
      lostSet.add(s.id);
      out.push({ type: "session.lost", thread: s.thread, payload: { session: s.id, reason } } as EventBody);
    }
  };
  /**
   * A worker whose ticket it finished has ended or was lost: its turn is over, so the coordinator now hears that the
   * ticket is done (deferred at ticket.completed). The idle that ends a finished worker ends it here too.
   */
  const doneWorkerEnded = (s: Session, t: Thread) => {
    const k = t.tickets.find((x) => x.id === s.ticket);
    // An accepted ticket's coordinator heard of it at review (reviewReady) and accepted it: nothing more to say.
    if (k?.status === "done" && k.assignee === s.id && !k.accepted) notify(coordinatorToNotify(t.id), doneNotice(k.id, k.summary));
  };
  /** Ends a worker that finished its ticket (the teardown of the idle that ends it), closing its pane when configured. */
  const endFinishedWorker = (s: Session) => {
    if (end(s) && ctx.config.herdr.close_worker_pane_on_end && s.pane) effects.push({ kind: "pane.close", pane: s.pane });
  };
  /**
   * Replaces a lost or exited coordinator with a fresh split from the thread's root pane, at most once: never when it
   * was replaced earlier in this call or already has a replacement. Returns whether it did.
   */
  const replaceCoordinator = (s: Session, t: Thread, why: string): boolean => {
    if (!t.rootPane || rotatedTo.has(s.id) || [...state.sessions.values()].some((x) => x.replaces === s.id)) return false;
    // Never resumed: a fresh coordinator takes over from the handoff, generated when there is none or when it
    // predates the session (a handoff its predecessor wrote, already consumed by that rotation).
    if (!t.handoff || Date.parse(t.handoff.ts) < Date.parse(s.createdAt)) {
      out.push({ type: "handoff.submitted", thread: t.id, payload: { content: generateHandoff(t, why), generated: true } });
    }
    // A split gets its own agent env; the root pane may carry the old session's AGT_SESSION. It is retired on attach.
    // The root pane may be gone with the old coordinator (its pane was closed): any other live pane of the thread will do.
    const fallbacks = liveSessions(state, t.id)
      .filter((x) => x.id !== s.id && x.pane && x.pane !== t.rootPane)
      .map((x) => x.pane!);
    const r = spawnReplacement(t, s, ctx, { splitFrom: t.rootPane, retirePane: t.rootPane, bootstrap: "handoff", fallbacks });
    const created = r.events.find((e) => e.type === "session.created");
    if (created?.type === "session.created") redirect(s.id, created.payload.session);
    take(r);
    return true;
  };
  /**
   * Coordinator replacements (and rotations) of a thread in the 10 minutes up to `ts`, from session.created events
   * with `replaces`: derived from the log, so the brake survives a daemon restart.
   */
  const recentReplacements = (thread: string, ts: string) =>
    [...state.sessions.values()].filter(
      (x) => x.thread === thread && x.role === "coordinator" && x.replaces && Date.parse(ts) - Date.parse(x.createdAt) <= AUTO_REPLACE_WINDOW_MS,
    ).length;
  const braked = new Set<string>();
  const stalled = new Set<string>();
  /** Threads whose coordinator is lost in this batch; it will be replaced, so tab_opened must not spawn a fresh one. */
  const coordinatorLostIn = new Set(
    events
      .filter((e) => e.type === "session.lost")
      .map((e) => (e.type === "session.lost" ? state.sessions.get(e.payload.session) : undefined))
      .filter((s) => s?.role === "coordinator")
      .map((s) => s!.thread),
  );

  /** Timer states set earlier in this call, by thread; state does not know about them yet. */
  const timers = new Map<string, "paused" | "running">();
  /** Pauses (main is working) or restarts (main is idle) every proposal's timer that is not in that state already. */
  const setTimers = (s: Session | undefined, to: "paused" | "running") => {
    if (s?.role !== "main") return;
    for (const t of state.threads.values()) {
      if (!t.tierProposal || t.status === "done") continue;
      const current = timers.get(t.id) ?? (t.tierProposal.runningSince !== undefined ? "running" : "paused");
      if (current === to) continue;
      timers.set(t.id, to);
      out.push({ type: "thread.tier_timer", thread: t.id, payload: { state: to } });
    }
  };

  for (const ev of events) {
    reviewReady(ev);
    switch (ev.type) {
      case "thread.tier_chosen": {
        const t = state.threads.get(ev.thread);
        if (!t || t.status === "done" || t.tierProposal) break;
        if (state.layout && !t.tab) effects.push(tabEnsure(t, ctx));
        if (ev.payload.auto) {
          const timeout = ctx.config.agents.complexity.timeout;
          notify(liveSessions(state, undefined, "main")[0], `Thread ${t.id} started with tier ${ev.payload.tier} (${tierRun(ctx.config, ev.payload.tier)}) after ${timeout} without a choice.`);
        }
        break;
      }
      case "session.active":
        setTimers(state.sessions.get(ev.payload.session), "paused");
        break;
      case "notice.delivered":
        // A pasted notice starts a turn of main's: it is working.
        setTimers(state.sessions.get(ev.payload.session), "paused");
        break;
      case "thread.tab_opened": {
        const t = state.threads.get(ev.thread);
        // A proposed thread waits for its tier: its coordinator starts only once the tier is chosen.
        if (!t || t.status === "done" || !t.rootPane || t.tierProposal) break;
        const c = coordinatorOf(t.id);
        if (c && c.pane && c.pane !== t.rootPane) {
          lose(c, "tab was reopened");
          for (const w of liveSessions(state, t.id, "worker")) lose(w, "tab was reopened");
        } else if (!c && !coordinatorLostIn.has(t.id)) {
          // A tab reopened after its coordinator failed or ended (a root pane gone, or agt start reopening it): the new
          // coordinator replaces that session in the fresh root pane, carrying its queued notices; the brake counts it.
          const latest = [...state.sessions.values()].filter((x) => x.thread === t.id && x.role === "coordinator").at(-1);
          if (latest && (latest.status === "failed" || latest.status === "ended") && rotatedTo.has(latest.id)) {
            // Already replaced in this batch: its replacement is the coordinator, a second one would be a duplicate.
          } else if (latest && (latest.status === "failed" || latest.status === "ended")) {
            const r = spawnReplacement(t, latest, ctx, { pane: t.rootPane, bootstrap: t.handoff ? "handoff" : "start" });
            const created = r.events.find((e) => e.type === "session.created");
            if (created?.type === "session.created") redirect(latest.id, created.payload.session);
            take(r);
          } else {
            take(spawnCoordinator(t, ctx));
          }
        }
        break;
      }
      case "session.lost": {
        const s = state.sessions.get(ev.payload.session);
        const t = s?.thread ? state.threads.get(s.thread) : undefined;
        // The projection ignores a loss of a session that already rotated, ended or failed.
        if (!s || s.status !== "lost" || !t || t.status === "done") break;
        if (s.role === "coordinator" && t.rootPane) {
          replaceCoordinator(s, t, "the previous coordinator session was lost");
        } else if (s.role === "worker") {
          doneWorkerEnded(s, t);
          const k = t.tickets.find((x) => x.id === s.ticket);
          const held = k?.status === "in_progress" && k.assignee === s.id;
          // A returned ticket reaches a worker: fillWorkers gives it a fresh one (with the note), not the coordinator,
          // unless its fresh workers keep exiting.
          const returned = held && k.returnNote !== undefined;
          const exiting = returned && (k.freshWorkers ?? 0) >= MAX_FRESH_WORKERS;
          if (held && (!returned || exiting)) releaseTicket(t.id, k.id, exiting ? KEEPS_EXITING : "worker session lost");
          const w = cap(workerRef(s.ticket, "worker"));
          // One lost before it started is replaced, and the coordinator hears that instead.
          if (!earlyExitNotice(s, t, ev.seq)) {
            notify(coordinatorToNotify(t.id), exiting ? `${w} was lost; ${EXITING}` : returned ? `${w} was lost; ${FRESH}` : held ? `${w} was lost; the ticket is open again.` : `${w} was lost.`);
          }
          // A released ticket is not open in `state` yet, so this only spawns other queued tickets (and returned ones); the coordinator decides on the released one.
          fillWorkers(t.id);
        }
        break;
      }
      case "ticket.completed": {
        fillWorkers(ev.thread); // a queued ticket that shared its files can start
        // While its worker still runs, the notice waits for the worker's turn to end (see doneWorkerEnded): a coordinator
        // that reviews and commits at once would miss edits made after `agt ticket done`.
        const k = state.threads.get(ev.thread)?.tickets.find((x) => x.id === ev.payload.ticket);
        const w = k?.assignee ? state.sessions.get(k.assignee) : undefined;
        if (k?.status === "done" && w && isLive(w) && w.role === "worker") {
          // Completed by someone else (the coordinator) while the worker sits idle: no further idle will come, so end it now;
          // session.ended sends the notice. A worker's own `agt ticket done` is not ended here: its stored idle can be stale
          // (a compaction start, a lagging poll), so its own idle, or the sweep's grace, ends it.
          if (w.status === "idle" && ev.actor.session !== w.id) endFinishedWorker(w);
          break;
        }
        notify(coordinatorToNotify(ev.thread), doneNotice(ev.payload.ticket, ev.payload.summary));
        break;
      }
      case "stack.released": {
        // The freed lock goes to the first thread in the queue (state is the post-batch one, so a queue entry that left in
        // this batch is already gone); it is handed on once per call.
        const next = state.stack.holder || stackGiven ? undefined : state.stack.queue[0];
        if (!next) break;
        stackGiven = true;
        out.push({ type: "stack.acquired", thread: next.thread, payload: { thread: next.thread, ...(next.purpose ? { purpose: next.purpose } : {}) } });
        notify(coordinatorToNotify(next.thread), `The stack lock is yours for thread ${next.thread}.`);
        break;
      }
      case "ticket.reopened":
      case "ticket.released":
        // A released ticket no longer holds its files: a queued ticket that shared them can start. The released ticket
        // itself is not queued, so it waits for the coordinator.
        fillWorkers(ev.thread);
        break;
      case "ticket.accepted": {
        // The worker stayed for the review; accepted, it ends as a finished worker. One still busy ends at its idle (or
        // the sweep's grace). Its slot and the ticket's files are free for queued tickets.
        const k = state.threads.get(ev.thread)?.tickets.find((x) => x.id === ev.payload.ticket);
        const w = k?.assignee ? state.sessions.get(k.assignee) : undefined;
        if (k?.status === "done" && w && isLive(w) && w.role === "worker" && w.status === "idle") endFinishedWorker(w);
        fillWorkers(ev.thread);
        break;
      }
      case "ticket.returned": {
        const t = state.threads.get(ev.thread);
        const k = t?.tickets.find((x) => x.id === ev.payload.ticket);
        if (!t || k?.status !== "in_progress") break;
        const w = k.assignee ? state.sessions.get(k.assignee) : undefined;
        // Its worker is gone: a fresh one, whose bootstrap carries the note (spawnWorker), takes the ticket over. Without
        // a free slot it waits like a queued spawn: fillWorkers starts returned tickets awaiting a worker first.
        if (w && isLive(w)) notify(w, returnNotice(t.id, k.id, ev.payload.note));
        else fillWorkers(t.id);
        break;
      }
      case "ticket.blocked":
        fillWorkers(ev.thread);
        notify(coordinatorToNotify(ev.thread), `Ticket ${ev.payload.ticket} is blocked: ${ev.payload.reason}.`);
        break;
      case "thread.waiting":
        notify(liveSessions(state, undefined, "main")[0], `Thread ${ev.thread} (${state.threads.get(ev.thread)?.title ?? ""}) waits for you in its tab: ${ev.payload.what}`);
        break;
      case "thread.status_changed": {
        const t = state.threads.get(ev.thread);
        if (ev.payload.from === "blocked" && ev.payload.to === "open") {
          notify(coordinatorToNotify(ev.thread), `Thread ${ev.thread} is unblocked: ${ev.payload.reason ?? "no reason given"}.`);
        } else if (ev.payload.to === "review") {
          notify(liveSessions(state, undefined, "main")[0], `Thread ${ev.thread} (${t?.title ?? ""}) is ready for review.`);
        } else if (ev.payload.to === "done") {
          for (const s of liveSessions(state, ev.thread)) end(s);
        }
        break;
      }
      case "session.failed": {
        const s = state.sessions.get(ev.payload.session);
        const lostSpawn = /^spawn report lost after (.+)$/.exec(ev.payload.reason);
        // Herdr's missing-pane errors: the code itself, or the bridge's "herdr <cmd>: [agent target ]pane <id> not found".
        const paneGone = /pane_not_found|\bpane \S+ not found/i.test(ev.payload.reason);
        let reopened = false;
        const text = lostSpawn && s ? `Session ${s.id} (${s.role}) never reported back from its spawn; marked failed after ${lostSpawn[1]}.` : undefined;
        const t = s?.thread ? state.threads.get(s.thread) : undefined;
        if (s?.role === "worker") {
          if (t) doneWorkerEnded(s, t);
          // Its agent may have claimed the ticket before the report was lost (the spawn job stops that agent): free it.
          // A fresh worker for a returned ticket holds it from its creation: a failed spawn must not strand it either.
          const k = t && t.status !== "done" ? t.tickets.find((x) => x.id === s.ticket) : undefined;
          if (k?.status === "in_progress" && k.assignee === s.id && (lostSpawn || k.returnNote !== undefined)) {
            // Released, not respawned: a spawn that keeps failing must not loop. A worker that had run failed as a session.
            releaseTicket(t!.id, k.id, lostSpawn ? "worker spawn report lost" : s.pane || s.turns > 0 ? "worker session failed" : "worker spawn failed");
          }
          notify(coordinatorToNotify(s.thread), text ?? `${cap(workerRef(s.ticket, "worker"))} failed: ${ev.payload.reason}.`);
          if (t) earlyExitNotice(s, t, ev.seq);
        }
        if (s?.role === "coordinator") {
          const main = liveSessions(state, undefined, "main")[0];
          // A coordinator whose spawn report was lost never started: a fresh one takes over (same brake as an exit loop).
          if (lostSpawn && t && t.status !== "done" && !coordinatorOf(t.id)) {
            if (recentReplacements(t.id, ev.ts) >= MAX_AUTO_REPLACEMENTS) {
              notify(main, text!);
              if (!braked.has(t.id)) {
                braked.add(t.id);
                notify(main, `Coordinator for thread ${t.id} could not be replaced (too many recent replacements); run agt start after fixing the cause.`);
              }
            } else if (replaceCoordinator(s, t, "the previous coordinator never reported back from its spawn")) {
              notify(main, `${text!} A replacement is starting.`);
            } else {
              notify(main, text!);
            }
          } else if (paneGone && t && t.status !== "done" && !coordinatorOf(t.id)) {
            // A replacement's split found no pane to split from (the root pane went with the old coordinator, and no
            // fallback was live): the tab is beyond repair, so a fresh tab replaces it, and its tab_opened spawns the
            // coordinator. The loop is bounded by the brake: the coordinator the fresh tab spawns sets `replaces`, so every
            // reopen counts as a replacement and a tab that keeps failing stops after MAX_AUTO_REPLACEMENTS.
            if (recentReplacements(t.id, ev.ts) >= MAX_AUTO_REPLACEMENTS) {
              notify(main, `Coordinator for thread ${t.id} failed: ${ev.payload.reason}.`);
              if (!braked.has(t.id)) {
                braked.add(t.id);
                notify(main, `Coordinator for thread ${t.id} could not be replaced (too many recent replacements); run agt start after fixing the cause.`);
              }
            } else {
              if (t.tab) effects.push({ kind: "herdr.tab.close", thread: t.id, tab: t.tab });
              effects.push(tabEnsure({ ...t, tab: undefined }, ctx));
              notify(main, `Thread ${t.id} lost its tab pane; reopening its tab with a fresh coordinator.`);
              // Workers split from the root pane, which is gone with the tab: they wait for the fresh tab.
              reopened = true;
            }
          } else {
            notify(main, text ?? `Coordinator for thread ${s.thread} failed: ${ev.payload.reason}.`);
          }
        }
        if (!reopened) fillWorkers(s?.thread);
        break;
      }
      case "worktree.added":
        // A ticket queued while its repo had no worktree can start now.
        fillWorkers(ev.thread);
        break;
      case "session.ended": {
        const s = state.sessions.get(ev.payload.session);
        // Without a main session nobody is replying: a paused proposal must not wait forever.
        setTimers(s, "running");
        const t = s?.thread ? state.threads.get(s.thread) : undefined;
        // The thread's acting coordinator exited (any source: polled status or a hook): a fresh one takes over, as for
        // a loss. One ended by a finished thread, or one that was rotated or lost first, is not replaced here.
        if (s?.role === "coordinator" && s.status === "ended" && t && t.status !== "done" && !coordinatorOf(t.id)) {
          if (recentReplacements(t.id, ev.ts) >= MAX_AUTO_REPLACEMENTS) {
            // A replacement that keeps exiting (bad auth, a crash) would respawn forever. Only `agt start` retries now.
            if (!braked.has(t.id) && !rotatedTo.has(s.id) && t.rootPane) {
              braked.add(t.id);
              notify(liveSessions(state, undefined, "main")[0], `Coordinator for thread ${t.id} keeps exiting (${MAX_AUTO_REPLACEMENTS} replacements in 10m); not replacing. Fix the cause, then run agt start.`);
            }
          } else if (replaceCoordinator(s, t, "the previous coordinator session exited")) {
            notify(liveSessions(state, undefined, "main")[0], `Coordinator for thread ${t.id} exited; a fresh coordinator is starting from brief.md.`);
          }
        }
        if (s?.role === "worker" && t && t.status !== "done") {
          if (s.status === "ended") doneWorkerEnded(s, t);
          // A worker that exits on its own must not leave its ticket stuck; one ended by teardown has a done or blocked ticket.
          const k = t.tickets.find((x) => x.id === s.ticket);
          if (k?.status === "in_progress" && k.assignee === s.id && k.returnNote !== undefined && (k.freshWorkers ?? 0) >= MAX_FRESH_WORKERS) {
            // Its fresh workers keep exiting (bad auth, a crash): respawning would loop, so the coordinator decides.
            releaseTicket(t.id, k.id, KEEPS_EXITING);
            notify(coordinatorToNotify(t.id), `${cap(workerRef(k.id, "worker"))} ended; ${EXITING}`);
          } else if (k?.status === "in_progress" && k.assignee === s.id && k.returnNote !== undefined) {
            // A returned ticket reaches a worker: the fillWorkers below gives it a fresh one, with the note.
            notify(coordinatorToNotify(t.id), `${cap(workerRef(k.id, "worker"))} ended; ${FRESH}`);
          } else if (k?.status === "in_progress" && k.assignee === s.id) {
            releaseTicket(t.id, k.id, "worker session ended");
            notify(coordinatorToNotify(t.id), `${cap(workerRef(k.id, "worker"))} ended; the ticket is open again.`);
          } else {
            earlyExitNotice(s, t, ev.seq);
          }
        }
        fillWorkers(s?.thread);
        break;
      }
      case "notice.queued": {
        const s = state.sessions.get(ev.payload.session);
        const t = s?.thread ? state.threads.get(s.thread) : undefined;
        const stale =
          s && t && isLive(s) && s.role === "coordinator" && !s.rotation && s.status === "idle" && s.lastActiveAt &&
          Date.parse(ev.ts) - Date.parse(s.lastActiveAt) > durationMs(rotation.idle_timeout);
        if (s && rotated.has(s.id)) break; // already rotated in this call; its notices went to the replacement
        const handoff: EventBody | undefined = stale
          ? { type: "handoff.submitted", thread: t.id, payload: { content: generateHandoff(t, `the coordinator was idle for more than ${rotation.idle_timeout}`), generated: true } }
          : undefined;
        if (!handoff || !rotate(s!, "idle_timeout", handoff)) deliver(s);
        break;
      }
      case "session.attached": {
        const s = state.sessions.get(ev.payload.session);
        const old = s?.replaces ? state.sessions.get(s.replaces) : undefined;
        const t = s?.thread ? state.threads.get(s.thread) : undefined;
        // An explicit retirePane (the thread's root pane when the replacement was made) wins: after a tab reopen the
        // lost session's pane is gone with its old tab, and the new tab's root pane is the one to close.
        const retire = s?.retirePane ?? old?.pane;
        if (retire && retire !== ev.payload.pane) effects.push({ kind: "pane.close", pane: retire });
        if ((s?.replaces || s?.retirePane) && t && t.rootPane !== ev.payload.pane) out.push({ type: "thread.root_pane_changed", thread: t.id, payload: { pane: ev.payload.pane } });
        deliver(s);
        break;
      }
      case "session.started": {
        const s = state.sessions.get(ev.payload.session);
        if (s && isLive(s) && s.status === "idle") setTimers(s, "running");
        deliver(s);
        break;
      }
      case "session.compacting":
        if (rotation.on_precompact) requestRotation(state.sessions.get(ev.payload.session), "precompact");
        break;
      case "session.rotation_requested": {
        const s = state.sessions.get(ev.payload.session);
        const t = s?.thread ? state.threads.get(s.thread) : undefined;
        if (s && t && s.rotation?.requestedAt === ev.ts && !rotated.has(s.id)) notify(s, handoffRequestPrompt({ root: ctx.root, thread: t, reason: ev.payload.reason }));
        break;
      }
      case "handoff.submitted": {
        // Only the coordinator's own handoff, or a generated one, completes a pending rotation.
        const c = coordinatorOf(ev.thread);
        if (c?.rotation && (ev.actor.role === "coordinator" || ev.payload.generated)) rotate(c, c.rotation.reason);
        break;
      }
      case "question.recorded": {
        const s = ev.actor.session ? state.sessions.get(ev.actor.session) : undefined;
        if (s?.role === "worker" && ev.payload.id) {
          notify(coordinatorToNotify(ev.thread), `Question ${ev.payload.id} from ${workerRef(s.ticket ?? ev.actor.ticket, "the worker", "ticket ")}: ${ev.payload.message} Answer with: agt answer ${ev.thread} ${ev.payload.id} "<answer>"`);
        }
        break;
      }
      case "question.answered": {
        const q = state.threads.get(ev.thread)?.questions.find((x) => x.id === ev.payload.question);
        const asker = q?.actor.session ? state.sessions.get(q.actor.session) : undefined;
        // A worker that has ended gets nothing; the answer stays recorded.
        if (asker && isLive(asker) && asker.role === "worker") notify(asker, `Answer to ${ev.payload.question} from the coordinator: ${ev.payload.answer}`);
        break;
      }
      case "agent.blocked": {
        const s = state.sessions.get(ev.payload.session);
        // Limitation: state is the post-batch state, so two blocked events in one batch notify once (the first), and a block
        // raised and cleared inside one batch is not seen at all.
        // Only the event that raised the flag notifies: a repeat with no active/idle in between is the same block.
        if (s && isLive(s) && s.blockedSeq !== ev.seq) break;
        if (s && isLive(s) && s.role === "worker") {
          const pane = s.pane ?? "unknown";
          const replace = s.ticket ? `, replace it with agt worker spawn ${s.thread} --ticket ${s.ticket}, or ask the user` : " or ask the user";
          notify(coordinatorToNotify(s.thread), `${cap(workerRef(s.ticket, "the worker", "ticket "))} is blocked in pane ${pane}. Check it${replace}.`);
        } else if (s && isLive(s) && s.role !== "main") {
          notify(liveSessions(state, undefined, "main")[0], `${s.role} for thread ${s.thread} is waiting for approval in pane ${s.pane ?? "unknown"}.`);
        }
        break;
      }
      case "agent.idle": {
        const s = state.sessions.get(ev.payload.session);
        if (s && isLive(s)) setTimers(s, "running");
        // A coordinator or worker that never runs an agt command is likely misconfigured (a wrong model, no auth):
        // report it once, after its first turn.
        // Not a replacement (the session it replaced proved its agent and model), nor one already reported blocked; and
        // only turns that ran after its bootstrap was delivered count.
        if (s && isLive(s) && s.role !== "main" && (s.settledTurns ?? 0) >= STALL_TURNS && !s.authored && !s.stalled && !s.replaces && !s.blockedEarly && !stalled.has(s.id)) {
          stalled.add(s.id);
          out.push({ type: "session.stalled", ...(s.thread ? { thread: s.thread } : {}), payload: { session: s.id } } as EventBody);
          const text = `Session ${s.id} (${s.agent} ${s.model ?? "default"}) finished its first turn without running any agt command; it may be misconfigured (for example a wrong model). Check pane ${s.pane ?? "unknown"}.`;
          notify(s.role === "coordinator" ? liveSessions(state, undefined, "main")[0] : coordinatorToNotify(s.thread), text);
        }
        const ticketStatus = s?.thread ? state.threads.get(s.thread)?.tickets.find((k) => k.id === s.ticket)?.status : undefined;
        // A worker whose ticket is done or blocked has nothing left to do; ending it frees its slot.
        const finished = s && isLive(s) && s.role === "worker" && (ticketStatus === "done" || ticketStatus === "blocked");
        if (!finished) {
          if (s && s.role === "coordinator" && s.contextTokens !== undefined && s.contextTokens / rotation.context_window >= rotation.context_threshold) {
            requestRotation(s, "context");
          } else if (s && s.role === "coordinator" && s.turns >= rotation.max_turns) {
            requestRotation(s, "turns");
          }
          if (s && isLive(s) && s.role !== "main" && !s.rotation && !requested.has(s.id) && !rotated.has(s.id) && !reminded.has(s.id) && !s.remindedSinceProgress) {
            const since = Date.parse(ev.ts) - Date.parse(s.lastProgressAt ?? s.createdAt);
            if (s.turnsSinceProgress >= ctx.config.checkpoint.reminder_turns || since > durationMs(ctx.config.checkpoint.reminder_after)) {
              reminded.add(s.id);
              out.push({ type: "checkpoint.reminded", ...(s.thread ? { thread: s.thread } : {}), payload: { session: s.id } } as EventBody);
              notify(s, CHECKPOINT_NOTICE(s.thread));
            }
          }
          deliver(s);
        } else {
          endFinishedWorker(s);
        }
        break;
      }
    }
  }
  return { events: out, effects };
}
