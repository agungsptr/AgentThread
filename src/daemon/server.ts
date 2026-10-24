import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { configWarnings } from "../agents/roles.ts";
import type { SpawnJob } from "../agents/spawn-job.ts";
import { handle, type Effect } from "../commands/handler.ts";
import { ActorSchema, CommandSchema, type Command } from "../commands/schema.ts";
import { durationMs, loadConfig, type Config } from "../config/config.ts";
import type { Actor, EventBody, StoredEvent } from "../domain/types.ts";
import { react } from "../orchestration/reactor.ts";
import { sweep } from "../orchestration/sweep.ts";
import { dueProposals } from "../orchestration/tiers.ts";
import { paths } from "../project/paths.ts";
import { trailCache } from "../project/gittrail.ts";
import { writeAll } from "../render/write.ts";
import { applyEvent, project } from "../state/projection.ts";
import { EventStore } from "../store/event-store.ts";
import { createEffectRunner } from "./effects.ts";
import { LineReader, LineWriter } from "./framing.ts";
import type { Request, Response } from "./protocol.ts";
import { HerdrCli } from "../herdr/bridge.ts";
import { diffAgentStatus } from "./poller.ts";
import { ensureSocketDir } from "./socket-dir.ts";

export interface Daemon {
  stop(): Promise<void>;
  closed: Promise<void>;
}

const MAX_FOLLOW_UP_ROUNDS = 10;

/** Follow-ups (spawns, notifications, teardown) are themselves events; bound the chain so a bug can't loop forever. */
export async function runFollowUps(
  fresh: StoredEvent[],
  round: (events: StoredEvent[]) => StoredEvent[] | Promise<StoredEvent[]>,
  log: (message: string) => void,
): Promise<void> {
  for (let i = 0; i < MAX_FOLLOW_UP_ROUNDS && fresh.length > 0; i++) fresh = await round(fresh);
  if (fresh.length > 0) log(`reactor stopped after ${MAX_FOLLOW_UP_ROUNDS} rounds`);
}

