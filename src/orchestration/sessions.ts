import { join } from "node:path";
import { adapterFor } from "../agents/adapters.ts";
import { agentEnv, claudeConfigDir } from "../agents/claude.ts";
import { HANDOFF_REQUEST_PREFIX, returnNotice } from "../agents/prompts.ts";
import { roleAgent, tierAgent, type RoleAgent } from "../agents/roles.ts";
import type { Effect } from "../commands/handler.ts";
import type { Config } from "../config/config.ts";
import { scopesOverlap } from "../domain/rules.ts";
import type { AgentKind, EventBody, SessionRole } from "../domain/types.ts";
import type { ProfilePicker } from "./profile-pick.ts";
import { isLive, threadCwd, type Session, type State, type Thread } from "../state/projection.ts";

export interface SpawnContext {
  root: string;
  config: Config;
  newId: () => string;
  /** The profile picker of this decision (2 or more Claude profiles configured); absent otherwise. */
  profile?: ProfilePicker;
}

/** The Claude profile a launch of `agent` uses, and the events recording the choice (first use of the picker only). */
function profileFor(ctx: { profile?: ProfilePicker }, agent: AgentKind): { profile?: string; events: EventBody[] } {
  if (agent !== "claude-code" || !ctx.profile) return { events: [] };
  return { profile: ctx.profile.name(), events: ctx.profile.take() };
}

/** The agent, model and effort fields of a session.created payload (model and effort only when set). */
const runFields = (run: RoleAgent) => ({ agent: run.agent, ...(run.model ? { model: run.model } : {}), ...(run.effort ? { effort: run.effort } : {}) });

/**
 * The env of a thread's tab, which its first coordinator inherits in the root pane: the AGT_* env with the
 * coordinator adapter's env merged over it.
 */
export function tabEnv(t: { id: string; tier?: string; dir?: string; task?: string }, ctx: { root: string; config: Config; profile?: ProfilePicker }): Record<string, string> {
  const run = tierAgent(ctx.config, t.tier);
  // Only the name: recording the choice (take) is left to the launch that follows, so it is never lost.
  const profile = run.agent === "claude-code" ? ctx.profile?.name() : undefined;
  const base = agentEnv({ root: ctx.root, role: "coordinator", agent: run.agent, thread: t.id, ...(t.dir !== undefined && t.task ? { task: t.task } : {}), configDir: claudeConfigDir(ctx.config) });
  return { ...base, ...adapterFor(run.agent).launch({ role: "coordinator", run, config: ctx.config, root: ctx.root, ...(profile ? { profile } : {}) }).env, ...threadGitEnv(t, ctx.root) };
}

/**
 * A thread directory is not a git repo, but in a single-repo project it sits inside the user's checkout: git run there
 * would act on that unguarded checkout. GIT_CEILING_DIRECTORIES=<root>/.worktrees stops git's search at .worktrees, so
 * git fails in the thread directory while a repo worktree inside it still finds its own .git. Legacy threads: none.
 */
export function threadGitEnv(t: { dir?: string }, root: string): Record<string, string> {
  return t.dir !== undefined ? { GIT_CEILING_DIRECTORIES: join(root, ".worktrees") } : {};
}

/** Opens (or re-finds) a thread's Herdr tab in its thread directory (a legacy thread's worktree), with the env its first coordinator inherits. */
export function tabEnsure(t: { id: string; slug: string; dir?: string; worktree?: string; tab?: string; tier?: string }, ctx: { root: string; config: Config; profile?: ProfilePicker }): Effect {
  return { kind: "herdr.tab.ensure", thread: t.id, label: `${t.id}-${t.slug}`, cwd: threadCwd(t), env: tabEnv(t, ctx), ...(t.tab ? { tab: t.tab } : {}) };
}

export function liveSessions(state: State, thread?: string, role?: SessionRole): Session[] {
  return [...state.sessions.values()].filter(
    (s) => isLive(s) && (thread === undefined || s.thread === thread) && (role === undefined || s.role === role),
  );
}

/** Ticket statuses whose files are taken: another ticket of the same repo sharing a file waits until they leave these. */
export const FILE_HOLDING: readonly string[] = ["in_progress", "review"];

/**
 * Whether a ticket waits for a worker to be spawned: an open one, or a returned one (in_progress) whose worker is gone.
 * The fresh worker takes the returned ticket over when it is created.
 */
export function awaitsWorker(state: State, t: Thread, ticket: string): boolean {
  const k = t.tickets.find((x) => x.id === ticket);
  if (k?.status === "open") return true;
  if (k?.status !== "in_progress" || k.returnNote === undefined) return false;
  const w = k.assignee ? state.sessions.get(k.assignee) : undefined;
  return !w || !isLive(w);
}

