import { HANDOFF_REQUEST_PREFIX } from "../agents/prompts.ts";
import type { Effect } from "../commands/handler.ts";
import type { Config } from "../config/config.ts";
import type { EventBody, SessionRole } from "../domain/types.ts";
import { isLive, type Session, type State, type Thread } from "../state/projection.ts";

export interface SpawnContext {
  root: string;
  newId: () => string;
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

export function spawnCoordinator(t: Thread, ctx: SpawnContext): { events: EventBody[]; effects: Effect[] } {
  const session = ctx.newId();
  const name = agentName(ctx.root, "coordinator", t.id, undefined, session);
  return {
    events: [{ type: "session.created", thread: t.id, payload: { session, role: "coordinator", agent: "claude-code", name } }],
    effects: [{ kind: "agent.spawn", session, role: "coordinator", name, thread: t.id, cwd: t.worktree, pane: t.rootPane! }],
  };
}

export function spawnWorker(state: State, t: Thread, ticket: string, ctx: SpawnContext): { events: EventBody[]; effects: Effect[] } {
  const session = ctx.newId();
  const name = agentName(ctx.root, "worker", t.id, ticket, session);
  const last = liveSessions(state, t.id, "worker")
    .filter((s) => s.pane)
    .at(-1);
  return {
    events: [{ type: "session.created", thread: t.id, payload: { session, role: "worker", agent: "claude-code", name, ticket } }],
    effects: [
      {
        kind: "agent.spawn",
        session,
        role: "worker",
        name,
        thread: t.id,
        ticket,
        cwd: t.worktree,
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
  how: { pane?: string; bootstrap: "handoff" | "resume" },
): { events: EventBody[]; effects: Effect[] } {
  const session = ctx.newId();
  const name = agentName(ctx.root, "coordinator", t.id, undefined, session);
  const carried = old.notices.filter((n) => !n.startsWith(HANDOFF_REQUEST_PREFIX));
  return {
    events: [
      { type: "session.created", thread: t.id, payload: { session, role: "coordinator", agent: "claude-code", name, replaces: old.id } },
      ...(carried.length ? [{ type: "notice.queued" as const, thread: t.id, payload: { session, text: carried.join("\n") } }] : []),
    ],
    effects: [
      {
        kind: "agent.spawn",
        session,
        role: "coordinator",
        name,
        thread: t.id,
        cwd: t.worktree,
        ...(how.pane ? { pane: how.pane } : { splitFrom: old.pane ?? t.rootPane!, direction: "right" as const }),
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
