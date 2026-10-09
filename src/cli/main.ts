import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { stringify } from "yaml";
import { decodeJob, runSpawnJob } from "../agents/spawn-job.ts";
import { isAlive, request } from "../daemon/client.ts";
import { startDaemon } from "../daemon/server.ts";
import { loadConfig } from "../config/config.ts";
import { ROLES, type Actor, type Layout, type StoredEvent } from "../domain/types.ts";
import { HerdrCli, shellQuote } from "../herdr/bridge.ts";
import { initProject } from "../project/init.ts";
import { paths } from "../project/paths.ts";
import { findRoot } from "../project/root.ts";

type Env = Record<string, string | undefined>;

const USAGE = `usage: agt <command>

  init [--name <name>]
  start                      set up the Herdr layout (run inside a Herdr pane)
  daemon start|stop|status
  config
  thread new <title...> --type feature|bug|chore [--goal <text>] [--criteria <text>]... [--depends <id>]...
  thread status <id> <status> [--reason <text>]
  ticket add <thread> <title...> --scope <path> [--scope <path>]...
  ticket claim|reopen <thread>/<ticket>
  ticket done <thread>/<ticket> [--summary <text>]
  ticket block <thread>/<ticket> --reason <text>
  log <thread> <message...>
  decide <thread> <message...>
  handoff <thread> --file <path>
  logs [-f]`;

class UsageError extends Error {}

export async function main(argv: string[], env: Env = process.env, cwd: string = process.cwd()): Promise<number> {
  try {
    return await run(argv, env, cwd);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message ? `agt: ${e.message}\n\n${USAGE}` : USAGE);
      return 2;
    }
    console.error(`agt: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

export function actorFromEnv(env: Env): Actor {
  const role = env.AGT_ROLE ?? "user";
  if (!(ROLES as readonly string[]).includes(role)) throw new Error(`invalid AGT_ROLE ${role}`);
  const actor: Record<string, string> = { role };
  for (const [key, field] of [
    ["AGT_THREAD", "thread"],
    ["AGT_SESSION", "session"],
    ["AGT_TICKET", "ticket"],
    ["AGT_AGENT", "agent"],
  ] as const) {
    if (env[key]) actor[field] = env[key];
  }
  return actor as unknown as Actor;
}

export function parseTicketRef(ref: string | undefined): { thread: string; ticket: string } {
  const m = /^(\d{3,})\/(T\d+)$/.exec(ref ?? "");
  if (!m) throw new UsageError(`expected <thread>/<ticket>, like 002/T3, got '${ref ?? ""}'`);
  return { thread: m[1]!, ticket: m[2]! };
}

async function run(argv: string[], env: Env, cwd: string): Promise<number> {
  const [group, sub, ...rest] = argv;
  switch (group) {
    case "__spawn": {
      const job = decodeJob(sub ?? "");
      const herdr = new HerdrCli({
        bin: job.herdrBin,
        env: { ...process.env, ...(job.herdrSocket ? { HERDR_SOCKET_PATH: job.herdrSocket } : {}) },
        timeoutMs: 90_000,
      });
      const socket = paths(job.root).socket;
      await runSpawnJob(job, {
        herdr,
        report: async (command) => {
          try {
            const res = await request(socket, { op: "command", command, actor: { role: "user" } });
            if (!res.ok) console.error(`agt __spawn: ${res.error}`);
          } catch (e) {
            console.error(`agt __spawn: cannot report to daemon: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      });
      return 0;
    }
    case "init": {
      const { values } = parse(argv.slice(1), { name: { type: "string" } });
      initProject(resolve(env.AGT_ROOT ?? cwd), values.name as string | undefined);
      console.log("initialized");
      return 0;
    }
    case "daemon":
      return daemon(sub, findRoot(cwd, env), env);
    case "config":
      console.log(stringify(loadConfig(findRoot(cwd, env), env)).trimEnd());
      return 0;
    case "start":
      return start(findRoot(cwd, env), env);
    case "thread":
      return thread(sub, rest, findRoot(cwd, env), env);
    case "ticket":
      return ticket(sub, rest, findRoot(cwd, env), env);
    case "log":
    case "decide": {
      const [threadId, ...words] = argv.slice(1);
      if (!threadId || !words.length) throw new UsageError(`${group} needs <thread> <message>`);
      return send(findRoot(cwd, env), env, { cmd: group, thread: threadId, message: words.join(" ") });
    }
    case "handoff": {
      const { values, positionals } = parse(argv.slice(1), { file: { type: "string" } });
      if (!positionals[0] || !values.file) throw new UsageError("handoff needs <thread> --file <path>");
      const content = readFileSync(resolve(cwd, values.file as string), "utf8");
      return send(findRoot(cwd, env), env, { cmd: "handoff", thread: positionals[0], content });
    }
    case "logs": {
      const { values } = parse(argv.slice(1), { follow: { type: "boolean", short: "f" } });
      return logs(findRoot(cwd, env), Boolean(values.follow));
    }
    default:
      throw new UsageError(group ? `unknown command '${group}'` : "");
  }
}

