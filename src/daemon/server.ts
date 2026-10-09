import { rmSync } from "node:fs";
import { handle, type Effect } from "../commands/handler.ts";
import { ActorSchema, CommandSchema } from "../commands/schema.ts";
import { addWorktree } from "../project/git.ts";
import { paths } from "../project/paths.ts";
import { writeAll } from "../render/write.ts";
import { applyEvent, project } from "../state/projection.ts";
import { EventStore } from "../store/event-store.ts";
import { LineReader, LineWriter } from "./framing.ts";
import type { Request, Response } from "./protocol.ts";
import { ensureSocketDir } from "./socket-dir.ts";

export interface Daemon {
  stop(): Promise<void>;
  closed: Promise<void>;
}

export async function startDaemon(root: string): Promise<Daemon> {
  const p = paths(root);
  // Taking the exclusive store lock first makes "one daemon per project" a property of state.db, not of the socket path.
  const store = new EventStore(p.db, { exclusive: true });
  let state: ReturnType<typeof project>;
  try {
    state = project(store.all());
    if (!state.project) throw new Error("project not initialized; run `agt init`");
    ensureSocketDir(p.socketDir);
    rmSync(p.socket, { force: true });
    writeAll(root, state);
  } catch (e) {
    store.close();
    throw e;
  }

  // Every command runs strictly one after another: this queue is what makes the daemon the single writer.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => T): Promise<T> => {
    const next = chain.then(fn);
    chain = next.catch(() => {});
    return next;
  };

  const runEffect = (effect: Effect) => {
    switch (effect.kind) {
      case "git.worktree.add":
        addWorktree(root, effect.branch, effect.path);
        break;
    }
  };

  const runCommand = (raw: { command: unknown; actor: unknown }): Response => {
    const command = CommandSchema.safeParse(raw.command);
    if (!command.success) return { ok: false, error: `invalid command: ${command.error.issues.map((i) => i.message).join("; ")}` };
    const actor = ActorSchema.safeParse(raw.actor);
    if (!actor.success) return { ok: false, error: `invalid actor: ${actor.error.issues.map((i) => i.message).join("; ")}` };
    const decision = handle(state, command.data, actor.data, { root });
    if (!decision.ok) return decision;
    for (const effect of decision.effects) runEffect(effect);
    for (const ev of store.append(decision.events, actor.data)) applyEvent(state, ev);
    try {
      writeAll(root, state);
    } catch (e) {
      // Events are already committed; failing here would make the client retry and duplicate the command.
      console.error(`render failed after commit: ${e instanceof Error ? e.message : String(e)}`);
    }
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

  const stop = (): Promise<void> => {
    shuttingDown = true;
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
