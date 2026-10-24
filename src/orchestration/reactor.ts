import { handoffRequestPrompt } from "../agents/prompts.ts";
import type { Effect } from "../commands/handler.ts";
import { type Config, durationMs } from "../config/config.ts";
import type { EventBody, StoredEvent } from "../domain/types.ts";
import { isLive, type Session, type State, type Thread } from "../state/projection.ts";
import { generateHandoff } from "./handoff.ts";
import { liveSessions, rotateCoordinator, spawnCoordinator, spawnReplacement, spawnWorker, tabEnsure, workerLimit } from "./sessions.ts";
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
          take(spawnCoordinator(t, ctx));
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
          const k = t.tickets.find((x) => x.id === s.ticket);
          const release = k?.status === "in_progress" && k.assignee === s.id;
          if (release) out.push({ type: "ticket.released", thread: t.id, payload: { ticket: k.id, reason: "worker session lost" } });
          notify(coordinatorToNotify(t.id), release ? `Worker for ${s.ticket} was lost; the ticket is open again.` : `Worker for ${s.ticket} was lost.`);
          // The released ticket is not open in `state` yet, so this only spawns other queued tickets; the coordinator decides on the released one.
          fillWorkers(t.id);
        }
        break;
      }
      case "ticket.completed":
        notify(coordinatorToNotify(ev.thread), `Ticket ${ev.payload.ticket} is done${ev.payload.summary ? `: ${ev.payload.summary}` : ""}.`);
        break;
      case "ticket.blocked":
        notify(coordinatorToNotify(ev.thread), `Ticket ${ev.payload.ticket} is blocked: ${ev.payload.reason}.`);
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
        if (s?.role === "worker") notify(coordinatorToNotify(s.thread), `Worker for ${s.ticket} failed: ${ev.payload.reason}.`);
        if (s?.role === "coordinator") notify(liveSessions(state, undefined, "main")[0], `Coordinator for thread ${s.thread} failed: ${ev.payload.reason}.`);
        fillWorkers(s?.thread);
        break;
      }
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
          // A worker that exits on its own must not leave its ticket stuck; one ended by teardown has a done or blocked ticket.
          const k = t.tickets.find((x) => x.id === s.ticket);
          if (k?.status === "in_progress" && k.assignee === s.id) {
            out.push({ type: "ticket.released", thread: t.id, payload: { ticket: k.id, reason: "worker session ended" } });
            notify(coordinatorToNotify(t.id), `Worker for ${k.id} ended; the ticket is open again.`);
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
          notify(coordinatorToNotify(ev.thread), `Question ${ev.payload.id} from the worker for ticket ${s.ticket ?? ev.actor.ticket}: ${ev.payload.message} Answer with: agt answer ${ev.thread} ${ev.payload.id} "<answer>"`);
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
        if (s && isLive(s) && s.role === "worker") {
          const pane = s.pane ?? "unknown";
          notify(coordinatorToNotify(s.thread), `The worker for ticket ${s.ticket} is blocked in pane ${pane}. Check it, replace it with agt worker spawn ${s.thread} --ticket ${s.ticket}, or ask the user.`);
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
        } else if (end(s) && ctx.config.herdr.close_worker_pane_on_end && s.pane) {
          effects.push({ kind: "pane.close", pane: s.pane });
        }
        break;
      }
    }
  }
  return { events: out, effects };
}
