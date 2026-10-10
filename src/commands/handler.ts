import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../config/config.ts";
import { canTransitionThread, canTransitionTicket, scopesOverlap, slugify, validateHandoff } from "../domain/rules.ts";
import { ROLES, type Actor, type EventBody, type Role, type ThreadStatus, type TicketStatus } from "../domain/types.ts";
import { agentName, liveSessions, spawnWorker, workerLimit } from "../orchestration/sessions.ts";
import { isLive, type State, type Thread, type Ticket } from "../state/projection.ts";
import type { Command, CommandName } from "./schema.ts";

export type Effect =
  | { kind: "git.worktree.add"; branch: string; path: string }
  | { kind: "herdr.tab.ensure"; thread: string; label: string; cwd: string; tab?: string }
  | { kind: "herdr.tab.close"; thread: string; tab: string }
  | {
      kind: "agent.spawn";
      session: string;
      role: "coordinator" | "worker";
      name: string;
      thread: string;
      ticket?: string;
      cwd: string;
      pane?: string;
      splitFrom?: string;
      direction?: "right" | "down";
      bootstrap?: "start" | "handoff" | "resume";
      resume?: boolean;
    }
  | { kind: "notice.deliver"; session: string; thread?: string; pane: string; text: string; count: number }
  | { kind: "pane.close"; pane: string };

export interface HandlerContext {
  root: string;
  config?: Config;
  newId?: () => string;
}

export type HandleResult =
  | { ok: true; events: EventBody[]; effects: Effect[]; result: unknown }
  | { ok: false; error: string };

interface Decision {
  events: EventBody[];
  effects?: Effect[];
  result?: unknown;
}

const ALLOWED: Record<CommandName, readonly Role[]> = {
  "thread.new": ["user", "main"],
  "thread.status": ["user", "main", "coordinator"],
  "ticket.add": ["coordinator"],
  "ticket.claim": ["worker"],
  "ticket.done": ["worker"],
  "ticket.block": ["worker"],
  "ticket.reopen": ["coordinator"],
  log: ROLES,
  decide: ["coordinator"],
  handoff: ["main", "coordinator", "worker"],
  "layout.register": ["user"],
  "layout.reconcile": ["user"],
  "worker.spawn": ["coordinator"],
  tell: ROLES,
  "session.signal": ROLES,
  "session.attached": ["user"],
  "session.failed": ["user"],
  "session.open_main": ["user"],
};

const SIGNAL_EVENT = {
  started: "session.started",
  active: "session.active",
  idle: "agent.idle",
  compacting: "session.compacting",
  ended: "session.ended",
} as const;

class Rejection extends Error {}

function reject(message: string): never {
  throw new Rejection(message);
}

export function handle(state: State, cmd: Command, actor: Actor, ctx: HandlerContext): HandleResult {
  try {
    const d = decide(state, cmd, actor, ctx);
    return { ok: true, events: d.events, effects: d.effects ?? [], result: d.result ?? null };
  } catch (e) {
    if (e instanceof Rejection) return { ok: false, error: e.message };
    throw e;
  }
}

