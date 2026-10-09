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

/** Herdr agent names must be unique per Herdr server, so they carry a short hash of the project root. */
export function agentName(root: string, role: SessionRole, thread?: string, ticket?: string): string {
  const h = Bun.hash(root).toString(16).padStart(4, "0").slice(-4);
  if (role === "main") return `agt-${h}-main`;
  if (role === "coordinator") return `agt-${h}-c${thread}`;
  return `agt-${h}-w${thread}-${(ticket ?? "").toLowerCase()}`;
}

export function spawnCoordinator(t: Thread, ctx: SpawnContext): { events: EventBody[]; effects: Effect[] } {
  const session = ctx.newId();
  const name = agentName(ctx.root, "coordinator", t.id);
  return {
    events: [{ type: "session.created", thread: t.id, payload: { session, role: "coordinator", agent: "claude-code", name } }],
    effects: [{ kind: "agent.spawn", session, role: "coordinator", name, thread: t.id, cwd: t.worktree, pane: t.rootPane! }],
  };
}

export function spawnWorker(state: State, t: Thread, ticket: string, ctx: SpawnContext): { events: EventBody[]; effects: Effect[] } {
  const session = ctx.newId();
  const name = agentName(ctx.root, "worker", t.id, ticket);
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
