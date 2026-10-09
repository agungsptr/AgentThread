export const ROLES = ["user", "main", "coordinator", "worker"] as const;
export type Role = (typeof ROLES)[number];

export const AGENT_KINDS = ["claude-code", "opencode"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

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
        branch: string;
        worktree: string;
        status: ThreadStatus;
      };
    }
  | { type: "thread.status_changed"; thread: string; payload: { from: ThreadStatus; to: ThreadStatus; reason?: string } }
  | { type: "ticket.created"; thread: string; payload: { ticket: string; title: string; scope: string[] } }
  | { type: "ticket.claimed"; thread: string; payload: { ticket: string; assignee: string } }
  | { type: "ticket.completed"; thread: string; payload: { ticket: string; summary?: string } }
  | { type: "ticket.blocked"; thread: string; payload: { ticket: string; reason: string } }
  | { type: "ticket.reopened"; thread: string; payload: { ticket: string } }
  | { type: "log.appended"; thread: string; payload: { message: string } }
  | { type: "decision.recorded"; thread: string; payload: { message: string } }
  | { type: "handoff.submitted"; thread: string; payload: { content: string; generated: boolean } };

export type EventType = EventBody["type"];

export type StoredEvent = EventBody & { seq: number; ts: string; actor: Actor };