function parse(args: string[], options: ParseArgsConfig["options"]) {
  try {
    const { values, positionals } = parseArgs({ args, options, allowPositionals: true, strict: true });
    // Option names are dynamic here, so values are loosely typed.
    return { values: values as Record<string, any>, positionals };
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
}

async function send(root: string, env: Env, command: object): Promise<number> {
  const actor = actorFromEnv(env);
  const res = await request(paths(root).socket, { op: "command", command, actor });
  if (!res.ok) throw new Error(res.error);
  console.log(res.result === null ? "ok" : JSON.stringify(res.result));
  return 0;
}

async function thread(sub: string | undefined, args: string[], root: string, env: Env): Promise<number> {
  if (sub === "new") {
    const { values, positionals } = parse(args, {
      type: { type: "string" },
      goal: { type: "string" },
      criteria: { type: "string", multiple: true },
      depends: { type: "string", multiple: true },
    });
    if (!positionals.length || !values.type) throw new UsageError("thread new needs <title> --type <type>");
    return send(root, env, {
      cmd: "thread.new",
      title: positionals.join(" "),
      type: values.type,
      goal: values.goal ?? "",
      criteria: values.criteria ?? [],
      dependsOn: values.depends ?? [],
    });
  }
  if (sub === "status") {
    const { values, positionals } = parse(args, { reason: { type: "string" } });
    const [id, status] = positionals;
    if (!id || !status) throw new UsageError("thread status needs <id> <status>");
    return send(root, env, { cmd: "thread.status", thread: id, status, reason: values.reason });
  }
  throw new UsageError(`unknown thread subcommand '${sub ?? ""}'`);
}

async function ticket(sub: string | undefined, args: string[], root: string, env: Env): Promise<number> {
  switch (sub) {
    case "add": {
      const { values, positionals } = parse(args, { scope: { type: "string", multiple: true } });
      const [threadId, ...title] = positionals;
      if (!threadId || !title.length) throw new UsageError("ticket add needs <thread> <title> --scope <path>");
      return send(root, env, { cmd: "ticket.add", thread: threadId, title: title.join(" "), scope: values.scope ?? [] });
    }
    case "claim":
    case "reopen":
      return send(root, env, { cmd: `ticket.${sub}`, ...parseTicketRef(args[0]) });
    case "done": {
      const { values, positionals } = parse(args, { summary: { type: "string" } });
      return send(root, env, { cmd: "ticket.done", ...parseTicketRef(positionals[0]), summary: values.summary });
    }
    case "block": {
      const { values, positionals } = parse(args, { reason: { type: "string" } });
      const reason = values.reason;
      if (!reason) throw new UsageError("ticket block needs <thread>/<ticket> --reason <text>");
      return send(root, env, { cmd: "ticket.block", ...parseTicketRef(positionals[0]), reason });
    }
    default:
      throw new UsageError(`unknown ticket subcommand '${sub ?? ""}'`);
  }
}

async function ensureDaemon(root: string, env: Env): Promise<"started" | "running"> {
  const p = paths(root);
  if (await isAlive(p.socket)) return "running";
  // A new session (detached) keeps the daemon alive when the pane that started it goes away.
  const logFd = openSync(p.daemonLog, "a");
  try {
    spawn(process.execPath, [Bun.main, "daemon", "run"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...env, AGT_ROOT: root },
    }).unref();
  } catch {
    throw new Error("failed to launch daemon");
  } finally {
    closeSync(logFd);
  }
  for (let i = 0; i < 50; i++) {
    if (await isAlive(p.socket)) return "started";
    await Bun.sleep(100);
  }
  throw new Error(`daemon failed to start; see ${p.daemonLog}`);
}