/** Fresh workers an open ticket gets when its workers exit before starting (Ticket.earlyExits); past that the coordinator decides. */
export const MAX_EARLY_RESPAWNS = 2;

/**
 * The ticket's latest worker when it exited before starting (Session.earlyExitSeq), the ticket is still open and none
 * of its workers is live; undefined otherwise.
 */
export function exitedBeforeStart(state: State, t: Thread, ticket: string): Session | undefined {
  if (t.tickets.find((x) => x.id === ticket)?.status !== "open") return undefined;
  const workers = [...state.sessions.values()].filter((s) => s.role === "worker" && s.thread === t.id && s.ticket === ticket);
  if (workers.some(isLive)) return undefined;
  const last = workers.at(-1);
  return last?.earlyExitSeq !== undefined ? last : undefined;
}

/**
 * Whether an open ticket waits for a fresh worker because its worker exited before starting: at most
 * MAX_EARLY_RESPAWNS times (counted from the events, so a daemon restart keeps both the wait and the count).
 */
export function awaitsRespawn(state: State, t: Thread, ticket: string): boolean {
  const k = t.tickets.find((x) => x.id === ticket);
  return exitedBeforeStart(state, t, ticket) !== undefined && (k?.earlyExits ?? 0) <= MAX_EARLY_RESPAWNS;
}

/**
 * The ticket that keeps `ticket` from starting on a task thread: one in the same repo with a file in common that is
 * in a file-holding status or has a live worker already (spawned, not yet claimed). `also` names tickets spawned in the
 * same reactor pass, which state does not show yet. Undefined on legacy threads and when nothing clashes.
 */
export function conflictingTicket(state: State, t: Thread, ticket: string, also: ReadonlySet<string> = new Set()): string | undefined {
  const k = t.tickets.find((x) => x.id === ticket);
  if (!k || k.repo === undefined) return undefined;
  const live = new Set(liveSessions(state, t.id, "worker").map((s) => s.ticket));
  return t.tickets.find(
    (o) => o.id !== k.id && o.repo === k.repo && (FILE_HOLDING.includes(o.status) || (o.status === "open" && live.has(o.id)) || also.has(o.id)) && scopesOverlap(o.scope, k.scope),
  )?.id;
}

export function workerLimit(t: Thread, config: Config): number {
  return t.maxWorkers ?? config.workers.max_workers;
}

/**
 * Herdr agent names must be unique per Herdr server, so they carry a short hash of the project root.
 * Worker and coordinator names also carry a short session prefix, so a ticket's next worker never reuses an
 * earlier worker's name, and a replacement coordinator can start while the one it replaces still holds its name.
 */
export function agentName(root: string, role: SessionRole, thread?: string, ticket?: string, session?: string): string {
  const h = Bun.hash(root).toString(16).padStart(4, "0").slice(-4);
  if (role === "main") return `agt-${h}-main`;
  const suffix = session ? `-${session.replaceAll("-", "").slice(0, 4).toLowerCase()}` : "";
  if (role === "coordinator") return `agt-${h}-c${thread}${suffix}`;
  return `agt-${h}-w${thread}-${(ticket ?? "").toLowerCase()}${suffix}`;
}

/**
 * A thread's first coordinator, started in the root pane. With `splitFrom` it starts in a split of that pane instead
 * (getting its own agent env) and retires the root pane once it attaches.
 */
export function spawnCoordinator(
  t: Thread,
  ctx: SpawnContext,
  how: { splitFrom?: string; bootstrap?: "start" | "handoff" } = {},
): { events: EventBody[]; effects: Effect[] } {
  const session = ctx.newId();
  const name = agentName(ctx.root, "coordinator", t.id, undefined, session);
  // A thread's coordinator runs at the thread's tier, else as roles.coordinator.
  const run = tierAgent(ctx.config, t.tier);
  const pf = profileFor(ctx, run.agent);
  return {
    events: [
      ...pf.events,
      {
        type: "session.created",
        thread: t.id,
        payload: { session, role: "coordinator", ...runFields(run), name, ...(how.splitFrom ? { retirePane: how.splitFrom } : {}), ...(pf.profile ? { profile: pf.profile } : {}) },
      },
    ],
    effects: [
      {
        kind: "agent.spawn",
        session,
        role: "coordinator",
        run,
        name,
        thread: t.id,
        cwd: threadCwd(t),
        ...(how.splitFrom ? { splitFrom: how.splitFrom, direction: "right" as const } : { pane: t.rootPane! }),
        ...(how.bootstrap ? { bootstrap: how.bootstrap } : {}),
        ...(pf.profile ? { profile: pf.profile } : {}),
      },
    ],
  };
}

/** Where a ticket's worker runs: the ticket's repo worktree on a task thread, else the thread directory. Undefined when that worktree is missing. */
export function workerCwd(t: Thread, ticket: string): string | undefined {
  const repo = t.tickets.find((k) => k.id === ticket)?.repo;
  return repo === undefined ? threadCwd(t) : t.worktrees[repo]?.path;
}

