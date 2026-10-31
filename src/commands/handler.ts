import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../config/config.ts";
import { canTransitionThread, canTransitionTicket, scopesOverlap, slugify, validateHandoff } from "../domain/rules.ts";
import { ROLES, type Actor, type EventBody, type Role, type ThreadStatus, type TicketStatus } from "../domain/types.ts";
import { roleAgent, type RoleAgent } from "../agents/roles.ts";
import { agentName, liveSessions, spawnCoordinator, spawnReplacement, spawnWorker, tabEnsure as tabEnsureFor, workerLimit } from "../orchestration/sessions.ts";
import { workspaceReposNoSpawn } from "../project/workspace.ts";
import { actorSession, isLive, type State, type Thread, type Ticket } from "../state/projection.ts";
import type { Command, CommandName } from "./schema.ts";

export type Effect =
  /** Legacy form (old threads only): the thread's own worktree of the root repo. */
  | { kind: "git.worktree.add"; branch: string; path: string; thread: { id: string; title: string; slug: string } }
  /** A task worktree of one workspace repo, at `<dir>/<repo>` on a new `wip/<task>` from `source`. */
  | { kind: "git.worktree.add"; thread: string; repo: string; repoPath: string; path: string; branch: string; source: string }
  | { kind: "thread.dir.ensure"; thread: { id: string; title: string; slug: string; task: string; dir: string } }
  | { kind: "herdr.tab.ensure"; thread: string; label: string; cwd: string; env: Record<string, string>; tab?: string }
  | { kind: "herdr.tab.close"; thread: string; tab: string }
  | {
      kind: "agent.spawn";
      session: string;
      role: "coordinator" | "worker";
      run: RoleAgent;
      name: string;
      thread: string;
      ticket?: string;
      cwd: string;
      pane?: string;
      splitFrom?: string;
      /** Panes to split from instead when `splitFrom` is gone (real Herdr removes a closed pane). */
      splitFallbacks?: string[];
      direction?: "right" | "down";
      bootstrap?: "start" | "handoff";
    }
  | { kind: "notice.deliver"; session: string; thread?: string; pane: string; text: string; count: number }
  | { kind: "pane.close"; pane: string }
  | { kind: "session.probe"; session: string; thread?: string; pane: string };

export interface HandlerContext {
  root: string;
  config?: Config;
  newId?: () => string;
}

export type HandleResult =
  | { ok: true; events: EventBody[]; effects: Effect[]; result: unknown; /** Set for a command other than a signal: the attributed, marked actor (see attribute) to store `events` with. */ actor?: Actor }
  | { ok: false; error: string };

interface Decision {
  events: EventBody[];
  effects?: Effect[];
  result?: unknown;
}

const ALLOWED: Record<CommandName, readonly Role[]> = {
  "thread.new": ["user", "main"],
  "thread.status": ["user", "main", "coordinator"],
  "thread.choose": ["user", "main"],
  "thread.cancel": ["user", "main"],
  "ticket.add": ["coordinator"],
  "ticket.claim": ["worker"],
  "ticket.done": ["worker"],
  "ticket.block": ["worker"],
  "ticket.reopen": ["coordinator"],
  log: ROLES,
  decide: ["coordinator"],
  note: ROLES,
  progress: ROLES,
  question: ROLES,
  answer: ROLES,
  handoff: ["main", "coordinator", "worker"],
  "layout.register": ["user"],
  "layout.reconcile": ["user"],
  "worker.spawn": ["coordinator"],
  "worktree.add": ["user", "coordinator"],
  "worktree.report": ["user"],
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
  blocked: "agent.blocked",
} as const;

class Rejection extends Error {}

function reject(message: string): never {
  throw new Rejection(message);
}

/**
 * The actor a command's decided events are stored with. A lifecycle signal keeps its actor: it names its session or
 * pane, and it does not show that the agent ran an agt command. Any other command is marked `via: "command"` (only
 * such events count as authored), and a coordinator or worker actor without a session (the root-pane coordinator has
 * no AGT_SESSION) gets one, so the stored events say who ran it.
 */
function attribute(state: State, cmd: Command, actor: Actor): Actor {
  if (cmd.cmd === "session.signal") return actor;
  const session = (actor.session || (actor.role !== "coordinator" && actor.role !== "worker")) ? undefined : actorSession(state, actor);
  return { ...actor, ...(session ? { session } : {}), via: "command" };
}

