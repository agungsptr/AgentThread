import { join } from "node:path";
import { canTransitionThread, canTransitionTicket, scopesOverlap, slugify, validateHandoff } from "../domain/rules.ts";
import { ROLES, type Actor, type EventBody, type Role, type ThreadStatus, type TicketStatus } from "../domain/types.ts";
import type { State, Thread, Ticket } from "../state/projection.ts";
import type { Command, CommandName } from "./schema.ts";

export type Effect = { kind: "git.worktree.add"; branch: string; path: string };

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
};

class Rejection extends Error {}

function reject(message: string): never {
  throw new Rejection(message);
}

export function handle(state: State, cmd: Command, actor: Actor, ctx: { root: string }): HandleResult {
  try {
    const d = decide(state, cmd, actor, ctx);
    return { ok: true, events: d.events, effects: d.effects ?? [], result: d.result ?? null };
  } catch (e) {
    if (e instanceof Rejection) return { ok: false, error: e.message };
    throw e;
  }
}

function decide(state: State, cmd: Command, actor: Actor, ctx: { root: string }): Decision {
  if (!state.project) reject("project not initialized; run `agt init`");
  if (!ALLOWED[cmd.cmd].includes(actor.role)) reject(`role ${actor.role} may not run ${cmd.cmd}`);
  if (cmd.cmd === "thread.new") return newThread(state, cmd, ctx);

  const t = state.threads.get(cmd.thread) ?? reject(`unknown thread ${cmd.thread}`);
  if ((actor.role === "coordinator" || actor.role === "worker") && actor.thread !== t.id) {
    reject(`${actor.role} is bound to thread ${actor.thread ?? "(none)"}`);
  }

  switch (cmd.cmd) {
    case "thread.status":
      return threadStatus(state, t, cmd.status, cmd.reason);
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
      transitionTicket(k, "in_progress");
      const clash = t.tickets.find((o) => o.id !== k.id && o.status === "in_progress" && scopesOverlap(o.scope, k.scope));
      if (clash) reject(`scope of ${k.id} overlaps in-progress ticket ${clash.id}`);
      return { events: [{ type: "ticket.claimed", thread: t.id, payload: { ticket: k.id, assignee: actor.session ?? actor.role } }] };
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

function newThread(state: State, cmd: Extract<Command, { cmd: "thread.new" }>, ctx: { root: string }): Decision {
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
          branch,
          worktree,
          status,
        },
      },
    ],
    effects: [{ kind: "git.worktree.add", branch, path: worktree }],
    result: { thread: id, worktree },
  };
}

function threadStatus(state: State, t: Thread, to: ThreadStatus, reason: string | undefined): Decision {
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
  return { events };
}

function depsDone(state: State, deps: string[], alsoDone?: string): boolean {
  return deps.every((d) => d === alsoDone || state.threads.get(d)?.status === "done");
}

function findTicket(t: Thread, id: string): Ticket {
  return t.tickets.find((k) => k.id === id) ?? reject(`unknown ticket ${id} in thread ${t.id}`);
}

function workerTicket(t: Thread, id: string, actor: Actor): Ticket {
  if (actor.ticket && actor.ticket !== id) reject(`worker is bound to ticket ${actor.ticket}`);
  return findTicket(t, id);
}

function assignedTicket(t: Thread, id: string, actor: Actor): Ticket {
  const k = workerTicket(t, id, actor);
  if (k.assignee && actor.session && k.assignee !== actor.session) reject(`ticket ${k.id} is assigned to ${k.assignee}`);
  return k;
}

function transitionTicket(k: Ticket, to: TicketStatus): void {
  if (!canTransitionTicket(k.status, to)) reject(`ticket ${k.id} cannot go ${k.status} → ${to}`);
}
