import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserCheckMode, DEFAULT_CONFIG, type Config } from "../config/config.ts";
import { canTransitionThread, canTransitionTicket, scopesOverlap, slugify, validateHandoff } from "../domain/rules.ts";
import { squashBranch } from "../domain/branches.ts";
import { ROLES, type Actor, type AgentKind, type EventBody, type Role, type ThreadStatus, type ThreadType, type TicketStatus } from "../domain/types.ts";
import { roleAgent, type RoleAgent } from "../agents/roles.ts";
import { agentName, awaitsWorker, conflictingTicket, FILE_HOLDING, liveSessions, spawnCoordinator, spawnReplacement, spawnWorker, tabEnsure as tabEnsureFor, workerLimit } from "../orchestration/sessions.ts";
import { stageNa } from "../workflow/project-config.ts";
import { workspaceReposNoSpawn } from "../project/workspace.ts";
import { actorSession, isLive, type State, type Thread, type Ticket } from "../state/projection.ts";
import type { Command, CommandName } from "./schema.ts";

export type Effect =
  /** Legacy form (old threads only): the thread's own worktree of the root repo. */
  | { kind: "git.worktree.add"; branch: string; path: string; thread: { id: string; title: string; slug: string } }
  /** A task worktree of one workspace repo, at `<dir>/<repo>` on a new `wip/<task>` from `source`. */
  | { kind: "git.worktree.add"; thread: string; repo: string; repoPath: string; path: string; branch: string; source: string }
  /** Removes a done task thread's repo worktrees and wip/<task> branches, then its directory if only agt's files are left. */
  | { kind: "git.thread.cleanup"; thread: string; task: string; /** The thread's squash branch (a thread from before types follow the prefix: feat/<task> is checked too). */ squashBranch: string; dir: string; repos: { repo: string; repoPath: string; path: string }[] }
  | { kind: "thread.dir.ensure"; thread: { id: string; title: string; slug: string; task: string; dir: string; type: ThreadType } }
  | { kind: "herdr.tab.ensure"; thread: string; label: string; cwd: string; env: Record<string, string>; tab?: string }
  /** `workers`: the thread is done, so its workers tabs close too (a tab closed only to be reopened keeps them). */
  | { kind: "herdr.tab.close"; thread: string; tab: string; workers?: true }
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
      /** Text the bootstrap prompt ends with: a returned ticket's notice for its fresh worker. */
      notice?: string;
    }
  /** `unconfirmed`: only Herdr's poll says the agent started (it may list an agent at a startup dialog idle). */
  /** `agent` is the session's: only its adapter's trust dialog holds the delivery. */
  | { kind: "notice.deliver"; session: string; thread?: string; agent: AgentKind; pane: string; text: string; count: number; /** Copy of the queued notices delivered (so a notice queued meanwhile is not dropped). */ texts?: string[]; unconfirmed?: true; /** Holds so far in this stretch (the session's noticeHeldCount), when any. */ held?: number }
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
  "thread.waiting": ["coordinator"],
  "thread.browser_check": ["user", "main", "coordinator"],
  "thread.cleanup": ["user", "main"],
  "thread.cleanup_report": ["user"],
  "ticket.add": ["coordinator"],
  "ticket.files": ROLES, // changing the list (--add/--remove) is the coordinator's, checked in decide
  "ticket.claim": ["worker"],
  "ticket.done": ["worker"],
  "ticket.block": ["worker"],
  "ticket.reopen": ["coordinator"],
  "ticket.accept": ["coordinator"],
  "ticket.return": ["coordinator"],
  stage: ["user", "coordinator"],
  "stack.acquire": ["user", "coordinator"],
  "stack.release": ["user", "coordinator"],
  "stack.status": ROLES,
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

const noWorktree = (t: Thread, k: Ticket) => `ticket ${k.id} needs a worktree for ${k.repo}; create it with agt worktree add ${t.id} ${k.repo}`;