export function handle(state: State, cmd: Command, actor: Actor, ctx: HandlerContext): HandleResult {
  try {
    const who = attribute(state, cmd, actor);
    // A failed or ended session's agent may still be running (its spawn report was lost, or it kept going after it
    // ended): it must not act for the thread any more. Its own lifecycle signals are still taken (and ignored).
    const by = cmd.cmd === "session.signal" || !who.session ? undefined : state.sessions.get(who.session);
    if (by && (by.status === "failed" || by.status === "ended")) reject(`session ${by.id} is no longer live`);
    const d = decide(state, cmd, who, ctx);
    return { ok: true, events: d.events, effects: d.effects ?? [], result: d.result ?? null, ...(who !== actor ? { actor: who } : {}) };
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
    // A thread waiting for its tier gets no tab yet: the tab's env is fixed when it is created.
    const open = all.filter((t) => t.status !== "done" && !t.tierProposal);
    const closes: Effect[] = (ctx.config ?? DEFAULT_CONFIG).herdr.close_tab_on_done
      ? all.flatMap((t) => (t.status === "done" && t.tab ? [{ kind: "herdr.tab.close" as const, thread: t.id, tab: t.tab }] : []))
      : [];
    const probes: Effect[] = [...state.sessions.values()]
      .filter((s) => isLive(s) && (s.role === "coordinator" || s.role === "worker") && s.pane)
      .map((s) => ({ kind: "session.probe", session: s.id, ...(s.thread ? { thread: s.thread } : {}), pane: s.pane! }));
    const recovery = recoverCoordinators(state, open, ctx);
    return { events: recovery.events, effects: [...open.map((t) => tabEnsure(t, ctx)), ...closes, ...probes, ...recovery.effects], result: { threads: open.length } };
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
    if (!cmd.session && !cmd.pane) reject("session or pane is required");
    const s = cmd.session
      ? (state.sessions.get(cmd.session) ?? reject(`unknown session ${cmd.session}`))
      : ([...state.sessions.values()].find((x) => isLive(x) && x.pane === cmd.pane) ?? reject(`no live session in pane ${cmd.pane}`));
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
    if (!isLive(s)) {
      // The spawn job stops an agent whose attach is refused: nobody would track it (a replacement may already run).
      if (cmd.cmd === "session.attached") reject(`session ${s.id} is no longer live`);
      return { events: [] };
    }
    // A repeated report (a retry whose first attempt did get through) changes nothing.
    if (cmd.cmd === "session.attached" && s.pane === cmd.pane) return { events: [] };
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
    const run = roleAgent(ctx.config ?? DEFAULT_CONFIG, "main");
    return {
      events: [
        ...stale,
        {
          type: "session.created",
          payload: {
            session: cmd.session,
            role: "main",
            agent: run.agent,
            ...(run.model ? { model: run.model } : {}),
            ...(run.effort ? { effort: run.effort } : {}),
            name: agentName(ctx.root, "main"),
          },
        },
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
    case "thread.choose": {
      const proposal = t.tierProposal ?? reject(`thread ${t.id} is not waiting for a tier`);
      if (cmd.auto) {
        // The daemon's auto-accept takes the proposed tier, even one since removed from the config (roles.coordinator then).
        if (actor.role !== "user") reject("only the daemon may auto-accept a tier");
        return { events: [{ type: "thread.tier_chosen", thread: t.id, payload: { tier: proposal.tier, auto: true } }] };
      }
      checkTier(cmd.tier, ctx);
      return { events: [{ type: "thread.tier_chosen", thread: t.id, payload: { tier: cmd.tier, auto: false } }] };
    }
    case "thread.cancel":
      if (!t.tierProposal) reject(`thread ${t.id} is not waiting for a tier`);
      // The usual path to done (dependents unblock), though an open or blocked thread cannot otherwise go straight to done.
      return threadStatus(state, t, "done", "cancelled before start", ctx, { cancel: true });
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
        return { events: [{ type: "worker.queued", thread: t.id, payload: { ticket: k.id, ...(cmd.agent ? { agent: cmd.agent } : {}) } }], result: { queued: true } };
      }
      const spawned = spawnWorker(state, t, k.id, spawnContext(ctx), cmd.agent);
      const session = (spawned.events[0] as Extract<EventBody, { type: "session.created" }>).payload.session;
      return { ...spawned, result: { session, queued: false } };
    }
    case "worktree.add":
      return addWorktree(t, cmd.repo, cmd.from, ctx);
    case "worktree.report":
      return reportWorktree(state, t, cmd.repo, cmd.ok ? undefined : (cmd.error ?? "unknown error"));
    case "log":
      return { events: [{ type: "log.appended", thread: t.id, payload: { message: cmd.message } }] };
    case "decide":
      return { events: [{ type: "decision.recorded", thread: t.id, payload: { message: cmd.message } }] };
    case "note":
      return { events: [{ type: "note.recorded", thread: t.id, payload: { message: cmd.message } }] };
    case "progress":
      return { events: [{ type: "progress.recorded", thread: t.id, payload: { message: cmd.message } }] };
    case "question":
      return { events: [{ type: "question.recorded", thread: t.id, payload: { message: cmd.message, id: `Q${t.questions.length + 1}` } }] };
    case "answer": {
      if (actor.role !== "coordinator") reject("only the coordinator answers questions");
      if (!t.questions.some((q) => q.id === cmd.question)) reject(`unknown question ${cmd.question} in thread ${t.id}`);
      return { events: [{ type: "question.answered", thread: t.id, payload: { question: cmd.question, answer: cmd.message } }] };
    }
    case "handoff": {
      const v = validateHandoff(cmd.content);
      if (!v.ok) reject(`handoff missing sections: ${v.missing.join(", ")}`);
      return { events: [{ type: "handoff.submitted", thread: t.id, payload: { content: cmd.content, generated: false } }] };
    }
  }
}

