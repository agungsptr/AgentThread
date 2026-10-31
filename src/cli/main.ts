import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { stringify } from "yaml";
import { agentEnv } from "../agents/claude.ts";
import { adapterFor, agentBin } from "../agents/adapters.ts";
import { configWarnings, installWarnings, roleAgent, trustWarning } from "../agents/roles.ts";
import { systemPrompt } from "../agents/prompts.ts";
import { decodeJob, loggedArgv, reportWithRetry, runSpawnJob, spawnReportRetry } from "../agents/spawn-job.ts";
import { contextTokensFromTranscript } from "../agents/transcript.ts";
import { isAlive, request } from "../daemon/client.ts";
import { startDaemon } from "../daemon/server.ts";
import { configHash, DEFAULT_CONFIG, loadConfig } from "../config/config.ts";
import { AGENT_KINDS, ROLES, SESSION_SIGNALS, STAGE_STATES, type Actor, type SessionRole, type AgentKind, type Layout, type StoredEvent } from "../domain/types.ts";
import { HerdrCli, shellQuote } from "../herdr/bridge.ts";
import { refreshRootSkill } from "../agents/skill.ts";
import { initCommand, setupIfNeeded, setupOnTty } from "../project/setup.ts";
import { paths } from "../project/paths.ts";
import { findRoot } from "../project/root.ts";
import type { State } from "../state/projection.ts";
import { USAGE } from "./usage.ts";
import { guide, isLegacyThread } from "../agents/guide.ts";

type Env = Record<string, string | undefined>;

