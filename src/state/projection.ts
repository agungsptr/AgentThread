import { isHandoffRequest } from "../agents/prompts.ts";
import { STAGE_NAMES, type Actor, type AgentKind, type Layout, type Role, type SessionRole, type StageBy, type StageState, type StoredEvent, type ThreadStatus, type ThreadType, type TicketStatus } from "../domain/types.ts";

export type SessionStatus = "starting" | "active" | "idle" | "rotated" | "ended" | "failed" | "lost";

export interface Session {
  id: string;
  role: SessionRole;
  agent: AgentKind;
  model?: string;
  effort?: string;
  name: string;
  thread?: string;
  ticket?: string;
  pane?: string;
  status: SessionStatus;
  notices: string[];
  lastActiveAt?: string;
  contextTokens?: number;
  rotation?: { reason: string; requestedAt: string; /** When the handoff request reached the pane (notice.delivered): the fallback window runs from here. */ deliveredAt?: string };
  replaces?: string;
  /** The Claude profile it launched on (session.created), when several are configured. */
  profile?: string;
  /** Main was told that its profile is over the threshold (profile.notified). */
  profileNotified?: boolean;
  /** A pane to close once this session attaches elsewhere (the pane of a session it takes over from). */
  retirePane?: string;
  /** When the last resume of this session started (old logs only: sessions are no longer resumed). */
  resumingAt?: string;
  /** When the agent last recorded progress (set by progress.recorded). */
  lastProgressAt?: string;
  /** Turns finished since the last recorded progress. */
  turnsSinceProgress: number;
  /** A checkpoint reminder was sent since the last progress (cleared by progress.recorded). */
  remindedSinceProgress?: boolean;
  /**
   * The poller saw the first start, and nothing has happened since: the agent's own start hook, which may arrive just
   * after, is the same first start (not a resume).
   */
  polledStart?: boolean;
  /** Finished turns (real active to idle transitions). */
  turns: number;
  /** The session ran an agt command other than a lifecycle signal (see isAuthored). */
  authored?: boolean;
  /** Reported as stalled (session.stalled): finished its first turn without running any agt command. */
  stalled?: boolean;
  /** Turns finished with no notice (e.g. its bootstrap) still waiting for delivery: a startup spin does not count. */
  settledTurns?: number;
  /** Seq of the agent.idle that began the current idle stretch (cleared when the session is active again). */
  idleSeq?: number;
  /** When that agent.idle was (set and cleared with idleSeq). */
  idleAt?: string;
  /** The sweep reported this idle stretch to the coordinator (worker.idle_reported; cleared with idleSeq). */
  idleReported?: boolean;
  /** When a delivery of its queued notices was last held or failed (notice.held): the sweep retries after that. */
  noticeHeldAt?: string;
  /** Consecutive notice.held in this stretch (reset by a delivery or an active/started session): the sweep backs off by it. */
  noticeHeldCount?: number;
  /** Why the latest of them was held. */
  noticeHeldReason?: string;
  /** The coordinator was told the notices stay held (notice.held_reported; cleared with the stretch). */
  noticeHeldReported?: boolean;
  /** Since when notices have been queued for it without a break (set when its queue fills, cleared when it empties). */
  noticesSince?: string;
  /** Main was told this busy session has not read its notices (notice.stuck_reported; cleared when the queue empties). */
  noticeStuckReported?: boolean;
  /** The message of the session's latest progress or note. */
  lastReport?: string;
  /** Herdr reported it blocked before it finished any turn (it got a blocked notice instead). */
  blockedEarly?: boolean;
  /** A blocked notice was already raised and no active/idle/start has happened since. */
  blockedNotified?: boolean;
  /** A hook (a non-user actor; polls are the user) has signalled active or idle (its agent's hooks work); until then the poller drives its turns. */
  hooksSeen?: boolean;
  /** Seq of the agent.blocked event that raised that notice (the only one the reactor notifies for). */
  blockedSeq?: number;
  /** A worker claimed its ticket (ticket.claimed named it the assignee): it started, whatever the ticket's status later. */
  claimed?: boolean;
  /**
   * The seq of the end, loss or failure of a worker that never claimed while its ticket was still open: it exited before
   * starting (see Ticket.earlyExits). Only that event counts; a later loss or failure of the same session does not.
   */
  earlyExitSeq?: number;
  /** When the session was created (session.created ts). */
  createdAt: string;
}

export function isLive(s: Session): boolean {
  return s.status !== "ended" && s.status !== "failed" && s.status !== "rotated" && s.status !== "lost";
}

export function displayStatus(s: Session): string {
  return s.rotation && isLive(s) ? "rotating" : s.status;
}

export interface Ticket {
  id: string;
  title: string;
  scope: string[];
  /** A task thread's ticket: the repo it works in, the repo-relative files it may change, and its doc path. */
  repo?: string;
  files?: string[];
  doc?: string;
  status: TicketStatus;
  assignee?: string;
  /** The summary of `agt ticket done` (set while the ticket is done). */
  summary?: string;
  /** When the ticket was completed (set while it is done); on a task thread, when it was accepted. */
  completedAt?: string;
  /** Task threads, while in review: the seq of the event at which the coordinator hears the ticket is ready for review. */
  reviewNoticeSeq?: number;
  /** Task threads: the coordinator's note of the latest return, until the ticket is in review again; a fresh worker gets it. */
  returnNote?: string;
  /** Task threads: the coordinator accepted it (its done notice was the review notice). */
  accepted?: boolean;
  /** Task threads: fresh workers created for the ticket since its latest return (see session.created); bounds respawns. */
  freshWorkers?: number;
  /**
   * Workers of the ticket that ended, were lost or failed while it was still open (before any claimed it), since its
   * latest claim; the reactor gives it a fresh worker for the first MAX_EARLY_RESPAWNS of them (orchestration/sessions.ts).
   */
  earlyExits?: number;
  /** Idle notices the coordinator got for the ticket's workers (worker.idle_reported); capped (orchestration/sweep.ts). */
  idleNotices?: number;
  /** The coordinator was told a worker of the ticket passed the context threshold (worker.context_reported): once per ticket. */
  contextReported?: boolean;
}