/**
 * Threads with a tab but no live coordinator (it exited, or it or its spawn failed) get one back on reconcile:
 * an ended coordinator is reported lost, so the reactor replaces it; otherwise a fresh one is split from the root pane.
 */
function recoverCoordinators(state: State, open: Thread[], ctx: HandlerContext): Decision & { effects: Effect[] } {
  const events: EventBody[] = [];
  const effects: Effect[] = [];
  const spawn = spawnContext(ctx);
  for (const t of open) {
    if (!t.rootPane || t.tierProposal || liveSessions(state, t.id, "coordinator").length > 0) continue;
    const latest = [...state.sessions.values()].filter((s) => s.thread === t.id && s.role === "coordinator").at(-1);
    const how = { splitFrom: t.rootPane, bootstrap: t.handoff ? ("handoff" as const) : ("start" as const) };
    let r: { events: EventBody[]; effects: Effect[] } | undefined;
    if (latest?.status === "ended") {
      events.push({ type: "session.lost", thread: t.id, payload: { session: latest.id, reason: "coordinator exited" } });
    } else if (latest?.status === "failed") {
      r = spawnReplacement(t, latest, spawn, { ...how, retirePane: t.rootPane });
    } else if (!latest) {
      r = spawnCoordinator(t, spawn, how);
    }
    if (r) {
      events.push(...r.events);
      effects.push(...r.effects);
    }
  }
  return { events, effects };
}

export const TASK_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * A new thread gets a task name (--task, else the title's slug) and a thread directory, <root>/.worktrees/<task>, that
 * is not a git repo: the coordinator works there, and the repo worktrees are added inside it later.
 */
function newThread(state: State, cmd: Extract<Command, { cmd: "thread.new" }>, ctx: HandlerContext): Decision {
  for (const dep of cmd.dependsOn) if (!state.threads.has(dep)) reject(`unknown dependency ${dep}`);
  if (cmd.tier !== undefined) checkTier(cmd.tier, ctx);
  else if (cmd.now) reject("--now needs --tier");
  const next = Math.max(0, ...[...state.threads.keys()].map(Number)) + 1;
  const id = String(next).padStart(3, "0");
  const slug = slugify(cmd.title);
  // A legacy thread's worktree sits at the same level, so its name is taken too.
  const ownerOf = (name: string) => {
    const at = join(ctx.root, ".worktrees", name);
    return [...state.threads.values()].find((t) => t.task === name || t.dir === at || t.worktree === at);
  };
  // A folder no thread owns (made by hand, or left behind) is never adopted: its name is taken as well.
  const taken = (name: string) => ownerOf(name) !== undefined || existsSync(join(ctx.root, ".worktrees", name));
  let task: string;
  if (cmd.task !== undefined) {
    task = cmd.task;
    if (!TASK_NAME.test(task)) reject(`task name must match ${TASK_NAME.source}`);
    const owner = ownerOf(task);
    if (owner) reject(`task ${task} is already used by thread ${owner.id}`);
    if (existsSync(join(ctx.root, ".worktrees", task))) reject(`folder .worktrees/${task} already exists`);
  } else {
    // A derived name (the slug always matches TASK_NAME) that is taken gets the first free numeric suffix.
    task = slug;
    for (let n = 2; taken(task); n++) task = `${slug}-${n}`;
  }
  const dir = join(ctx.root, ".worktrees", task);
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
          task,
          dir,
          status,
        },
      },
      ...tierEvents(state, id, cmd),
    ],
    effects: [
      { kind: "thread.dir.ensure", thread: { id, title: cmd.title, slug, task, dir } },
      // A proposed thread's tab opens once its tier is chosen (the reactor, on thread.tier_chosen).
      ...(state.layout && cmd.tier === undefined ? [tabEnsure({ id, slug, dir }, ctx)] : []),
    ],
    result: { thread: id, task, dir, ...(cmd.tier !== undefined ? { tier: cmd.tier, proposed: !cmd.now } : {}) },
  };
}