const GUIDE_ROLES = ["main", "coordinator", "worker"] as const;

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
      const retry = spawnReportRetry(process.env);
      await runSpawnJob(job, {
        herdr,
        report: (command) => reportWithRetry(() => request(socket, { op: "command", command, actor: { role: "user" } }), retry),
      });
      return 0;
    }
    case "init": {
      const { values } = parse(argv.slice(1), { name: { type: "string" } });
      const initRoot = resolve(env.AGT_ROOT ?? cwd);
      return initCommand(initRoot, env, values.name as string | undefined);
    }
    case "setup": {
      if (!process.stdin.isTTY) throw new UsageError("agt setup needs a terminal; edit .agentthread/config.yaml instead");
      const setupRoot = findRoot(cwd, env);
      await setupOnTty(setupRoot, env);
      refreshRootSkill(setupRoot, env);
      console.log("saved .agentthread/config.yaml");
      if (await isAlive(paths(setupRoot).socket)) console.log("run agt start to apply the new config");
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
    case "stage": {
      const { values, positionals } = parse(argv.slice(1), { reason: { type: "string" }, by: { type: "string" } });
      const [threadId, stage, state] = positionals;
      if (!threadId || !stage || !state || positionals.length > 3) throw new UsageError("stage needs <thread> <1-10> done|skipped|na|approve");
      if (!/^\d+$/.test(stage)) throw new UsageError(`stage must be a number 1-10, got '${stage}'`);
      if (!(STAGE_STATES as readonly string[]).includes(state)) throw new UsageError(`stage state must be one of ${STAGE_STATES.join(", ")}`);
      if (values.by !== undefined && values.by !== "user") throw new UsageError("--by must be user");
      return send(findRoot(cwd, env), env, {
        cmd: "stage", thread: threadId, stage: Number(stage), state,
        ...(values.reason !== undefined ? { reason: values.reason } : {}),
        ...(values.by ? { by: values.by } : {}),
      });
    }
    case "stack": {
      const stackRoot = findRoot(cwd, env);
      if (sub === "status") {
        if (rest.length) throw new UsageError("stack status takes no arguments");
        const res = await request(paths(stackRoot).socket, { op: "command", command: { cmd: "stack.status" }, actor: actorFromEnv(env) });
        if (!res.ok) throw new Error(res.error);
        const { holder, queue } = res.result as State["stack"];
        console.log(holder ? `holder: thread ${holder.thread}${holder.purpose ? ` for ${holder.purpose}` : ""}, since ${holder.since}` : "holder: none (the stack is free)");
        console.log(queue.length ? `queue: ${queue.map((q) => `${q.thread}${q.purpose ? ` (${q.purpose})` : ""}`).join(", ")}` : "queue: empty");
        return 0;
      }
      if (sub !== "acquire" && sub !== "release") throw new UsageError(`unknown stack subcommand '${sub ?? ""}'`);
      const { values, positionals } = parse(rest, { for: { type: "string" } });
      if (positionals.length !== 1) throw new UsageError(`stack ${sub} needs <thread>`);
      if (values.for !== undefined && (sub !== "acquire" || values.for !== "e2e4")) throw new UsageError("--for is only e2e4, and only for stack acquire");
      return send(stackRoot, env, { cmd: `stack.${sub}`, thread: positionals[0], ...(values.for ? { for: values.for } : {}) });
    }
    case "log":
    case "decide":
    case "note":
    case "progress":
    case "question": {
      const [threadId, ...words] = argv.slice(1);
      if (!threadId || !words.length) throw new UsageError(`${group} needs <thread> <message>`);
      return send(findRoot(cwd, env), env, { cmd: group, thread: threadId, message: words.join(" ") });
    }
    case "answer": {
      const [threadId, question, ...words] = argv.slice(1);
      if (!threadId || !question || !words.length) throw new UsageError('answer needs <thread> <Q> "<text>"');
      return send(findRoot(cwd, env), env, { cmd: "answer", thread: threadId, question, message: words.join(" ") });
    }
    case "handoff": {
      const { values, positionals } = parse(argv.slice(1), { file: { type: "string" }, stdin: { type: "boolean" } });
      if (!positionals[0] || Boolean(values.file) === Boolean(values.stdin)) throw new UsageError("handoff needs <thread> and exactly one of --file <path> or --stdin");
      const content = values.stdin ? await Bun.stdin.text() : readFileSync(resolve(cwd, values.file as string), "utf8");
      return send(findRoot(cwd, env), env, { cmd: "handoff", thread: positionals[0], content });
    }
    case "worker": {
      if (sub !== "spawn") throw new UsageError(`unknown worker subcommand '${sub ?? ""}'`);
      const { values, positionals } = parse(rest, { ticket: { type: "string" }, agent: { type: "string" } });
      if (!positionals[0] || !values.ticket) throw new UsageError("worker spawn needs <thread> --ticket <T>");
      if (values.agent !== undefined && !(AGENT_KINDS as readonly string[]).includes(values.agent)) {
        throw new UsageError(`--agent must be one of ${AGENT_KINDS.join(", ")}`);
      }
      return send(findRoot(cwd, env), env, { cmd: "worker.spawn", thread: positionals[0], ticket: values.ticket, ...(values.agent ? { agent: values.agent } : {}) });
    }
    case "worktree": {
      if (sub !== "add") throw new UsageError(`unknown worktree subcommand '${sub ?? ""}'`);
      const { values, positionals } = parse(rest, { from: { type: "string" } });
      if (!positionals[0] || !positionals[1] || positionals.length > 2) throw new UsageError("worktree add needs <thread> <repo> [--from <branch>]");
      const command = { cmd: "worktree.add", thread: positionals[0], repo: positionals[1], ...(values.from ? { from: values.from } : {}) };
      const res = await request(paths(findRoot(cwd, env)).socket, { op: "command", command, actor: actorFromEnv(env) });
      if (!res.ok) throw new Error(res.error);
      // Only a live coordinator gets the ready or failed notice; anyone else looks it up.
      console.log(
        env.AGT_ROLE === "coordinator"
          ? `requested worktree for ${positionals[1]}; you will get a notice when it is ready`
          : `requested worktree for ${positionals[1]}; check agt logs or the thread brief`,
      );
      return 0;
    }
    case "guide": {
      const role = sub ?? (env.AGT_ROLE && (GUIDE_ROLES as readonly string[]).includes(env.AGT_ROLE) ? env.AGT_ROLE : "all");
      if (!(GUIDE_ROLES as readonly string[]).includes(role) && role !== "all") throw new UsageError(`unknown role '${role}' (main, coordinator, worker or all)`);
      let root = resolve(cwd);
      let config = DEFAULT_CONFIG;
      let inProject = false;
      try {
        root = findRoot(cwd, env);
        inProject = true;
      } catch {}
      if (inProject) {
        try {
          config = loadConfig(root, env);
        } catch (e) {
          console.error(`agt: warning: ${e instanceof Error ? e.message : String(e)}; showing the default guide`);
        }
      }
      const legacy = inProject && env.AGT_THREAD ? isLegacyThread(root, env.AGT_THREAD) : false;
      console.log(guide({ role: role as SessionRole | "all", root, config, ...(legacy ? { legacy } : {}) }));
      return 0;
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
      task: { type: "string" },
      tier: { type: "string" },
      reason: { type: "string" },
      now: { type: "boolean" },
    });
    if (!positionals.length || !values.type) throw new UsageError("thread new needs <title> --type <type>");
    if (values.tier !== undefined && !values.reason) throw new UsageError('--tier needs --reason "<why>"');
    if (values.reason !== undefined && values.tier === undefined) throw new UsageError("--reason needs --tier");
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
      ...(values.task !== undefined ? { task: values.task } : {}),
      ...(values.tier !== undefined ? { tier: values.tier } : {}),
      ...(values.reason !== undefined ? { reason: values.reason } : {}),
      ...(values.now ? { now: true } : {}),
    });
  }
  if (sub === "choose") {
    const { values, positionals } = parse(args, { tier: { type: "string" } });
    if (!positionals[0] || !values.tier) throw new UsageError("thread choose needs <id> --tier <name>");
    return send(root, env, { cmd: "thread.choose", thread: positionals[0], tier: values.tier });
  }
  if (sub === "cancel") {
    if (!args[0] || args.length > 1) throw new UsageError("thread cancel needs <id>");
    return send(root, env, { cmd: "thread.cancel", thread: args[0] });
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
      const { values, positionals } = parse(args, {
        scope: { type: "string", multiple: true },
        repo: { type: "string" },
        file: { type: "string", multiple: true },
        doc: { type: "string" },
      });
      const [threadId, ...title] = positionals;
      if (!threadId || !title.length) throw new UsageError("ticket add needs <thread> <title> --scope <path> (or --repo <repo> --file <path>)");
      return send(root, env, {
        cmd: "ticket.add",
        thread: threadId,
        title: title.join(" "),
        scope: values.scope ?? [],
        ...(values.repo !== undefined ? { repo: values.repo } : {}),
        ...(values.file ? { files: values.file } : {}),
        ...(values.doc !== undefined ? { doc: values.doc } : {}),
      });
    }
    case "files": {
      const res = await request(paths(root).socket, { op: "command", command: { cmd: "ticket.files", ...parseTicketRef(args[0]) }, actor: actorFromEnv(env) });
      if (!res.ok) throw new Error(res.error);
      for (const f of (res.result as { files: string[] }).files) console.log(f);
      return 0;
    }
    case "claim":
    case "reopen":
    case "accept":
      return send(root, env, { cmd: `ticket.${sub}`, ...parseTicketRef(args[0]) });
    case "return": {
      const [ref, ...note] = args;
      if (!note.join(" ").trim()) throw new UsageError('ticket return needs <thread>/<ticket> "<what to fix>"');
      return send(root, env, { cmd: "ticket.return", ...parseTicketRef(ref), note: note.join(" ") });
    }
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