export interface Entry {
  ts: string;
  actor: Actor;
  message: string;
}

/** A question asked with `agt question`; `by` is the asker's role and ticket, `answer` the coordinator's reply. */
export interface Question extends Entry {
  id: string;
  by?: { role: Role; ticket?: string };
  answer?: { message: string; ts: string };
}

/** A recorded progress line and who wrote it. */
export interface Progress {
  message: string;
  ts: string;
  actor: Actor;
  role: Role;
  ticket?: string;
}

/** `(coordinator)`, `(worker T1)`, `(main)`: who a progress line is from. */
export function progressBy(p: Progress): string {
  return p.role === "worker" && p.ticket ? `(worker ${p.ticket})` : `(${p.role})`;
}

export interface Thread {
  id: string;
  tab?: string;
  rootPane?: string;
  slug: string;
  title: string;
  type: ThreadType;
  status: ThreadStatus;
  goal: string;
  criteria: string[];
  dependsOn: string[];
  /** Legacy threads: the thread's branch and its one git worktree, where every session runs. */
  branch?: string;
  worktree?: string;
  /** Thread-directory threads: the task name and `<root>/.worktrees/<task>` (not a git repo), where the sessions run. */
  task?: string;
  dir?: string;
  /** The repo worktrees inside `dir`, by repo name. */
  worktrees: Record<string, { path: string; branch: string; source: string }>;
  /** Repo worktrees being created in the background (worktree.requested, not yet added or failed), by repo name. */
  worktreeRequests: Record<string, { path: string; branch: string; source: string }>;
  /** A cleanup (`agt thread cleanup`) runs in the background: requested, not yet cleaned or failed. */
  cleanupRequested?: boolean;
  /** True for a thread created before thread directories (its thread.created has a worktree and no dir). */
  legacy: boolean;
  maxWorkers?: number;
  /** The complexity tier the thread runs at (picks the coordinator's agent). */
  tier?: string;
  /** A proposed tier that waits for the user's choice; `runningSince` is undefined while the timer is paused. */
  tierProposal?: { tier: string; reason: string; runningSince?: string };
  /** How the tier was chosen, and the reason main gave for proposing it. */
  tierChoice?: { auto: boolean; reason: string };
  workerQueue: string[];
  /** The `agt worker spawn --agent` override of a queued ticket, by ticket; dropped when its worker is created. */
  workerAgents: Record<string, AgentKind>;
  tickets: Ticket[];
  /** Task threads: the latest record of each stage 1-10 (approve is not a stage state; see stage7Approved). */
  stages: Partial<Record<number, { state: Exclude<StageState, "approve">; by: StageBy; reason?: string; ts: string }>>;
  /** The user approved the e2e stage (`agt stage <thread> 7 approve --by user`). */
  stage7Approved: boolean;
  /**
   * The coordinator said it waits for the user. `idleSeen` is set by the coordinator's next idle; the turn start after
   * that (the user answering) clears it.
   */
  waiting?: { what: string; since: string; idleSeen: boolean; session?: string };
  /** The last agt thread waiting, kept after the wait ends: the blocked notice is not sent for a session that just said it waits. */
  lastWaiting?: { session?: string; at: string };
  /**
   * The wait on the user that main may have been told about: a coordinator's blocked pane (agent.blocked) and/or its
   * agt thread waiting. `told` are the wait notices queued to main (notice.queued with wait); `endedSeq` is the
   * session.active event at which the user answered. Kept after it ends, so the reactor sees its end.
   */
  openWait?: { session?: string; at: string; blocked?: boolean; what?: string; told: string[]; endedSeq?: number };
  /** The last agent.blocked of a coordinator (or planner): a thread.waiting right after it is not told to main again. */
  lastBlocked?: { session: string; at: string };
  /** The thread was created with --browser-check: stage 8 is required. */
  browserCheck?: true;
  decisions: Entry[];
  findings: Entry[];
  questions: Question[];
  /** The thread's position: the coordinator's (or main's, or the user's) latest progress. */
  progress?: Progress;
  /** Each worker's latest progress, by ticket. */
  workerProgress: Record<string, Progress>;
  log: Entry[];
  /** `by` is "generated" for a daemon-written handoff, else the author's role. */
  handoff?: { content: string; generated: boolean; ts: string; by: string };
}

/** Where a thread's sessions run: its thread directory, or a legacy thread's worktree. */
export function threadCwd(t: { dir?: string; worktree?: string }): string {
  const cwd = t.dir ?? t.worktree;
  if (cwd === undefined) throw new Error("thread has neither a directory nor a worktree");
  return cwd;
}

export interface State {
  layout?: Layout;
  project?: { name: string };
  threads: Map<string, Thread>;
  sessions: Map<string, Session>;
  /** The workspace's one stack lock: who holds it and who waits, in order. */
  stack: { holder?: { thread: string; purpose?: string; since: string }; queue: { thread: string; purpose?: string }[] };
  /** Claude profiles: the one new launches use (profile.switched) and the rate_limit marks (profile.limited, the latest per profile). */
  profiles: { current?: string; limited: Record<string, { at: string }> };
  lastSeq: number;
}