/**
 * A task worktree for one repo of the workspace: `<dir>/<repo>` on a new `wip/<task>` from `--from`, else the repo's
 * source_branch. The command records the request and returns at once; the effect creates the worktree in the
 * background (outside the command queue) and reports back with worktree.report.
 */
function addWorktree(t: Thread, repo: string, from: string | undefined, ctx: HandlerContext): Decision {
  if (t.legacy || t.dir === undefined || t.task === undefined) reject(`thread ${t.id} uses the single-repo layout`);
  if (t.status === "done") reject(`thread ${t.id} is done`);
  const repos = workspaceReposNoSpawn(ctx.root, ctx.config ?? DEFAULT_CONFIG);
  const entry = Object.hasOwn(repos, repo) ? repos[repo] : undefined;
  if (!entry) reject(`unknown repo ${repo}; workspace repos: ${Object.keys(repos).join(", ") || "(none)"}`);
  if (t.worktrees[repo]) reject(`thread ${t.id} already has a worktree for ${repo}`);
  if (t.worktreeRequests[repo]) reject(`a worktree for ${repo} is already being created`);
  const source = from ?? entry.source_branch ?? reject(`no source branch for ${repo}; pass --from <branch>`);
  if (source.startsWith("-")) reject(`invalid source branch ${source}`);
  const path = join(t.dir, repo);
  const branch = `wip/${t.task}`;
  return {
    events: [{ type: "worktree.requested", thread: t.id, payload: { repo, path, branch, source } }],
    effects: [{ kind: "git.worktree.add", thread: t.id, repo, repoPath: resolve(ctx.root, entry.path), path, branch, source }],
    result: { repo, path, branch, source, requested: true },
  };
}

/** The background job's outcome: the worktree is added or the request failed, and the coordinator gets a notice. */
function reportWorktree(state: State, t: Thread, repo: string, failure: string | undefined): Decision {
  const req = t.worktreeRequests[repo];
  if (!req) return { events: [] }; // a stale or repeated report
  const coordinator = liveSessions(state, t.id, "coordinator")[0];
  const notice = (text: string): EventBody[] => (coordinator ? [{ type: "notice.queued", thread: t.id, payload: { session: coordinator.id, text } }] : []);
  if (failure === undefined) {
    return {
      events: [
        { type: "worktree.added", thread: t.id, payload: { repo, ...req } },
        ...notice(`Worktree for ${repo} is ready at ${req.path} on ${req.branch}.`),
      ],
    };
  }
  const reason = failure.trim().replace(/\.$/, "") || "unknown error";
  return { events: [{ type: "worktree.failed", thread: t.id, payload: { repo, reason } }, ...notice(`Worktree for ${repo} failed: ${reason}.`)] };
}

/** A proposed tier: the proposal, then either the choice (--now) or the timer, running unless main is working. */
function tierEvents(state: State, id: string, cmd: Extract<Command, { cmd: "thread.new" }>): EventBody[] {
  if (cmd.tier === undefined) return [];
  const proposed: EventBody = { type: "thread.tier_proposed", thread: id, payload: { tier: cmd.tier, reason: cmd.reason ?? "" } };
  if (cmd.now) return [proposed, { type: "thread.tier_chosen", thread: id, payload: { tier: cmd.tier, auto: false } }];
  const main = liveSessions(state, undefined, "main")[0];
  return main?.status === "active" ? [proposed] : [proposed, { type: "thread.tier_timer", thread: id, payload: { state: "running" } }];
}

function checkTier(tier: string, ctx: HandlerContext): void {
  const tiers = Object.keys((ctx.config ?? DEFAULT_CONFIG).agents.complexity.tiers);
  if (!tiers.includes(tier)) reject(`unknown tier ${tier}; configured: ${tiers.join(", ") || "(none)"}`);
}

function threadStatus(state: State, t: Thread, to: ThreadStatus, reason: string | undefined, ctx: HandlerContext, how: { cancel?: boolean } = {}): Decision {
  if (!how.cancel && !canTransitionThread(t.status, to)) reject(`thread ${t.id} cannot go ${t.status} → ${to}`);
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

function spawnContext(ctx: HandlerContext) {
  return { root: ctx.root, config: ctx.config ?? DEFAULT_CONFIG, newId: ctx.newId ?? randomUUID };
}

function tabEnsure(t: { id: string; slug: string; dir?: string; worktree?: string; tab?: string; tier?: string }, ctx: HandlerContext): Effect {
  return tabEnsureFor(t, { root: ctx.root, config: ctx.config ?? DEFAULT_CONFIG });
}