function decide(state: State, cmd: Command, actor: Actor, ctx: HandlerContext): Decision {
  if (!state.project) reject("project not initialized; run `agt init`");
  if (!ALLOWED[cmd.cmd].includes(actor.role)) reject(`role ${actor.role} may not run ${cmd.cmd}`);
  if (cmd.cmd === "thread.new") return newThread(state, cmd, ctx);
  if (cmd.cmd === "layout.register") {
    const { cmd: _cmd, ...layout } = cmd;
    return { events: [{ type: "layout.registered", payload: layout }] };
  }
  if (cmd.cmd === "layout.reconcile") {
    if (!state.layout) reject("no Herdr layout registered; run `agt start`");
    const all = [...state.threads.values()];
    const open = all.filter((t) => t.status !== "done");
    const closes: Effect[] = (ctx.config ?? DEFAULT_CONFIG).herdr.close_tab_on_done
      ? all.flatMap((t) => (t.status === "done" && t.tab ? [{ kind: "herdr.tab.close" as const, thread: t.id, tab: t.tab }] : []))
      : [];
    return { events: [], effects: [...open.map(tabEnsure), ...closes], result: { threads: open.length } };
  }

  if (cmd.cmd === "tell") {
    const target =
      cmd.target === "main" ? liveSessions(state, undefined, "main")[0] : liveSessions(state, cmd.target, "coordinator")[0];
    if (!target) reject(cmd.target === "main" ? "no live main manager session" : `no live coordinator for thread ${cmd.target}`);
    return {
      events: [{ type: "notice.queued", thread: target.thread, payload: { session: target.id, text: `Message from ${actor.role}: ${cmd.message}` } }],
    };
  }
  if (cmd.cmd === "session.signal") {
    const s = state.sessions.get(cmd.session) ?? reject(`unknown session ${cmd.session}`);
    if (actor.session && actor.session !== s.id) reject(`actor session ${actor.session} cannot signal ${s.id}`);
    if (!isLive(s)) return { events: [] };
    const payload = {
      session: s.id,
      ...(cmd.signal === "idle" && cmd.contextTokens !== undefined ? { contextTokens: cmd.contextTokens } : {}),
      ...(cmd.signal === "started" && cmd.source ? { source: cmd.source } : {}),
    };
    return { events: [{ type: SIGNAL_EVENT[cmd.signal], thread: s.thread, payload }] };
  }
  if (cmd.cmd === "session.attached" || cmd.cmd === "session.failed") {
    const s = state.sessions.get(cmd.session) ?? reject(`unknown session ${cmd.session}`);
    if (!isLive(s)) return { events: [] };
    return cmd.cmd === "session.attached"
      ? {
          events: [
            { type: "session.attached", thread: s.thread, payload: { session: s.id, pane: cmd.pane } },
            // A bootstrap prompt the spawn job could not deliver is queued; the reactor sends it at the first idle.
            ...(cmd.pending ? [{ type: "notice.queued" as const, thread: s.thread, payload: { session: s.id, text: cmd.pending } }] : []),
          ],
        }
      : { events: [{ type: "session.failed", thread: s.thread, payload: { session: s.id, reason: cmd.reason } }] };
  }
  if (cmd.cmd === "session.open_main") {
    if (state.sessions.has(cmd.session)) reject(`session ${cmd.session} already exists`);
    const stale: EventBody[] = liveSessions(state, undefined, "main").map((s) => ({ type: "session.ended", payload: { session: s.id } }));
    return {
      events: [
        ...stale,
        { type: "session.created", payload: { session: cmd.session, role: "main", agent: "claude-code", name: agentName(ctx.root, "main") } },
        { type: "session.attached", payload: { session: cmd.session, pane: cmd.pane } },
      ],
      result: { session: cmd.session },
    };
  }

  const t = state.threads.get(cmd.thread) ?? reject(`unknown thread ${cmd.thread}`);
  if ((actor.role === "coordinator" || actor.role === "worker") && actor.thread !== t.id) {
    reject(`${actor.role} is bound to thread ${actor.thread ?? "(none)"}`);
  }

  switch (cmd.cmd) {
    case "thread.status":
      return threadStatus(state, t, cmd.status, cmd.reason, ctx);
    case "ticket.add": {
      if (t.status === "done") reject(`thread ${t.id} is done`);
      const ticket = `T${t.tickets.length + 1}`;
      return {
        events: [{ type: "ticket.created", thread: t.id, payload: { ticket, title: cmd.title, scope: cmd.scope } }],
        result: { ticket },
      };
    }
    case "ticket.claim": {
      const k = workerTicket(t, cmd.ticket, actor);
      const session = workerSession(actor);
      transitionTicket(k, "in_progress");
      const clash = t.tickets.find((o) => o.id !== k.id && o.status === "in_progress" && scopesOverlap(o.scope, k.scope));
      if (clash) reject(`scope of ${k.id} overlaps in-progress ticket ${clash.id}`);
      return { events: [{ type: "ticket.claimed", thread: t.id, payload: { ticket: k.id, assignee: session } }] };
    }
    case "ticket.done": {
      const k = assignedTicket(t, cmd.ticket, actor);
      transitionTicket(k, "done");
      return { events: [{ type: "ticket.completed", thread: t.id, payload: { ticket: k.id, summary: cmd.summary } }] };
    }
    case "ticket.block": {
      const k = assignedTicket(t, cmd.ticket, actor);
      transitionTicket(k, "blocked");
      return { events: [{ type: "ticket.blocked", thread: t.id, payload: { ticket: k.id, reason: cmd.reason } }] };
    }
    case "ticket.reopen": {
      const k = findTicket(t, cmd.ticket);
      transitionTicket(k, "open");
      return { events: [{ type: "ticket.reopened", thread: t.id, payload: { ticket: k.id } }] };
    }
    case "worker.spawn": {
      if (t.status === "done") reject(`thread ${t.id} is done`);
      if (!t.rootPane) reject(`thread ${t.id} has no Herdr tab; run \`agt start\``);
      const k = findTicket(t, cmd.ticket);
      if (k.status !== "open") reject(`ticket ${k.id} is ${k.status}`);
      const workers = liveSessions(state, t.id, "worker");
      if (t.workerQueue.includes(k.id) || workers.some((s) => s.ticket === k.id)) reject(`ticket ${k.id} already has a worker`);
      if (workers.length >= workerLimit(t, ctx.config ?? DEFAULT_CONFIG)) {
        return { events: [{ type: "worker.queued", thread: t.id, payload: { ticket: k.id } }], result: { queued: true } };
      }
      const spawned = spawnWorker(state, t, k.id, { root: ctx.root, newId: ctx.newId ?? randomUUID });
      const session = (spawned.events[0] as Extract<EventBody, { type: "session.created" }>).payload.session;
      return { ...spawned, result: { session, queued: false } };
    }
    case "log":
      return { events: [{ type: "log.appended", thread: t.id, payload: { message: cmd.message } }] };
    case "decide":
      return { events: [{ type: "decision.recorded", thread: t.id, payload: { message: cmd.message } }] };
    case "handoff": {
      const v = validateHandoff(cmd.content);
      if (!v.ok) reject(`handoff missing sections: ${v.missing.join(", ")}`);
      return { events: [{ type: "handoff.submitted", thread: t.id, payload: { content: cmd.content, generated: false } }] };
    }
  }
}