/**
 * A ticket file path as the repo-relative, normalised form: no leading /, no .. segment, no empty or . segment. A file,
 * not a directory (no trailing /), and none of the characters git quotes in its output (the commit hook could never
 * match such a path).
 */
function repoRelative(p: string): string {
  const parts = p.split("/");
  if (!p.trim() || p.startsWith("/") || p.includes("\0") || parts.includes("..")) reject(`file paths are relative to the repo: ${p}`);
  if (/["\\\t\n]/.test(p)) reject(`file paths may not contain a quote, backslash, tab or newline: ${p}`);
  const norm = parts.filter((s) => s !== "" && s !== ".").join("/");
  if (!norm) reject(`file paths are relative to the repo: ${p}`);
  if (p.endsWith("/")) reject(`--file takes a file, not a directory: ${p}`);
  return norm;
}

/**
 * Whether a ticket title word is an existing file of the ticket's repo (main checkout or the thread's worktree): the
 * signature of `--file a b c`, where only `a` is the option's value and `b c` fall into the title.
 */
function titleWordIsFile(word: string, ctx: HandlerContext, t: Thread, repo: string): boolean {
  if (!word || word.startsWith("/") || word.split("/").includes("..") || /[\0]/.test(word)) return false;
  const entry = workspaceReposNoSpawn(ctx.root, ctx.config ?? DEFAULT_CONFIG)[repo];
  const bases = [t.worktrees[repo]?.path, entry ? resolve(ctx.root, entry.path) : undefined].filter((b): b is string => !!b);
  return bases.some((b) => {
    try {
      return statSync(join(b, word)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * A ticket doc: a normalised workspace-root-relative file under .docs/ (no leading /, no empty, . or .. segment, no
 * trailing /), with no backslash or glob character. It becomes the worker's only write rule outside its worktree.
 */
function checkTicketDoc(p: string): string {
  const parts = p.split("/");
  const ok = parts[0] === ".docs" && parts.length > 1 && parts.every((s) => s !== "" && s !== "." && s !== "..") && !/[\\*?[\]\0]/.test(p);
  return ok ? p : reject(`--doc must be a path under .docs/: ${p}`);
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
      ? all.flatMap((t) => (t.status === "done" && t.tab ? [{ kind: "herdr.tab.close" as const, thread: t.id, tab: t.tab, workers: true as const }] : []))
      : [];
    const probes: Effect[] = [...state.sessions.values()]
      .filter((s) => isLive(s) && (s.role === "coordinator" || s.role === "worker") && s.pane)
      .map((s) => ({ kind: "session.probe", session: s.id, ...(s.thread ? { thread: s.thread } : {}), pane: s.pane! }));
    const recovery = recoverCoordinators(state, open, ctx);
    return { events: recovery.events, effects: [...open.map((t) => tabEnsure(t, ctx)), ...closes, ...probes, ...recovery.effects], result: { threads: open.length } };
  }

  if (cmd.cmd === "stack.status") return { events: [], result: state.stack };

  if (cmd.cmd === "tell" && cmd.target.includes("/")) {
    // <thread>/<ticket>: that ticket's live worker. Only the thread's coordinator (and the user) may speak to it.
    const [thread, ticket] = cmd.target.split("/") as [string, string];
    if (actor.role !== "user" && !(actor.role === "coordinator" && actor.thread === thread)) reject(`only the coordinator of thread ${thread} (or the user) may tell a worker`);
    const worker = liveSessions(state, thread, "worker").find((w) => w.ticket === ticket);
    if (!worker) reject(`no live worker for ticket ${cmd.target}; return the ticket with agt ticket return ${cmd.target} "<what to fix>" or start one with agt worker spawn ${thread} --ticket ${ticket}`);
    return { events: [{ type: "notice.queued", thread, payload: { session: worker.id, text: `Message from ${actor.role}: ${cmd.message}` } }] };
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
      if (cmd.status === "done" && actor.role === "coordinator" && !t.legacy) {
        reject(`only main or the user close a thread: agt tell main "${t.id}: merged into <source> in <repos> (verified)"`);
      }
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
    case "thread.browser_check":
      if (t.legacy) reject("the browser check applies to task threads");
      if (t.status === "done") reject(`thread ${t.id} is done`);
      return { events: [{ type: "thread.browser_check", thread: t.id, payload: {} }] };
    case "thread.waiting":
      if (t.legacy) reject("waiting applies to task threads");
      if (t.status === "done") reject(`thread ${t.id} is done`);
      return { events: [{ type: "thread.waiting", thread: t.id, payload: { what: cmd.what } }] };
    case "thread.cancel":
      if (t.cleanupRequested) reject(cleanupRunning(t));
      if (!t.tierProposal) reject(`thread ${t.id} is not waiting for a tier`);
      // The usual path to done (dependents unblock), though an open or blocked thread cannot otherwise go straight to done.
      return threadStatus(state, t, "done", "cancelled before start", ctx, { cancel: true });
    case "ticket.add": {
      if (t.status === "done") reject(`thread ${t.id} is done`);
      const ticket = `T${t.tickets.length + 1}`;
      if (t.legacy) {
        if (!cmd.scope.length) reject("ticket add needs at least one --scope <path>");
        return { events: [{ type: "ticket.created", thread: t.id, payload: { ticket, title: cmd.title, scope: cmd.scope } }], result: { ticket } };
      }
      if (!cmd.repo || !cmd.files?.length) reject("a task thread's ticket needs --repo <repo> and at least one --file <path>");
      if (!Object.hasOwn(workspaceReposNoSpawn(ctx.root, ctx.config ?? DEFAULT_CONFIG), cmd.repo)) reject(`unknown repo ${cmd.repo}`);
      const files = [...new Set(cmd.files.map(repoRelative))];
      for (const word of cmd.title.split(/\s+/)) {
        if (word && !files.includes(word) && titleWordIsFile(word, ctx, t, cmd.repo)) reject(`"${word}" looks like a file path in the title; repeat --file for every path: --file a --file b`);
      }
      if (cmd.doc !== undefined) checkTicketDoc(cmd.doc);
      return {
        events: [{ type: "ticket.created", thread: t.id, payload: { ticket, title: cmd.title, scope: files, repo: cmd.repo, files, ...(cmd.doc ? { doc: cmd.doc } : {}) } }],
        result: { ticket },
      };
    }
    case "stage": {
      if (t.legacy) reject("stages apply to task threads");
      const recordedNa = t.stages[cmd.stage];
      if (recordedNa?.state === "na" && recordedNa.by === "agt" && (cmd.state === "done" || cmd.state === "approve") && cmd.by !== "user" && actor.role !== "user") {
        reject(`stage ${cmd.stage} is na: ${recordedNa.reason ?? "ruled out by the config"}; only the user can change it (add --by user)`);
      }
      if (cmd.state === "approve") {
        if (cmd.stage !== 7) reject("only stage 7 (e2e) is approved");
        if (cmd.by !== "user") reject("approving stage 7 needs --by user");
      } else if (cmd.by === "user" && cmd.state !== "skipped") reject("--by user is only for approve and skipped");
      else if (cmd.state === "skipped" && cmd.by !== "user") reject("only the user skips a stage; record it with --by user");
      if ((cmd.state === "skipped" || cmd.state === "na") && !cmd.reason) reject(`stage ${cmd.stage} ${cmd.state} needs --reason <why>`);
      const recorded: EventBody = { type: "stage.recorded", thread: t.id, payload: { stage: cmd.stage, state: cmd.state, by: cmd.by ?? "coordinator", ...(cmd.reason ? { reason: cmd.reason } : {}) } };
      // The last stage done is the thread ready for review (the squash is done), through the usual transition.
      const toReview = cmd.stage === 10 && cmd.state === "done" && t.status === "in_progress" ? threadStatus(state, t, "review", "stage 10 done", ctx).events : [];
      return { events: [recorded, ...toReview] };
    }
    case "stack.acquire": {
      const { holder, queue } = state.stack;
      // Task threads only: stages do not exist on a legacy thread, which cannot be approved. Checked first, so neither
      // the holder nor a queued thread gets the e2e4 purpose without the approval.
      if (cmd.for === "e2e4" && !t.legacy && !t.stage7Approved) reject(`stage 4 e2e needs the user's approval: agt stage ${t.id} 7 approve --by user`);
      const payload = { thread: t.id, ...(cmd.for ? { purpose: cmd.for } : {}) };
      // The holder keeps the lock; a new purpose is recorded (status and main.thread.md show it).
      if (holder?.thread === t.id) return { events: holder.purpose === cmd.for ? [] : [{ type: "stack.acquired", thread: t.id, payload }], result: { acquired: true } };
      // The queue keeps a waiting thread's place; a new purpose is recorded in that place.
      const waiting = queue.findIndex((q) => q.thread === t.id);
      if (waiting >= 0) return { events: queue[waiting]!.purpose === cmd.for ? [] : [{ type: "stack.queued", thread: t.id, payload }], result: { acquired: false, position: waiting + 1 } };
      if (!holder) return { events: [{ type: "stack.acquired", thread: t.id, payload }], result: { acquired: true } };
      return { events: [{ type: "stack.queued", thread: t.id, payload }], result: { acquired: false, position: queue.length + 1 } };
    }
    case "stack.release": {
      const reason = state.stack.holder?.thread === t.id ? "released" : state.stack.queue.some((q) => q.thread === t.id) ? "left the queue" : undefined;
      return { events: reason ? [{ type: "stack.released", thread: t.id, payload: { thread: t.id, reason } }] : [] };
    }
    case "ticket.files": {
      const k = findTicket(t, cmd.ticket);
      if (!cmd.add?.length && !cmd.remove?.length) return { events: [], result: { files: k.files ?? [] } };
      if (actor.role === "worker") reject("only the coordinator (or the user) may change a ticket's files");
      if (t.legacy) reject("--add and --remove apply to task threads; a legacy thread's ticket has a scope, not a file list");
      if (k.status === "done") reject(`ticket ${k.id} is done; its files cannot change`);
      const current = k.files ?? [];
      const added = [...new Set((cmd.add ?? []).map(repoRelative))];
      const removed = [...new Set((cmd.remove ?? []).map(repoRelative))];
      for (const f of removed) if (!current.includes(f)) reject(`${f} is not one of ticket ${k.id}'s files`);
      const files = [...new Set([...current.filter((f) => !removed.includes(f) || added.includes(f)), ...added])];
      if (!files.length) reject(`ticket ${k.id} must keep at least one file`);
      if (files.length === current.length && files.every((f) => current.includes(f))) return { events: [], result: { files } };
      const clash = t.tickets.find((o) => o.id !== k.id && FILE_HOLDING.includes(o.status) && o.repo === k.repo && scopesOverlap(o.scope, files));
      if (clash && FILE_HOLDING.includes(k.status)) reject(`these files overlap ticket ${clash.id}`);
      const net = { added: files.filter((f) => !current.includes(f)), removed: current.filter((f) => !files.includes(f)) };
      return { events: [{ type: "ticket.files_changed", thread: t.id, payload: { ticket: k.id, files, ...net } }], result: { files } };
    }
    case "ticket.claim": {
      const k = workerTicket(t, cmd.ticket, actor);
      const session = workerSession(actor);
      // A fresh worker for a returned ticket already holds it (see session.created): its claim changes nothing.
      if (k.status === "in_progress" && k.assignee === session) return { events: [] };
      // Only an open ticket is claimed: a worker must not pull its ticket back out of review.
      if (k.status !== "open") reject(`ticket ${k.id} cannot go ${k.status} → in_progress`);
      // On a task thread, file lists are repo-relative: only tickets of the same repo can clash. A ticket in review
      // still holds its files, as in scheduling.
      const clash = t.tickets.find((o) => o.id !== k.id && FILE_HOLDING.includes(o.status) && o.repo === k.repo && scopesOverlap(o.scope, k.scope));
      if (clash) reject(clash.status === "review" ? `scope of ${k.id} overlaps ticket ${clash.id} in review` : `scope of ${k.id} overlaps in-progress ticket ${clash.id}`);
      return { events: [{ type: "ticket.claimed", thread: t.id, payload: { ticket: k.id, assignee: session } }] };
    }
    case "ticket.done": {
      const k = assignedTicket(t, cmd.ticket, actor);
      if (t.legacy) {
        transitionTicket(k, "done");
        return { events: [{ type: "ticket.completed", thread: t.id, payload: { ticket: k.id, summary: cmd.summary } }] };
      }
      // A task thread's ticket waits for the coordinator's review; its worker stays to fix what comes back.
      transitionTicket(k, "review");
      return { events: [{ type: "ticket.reviewed", thread: t.id, payload: { ticket: k.id, summary: cmd.summary } }] };
    }
    case "ticket.accept":
    case "ticket.return": {
      const k = findTicket(t, cmd.ticket);
      if (k.status !== "review") reject(`ticket ${k.id} is ${k.status}, not in review`);
      return cmd.cmd === "ticket.accept"
        ? { events: [{ type: "ticket.accepted", thread: t.id, payload: { ticket: k.id } }] }
        : { events: [{ type: "ticket.returned", thread: t.id, payload: { ticket: k.id, note: cmd.note } }] };
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
      if (k.status !== "open" && !awaitsWorker(state, t, k.id)) reject(`ticket ${k.id} is ${k.status}`);
      const workers = liveSessions(state, t.id, "worker");
      if (t.workerQueue.includes(k.id) || workers.some((s) => s.ticket === k.id)) reject(`ticket ${k.id} already has a worker`);
      // A missing worktree is told at once, never left to wait in the queue.
      if (k.repo !== undefined && !t.worktrees[k.repo]) reject(noWorktree(t, k));
      // Tickets that share a file in one repo run one after the other: fillWorkers starts this one once the other is done, blocked or open again.
      const waitingFor = conflictingTicket(state, t, k.id);
      if (waitingFor) {
        return { events: [{ type: "worker.queued", thread: t.id, payload: { ticket: k.id, ...(cmd.agent ? { agent: cmd.agent } : {}) } }], result: { queued: true, waitingFor } };
      }
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
    case "thread.cleanup":
      return cleanupThread(t, ctx);
    case "thread.cleanup_report":
      return reportCleanup(state, t, cmd);
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
          ...(cmd.browserCheck ? { browserCheck: true as const } : {}),
        },
      },
      // The stages the config rules out are na from the start (stage.recorded needs the thread, so after thread.created).
      ...stageNa(ctx.config ?? DEFAULT_CONFIG).map(({ stage, reason }): EventBody => ({ type: "stage.recorded", thread: id, payload: { stage, state: "na", by: "agt", reason } })),
      // Stage 8 only on request: agt records it skipped itself, so the squash guard opens and nobody is asked. The coordinator
      // records it done if the user asks for a browser check later.
      ...(!cmd.browserCheck && browserCheckMode(ctx.config ?? DEFAULT_CONFIG) === "on_request" && !stageNa(ctx.config ?? DEFAULT_CONFIG).some((x) => x.stage === 8)
        ? [{ type: "stage.recorded", thread: id, payload: { stage: 8, state: "skipped", by: "agt", reason: "not requested" } } as EventBody]
        : []),
      ...tierEvents(state, id, cmd),
    ],
    effects: [
      { kind: "thread.dir.ensure", thread: { id, title: cmd.title, slug, task, dir, type: cmd.type } },
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
  if (t.cleanupRequested) reject(cleanupRunning(t));
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

const cleanupRunning = (t: Thread) => `cleanup of thread ${t.id} is running`;

/**
 * `agt thread cleanup`: a done (merged) task thread's worktrees and wip/<task> branches go. The command records the
 * request and returns at once; the effect checks and removes them in the background and reports back with
 * thread.cleanup_report.
 */
function cleanupThread(t: Thread, ctx: HandlerContext): Decision {
  if (t.legacy || t.dir === undefined || t.task === undefined) reject("legacy threads keep their worktree; remove it by hand");
  if (t.status !== "done") reject(`cleanup needs thread ${t.id} to be done; the user says when it is merged`);
  if (t.cleanupRequested) reject(`cleanup of thread ${t.id} is already running`);
  const pending = Object.keys(t.worktreeRequests);
  if (pending.length) reject(`a worktree for ${pending.join(", ")} is still being created`);
  if (!Object.keys(t.worktrees).length) reject(`thread ${t.id} has no worktrees to clean up`);
  const all = workspaceReposNoSpawn(ctx.root, ctx.config ?? DEFAULT_CONFIG);
  for (const [repo, w] of Object.entries(t.worktrees)) {
    if (!Object.hasOwn(all, repo)) reject(`repo ${repo} is no longer in the workspace config; remove its worktree ${w.path} by hand`);
  }
  // In the config's order: the worktrees were added in whatever order their jobs finished.
  const repos = Object.entries(all)
    .filter(([repo]) => Object.hasOwn(t.worktrees, repo))
    .map(([repo, entry]) => ({ repo, repoPath: resolve(ctx.root, entry.path), path: t.worktrees[repo]!.path }));
  return {
    events: [{ type: "thread.cleanup_requested", thread: t.id, payload: {} }],
    effects: [{ kind: "git.thread.cleanup", thread: t.id, task: t.task, squashBranch: squashBranch(t.type, t.task, (ctx.config ?? DEFAULT_CONFIG).workflow.branch_prefix), dir: t.dir, repos }],
    result: { requested: true, repos: repos.map((r) => r.repo) },
  };
}

/** The cleanup job's outcome: the thread is cleaned or the cleanup stopped at a repo, and main gets a notice. */
function reportCleanup(state: State, t: Thread, cmd: Extract<Command, { cmd: "thread.cleanup_report" }>): Decision {
  if (!t.cleanupRequested) return { events: [] }; // a stale or repeated report
  const main = liveSessions(state, undefined, "main")[0];
  const notice = (text: string): EventBody[] => (main ? [{ type: "notice.queued", payload: { session: main.id, text } }] : []);
  if (cmd.ok) {
    const repos = cmd.repos ?? [];
    return {
      events: [
        { type: "thread.cleaned", thread: t.id, payload: { repos } },
        ...notice(`Thread ${t.id} is cleaned up: removed the worktrees and wip/${t.task ?? ""} of ${repos.join(", ")}.`),
      ],
    };
  }
  const repo = cmd.repo ?? "(all)";
  const reason = (cmd.error ?? "").trim().replace(/\.$/, "") || "unknown error";
  const removed = cmd.removed?.length ? { removed: cmd.removed } : {};
  return { events: [{ type: "thread.cleanup_failed", thread: t.id, payload: { repo, reason, ...removed } }, ...notice(`Cleanup of thread ${t.id} stopped at ${repo}: ${reason}`)] };
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
  if (t.cleanupRequested) reject(cleanupRunning(t));
  // The same status again (a rotated coordinator re-running its start command) is a no-op, not an error.
  if (!how.cancel && t.status === to) return { events: [], result: { unchanged: true, message: `already ${to}` } };
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
  const effects: Effect[] = to === "done" && t.tab && config.herdr.close_tab_on_done ? [{ kind: "herdr.tab.close", thread: t.id, tab: t.tab, workers: true }] : [];
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
