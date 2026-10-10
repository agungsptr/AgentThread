import type { Actor, AgentKind, Layout, SessionRole, StoredEvent, ThreadStatus, ThreadType, TicketStatus } from "../domain/types.ts";

export type SessionStatus = "starting" | "active" | "idle" | "ended" | "failed";

export interface Session {
  id: string;
  role: SessionRole;
  agent: AgentKind;
  name: string;
  thread?: string;
  ticket?: string;
  pane?: string;
  status: SessionStatus;
  notices: string[];
}

export function isLive(s: Session): boolean {
  return s.status !== "ended" && s.status !== "failed";
}

export interface Ticket {
  id: string;
  title: string;
  scope: string[];
  status: TicketStatus;
  assignee?: string;
}

export interface Entry {
  ts: string;
  actor: Actor;
  message: string;
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
  branch: string;
  worktree: string;
  maxWorkers?: number;
  workerQueue: string[];
  tickets: Ticket[];
  decisions: Entry[];
  log: Entry[];
  handoff?: { content: string; generated: boolean; ts: string };
}

export interface State {
  layout?: Layout;
  project?: { name: string };
  threads: Map<string, Thread>;
  sessions: Map<string, Session>;
  lastSeq: number;
}

export function emptyState(): State {
  return { threads: new Map(), sessions: new Map(), lastSeq: 0 };
}

export function project(events: StoredEvent[]): State {
  const state = emptyState();
  for (const ev of events) applyEvent(state, ev);
  return state;
}

export function applyEvent(state: State, ev: StoredEvent): void {
  state.lastSeq = ev.seq;

  if (ev.type === "project.initialized") {
    state.project = { name: ev.payload.name };
    return;
  }

  if (ev.type === "layout.registered") {
    state.layout = ev.payload;
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
      branch: p.branch,
      worktree: p.worktree,
      maxWorkers: p.maxWorkers,
      workerQueue: [],
      tickets: [],
      decisions: [],
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
    case "thread.tab_closed":
      delete t.tab;
      delete t.rootPane;
      note(t, ev, `herdr tab ${ev.payload.tab} closed`);
      break;
    case "thread.status_changed": {
      t.status = ev.payload.to;
      const reason = ev.payload.reason ? `: ${ev.payload.reason}` : "";
      note(t, ev, `status ${ev.payload.from} → ${ev.payload.to}${reason}`);
      break;
    }
    case "ticket.created":
      t.tickets.push({ id: ev.payload.ticket, title: ev.payload.title, scope: ev.payload.scope, status: "open" });
      note(t, ev, `${ev.payload.ticket} created: ${ev.payload.title}`);
      break;
    case "ticket.claimed": {
      const k = ticket(ev.payload.ticket);
      k.status = "in_progress";
      k.assignee = ev.payload.assignee;
      note(t, ev, `${k.id} claimed by ${k.assignee}`);
      break;
    }
    case "ticket.completed": {
      const k = ticket(ev.payload.ticket);
      k.status = "done";
      note(t, ev, `${k.id} done${ev.payload.summary ? `: ${ev.payload.summary}` : ""}`);
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
      note(t, ev, `${k.id} reopened`);
      break;
    }
    case "worker.queued":
      t.workerQueue.push(ev.payload.ticket);
      note(t, ev, `${ev.payload.ticket} queued for a worker`);
      break;
    case "log.appended":
      note(t, ev, ev.payload.message);
      break;
    case "decision.recorded":
      t.decisions.push({ ts: ev.ts, actor: ev.actor, message: ev.payload.message });
      note(t, ev, `decision: ${ev.payload.message}`);
      break;
    case "handoff.submitted":
      t.handoff = { content: ev.payload.content, generated: ev.payload.generated, ts: ev.ts };
      note(t, ev, `handoff submitted${ev.payload.generated ? " (generated)" : ""}`);
      break;
  }
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

/** Applies session and notice events; returns false for every other event type. */
function applySessionEvent(state: State, ev: StoredEvent): boolean {
  switch (ev.type) {
    case "session.created": {
      const p = ev.payload;
      state.sessions.set(p.session, {
        id: p.session,
        role: p.role,
        agent: p.agent,
        name: p.name,
        thread: ev.thread,
        ...(p.ticket ? { ticket: p.ticket } : {}),
        status: "starting",
        notices: [],
      });
      const t = ev.thread ? state.threads.get(ev.thread) : undefined;
      if (t && p.ticket) t.workerQueue = t.workerQueue.filter((k) => k !== p.ticket);
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
      // A first start leaves the agent at an empty prompt (no turn runs, so no Stop hook), so it is idle and can take notices.
      if (isLive(s)) s.status = ev.type === "session.started" && s.status === "starting" ? "idle" : "active";
      return true;
    }
    case "agent.idle": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      if (isLive(s)) s.status = "idle";
      return true;
    }
    case "session.compacting":
      sessionOf(state, ev.seq, ev.payload.session);
      threadNote(state, ev, `session ${short(ev.payload.session)} is compacting`);
      return true;
    case "session.ended": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      if (isLive(s)) {
        s.status = "ended";
        threadNote(state, ev, `session ${short(ev.payload.session)} ended`);
      }
      return true;
    }
    case "session.failed":
      sessionOf(state, ev.seq, ev.payload.session).status = "failed";
      threadNote(state, ev, `session ${short(ev.payload.session)} failed: ${ev.payload.reason}`);
      return true;
    case "notice.queued":
      sessionOf(state, ev.seq, ev.payload.session).notices.push(ev.payload.text);
      return true;
    case "notice.delivered": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      s.notices.splice(0, ev.payload.count);
      if (isLive(s)) s.status = "active"; // a pasted notice starts a turn
      return true;
    }
    default:
      return false;
  }
}
