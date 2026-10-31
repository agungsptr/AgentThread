import { adapterFor } from "../agents/adapters.ts";
import { agentEnv, claudeConfigDir } from "../agents/claude.ts";
import { HANDOFF_REQUEST_PREFIX } from "../agents/prompts.ts";
import { roleAgent, tierAgent, type RoleAgent } from "../agents/roles.ts";
import type { Effect } from "../commands/handler.ts";
import type { Config } from "../config/config.ts";
import type { AgentKind, EventBody, SessionRole } from "../domain/types.ts";
import { isLive, threadCwd, type Session, type State, type Thread } from "../state/projection.ts";

export interface SpawnContext {
  root: string;
  config: Config;
  newId: () => string;
}

/** The agent, model and effort fields of a session.created payload (model and effort only when set). */
const runFields = (run: RoleAgent) => ({ agent: run.agent, ...(run.model ? { model: run.model } : {}), ...(run.effort ? { effort: run.effort } : {}) });

/**
 * The env of a thread's tab, which its first coordinator inherits in the root pane: the AGT_* env with the
 * coordinator adapter's env merged over it.
 */
export function tabEnv(t: { id: string; tier?: string }, ctx: { root: string; config: Config }): Record<string, string> {
  const run = tierAgent(ctx.config, t.tier);
  const base = agentEnv({ root: ctx.root, role: "coordinator", agent: run.agent, thread: t.id, configDir: claudeConfigDir(ctx.config) });
  return { ...base, ...adapterFor(run.agent).launch({ role: "coordinator", run, config: ctx.config, root: ctx.root }).env };
}

/** Opens (or re-finds) a thread's Herdr tab in its thread directory (a legacy thread's worktree), with the env its first coordinator inherits. */
export function tabEnsure(t: { id: string; slug: string; dir?: string; worktree?: string; tab?: string; tier?: string }, ctx: { root: string; config: Config }): Effect {
  return { kind: "herdr.tab.ensure", thread: t.id, label: `${t.id}-${t.slug}`, cwd: threadCwd(t), env: tabEnv(t, ctx), ...(t.tab ? { tab: t.tab } : {}) };
}

export function liveSessions(state: State, thread?: string, role?: SessionRole): Session[] {
  return [...state.sessions.values()].filter(
    (s) => isLive(s) && (thread === undefined || s.thread === thread) && (role === undefined || s.role === role),
  );
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
  return {
    events: [
      {
        type: "session.created",
        thread: t.id,
        payload: { session, role: "coordinator", ...runFields(run), name, ...(how.splitFrom ? { retirePane: how.splitFrom } : {}) },
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
      },
    ],
  };
}

/**
 * A worker runs in the thread directory for now (Plan 11 points it at its ticket's repo worktree); a legacy
 * thread's worker runs in the thread's worktree.
 * `agent` (agt worker spawn --agent) replaces the worker role with that adapter's defaults: no model or effort is carried across vendors. */
export function spawnWorker(state: State, t: Thread, ticket: string, ctx: SpawnContext, agent?: AgentKind): { events: EventBody[]; effects: Effect[] } {
  const session = ctx.newId();
  const name = agentName(ctx.root, "worker", t.id, ticket, session);
  const last = liveSessions(state, t.id, "worker")
    .filter((s) => s.pane)
    .at(-1);
  const run: RoleAgent = agent ? { agent } : roleAgent(ctx.config, "worker");
  return {
    events: [{ type: "session.created", thread: t.id, payload: { session, role: "worker", ...runFields(run), name, ticket } }],
    effects: [
      {
        kind: "agent.spawn",
        session,
        role: "worker",
        run,
        name,
        thread: t.id,
        ticket,
        cwd: threadCwd(t),
        splitFrom: last?.pane ?? t.rootPane!,
        direction: last ? "down" : "right",
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
  return {
    events: [
      {
        type: "session.created",
        thread: t.id,
        payload: { session, role: "coordinator", ...runFields(run), name, replaces: old.id, ...(how.retirePane ? { retirePane: how.retirePane } : {}) },
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
