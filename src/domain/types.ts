export const ROLES = ["user", "main", "coordinator", "worker"] as const;
export type Role = (typeof ROLES)[number];

export const AGENT_KINDS = ["claude-code", "opencode", "codex", "omp"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export type SessionRole = "main" | "coordinator" | "worker";

export const SESSION_SIGNALS = ["started", "active", "idle", "compacting", "ended", "blocked"] as const;
export type SessionSignal = (typeof SESSION_SIGNALS)[number];

export const THREAD_TYPES = ["feature", "bug", "chore"] as const;
export type ThreadType = (typeof THREAD_TYPES)[number];

export const THREAD_STATUSES = ["open", "in_progress", "blocked", "review", "done"] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export type TicketStatus = "open" | "in_progress" | "blocked" | "done";

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
      };
    }
  | { type: "worktree.added"; thread: string; payload: { repo: string; path: string; branch: string; source: string } }
  | { type: "thread.status_changed"; thread: string; payload: { from: ThreadStatus; to: ThreadStatus; reason?: string } }
  | { type: "thread.tier_proposed"; thread: string; payload: { tier: string; reason: string } }
  | { type: "thread.tier_timer"; thread: string; payload: { state: "paused" | "running" } }
  | { type: "thread.tier_chosen"; thread: string; payload: { tier: string; auto: boolean } }
  | { type: "ticket.created"; thread: string; payload: { ticket: string; title: string; scope: string[] } }
  | { type: "ticket.claimed"; thread: string; payload: { ticket: string; assignee: string } }
  | { type: "ticket.completed"; thread: string; payload: { ticket: string; summary?: string } }
  | { type: "ticket.blocked"; thread: string; payload: { ticket: string; reason: string } }
  | { type: "ticket.reopened"; thread: string; payload: { ticket: string } }
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
  | { type: "notice.queued"; thread?: string; payload: { session: string; text: string } }
  | { type: "notice.delivered"; thread?: string; payload: { session: string; count: number } };

export type EventType = EventBody["type"];

export type StoredEvent = EventBody & { seq: number; ts: string; actor: Actor };