export function emptyState(): State {
  return { threads: new Map(), sessions: new Map(), stack: { queue: [] }, profiles: { limited: {} }, lastSeq: 0 };
}

export function project(events: StoredEvent[]): State {
  const state = emptyState();
  for (const ev of events) applyEvent(state, ev);
  return state;
}

/**
 * The session an actor stands for. Without AGT_SESSION (a thread's first coordinator runs in the tab's root pane, whose
 * env has none) it is the thread's acting coordinator, or the live worker of the actor's ticket.
 */
export function actorSession(state: State, actor: Actor): string | undefined {
  if (actor.session) return actor.session;
  if (!actor.thread) return undefined;
  const live = [...state.sessions.values()].filter((s) => isLive(s) && s.thread === actor.thread);
  if (actor.role === "coordinator") return live.find((s) => s.role === "coordinator")?.id;
  if (actor.role === "worker" && actor.ticket) return live.find((s) => s.role === "worker" && s.ticket === actor.ticket)?.id;
  return undefined;
}

/**
 * Event types only an agt command produces (never the reactor or an effect), for logs written before commands were
 * marked `via: "command"`.
 */
export const COMMAND_OUTPUT_TYPES: ReadonlySet<string> = new Set([
  "thread.status_changed", "ticket.created", "ticket.files_changed", "ticket.claimed", "ticket.completed", "ticket.blocked", "ticket.reopened",
  "ticket.reviewed", "ticket.accepted", "ticket.returned", "stage.recorded", "log.appended", "decision.recorded", "note.recorded", "progress.recorded", "question.recorded", "question.answered",
  "worker.queued", "thread.waiting", "thread.browser_check", "thread.cleanup_requested",
]);

/**
 * Whether an event shows that its actor ran an agt command: handle() decided it for a command other than a signal.
 * Follow-ups (the reactor's events, effect output such as notice.delivered) are stored with the triggering actor but
 * unmarked, so a session's own hooks never count. Unmarked events (old logs) count by type: the reactor and effects
 * emit none of these types, so a follow-up never matches.
 */
function isAuthored(ev: StoredEvent): boolean {
  if (ev.actor.via === "command") return true;
  if (ev.type === "handoff.submitted") return ev.payload.generated === false;
  return COMMAND_OUTPUT_TYPES.has(ev.type);
}