/** The running daemon's config hash, or undefined when it does not answer or predates the hash. */
async function daemonConfigHash(socket: string): Promise<string | undefined> {
  try {
    const res = await request(socket, { op: "ping" }, 1_000);
    return res.ok ? (res.result as { configHash?: string }).configHash : undefined;
  } catch {
    return undefined;
  }
}

async function stopDaemon(socket: string): Promise<void> {
  await request(socket, { op: "shutdown" });
  for (let i = 0; i < 50 && (await isAlive(socket)); i++) await Bun.sleep(100);
  if (await isAlive(socket)) throw new Error("daemon did not stop");
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
  await setupIfNeeded(root, env);
  refreshRootSkill(root, env);
  const config = loadConfig(root, env);
  const warnings = [
    ...configWarnings(config),
    ...installWarnings(config, Bun.which, env),
    ...[trustWarning(config, root)].filter((w) => w !== undefined),
  ];
  for (const w of warnings) console.error(`agt: warning: ${w}`);
  const socket = paths(root).socket;
  // The daemon reads the config only when it starts: one running with an older config (agt setup, an edit) is
  // replaced. Its state lives in the event log, so a restart loses nothing.
  if ((await ensureDaemon(root, env)) === "running" && (await daemonConfigHash(socket)) !== configHash(config)) {
    await stopDaemon(socket);
    await ensureDaemon(root, env);
    console.log("config changed; restarted the daemon");
  }
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
  const run = roleAgent(config, "main");
  const adapter = adapterFor(run.agent);
  const bin = agentBin(run.agent, env);
  let code: number;
  try {
    const launched = adapter.launch({ role: "main", run, config, root, ...gitCommonDir(root) });
    const proc = Bun.spawn([bin, ...launched.args, ...adapter.promptArgs(systemPrompt({ root, role: "main", config }))], {
      stdio: ["inherit", "inherit", "inherit"],
      cwd: root,
      env: { ...env, ...launched.env, ...agentEnv({ root, role: "main", agent: run.agent, session }), ...launched.processEnv },
    });
    code = await proc.exited;
  } catch (e) {
    await endMainSession(socket, session);
    throw new Error(`cannot start ${AGENT_NAMES[run.agent]} (${bin}): ${e instanceof Error ? e.message : String(e)}`);
  }
  await endMainSession(socket, session);
  return code;
}

const AGENT_NAMES: Record<AgentKind, string> = { "claude-code": "Claude Code", opencode: "OpenCode", codex: "Codex", omp: "omp" };

/** `{ gitCommonDir }` for an agent launched in `root`, or nothing when git cannot tell (the adapter falls back to <root>/.git). */
function gitCommonDir(root: string): { gitCommonDir?: string } {
  const r = Bun.spawnSync(["git", "-C", root, "rev-parse", "--git-common-dir"], { stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString().trim();
  return r.exitCode === 0 && out ? { gitCommonDir: resolve(root, out) } : {};
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
    // Only Claude Code has this hook; a session without AGT_AGENT predates it and is Claude Code.
    if (signal === "started" && env.AGT_ROLE === "main" && (env.AGT_AGENT ?? "claude-code") === "claude-code" && (source === "clear" || source === "compact")) {
      const root = findRoot(cwd, env);
      let config;
      try {
        config = loadConfig(root, env);
      } catch {
        // a broken config must not cost main its role; the tier lines are left out
      }
      console.log(systemPrompt({ root, role: "main", config }));
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
      await stopDaemon(p.socket);
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