async function start(root: string, env: Env): Promise<number> {
  const workspace = env.HERDR_WORKSPACE_ID;
  const mainTab = env.HERDR_TAB_ID;
  const managerPane = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== "1" || !workspace || !mainTab || !managerPane) throw new Error("agt start must run inside a Herdr pane");
  if (env.AGT_THREAD || env.AGT_ROLE === "coordinator" || env.AGT_ROLE === "worker") {
    throw new Error("agt start must run from the main tab, not a subthread pane");
  }
  const config = loadConfig(root, env);
  await ensureDaemon(root, env);
  const socket = paths(root).socket;
  const herdr = new HerdrCli({ bin: env.HERDR_BIN_PATH ?? "herdr", env });

  const current = await request(socket, { op: "layout.get" });
  if (!current.ok) throw new Error(current.error);
  const layout = current.result as Layout | null;
  if (layout && herdr.tabExists(layout.mainTab)) {
    console.log(`layout already set up (main tab ${layout.mainTab})`);
  } else {
    herdr.renameTab(mainTab, config.herdr.main_tab_label);
    herdr.renamePane(managerPane, "main manager");
    const loggerPane = herdr.splitPane({ pane: managerPane, direction: "right", cwd: root, env: { AGT_ROOT: root } });
    herdr.renamePane(loggerPane, "logger");
    herdr.runInPane(loggerPane, `${shellQuote(process.execPath)} ${shellQuote(Bun.main)} logs -f`);
    await commandOrThrow(socket, {
      cmd: "layout.register",
      workspace,
      mainTab,
      managerPane,
      loggerPane,
      herdrBin: herdr.bin,
      herdrSocket: env.HERDR_SOCKET_PATH,
    });
    console.log(`main tab ${mainTab}: main manager ${managerPane}, logger ${loggerPane}`);
  }

  const reconciled = (await commandOrThrow(socket, { cmd: "layout.reconcile" })) as { threads: number };
  console.log(`subthread tabs reconciled (${reconciled.threads} open threads)`);
  return 0;
}

/** `agt start` is a human bootstrap command, so its commands always run as the user. */
async function commandOrThrow(socket: string, command: object): Promise<unknown> {
  const res = await request(socket, { op: "command", command, actor: { role: "user" } });
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

async function daemon(sub: string | undefined, root: string, env: Env): Promise<number> {
  const p = paths(root);
  switch (sub) {
    case "run": {
      const d = await startDaemon(root);
      process.on("SIGTERM", () => void d.stop());
      process.on("SIGINT", () => void d.stop());
      await d.closed;
      return 0;
    }
    case "start": {
      console.log((await ensureDaemon(root, env)) === "running" ? "daemon already running" : "daemon started");
      return 0;
    }
    case "stop": {
      if (!(await isAlive(p.socket))) {
        console.log("daemon not running");
        return 0;
      }
      await request(p.socket, { op: "shutdown" });
      for (let i = 0; i < 50 && (await isAlive(p.socket)); i++) await Bun.sleep(100);
      if (await isAlive(p.socket)) throw new Error("daemon did not stop");
      console.log("daemon stopped");
      return 0;
    }
    case "status": {
      try {
        const res = await request(p.socket, { op: "ping" }, 1_000);
        if (res.ok) {
          console.log(`running (pid ${(res.result as { pid: number }).pid})`);
          return 0;
        }
      } catch {
        // fall through
      }
      console.log("not running");
      return 1;
    }
    default:
      throw new UsageError(`unknown daemon subcommand '${sub ?? ""}'`);
  }
}

async function logs(root: string, follow: boolean): Promise<number> {
  const socket = paths(root).socket;
  let seq = 0;
  while (true) {
    const res = await request(socket, { op: "events.since", seq });
    if (!res.ok) throw new Error(res.error);
    for (const e of res.result as StoredEvent[]) {
      const who = e.actor.session ? `${e.actor.role}:${e.actor.session}` : e.actor.role;
      console.log(`${e.seq} ${e.ts} ${e.type} ${e.thread ?? "-"} ${who}`);
      seq = e.seq;
    }
    if (!follow) return 0;
    await Bun.sleep(500);
  }
}
