export const ROLES = ["user", "main", "coordinator", "worker"] as const;
export type Role = (typeof ROLES)[number];

export const AGENT_KINDS = ["claude-code", "opencode", "codex", "omp", "agy"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export type SessionRole = "main" | "coordinator" | "worker";

export const SESSION_SIGNALS = ["started", "active", "idle", "compacting", "ended", "blocked"] as const;
export type SessionSignal = (typeof SESSION_SIGNALS)[number];

export const THREAD_TYPES = ["feature", "bug", "chore"] as const;
export type ThreadType = (typeof THREAD_TYPES)[number];

export const THREAD_STATUSES = ["open", "in_progress", "blocked", "review", "done"] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

/** `review` (task threads): done by its worker, waiting for the coordinator to accept or return it. */
export type TicketStatus = "open" | "in_progress" | "blocked" | "review" | "done";

export interface Actor {
  role: Role;
  thread?: string;
  session?: string;
  ticket?: string;
  agent?: AgentKind;
  /**
   * Set by the daemon, never by a client: "command" marks the events handle() decided for a command other than a
   * lifecycle signal. Follow-ups (reactor events, effect output) carry no marker. Old logs have no marker at all.
   */
  via?: "command";
}

/** The ten workflow stages of a task thread, by number 1-10. */
export const STAGE_NAMES = [
  "discussion", "spec", "tickets", "delegation", "review", "unit and type check", "e2e", "browser check", "shared docs", "release and squash",
] as const;
export const STAGE_STATES = ["done", "skipped", "na", "approve"] as const;
export type StageState = (typeof STAGE_STATES)[number];
/** Who recorded a stage. Plan 12 adds "agt". */
/** `agt` is the daemon itself: the stages the config rules out are recorded na at task-thread creation. */
export type StageBy = "coordinator" | "user" | "agt";

export interface Layout {
  workspace: string;
  mainTab: string;
  managerPane: string;
  loggerPane: string;
  herdrBin: string;
  herdrSocket?: string;
}

export type EventBody =
  | { type: "layout.registered"; thread?: undefined; payload: Layout }
  | { type: "thread.tab_opened"; thread: string; payload: { tab: string; rootPane: string } }
  | { type: "thread.tab_closed"; thread: string; payload: { tab: string } }
  | { type: "project.initialized"; thread?: undefined; payload: { name: string } }
  | {
      type: "thread.created";
      thread: string;
      payload: {
        title: string;
        threadType: ThreadType;
        slug: string;
        goal: string;
        criteria: string[];
        dependsOn: string[];
        /** Legacy threads only: the thread's own branch and git worktree. */
        branch?: string;
        worktree?: string;
        /** Thread-directory threads: the task name and `<root>/.worktrees/<task>`, which holds the repo worktrees. */
        task?: string;
        dir?: string;
        status: ThreadStatus;
        maxWorkers?: number;
        /** The user asked for a browser check (stage 8): it is required even when workflow.browser.check is on_request. */
        browserCheck?: true;
      };
    }
  | { type: "worktree.requested" | "worktree.added"; thread: string; payload: { repo: string; path: string; branch: string; source: string } }
  | { type: "worktree.failed"; thread: string; payload: { repo: string; reason: string } }
  | { type: "thread.status_changed"; thread: string; payload: { from: ThreadStatus; to: ThreadStatus; reason?: string } }
  | { type: "thread.tier_proposed"; thread: string; payload: { tier: string; reason: string } }
  | { type: "thread.tier_timer"; thread: string; payload: { state: "paused" | "running" } }
  | { type: "thread.tier_chosen"; thread: string; payload: { tier: string; auto: boolean } }
  | { type: "ticket.created"; thread: string; payload: { ticket: string; title: string; scope: string[]; repo?: string; files?: string[]; doc?: string } }
  | { type: "ticket.files_changed"; thread: string; payload: { ticket: string; files: string[]; added: string[]; removed: string[] } }
  | { type: "ticket.claimed"; thread: string; payload: { ticket: string; assignee: string } }
  | { type: "ticket.completed"; thread: string; payload: { ticket: string; summary?: string } }
  | { type: "ticket.blocked"; thread: string; payload: { ticket: string; reason: string } }
  | { type: "ticket.reopened"; thread: string; payload: { ticket: string } }
  | { type: "ticket.reviewed"; thread: string; payload: { ticket: string; summary: string } }
  | { type: "ticket.accepted"; thread: string; payload: { ticket: string } }
  | { type: "ticket.returned"; thread: string; payload: { ticket: string; note: string } }
  | { type: "thread.waiting"; thread: string; payload: { what: string } }
  | { type: "thread.cleanup_requested"; thread: string; payload: Record<string, never> }
  | { type: "thread.cleaned"; thread: string; payload: { repos: string[] } }
  /** `removed`: the repos a job that stopped mid-way had already removed. */
  | { type: "thread.cleanup_failed"; thread: string; payload: { repo: string; reason: string; removed?: string[] } }
  | { type: "stage.recorded"; thread: string; payload: { stage: number; state: StageState; by: StageBy; reason?: string } }
  | { type: "stack.acquired" | "stack.queued"; thread: string; payload: { thread: string; purpose?: string } }
  | { type: "stack.released"; thread: string; payload: { thread: string; reason: string } }
  | { type: "log.appended"; thread: string; payload: { message: string } }
  | { type: "decision.recorded"; thread: string; payload: { message: string } }
  | { type: "note.recorded" | "progress.recorded"; thread: string; payload: { message: string } }
  | { type: "question.recorded"; thread: string; payload: { message: string; id?: string } }
  | { type: "question.answered"; thread: string; payload: { question: string; answer: string } }
  | { type: "checkpoint.reminded"; thread?: string; payload: { session: string } }
  | { type: "agent.blocked"; thread?: string; payload: { session: string } }
  | { type: "session.stalled"; thread?: string; payload: { session: string } }
  | { type: "handoff.submitted"; thread: string; payload: { content: string; generated: boolean } }
  | {
      type: "session.created";
      thread?: string;
      payload: {
        session: string;
        role: SessionRole;
        agent: AgentKind;
        model?: string;
        effort?: string;
        name: string;
        ticket?: string;
        replaces?: string;
        retirePane?: string;
      };
    }
  | { type: "session.attached"; thread?: string; payload: { session: string; pane: string } }
  | {
      type: "session.started" | "session.active" | "agent.idle" | "session.compacting" | "session.ended";
      thread?: string;
      payload: { session: string; source?: string; contextTokens?: number };
    }
  | { type: "session.rotation_requested"; thread?: string; payload: { session: string; reason: string } }
  | { type: "session.rotated" | "session.lost" | "session.resume_failed"; thread?: string; payload: { session: string; reason: string } }
  | { type: "session.resuming"; thread?: string; payload: { session: string } }
  | { type: "ticket.released"; thread: string; payload: { ticket: string; reason: string } }
  | { type: "thread.root_pane_changed"; thread: string; payload: { pane: string } }
  | { type: "session.failed"; thread?: string; payload: { session: string; reason: string } }
  | { type: "worker.queued"; thread: string; payload: { ticket: string; agent?: AgentKind } }
  | { type: "notice.queued"; thread?: string; payload: { session: string; text: string; /** A notice to main that the user is waited for (see Thread.openWait). */ wait?: true } }
  | { type: "notice.dropped"; thread?: string; payload: { session: string; texts: string[] } }
  | { type: "notice.delivered"; thread?: string; payload: { session: string; count: number; /** The delivered notices; absent in older events (then the first `count` are removed). */ texts?: string[] } }
  /** A notice delivery that did not type (a trust dialog, an unread screen, a Herdr error): the sweep retries it. */
  | { type: "notice.held"; thread?: string; payload: { session: string; reason: string } }
  /** The sweep told the coordinator that a worker sits idle with its ticket unfinished (once per idle stretch). */
  | { type: "worker.idle_reported"; thread: string; payload: { session: string } }
  | { type: "notice.held_reported"; thread?: string; payload: { session: string } }
  /** The coordinator was told a worker's context grew large (once per ticket). */
  | { type: "worker.context_reported"; thread: string; payload: { session: string; ticket: string } };

export type EventType = EventBody["type"];

export type StoredEvent = EventBody & { seq: number; ts: string; actor: Actor };