export function applyEvent(state: State, ev: StoredEvent): void {
  state.lastSeq = ev.seq;
  if (isAuthored(ev) && (ev.actor.role === "coordinator" || ev.actor.role === "worker" || ev.actor.session)) {
    // Commands are attributed at intake; old logs without a session fall back to the acting session (replay backstop).
    const sid = actorSession(state, ev.actor);
    const by = sid ? state.sessions.get(sid) : undefined;
    if (by) by.authored = true;
  }

  if (ev.type === "project.initialized") {
    state.project = { name: ev.payload.name };
    return;
  }

  if (ev.type === "layout.registered") {
    state.layout = ev.payload;
    return;
  }

  if (ev.type === "stack.acquired" || ev.type === "stack.queued" || ev.type === "stack.released") {
    const { thread } = ev.payload;
    const purpose = "purpose" in ev.payload ? ev.payload.purpose : undefined;
    const { stack } = state;
    const entry = { thread, ...(purpose ? { purpose } : {}) };
    const at = stack.queue.findIndex((q) => q.thread === thread);
    // A queued thread queued again (a new purpose) keeps its place.
    if (ev.type === "stack.queued" && at >= 0) {
      stack.queue[at] = entry;
      return;
    }
    stack.queue = stack.queue.filter((q) => q.thread !== thread);
    // The holder acquiring again (a new purpose) has held the lock since it first got it.
    if (ev.type === "stack.acquired") stack.holder = { ...entry, since: stack.holder?.thread === thread ? stack.holder.since : ev.ts };
    else if (ev.type === "stack.queued") stack.queue.push(entry);
    else if (stack.holder?.thread === thread) delete stack.holder;
    return;
  }

  if (ev.type === "profile.switched") {
    state.profiles.current = ev.payload.to;
    return;
  }
  if (ev.type === "profile.limited") {
    state.profiles.limited[ev.payload.profile] = { at: ev.payload.at };
    return;
  }
  if (ev.type === "profile.notified") {
    const s = state.sessions.get(ev.payload.session);
    if (s) s.profileNotified = true;
    return;
  }

  if (applySessionEvent(state, ev)) return;

  if (ev.type === "thread.created") {
    const p = ev.payload;
    const thread: Thread = {
      id: ev.thread,
      slug: p.slug,
      title: p.title,
      type: p.threadType,
      status: p.status,
      goal: p.goal,
      criteria: p.criteria,
      dependsOn: p.dependsOn,
      ...(p.branch !== undefined ? { branch: p.branch } : {}),
      ...(p.worktree !== undefined ? { worktree: p.worktree } : {}),
      ...(p.task !== undefined ? { task: p.task } : {}),
      ...(p.dir !== undefined ? { dir: p.dir } : {}),
      worktrees: {},
      worktreeRequests: {},
      legacy: p.dir === undefined && p.worktree !== undefined,
      maxWorkers: p.maxWorkers,
      ...(p.browserCheck ? { browserCheck: true as const } : {}),
      workerQueue: [],
      workerAgents: {},
      tickets: [],
      stages: {},
      stage7Approved: false,
      decisions: [],
      findings: [],
      questions: [],
      workerProgress: {},
      log: [],
    };
    state.threads.set(ev.thread, thread);
    note(thread, ev, `thread created (${p.status})`);
    return;
  }

  const t = ev.thread ? state.threads.get(ev.thread) : undefined;
  if (!t) throw new Error(`event ${ev.seq} references unknown thread ${ev.thread}`);
  const ticket = (id: string) => {
    const found = t.tickets.find((k) => k.id === id);
    if (!found) throw new Error(`event ${ev.seq} references unknown ticket ${id}`);
    return found;
  };

  switch (ev.type) {
    case "thread.tab_opened":
      t.tab = ev.payload.tab;
      t.rootPane = ev.payload.rootPane;
      note(t, ev, `herdr tab ${ev.payload.tab} opened`);
      break;
    case "worktree.requested":
      t.worktreeRequests[ev.payload.repo] = { path: ev.payload.path, branch: ev.payload.branch, source: ev.payload.source };
      note(t, ev, `worktree for ${ev.payload.repo} requested at ${ev.payload.path} on ${ev.payload.branch} from ${ev.payload.source}`);
      break;
    case "worktree.added":
      delete t.worktreeRequests[ev.payload.repo];
      t.worktrees[ev.payload.repo] = { path: ev.payload.path, branch: ev.payload.branch, source: ev.payload.source };
      note(t, ev, `worktree for ${ev.payload.repo} added at ${ev.payload.path} on ${ev.payload.branch} from ${ev.payload.source}`);
      break;
    case "worktree.failed":
      delete t.worktreeRequests[ev.payload.repo];
      note(t, ev, `worktree for ${ev.payload.repo} failed: ${ev.payload.reason}`);
      break;
    case "thread.cleanup_requested":
      t.cleanupRequested = true;
      note(t, ev, "cleanup requested");
      break;
    case "thread.cleaned":
      // The worktrees are gone: nothing may run in them or read their git trail any more.
      delete t.cleanupRequested;
      for (const repo of ev.payload.repos) delete t.worktrees[repo];
      note(t, ev, `cleaned up: removed the worktrees and wip/${t.task ?? ""} of ${ev.payload.repos.join(", ")}`);
      break;
    case "thread.cleanup_failed":
      delete t.cleanupRequested;
      for (const repo of ev.payload.removed ?? []) delete t.worktrees[repo];
      note(t, ev, `cleanup stopped at ${ev.payload.repo}: ${ev.payload.reason}`);
      break;
    case "thread.tab_closed":
      delete t.tab;
      delete t.rootPane;
      note(t, ev, `herdr tab ${ev.payload.tab} closed`);
      break;
    case "thread.tier_proposed":
      t.tierProposal = { tier: ev.payload.tier, reason: ev.payload.reason };
      note(t, ev, `tier ${ev.payload.tier} proposed${ev.payload.reason ? `: ${ev.payload.reason}` : ""}`);
      break;
    case "thread.tier_timer":
      if (t.tierProposal) {
        if (ev.payload.state === "running") t.tierProposal.runningSince = ev.ts;
        else delete t.tierProposal.runningSince;
      }
      break;
    case "thread.tier_chosen":
      t.tier = ev.payload.tier;
      t.tierChoice = { auto: ev.payload.auto, reason: t.tierProposal?.reason ?? "" };
      delete t.tierProposal;
      note(t, ev, `tier ${ev.payload.tier} chosen by ${ev.payload.auto ? "auto" : "user"}`);
      break;
    case "thread.status_changed": {
      t.status = ev.payload.to;
      if (t.status === "done") delete t.tierProposal;
      const reason = ev.payload.reason ? `: ${ev.payload.reason}` : "";
      note(t, ev, `status ${ev.payload.from} → ${ev.payload.to}${reason}`);
      break;
    }
    case "ticket.created":
      t.tickets.push({
        id: ev.payload.ticket,
        title: ev.payload.title,
        scope: ev.payload.scope,
        ...(ev.payload.repo !== undefined ? { repo: ev.payload.repo } : {}),
        ...(ev.payload.files !== undefined ? { files: ev.payload.files } : {}),
        ...(ev.payload.doc !== undefined ? { doc: ev.payload.doc } : {}),
        status: "open",
      });
      note(t, ev, `${ev.payload.ticket} created: ${ev.payload.title}`);
      break;
    case "ticket.files_changed": {
      const k = ticket(ev.payload.ticket);
      k.files = [...ev.payload.files];
      k.scope = [...ev.payload.files];
      const parts = [...ev.payload.added.map((f) => `+${f}`), ...ev.payload.removed.map((f) => `-${f}`)];
      note(t, ev, `${k.id} files changed: ${parts.join(" ")}`);
      break;
    }
    case "ticket.claimed": {
      const k = ticket(ev.payload.ticket);
      k.status = "in_progress";
      k.assignee = ev.payload.assignee;
      delete k.earlyExits; // a worker started on it: the next early exit counts from zero
      const by = state.sessions.get(ev.payload.assignee);
      if (by) by.claimed = true;
      note(t, ev, `${k.id} claimed by ${k.assignee}`);
      break;
    }
    case "ticket.completed": {
      const k = ticket(ev.payload.ticket);
      k.status = "done";
      k.completedAt = ev.ts;
      if (ev.payload.summary) k.summary = ev.payload.summary;
      else delete k.summary;
      note(t, ev, `${k.id} done${ev.payload.summary ? `: ${ev.payload.summary}` : ""}`);
      break;
    }
    case "ticket.reviewed": {
      const k = ticket(ev.payload.ticket);
      k.status = "review";
      k.summary = ev.payload.summary;
      delete k.returnNote;
      delete k.freshWorkers;
      // The coordinator hears it when the worker's turn ends (see reviewNoticeAt); at once when the worker is gone or
      // already recorded idle (a polled worker whose idle came first: no further idle may come).
      const w = k.assignee ? state.sessions.get(k.assignee) : undefined;
      if (!w || !isLive(w) || w.status === "idle") k.reviewNoticeSeq = ev.seq;
      note(t, ev, `${k.id} ready for review: ${ev.payload.summary}`);
      break;
    }
    case "ticket.accepted": {
      const k = ticket(ev.payload.ticket);
      k.status = "done";
      k.accepted = true;
      k.completedAt = ev.ts;
      delete k.reviewNoticeSeq;
      note(t, ev, `${k.id} accepted`);
      break;
    }
    case "ticket.returned": {
      const k = ticket(ev.payload.ticket);
      k.status = "in_progress";
      k.returnNote = ev.payload.note;
      delete k.freshWorkers;
      delete k.summary;
      delete k.reviewNoticeSeq;
      delete k.contextReported;
      note(t, ev, `${k.id} returned: ${ev.payload.note}`);
      break;
    }
    case "ticket.blocked": {
      const k = ticket(ev.payload.ticket);
      k.status = "blocked";
      note(t, ev, `${k.id} blocked: ${ev.payload.reason}`);
      break;
    }
    case "ticket.reopened": {
      const k = ticket(ev.payload.ticket);
      k.status = "open";
      delete k.assignee;
      delete k.summary;
      delete k.completedAt;
      delete k.returnNote;
      delete k.freshWorkers;
      delete k.earlyExits;
      delete k.accepted;
      note(t, ev, `${k.id} reopened`);
      break;
    }
    case "ticket.released": {
      const k = ticket(ev.payload.ticket);
      k.status = "open";
      delete k.assignee;
      delete k.freshWorkers;
      note(t, ev, `${k.id} released: ${ev.payload.reason}`);
      break;
    }
    case "thread.root_pane_changed":
      t.rootPane = ev.payload.pane;
      note(t, ev, `root pane is now ${ev.payload.pane}`);
      break;
    case "thread.browser_check": {
      t.browserCheck = true;
      // agt's own "not requested" skip is withdrawn, so stage 8 is open again (the squash guard closes); a user's skip, done or na stays.
      const s8 = t.stages[8];
      if (s8?.state === "skipped" && s8.by === "agt") delete t.stages[8];
      note(t, ev, "browser check requested");
      break;
    }
    case "thread.waiting":
      // A repeat replaces the text and starts the wait over.
      t.waiting = { what: ev.payload.what, since: ev.ts, idleSeen: false, ...(ev.actor.session ? { session: ev.actor.session } : {}) };
      t.lastWaiting = { ...(ev.actor.session ? { session: ev.actor.session } : {}), at: ev.ts };
      {
        // A wait not answered yet carries on, whoever asks again (the same coordinator, or its replacement after a
        // rotation): what main was told stays told. Its blocked pane is only the same session's.
        const open = t.openWait && t.openWait.endedSeq === undefined ? t.openWait : undefined;
        const same = open && open.session === ev.actor.session ? open : undefined;
        t.openWait = { ...(ev.actor.session ? { session: ev.actor.session } : {}), at: open?.at ?? ev.ts, ...(same?.blocked ? { blocked: true } : {}), what: ev.payload.what, told: open?.told ?? [] };
      }
      note(t, ev, `waiting for the user: ${ev.payload.what}`);
      break;
    case "worker.queued":
      t.workerQueue.push(ev.payload.ticket);
      if (ev.payload.agent) t.workerAgents[ev.payload.ticket] = ev.payload.agent;
      note(t, ev, `${ev.payload.ticket} queued for a worker`);
      break;
    case "stage.recorded": {
      const p = ev.payload;
      if (p.state === "approve") t.stage7Approved = true;
      else t.stages[p.stage] = { state: p.state, by: p.by, ...(p.reason ? { reason: p.reason } : {}), ts: ev.ts };
      note(t, ev, `stage ${p.stage} (${STAGE_NAMES[p.stage - 1]}) ${p.state}${p.reason ? `: ${p.reason}` : ""}`);
      break;
    }
    case "log.appended":
      note(t, ev, ev.payload.message);
      break;
    case "decision.recorded":
      t.decisions.push({ ts: ev.ts, actor: ev.actor, message: ev.payload.message });
      note(t, ev, `decision: ${ev.payload.message}`);
      break;
    case "note.recorded": {
      t.findings.push({ ts: ev.ts, actor: ev.actor, message: ev.payload.message });
      const by = ev.actor.session ? state.sessions.get(ev.actor.session) : undefined;
      if (by) by.lastReport = ev.payload.message;
      note(t, ev, `note: ${ev.payload.message}`);
      break;
    }
    case "question.recorded": {
      const by = ev.actor.session ? state.sessions.get(ev.actor.session) : undefined;
      const role: Role | undefined = by?.role ?? ev.actor.role;
      const ticketId = ev.actor.ticket ?? by?.ticket;
      // Old events carry no id: they are numbered in log order.
      const id = ev.payload.id ?? `Q${t.questions.length + 1}`;
      t.questions.push({
        id,
        ts: ev.ts,
        actor: ev.actor,
        message: ev.payload.message,
        ...(role ? { by: { role, ...(ticketId ? { ticket: ticketId } : {}) } } : {}),
      });
      note(t, ev, `question: ${ev.payload.message}`);
      break;
    }
    case "question.answered": {
      const q = t.questions.find((x) => x.id === ev.payload.question);
      if (q) q.answer = { message: ev.payload.answer, ts: ev.ts };
      note(t, ev, `answer to ${ev.payload.question}: ${ev.payload.answer}`);
      break;
    }
    case "progress.recorded": {
      const by = ev.actor.session ? state.sessions.get(ev.actor.session) : undefined;
      // Old events may carry no role: they are the coordinator's.
      const role: Role = by?.role ?? ev.actor.role ?? "coordinator";
      const ticketId = ev.actor.ticket ?? by?.ticket;
      const p: Progress = { message: ev.payload.message, ts: ev.ts, actor: ev.actor, role, ...(ticketId ? { ticket: ticketId } : {}) };
      if (role === "worker" && ticketId) t.workerProgress[ticketId] = p;
      else t.progress = p;
      note(t, ev, `progress: ${ev.payload.message}`);
      const sid =
        ev.actor.session ??
        (role === "coordinator"
          ? [...state.sessions.values()].find((s) => s.thread === t.id && s.role === "coordinator" && isLive(s))?.id
          : undefined);
      const s = sid ? state.sessions.get(sid) : undefined;
      if (s) {
        s.lastProgressAt = ev.ts;
        s.lastReport = ev.payload.message;
        s.turnsSinceProgress = 0;
        delete s.remindedSinceProgress;
      }
      break;
    }
    case "handoff.submitted":
      t.handoff = { content: ev.payload.content, generated: ev.payload.generated, ts: ev.ts, by: ev.payload.generated ? "generated" : (ev.actor.role ?? "coordinator") };
      note(t, ev, `handoff submitted${ev.payload.generated ? " (generated)" : ""}`);
      break;
  }
}

