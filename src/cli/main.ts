import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { stringify } from "yaml";
import { agentEnv } from "../agents/claude.ts";
import { adapterFor } from "../agents/adapters.ts";
import { roleAgent } from "../agents/roles.ts";
import { systemPrompt } from "../agents/prompts.ts";
import { decodeJob, loggedArgv, runSpawnJob } from "../agents/spawn-job.ts";
import { contextTokensFromTranscript } from "../agents/transcript.ts";
import { isAlive, request } from "../daemon/client.ts";
import { startDaemon } from "../daemon/server.ts";
import { loadConfig } from "../config/config.ts";
import { ROLES, SESSION_SIGNALS, type Actor, type Layout, type StoredEvent } from "../domain/types.ts";
import { HerdrCli, shellQuote } from "../herdr/bridge.ts";
import { initProject } from "../project/init.ts";
import { paths } from "../project/paths.ts";
import { findRoot } from "../project/root.ts";

type Env = Record<string, string | undefined>;

const USAGE = `usage: agt <command>

  init [--name <name>]
  start [--no-manager]       set up the Herdr layout and run the main manager (inside a Herdr pane)
  daemon start|stop|status
  config
  thread new <title...> --type feature|bug|chore [--goal <text>] [--criteria <text>]... [--depends <id>]... [--max-workers <n>]
  thread status <id> <status> [--reason <text>]
  ticket add <thread> <title...> --scope <path> [--scope <path>]...
  ticket claim|reopen <thread>/<ticket>
  ticket done <thread>/<ticket> --summary <text>
  ticket block <thread>/<ticket> --reason <text>
  log <thread> <message...>
  decide <thread> <message...>
  note <thread> <message...>
  progress <thread> <message...>
  question <thread> <message...>
  handoff <thread> (--file <path> | --stdin)
  worker spawn <thread> --ticket <T>
  tell <thread|main> <message...>
  event started|active|idle|compacting|ended   (used by Claude Code hooks)
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
      return start(findRoot(cwd, env), env, argv.slice(1));
    case "thread":
      return thread(sub, rest, findRoot(cwd, env), env);
    case "ticket":
      return ticket(sub, rest, findRoot(cwd, env), env);
    case "log":
    case "decide":
    case "note":
    case "progress":
    case "question": {
      const [threadId, ...words] = argv.slice(1);
      if (!threadId || !words.length) throw new UsageError(`${group} needs <thread> <message>`);
      return send(findRoot(cwd, env), env, { cmd: group, thread: threadId, message: words.join(" ") });
    }
    case "handoff": {
      const { values, positionals } = parse(argv.slice(1), { file: { type: "string" }, stdin: { type: "boolean" } });
      if (!positionals[0] || Boolean(values.file) === Boolean(values.stdin)) throw new UsageError("handoff needs <thread> and exactly one of --file <path> or --stdin");
      const content = values.stdin ? await Bun.stdin.text() : readFileSync(resolve(cwd, values.file as string), "utf8");
      return send(findRoot(cwd, env), env, { cmd: "handoff", thread: positionals[0], content });
    }
    case "worker": {
      if (sub !== "spawn") throw new UsageError(`unknown worker subcommand '${sub ?? ""}'`);
      const { values, positionals } = parse(rest, { ticket: { type: "string" } });
      if (!positionals[0] || !values.ticket) throw new UsageError("worker spawn needs <thread> --ticket <T>");
      return send(findRoot(cwd, env), env, { cmd: "worker.spawn", thread: positionals[0], ticket: values.ticket });
    }
    case "tell": {
      const [target, ...words] = argv.slice(1);
      if (!target || !words.length) throw new UsageError("tell needs <thread|main> <message>");
      return send(findRoot(cwd, env), env, { cmd: "tell", target, message: words.join(" ") });
    }
    case "event":
      return hookEvent(sub, env, cwd);
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
      "max-workers": { type: "string" },
    });
    if (!positionals.length || !values.type) throw new UsageError("thread new needs <title> --type <type>");
    let maxWorkers: number | undefined;
    if (values["max-workers"] !== undefined) {
      maxWorkers = Number(values["max-workers"]);
      if (!Number.isInteger(maxWorkers)) throw new UsageError("--max-workers must be an integer");
    }
    return send(root, env, {
      cmd: "thread.new",
      title: positionals.join(" "),
      type: values.type,
      goal: values.goal ?? "",
      criteria: values.criteria ?? [],
      dependsOn: values.depends ?? [],
      maxWorkers,
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
      if (!values.summary) throw new UsageError("ticket done needs <thread>/<ticket> --summary <text>");
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
  // A new session (detached) keeps the daemon alive when the pane that started it goes away. The shell opens the
  // log in the child (see loggedArgv): no fd of ours is handed over.
  const [cmd, args] = loggedArgv(p.daemonLog, [process.execPath, Bun.main, "daemon", "run"]);
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore", env: { ...env, AGT_ROOT: root } }).unref();
  } catch {
    throw new Error("failed to launch daemon");
  }
  for (let i = 0; i < 50; i++) {
    if (await isAlive(p.socket)) return "started";
    await Bun.sleep(100);
  }
  throw new Error(`daemon failed to start; see ${p.daemonLog}`);
}

async function start(root: string, env: Env, argv: string[]): Promise<number> {
  const { values } = parse(argv, { "no-manager": { type: "boolean" } });
  const workspace = env.HERDR_WORKSPACE_ID;
  const mainTab = env.HERDR_TAB_ID;
  const managerPane = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== "1" || !workspace || !mainTab || !managerPane) throw new Error("agt start must run inside a Herdr pane");
  // An agent pane (including the main manager's own Claude session) must never start another layout or main manager.
  if (env.AGT_THREAD || env.AGT_ROLE === "coordinator" || env.AGT_ROLE === "worker" || env.AGT_ROLE === "main") {
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

  if (values["no-manager"]) return 0;
  const session = randomUUID();
  await commandOrThrow(socket, { cmd: "session.open_main", session, pane: managerPane });
  console.log(`main manager session ${session}`);
  const bin = env.AGT_CLAUDE_BIN ?? "claude";
  let code: number;
  try {
    const launched = adapterFor(config.agents.main_manager).launch({ role: "main", run: roleAgent(config, "main"), config, root });
    const proc = Bun.spawn([bin, ...launched.args, systemPrompt({ root, role: "main" })], {
      stdio: ["inherit", "inherit", "inherit"],
      cwd: root,
      env: { ...env, ...launched.env, ...agentEnv({ root, role: "main", session }) },
    });
    code = await proc.exited;
  } catch (e) {
    await endMainSession(socket, session);
    throw new Error(`cannot start Claude Code (${bin}): ${e instanceof Error ? e.message : String(e)}`);
  }
  await endMainSession(socket, session);
  return code;
}

async function endMainSession(socket: string, session: string): Promise<void> {
  try {
    await request(socket, { op: "command", command: { cmd: "session.signal", session, signal: "ended" }, actor: { role: "user" } }, 3_000);
  } catch {
    // the SessionEnd hook normally reports this already
  }
}

/** Runs inside Claude Code hooks: it must never fail or hang the agent, so every problem is reported and swallowed. */
async function hookEvent(signal: string | undefined, env: Env, cwd: string): Promise<number> {
  try {
    if (!signal || !(SESSION_SIGNALS as readonly string[]).includes(signal)) throw new Error(`unknown signal '${signal ?? ""}'`);
    // A hook runner may leave stdin open; never wait on it for long.
    const input = process.stdin.isTTY ? "" : ((await Promise.race([Bun.stdin.text(), Bun.sleep(1_500).then(() => "")])) as string).trim();
    const session = env.AGT_SESSION;
    let transcript: unknown;
    let source: unknown;
    if (input) {
      const parsed = JSON.parse(input) as { transcript_path?: unknown; source?: unknown };
      transcript = parsed.transcript_path;
      source = parsed.source;
    }
    // Claude Code adds SessionStart hook stdout to the context: after /clear or a compaction the main manager would
    // otherwise lose its role, which it only gets as its first message.
    if (signal === "started" && env.AGT_ROLE === "main" && (source === "clear" || source === "compact")) {
      console.log(systemPrompt({ root: findRoot(cwd, env), role: "main" }));
    }
    // The vendor's own session_id is never ours; identify by AGT_SESSION, else by the Herdr pane.
    const pane = env.HERDR_PANE_ID;
    if (!session && !pane) throw new Error("no session (AGT_SESSION or HERDR_PANE_ID)");
    const contextTokens = signal === "idle" && typeof transcript === "string" ? contextTokensFromTranscript(transcript) : undefined;
    const command = {
      cmd: "session.signal",
      ...(session ? { session } : { pane }),
      signal,
      ...(contextTokens !== undefined ? { contextTokens } : {}),
      ...(signal === "started" && typeof source === "string" ? { source: source.slice(0, 32) } : {}),
    };
    const res = await request(paths(findRoot(cwd, env)).socket, { op: "command", command, actor: actorFromEnv(env) }, 3_000);
    if (!res.ok) throw new Error(res.error);
  } catch (e) {
    console.error(`agt event: ${e instanceof Error ? e.message : String(e)}`);
  }
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