function newThread(state: State, cmd: Extract<Command, { cmd: "thread.new" }>, ctx: HandlerContext): Decision {
  for (const dep of cmd.dependsOn) if (!state.threads.has(dep)) reject(`unknown dependency ${dep}`);
  const next = Math.max(0, ...[...state.threads.keys()].map(Number)) + 1;
  const id = String(next).padStart(3, "0");
  const slug = slugify(cmd.title);
  const name = `${id}-${slug}`;
  const branch = `thread/${name}`;
  const worktree = join(ctx.root, ".worktrees", name);
  const status: ThreadStatus = depsDone(state, cmd.dependsOn) ? "open" : "blocked";
  return {
    events: [
      {
        type: "thread.created",
        thread: id,
        payload: {
          title: cmd.title,
          threadType: cmd.type,
          slug,
          goal: cmd.goal,
          criteria: cmd.criteria,
          dependsOn: cmd.dependsOn,
          maxWorkers: cmd.maxWorkers,
          branch,
          worktree,
          status,
        },
      },
    ],
    effects: [
      { kind: "git.worktree.add", branch, path: worktree },
      ...(state.layout ? [tabEnsure({ id, slug, worktree })] : []),
    ],
    result: { thread: id, worktree },
  };
}

function threadStatus(state: State, t: Thread, to: ThreadStatus, reason: string | undefined, ctx: HandlerContext): Decision {
  if (!canTransitionThread(t.status, to)) reject(`thread ${t.id} cannot go ${t.status} → ${to}`);
  if ((to === "open" || to === "in_progress") && !depsDone(state, t.dependsOn)) {
    reject(`thread ${t.id} has unfinished dependencies: ${t.dependsOn.join(", ")}`);
  }
  const events: EventBody[] = [{ type: "thread.status_changed", thread: t.id, payload: { from: t.status, to, reason } }];
  if (to === "done") {
    for (const other of state.threads.values()) {
      if (other.status === "blocked" && other.dependsOn.includes(t.id) && depsDone(state, other.dependsOn, t.id)) {
        events.push({
          type: "thread.status_changed",
          thread: other.id,
          payload: { from: "blocked", to: "open", reason: "dependencies done" },
        });
      }
    }
  }
  const config = ctx.config ?? DEFAULT_CONFIG;
  const effects: Effect[] = to === "done" && t.tab && config.herdr.close_tab_on_done ? [{ kind: "herdr.tab.close", thread: t.id, tab: t.tab }] : [];
  return { events, effects };
}

function depsDone(state: State, deps: string[], alsoDone?: string): boolean {
  return deps.every((d) => d === alsoDone || state.threads.get(d)?.status === "done");
}

function findTicket(t: Thread, id: string): Ticket {
  return t.tickets.find((k) => k.id === id) ?? reject(`unknown ticket ${id} in thread ${t.id}`);
}

function workerSession(actor: Actor): string {
  return actor.session ?? reject("worker commands require AGT_SESSION");
}

function workerTicket(t: Thread, id: string, actor: Actor): Ticket {
  workerSession(actor);
  if (actor.ticket && actor.ticket !== id) reject(`worker is bound to ticket ${actor.ticket}`);
  return findTicket(t, id);
}

function assignedTicket(t: Thread, id: string, actor: Actor): Ticket {
  const k = workerTicket(t, id, actor);
  if (k.assignee && k.assignee !== actor.session) reject(`ticket ${k.id} is assigned to ${k.assignee}`);
  return k;
}

function transitionTicket(k: Ticket, to: TicketStatus): void {
  if (!canTransitionTicket(k.status, to)) reject(`ticket ${k.id} cannot go ${k.status} → ${to}`);
}

function tabEnsure(t: { id: string; slug: string; worktree: string; tab?: string }): Effect {
  return { kind: "herdr.tab.ensure", thread: t.id, label: `${t.id}-${t.slug}`, cwd: t.worktree, ...(t.tab ? { tab: t.tab } : {}) };
}