/** A task thread's current stage: the lowest not done, skipped or na; undefined for a legacy thread or when all ten are passed. */
export function currentStage(t: Thread): { n: number; name: string } | undefined {
  if (t.legacy) return undefined;
  for (let n = 1; n <= 10; n++) if (!t.stages[n]) return { n, name: STAGE_NAMES[n - 1]! };
  return undefined;
}

/** `Stage: <n> <name>` for a task thread (`all done` once every stage is passed), else nothing. */
export function stageLine(t: Thread): string[] {
  if (t.legacy) return [];
  const c = currentStage(t);
  return [`Stage: ${c ? `${c.n} ${c.name}` : "all done"}`];
}

function note(thread: Thread, ev: StoredEvent, message: string): void {
  thread.log.push({ ts: ev.ts, actor: ev.actor, message });
}

const short = (id: string) => id.slice(0, 8);

function sessionOf(state: State, seq: number, id: string): Session {
  const s = state.sessions.get(id);
  if (!s) throw new Error(`event ${seq} references unknown session ${id}`);
  return s;
}

function threadNote(state: State, ev: StoredEvent, message: string): void {
  const t = ev.thread ? state.threads.get(ev.thread) : undefined;
  if (t) note(t, ev, message);
}

/** A coordinator's turn start after its idle: the user answered, so the thread no longer waits. */
function clearWaiting(state: State, s: Session, ev: StoredEvent): void {
  if (ev.type !== "session.active" || s.role !== "coordinator" || !s.thread) return;
  const t = state.threads.get(s.thread);
  if (!t?.waiting?.idleSeen) return;
  delete t.waiting;
  if (t.openWait && t.openWait.endedSeq === undefined && t.openWait.session === s.id) {
    t.openWait.endedSeq = ev.seq;
    delete t.lastBlocked;
  }
  note(t, ev, "the user answered; no longer waiting");
}

