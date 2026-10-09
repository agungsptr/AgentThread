import type { Actor, Layout, StoredEvent, ThreadStatus, ThreadType, TicketStatus } from "../domain/types.ts";

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
  tickets: Ticket[];
  decisions: Entry[];
  log: Entry[];
  handoff?: { content: string; generated: boolean; ts: string };
}

export interface State {
  layout?: Layout;
  project?: { name: string };
  threads: Map<string, Thread>;
  lastSeq: number;
}

export function emptyState(): State {
  return { threads: new Map(), lastSeq: 0 };
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
      tickets: [],
      decisions: [],
      log: [],
    };
    state.threads.set(ev.thread, thread);
    note(thread, ev, `thread created (${p.status})`);
    return;
  }

  const t = state.threads.get(ev.thread);
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