export async function startDaemon(root: string, opts: { log?: (message: string) => void; launch?: (job: SpawnJob) => void; sweepIntervalMs?: number; pollIntervalMs?: number } = {}): Promise<Daemon> {
  const p = paths(root);
  // Taking the exclusive store lock first makes "one daemon per project" a property of state.db, not of the socket path.
  const trails = trailCache(root, 3000);
  const store = new EventStore(p.db, { exclusive: true });
  let state: ReturnType<typeof project>;
  let config: Config;
  try {
    state = project(store.all());
    if (!state.project) throw new Error("project not initialized; run `agt init`");
    config = loadConfig(root);
    ensureSocketDir(p.socketDir);
    rmSync(p.socket, { force: true });
    await trails.refresh(state.threads.values());
    writeAll(root, state, config, trails.get);
  } catch (e) {
    store.close();
    throw e;
  }
  for (const w of configWarnings(config)) (opts.log ?? console.error)(`warning: ${w}`);
  const ask = process.env.AGT_E2E_OPENCODE_ASK;
  if (ask) (opts.log ?? console.error)(`warning: AGT_E2E_OPENCODE_ASK=${ask} is set (release e2e only): OpenCode ${ask.split(",").join(", ")} sessions ask for every permission`);

  // Every command runs strictly one after another: this queue is what makes the daemon the single writer.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => T): Promise<T> => {
    const next = chain.then(fn);
    chain = next.catch(() => {});
    return next;
  };

  const runEffect = createEffectRunner({
    root,
    config,
    layout: () => state.layout,
    thread: (id) => state.threads.get(id),
    log: opts.log,
    launch: opts.launch,
  });

  const log = opts.log ?? console.error;
  const runEffects = async (effects: Effect[]): Promise<EventBody[]> => {
    const out: EventBody[] = [];
    for (const e of effects) out.push(...(await runEffect(e)));
    return out;
  };
  /** Renders every thread's files; git trails are computed without blocking first. */
  const render = async (): Promise<void> => {
    try {
      await trails.refresh(state.threads.values());
      writeAll(root, state, config, trails.get);
    } catch (e) {
      // Events are already committed; failing here would make the client retry and duplicate the command.
      log(`render failed after commit: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * Commits `bodies` with `actor`, then the reactor's follow-ups and effect output with the same actor minus its
   * `via` marker: only what handle() decided for a command counts as authored, never what the command triggered.
   */
  const applyAndReact = async (bodies: EventBody[], actor: Actor, unmarked: EventBody[] = []): Promise<void> => {
    const { via: _via, ...followActor } = actor;
    const commit = (b: EventBody[], by: Actor = followActor) => {
      const stored = store.append(b, by);
      for (const ev of stored) {
        applyEvent(state, ev);
        // A replacement coordinator must see the latest commits in its brief, not a cached trail.
        if (ev.type === "session.created" && ev.payload.replaces && ev.thread) trails.invalidate(ev.thread);
      }
      return stored;
    };
    const fresh = [...(bodies.length ? commit(bodies, actor) : []), ...(unmarked.length ? commit(unmarked) : [])];
    await runFollowUps(
      fresh,
      async (evs) => {
        const next = react(state, evs, { root, config, newId: randomUUID });
        // Commit the follow-up events first, and render before any agent starts: a replacement must find its
        // generated handoff (and the current state) in brief.md when it reads it.
        const committed = next.events.length ? commit(next.events) : [];
        if (next.effects.some((e) => e.kind === "agent.spawn")) await render();
        const produced = await runEffects(next.effects);
        return [...committed, ...(produced.length ? commit(produced) : [])];
      },
      log,
    );
    await render();
  };

  const runCommand = async (raw: { command: unknown; actor: unknown }): Promise<Response> => {
    const command = CommandSchema.safeParse(raw.command);
    if (!command.success) return { ok: false, error: `invalid command: ${command.error.issues.map((i) => i.message).join("; ")}` };
    const actor = ActorSchema.safeParse(raw.actor);
    if (!actor.success) return { ok: false, error: `invalid actor: ${actor.error.issues.map((i) => i.message).join("; ")}` };
    const decision = handle(state, command.data, actor.data, { root, config, newId: randomUUID });
    if (!decision.ok) return decision;
    await applyAndReact(decision.events, decision.actor ?? actor.data, await runEffects(decision.effects));
    return { ok: true, result: decision.result };
  };

  let stopping: Promise<void> | null = null;
  let shuttingDown = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));

  const respond = async (req: Request): Promise<Response> => {
    switch (req.op) {
      case "ping":
        return { ok: true, result: { pid: process.pid } };
      case "events.since":
        return { ok: true, result: store.since(req.seq) };
      case "shutdown":
        shuttingDown = true;
        setTimeout(() => void stop(), 50);
        return { ok: true, result: null };
      case "command":
        if (shuttingDown) return { ok: false, error: "daemon is shutting down" };
        return enqueue(() => runCommand(req));
      case "layout.get":
        return { ok: true, result: state.layout ?? null };
      default:
        return { ok: false, error: "unknown op" };
    }
  };

  const listener = Bun.listen<{ reader: LineReader; writer: LineWriter }>({
    unix: p.socket,
    socket: {
      open(s) {
        s.data = { reader: new LineReader(), writer: new LineWriter((b) => s.write(b)) };
      },
      drain(s) {
        s.data.writer.flush();
      },
      data(s, chunk) {
        for (const line of s.data.reader.push(chunk)) {
          let req: Request;
          try {
            req = JSON.parse(line) as Request;
          } catch {
            s.data.writer.send({ ok: false, error: "invalid JSON" });
            continue;
          }
          respond(req)
            .catch((e: unknown): Response => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
            .then((res) => s.data.writer.send(res));
        }
      },
    },
  });

  const sweepTimer = setInterval(() => {
    if (shuttingDown) return;
    void enqueue(async () => {
      const r = sweep(state, new Date().toISOString(), { root, config, newId: randomUUID });
      const bodies = [...r.events, ...(await runEffects(r.effects))];
      if (bodies.length) await applyAndReact(bodies, { role: "user" });
    }).catch((e) => (opts.log ?? console.error)(`sweep failed: ${e instanceof Error ? e.message : String(e)}`));
  }, opts.sweepIntervalMs ?? 15_000);
  sweepTimer.unref?.();

  const misses = new Map<string, number>();
  const pollTimer = setInterval(() => {
    if (shuttingDown) return;
    void enqueue(async () => {
      const actor: Actor = { role: "user" };
      const run = async (command: Command) => {
        const decision = handle(state, command, actor, { root, config, newId: randomUUID });
        if (decision.ok) await applyAndReact(decision.events, decision.actor ?? actor, await runEffects(decision.effects));
      };
      const layout = state.layout;
      if (layout) {
        let listed;
        try {
          listed = await new HerdrCli({ bin: layout.herdrBin, env: { ...process.env, ...(layout.herdrSocket ? { HERDR_SOCKET_PATH: layout.herdrSocket } : {}) } }).agentListAsync();
        } catch (e) {
          log(`herdr poll failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        for (const d of listed ? diffAgentStatus({ sessions: [...state.sessions.values()], listed, misses }) : []) {
          // A polled start is marked, so the agent's own start hook just after it is not taken for a resume.
          await run({ cmd: "session.signal", session: d.session, signal: d.signal, ...(d.signal === "started" ? { source: "poll" } : {}) });
        }
      }
      // After the signals: main starting to work in this tick pauses its proposals before they can fire.
      for (const thread of dueProposals(state, Date.now(), durationMs(config.agents.complexity.timeout))) {
        const t = state.threads.get(thread);
        if (t?.tierProposal) await run({ cmd: "thread.choose", thread, tier: t.tierProposal.tier, auto: true });
      }
    }).catch((e) => (opts.log ?? console.error)(`poll failed: ${e instanceof Error ? e.message : String(e)}`));
  }, opts.pollIntervalMs ?? durationMs(config.herdr.poll_interval));
  pollTimer.unref?.();

  const stop = (): Promise<void> => {
    shuttingDown = true;
    clearInterval(sweepTimer);
    clearInterval(pollTimer);
    stopping ??= (async () => {
      await chain;
      listener.stop(true);
      store.close();
      rmSync(p.socket, { force: true });
      resolveClosed();
    })();
    return stopping;
  };

  return { stop, closed };
}