/**
 * The first turn end (idle) or end of a worker whose ticket waits in review is when the coordinator hears it is ready:
 * edits the worker makes after `agt ticket done` within that turn are then in. Records that event's seq once.
 */
function reviewNoticeAt(state: State, s: Session, seq: number): void {
  if (s.role !== "worker" || !s.ticket || !isLive(s)) return;
  const k = (s.thread ? state.threads.get(s.thread) : undefined)?.tickets.find((x) => x.id === s.ticket);
  if (k?.status === "review" && k.assignee === s.id && k.reviewNoticeSeq === undefined) k.reviewNoticeSeq = seq;
}

/**
 * A live worker that never claimed, leaving while its ticket is still open with no other live worker for it, exited
 * before starting: it is marked (Session.earlyExitSeq) and counted on the ticket (Ticket.earlyExits). Called before
 * its status changes.
 */
function countEarlyExit(state: State, s: Session, seq: number): void {
  if (s.role !== "worker" || !isLive(s) || s.claimed || !s.thread || !s.ticket) return;
  const t = state.threads.get(s.thread);
  const k = t?.tickets.find((x) => x.id === s.ticket);
  if (!t || t.status === "done" || k?.status !== "open") return;
  if ([...state.sessions.values()].some((o) => o.id !== s.id && o.role === "worker" && o.thread === s.thread && o.ticket === s.ticket && isLive(o))) return;
  s.earlyExitSeq = seq;
  k.earlyExits = (k.earlyExits ?? 0) + 1;
}