/**
 * A worker runs in its ticket's repo worktree on a task thread, in the thread's worktree on a legacy one.
 * `agent` (agt worker spawn --agent) replaces the worker role with that adapter's defaults: no model or effort is carried across vendors.
 * `gone`: workers ended in the same reactor pass (state still shows them live); their panes are closing, so never split from them.
 */
export function spawnWorker(state: State, t: Thread, ticket: string, ctx: SpawnContext, agent?: AgentKind, gone: ReadonlySet<string> = new Set()): { events: EventBody[]; effects: Effect[] } {
  const session = ctx.newId();
  const name = agentName(ctx.root, "worker", t.id, ticket, session);
  const last = liveSessions(state, t.id, "worker")
    .filter((s) => s.pane && !gone.has(s.id))
    .at(-1);
  const run: RoleAgent = agent ? { agent } : roleAgent(ctx.config, "worker");
  // A worker for a returned ticket starts with what the coordinator asked to fix.
  const k = t.tickets.find((x) => x.id === ticket);
  const notice = k?.returnNote !== undefined ? returnNotice(t.id, ticket, k.returnNote) : undefined;
  const pf = profileFor(ctx, run.agent);
  return {
    events: [...pf.events, { type: "session.created", thread: t.id, payload: { session, role: "worker", ...runFields(run), name, ticket, ...(pf.profile ? { profile: pf.profile } : {}) } }],
    effects: [
      {
        kind: "agent.spawn",
        session,
        role: "worker",
        run,
        name,
        thread: t.id,
        ticket,
        cwd: workerCwd(t, ticket) ?? threadCwd(t),
        splitFrom: last?.pane ?? t.rootPane!,
        direction: last ? "down" : "right",
        ...(notice ? { notice } : {}),
        ...(pf.profile ? { profile: pf.profile } : {}),
      },
    ],
  };
}

export function spawnReplacement(
  t: Thread,
  old: Session,
  ctx: SpawnContext,
  how: { splitFrom?: string; retirePane?: string; bootstrap: "start" | "handoff"; fallbacks?: string[]; pane?: string },
): { events: EventBody[]; effects: Effect[] } {
  const session = ctx.newId();
  const name = agentName(ctx.root, "coordinator", t.id, undefined, session);
  const carried = old.notices.filter((n) => !n.startsWith(HANDOFF_REQUEST_PREFIX));
  // A replacement keeps the agent of the session it replaces, even when the config (or the thread's tier) has changed
  // since; only a thread whose tier is gone from the config falls back to roles.coordinator.
  const tierGone = t.tier !== undefined && !Object.hasOwn(ctx.config.agents.complexity.tiers, t.tier);
  const run: RoleAgent = tierGone
    ? roleAgent(ctx.config, "coordinator")
    : { agent: old.agent, ...(old.model ? { model: old.model } : {}), ...(old.effort ? { effort: old.effort } : {}) };
  const pf = profileFor(ctx, run.agent);
  return {
    events: [
      ...pf.events,
      {
        type: "session.created",
        thread: t.id,
        payload: { session, role: "coordinator", ...runFields(run), name, replaces: old.id, ...(how.retirePane ? { retirePane: how.retirePane } : {}), ...(pf.profile ? { profile: pf.profile } : {}) },
      },
      ...(carried.length ? [{ type: "notice.queued" as const, thread: t.id, payload: { session, text: carried.join("\n") } }] : []),
    ],
    effects: [
      {
        kind: "agent.spawn",
        session,
        role: "coordinator",
        run,
        name,
        thread: t.id,
        cwd: threadCwd(t),
        // The pane-target form starts the agent in `how.pane` itself (a fresh tab's empty root pane) instead of a split.
        ...(how.pane
          ? { pane: how.pane }
          : {
              splitFrom: how.splitFrom ?? old.pane ?? t.rootPane!,
              ...(how.fallbacks?.length ? { splitFallbacks: how.fallbacks } : {}),
              direction: "right" as const,
            }),
        bootstrap: how.bootstrap,
        ...(pf.profile ? { profile: pf.profile } : {}),
      },
    ],
  };
}

export function rotateCoordinator(state: State, s: Session, reason: string, ctx: SpawnContext): { events: EventBody[]; effects: Effect[] } {
  const t = s.thread ? state.threads.get(s.thread) : undefined;
  if (!t || t.status === "done" || !t.rootPane) return { events: [], effects: [] };
  const next = spawnReplacement(t, s, ctx, { bootstrap: "handoff" });
  return { events: [{ type: "session.rotated", thread: t.id, payload: { session: s.id, reason } }, ...next.events], effects: next.effects };
}