/** Applies session and notice events; returns false for every other event type. */
function applySessionEvent(state: State, ev: StoredEvent): boolean {
  switch (ev.type) {
    case "session.created": {
      const p = ev.payload;
      state.sessions.set(p.session, {
        id: p.session,
        role: p.role,
        agent: p.agent,
        ...(p.model ? { model: p.model } : {}),
        ...(p.effort ? { effort: p.effort } : {}),
        name: p.name,
        thread: ev.thread,
        ...(p.ticket ? { ticket: p.ticket } : {}),
        status: "starting",
        notices: [],
        turns: 0,
        turnsSinceProgress: 0,
        createdAt: ev.ts,
        ...(p.replaces ? { replaces: p.replaces } : {}),
        ...(p.retirePane ? { retirePane: p.retirePane } : {}),
        ...(p.profile ? { profile: p.profile } : {}),
      });
      const t = ev.thread ? state.threads.get(ev.thread) : undefined;
      if (t && p.ticket) {
        t.workerQueue = t.workerQueue.filter((k) => k !== p.ticket);
        delete t.workerAgents[p.ticket];
        // A fresh worker for a returned ticket whose worker is gone takes the ticket over: it is in_progress already.
        const k = t.tickets.find((x) => x.id === p.ticket);
        const prev = k?.assignee ? state.sessions.get(k.assignee) : undefined;
        if (p.role === "worker" && k?.status === "in_progress" && k.returnNote !== undefined && (!prev || !isLive(prev))) {
          k.assignee = p.session;
          k.freshWorkers = (k.freshWorkers ?? 0) + 1;
        }
      }
      threadNote(state, ev, `${p.role} session ${short(p.session)} created${p.ticket ? ` for ${p.ticket}` : ""}`);
      return true;
    }
    case "session.attached":
      sessionOf(state, ev.seq, ev.payload.session).pane = ev.payload.pane;
      threadNote(state, ev, `session ${short(ev.payload.session)} attached to pane ${ev.payload.pane}`);
      return true;
    case "session.started":
    case "session.active": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      if (isLive(s)) {
        // A first start, or a manual /compact, leaves the agent at an empty prompt: no turn runs, so no Stop hook follows.
        // A turn the user starts: the session sat idle with nothing queued for it. A delivered notice starts a turn too, but
        // only after it was queued (the hook may come before notice.delivered), or once delivered it is already active.
        const userTurn = s.status === "idle" && s.notices.length === 0;
        const atPrompt = ev.type === "session.started" && (s.status === "starting" || ev.payload.source === "compact" || s.polledStart === true);
        if (ev.type === "session.started" && ev.payload.source === "poll" && s.status === "starting") s.polledStart = true;
        else delete s.polledStart;
        delete s.blockedNotified;
        delete s.blockedSeq;
        endIdleStretch(s);
        // Herdr's poll flickers a hookless agent between working and idle: only a hook, a start or a delivery proves it is reachable.
        if (ev.type === "session.started" || ev.actor.role !== "user") endHeldStretch(s);
        if (ev.type === "session.active" && ev.actor.role !== "user") s.hooksSeen = true;
        s.status = atPrompt ? "idle" : "active";
        s.lastActiveAt = ev.ts;
        if (userTurn) clearWaiting(state, s, ev);
        // The blocked pane was answered (the session works again): the wait ends.
        const ow = ev.type === "session.active" && s.thread ? state.threads.get(s.thread)?.openWait : undefined;
        if (ow && ow.blocked && ow.endedSeq === undefined && ow.session === s.id) {
          ow.endedSeq = ev.seq;
          delete state.threads.get(s.thread!)!.lastBlocked;
        }
      }
      return true;
    }
    case "agent.idle": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      reviewNoticeAt(state, s, ev.seq);
      if (isLive(s)) {
        delete s.polledStart;
        delete s.blockedNotified;
        delete s.blockedSeq;
        if (s.idleSeq === undefined) {
          s.idleSeq = ev.seq;
          s.idleAt = ev.ts;
        }
        if (ev.actor.role !== "user") s.hooksSeen = true;
        if (s.status === "active") {
          s.turns++;
          s.turnsSinceProgress++;
          if (s.notices.length === 0) s.settledTurns = (s.settledTurns ?? 0) + 1;
        }
        s.status = "idle";
        s.lastActiveAt = ev.ts;
        const w = s.role === "coordinator" && s.thread ? state.threads.get(s.thread)?.waiting : undefined;
        if (w) w.idleSeen = true;
        if (ev.payload.contextTokens !== undefined) s.contextTokens = ev.payload.contextTokens;
      }
      return true;
    }
    case "session.stalled": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      s.stalled = true;
      threadNote(state, ev, `session ${short(s.id)} finished its first turn without running any agt command`);
      return true;
    }
    case "checkpoint.reminded": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      if (isLive(s)) s.remindedSinceProgress = true;
      return true;
    }
    case "agent.blocked": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      if (isLive(s) && !s.blockedNotified) {
        s.blockedNotified = true;
        s.blockedSeq = ev.seq;
        threadNote(state, ev, `session ${short(s.id)} is waiting for approval`);
        const t = s.thread && s.role !== "main" && s.role !== "worker" ? state.threads.get(s.thread) : undefined;
        if (t) {
          t.lastBlocked = { session: s.id, at: ev.ts };
          const prev = t.openWait && t.openWait.endedSeq === undefined && t.openWait.session === s.id ? t.openWait : undefined;
          t.openWait = { session: s.id, at: prev?.at ?? ev.ts, blocked: true, ...(prev?.what !== undefined ? { what: prev.what } : {}), told: prev?.told ?? [] };
        }
      }
      if (s.turns === 0) s.blockedEarly = true;
      return true;
    }
    case "session.rotation_requested": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      if (isLive(s) && !s.rotation) {
        s.rotation = { reason: ev.payload.reason, requestedAt: ev.ts };
        threadNote(state, ev, `session ${short(s.id)} rotation requested (${ev.payload.reason})`);
      }
      return true;
    }
    case "session.rotated": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      if (isLive(s)) {
        s.status = "rotated";
        delete s.rotation;
        threadNote(state, ev, `session ${short(s.id)} rotated (${ev.payload.reason})`);
      }
      return true;
    }
    case "session.lost": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      reviewNoticeAt(state, s, ev.seq);
      countEarlyExit(state, s, ev.seq);
      // A coordinator that exited normally is reported lost by `agt start`, so it gets replaced.
      if (isLive(s) || (s.status === "ended" && s.role === "coordinator")) {
        s.status = "lost";
        threadNote(state, ev, `session ${short(s.id)} lost: ${ev.payload.reason}`);
      }
      return true;
    }
    case "session.resume_failed":
      sessionOf(state, ev.seq, ev.payload.session).status = "lost";
      threadNote(state, ev, `session ${short(ev.payload.session)} could not be resumed: ${ev.payload.reason}`);
      return true;
    case "session.resuming": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      if (s.status === "lost") {
        s.status = "starting";
        delete s.pane;
        s.resumingAt = ev.ts;
        // A pending rotation's handoff clock restarts: the resumed agent needs time to see the request again.
        if (s.rotation) {
          s.rotation.requestedAt = ev.ts;
          delete s.rotation.deliveredAt;
        }
        threadNote(state, ev, `session ${short(s.id)} resuming`);
      }
      return true;
    }
    case "session.compacting":
      sessionOf(state, ev.seq, ev.payload.session);
      threadNote(state, ev, `session ${short(ev.payload.session)} is compacting`);
      return true;
    case "session.ended": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      reviewNoticeAt(state, s, ev.seq);
      countEarlyExit(state, s, ev.seq);
      if (isLive(s)) {
        s.status = "ended";
        threadNote(state, ev, `session ${short(ev.payload.session)} ended`);
      }
      return true;
    }
    case "session.failed": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      reviewNoticeAt(state, s, ev.seq);
      countEarlyExit(state, s, ev.seq);
      s.status = "failed";
      threadNote(state, ev, `session ${short(ev.payload.session)} failed: ${ev.payload.reason}`);
      return true;
    }
    case "notice.queued":
      {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      // A handoff request jumps ahead of every other queued notice (the coordinator's clock is running).
      const ow = ev.payload.wait && ev.thread ? state.threads.get(ev.thread)?.openWait : undefined;
      // A wait notice that arrives after the user already answered is stale: it is not queued at all.
      if (ow && ow.endedSeq !== undefined) return true;
      if (s.notices.length === 0) s.noticesSince = ev.ts;
      if (isHandoffRequest(ev.payload.text)) s.notices.unshift(ev.payload.text);
      else s.notices.push(ev.payload.text);
      if (ow) ow.told.push(ev.payload.text);
      return true;
    }
    case "notice.dropped": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      // One first-equal occurrence per dropped text, like notice.delivered.
      for (const x of ev.payload.texts) {
        const i = s.notices.indexOf(x);
        if (i >= 0) s.notices.splice(i, 1);
      }
      endNoticeStretch(s);
      return true;
    }
    case "notice.delivered": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      const texts = ev.payload.texts;
      if (texts) {
        // Remove one first-equal occurrence per delivered text: a notice queued while the delivery was in flight stays.
        if (s.rotation && texts.some(isHandoffRequest)) s.rotation.deliveredAt = ev.ts;
        for (const x of texts) {
          const i = s.notices.indexOf(x);
          if (i >= 0) s.notices.splice(i, 1);
        }
      } else {
        if (s.rotation && s.notices.slice(0, ev.payload.count).some(isHandoffRequest)) s.rotation.deliveredAt = ev.ts;
        s.notices.splice(0, ev.payload.count);
      }
      delete s.noticeHeldAt;
      endHeldStretch(s);
      endNoticeStretch(s);
      if (isLive(s)) {
        delete s.polledStart;
        endIdleStretch(s);
        s.status = "active"; // a pasted notice starts a turn
        s.lastActiveAt = ev.ts;
      }
      return true;
    }
    case "notice.held": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      s.noticeHeldAt = ev.ts;
      s.noticeHeldCount = (s.noticeHeldCount ?? 0) + 1;
      s.noticeHeldReason = ev.payload.reason;
      return true;
    }
    case "notice.held_reported":
      sessionOf(state, ev.seq, ev.payload.session).noticeHeldReported = true;
      return true;
    case "notice.stuck_reported":
      sessionOf(state, ev.seq, ev.payload.session).noticeStuckReported = true;
      return true;
    case "worker.context_reported": {
      const k = state.threads.get(ev.thread)?.tickets.find((x) => x.id === ev.payload.ticket);
      if (k) k.contextReported = true;
      return true;
    }
    case "worker.idle_reported": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      if (s.idleSeq !== undefined) s.idleReported = true;
      const k = state.threads.get(ev.thread)?.tickets.find((x) => x.id === s.ticket);
      if (k) k.idleNotices = (k.idleNotices ?? 0) + 1;
      return true;
    }
    default:
      return false;
  }
}

/** Its queue emptied: a later notice starts a new stretch, reported afresh. */
function endNoticeStretch(s: Session): void {
  if (s.notices.length > 0) return;
  delete s.noticesSince;
  delete s.noticeStuckReported;
}

/** A held stretch of notice deliveries is over: its backoff count, reason and report start afresh. */
function endHeldStretch(s: Session): void {
  delete s.noticeHeldCount;
  delete s.noticeHeldReason;
  delete s.noticeHeldReported;
}

/** The session is active again: its idle stretch (and whether it was reported) is over. */
function endIdleStretch(s: Session): void {
  delete s.idleSeq;
  delete s.idleAt;
  delete s.idleReported;
}
