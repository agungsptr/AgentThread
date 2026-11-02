// Release e2e harness: real Herdr (an isolated named session per run), real agents, real models.
// Run through tests/release/run.ts only (bun run e2e:release); nothing here is part of `bun test`.
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { CLAUDE_TRUST_PROMPT, TRUST_TRIES, answerTrustDialog, isTrustDialog } from "../../src/agents/trust.ts";
import { deepMerge } from "../../src/config/config.ts";
import { request } from "../../src/daemon/client.ts";
import type { AgentKind, StoredEvent } from "../../src/domain/types.ts";
import { spawnAsync, type RunResult } from "../../src/herdr/bridge.ts";
import { paths } from "../../src/project/paths.ts";

export const REPO = resolve(import.meta.dir, "../..");
export const AGT = join(REPO, "bin", "agt");
export const FIXTURE = join(import.meta.dir, "fixture-repo");
export const FIXTURE_WORKSPACE = join(import.meta.dir, "fixture-workspace");
const HERDR_BIN = process.env.AGT_E2E_HERDR_BIN || Bun.which("herdr", { PATH: process.env.PATH ?? "" }) || "herdr";

/** The sockets of the user's own Herdr: the inherited one and the default session's. Never touched. */
const LIVE_SOCKETS = [process.env.HERDR_SOCKET_PATH, join(homedir(), ".config", "herdr", "herdr.sock")].filter(Boolean) as string[];
const SESSIONS_DIR = join(homedir(), ".config", "herdr", "sessions");

/**
 * The env of every process the harness starts: the parent's, minus Herdr's pane context (it would point at the user's
 * live session), AgentThread's role vars and Claude Code's own session vars (this may run inside Claude Code).
 */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(HERDR_|AGT_|CLAUDE_CODE_)/.test(k)) continue;
    if (k === "CLAUDECODE" || k === "CLAUDE_PID" || k === "CLAUDE_EFFORT") continue;
    if (k === "SSH_AUTH_SOCK" && v.includes("herdr")) continue; // the live session's agent forwarding socket
    out[k] = v;
  }
  return { ...out, ...extra };
}

/** Throws unless `socket` is an agt-e2e-* named session's socket, distinct from the user's live Herdr. */
export function assertIsolated(socket: string): void {
  const s = resolve(socket);
  if (LIVE_SOCKETS.some((l) => resolve(l) === s)) throw new Error(`refusing to use the live Herdr socket ${socket}`);
  if (!s.startsWith(join(SESSIONS_DIR, "agt-e2e-"))) throw new Error(`refusing a Herdr socket outside ${SESSIONS_DIR}/agt-e2e-*: ${socket}`);
}

export interface HerdrReply extends RunResult {
  result?: any;
  error?: { code: string; message: string };
}

/** Herdr CLI bound to one isolated server: every call carries its socket and none of the parent's Herdr env. */
export class Herdr {
  constructor(
    readonly session: string,
    readonly socket: string,
  ) {
    assertIsolated(socket);
  }

  env(extra: Record<string, string> = {}): Record<string, string> {
    return cleanEnv({ ...extra, HERDR_SOCKET_PATH: this.socket });
  }

  async run(args: string[], timeoutMs = 30_000): Promise<HerdrReply> {
    assertIsolated(this.socket);
    if (args[0] === "server" && args[1] === "stop") throw new Error("use HerdrServer.stop(), which names the session");
    const r = await spawnAsync(HERDR_BIN, args, this.env(), timeoutMs);
    const reply: HerdrReply = { ...r };
    try {
      if (r.stdout.trim()) reply.result = JSON.parse(r.stdout).result;
    } catch {}
    try {
      if (r.stderr.trim()) reply.error = JSON.parse(r.stderr).error;
    } catch {}
    return reply;
  }

  /** The JSON result of a call that must succeed. */
  async ok(args: string[], timeoutMs?: number): Promise<any> {
    const r = await this.run(args, timeoutMs);
    if (r.exitCode !== 0) throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed: ${r.error ? `${r.error.code}: ${r.error.message}` : r.stderr.trim()}`);
    return r.result;
  }

  async panes(): Promise<string[]> {
    return ((await this.ok(["pane", "list"])).panes as { pane_id: string }[]).map((p) => p.pane_id);
  }

  async agents(): Promise<{ pane_id: string; agent: string; agent_status: string; name?: string }[]> {
    return (await this.ok(["agent", "list"])).agents;
  }

  async read(pane: string, lines = 80): Promise<string> {
    const r = await this.run(["pane", "read", pane, "--source", "recent-unwrapped", "--lines", String(lines)]);
    return r.exitCode === 0 ? r.stdout : "";
  }
}

export interface HerdrServer {
  socket: string;
  session: string;
  herdr: Herdr;
  /** `herdr status server` of the isolated server: the socket line proves it is not the user's. */
  proof: string;
  stop(): Promise<void>;
}

let serverSerial = 0;

/** Every isolated server started and not yet stopped, so an interrupt (even during startHerdr) can stop them all. */
export const activeServers = new Map<string, () => Promise<void>>();

export async function stopAllServers(): Promise<void> {
  await Promise.all([...activeServers.values()].map((stop) => stop().catch(() => {})));
}

/** Runs an isolated headless Herdr server: `herdr --session agt-e2e-<pid>-<n> server`, its own socket. */
export async function startHerdr(name?: string): Promise<HerdrServer> {
  const session = name ?? `agt-e2e-${process.pid}-${++serverSerial}`;
  if (!session.startsWith("agt-e2e-")) throw new Error(`isolated session names start with agt-e2e-: ${session}`);
  const socket = join(SESSIONS_DIR, session, "herdr.sock");
  assertIsolated(socket);
  const herdr = new Herdr(session, socket);
  mkdirSync(join(REPO, ".agentthread", "e2e-reports"), { recursive: true });
  const log = join(REPO, ".agentthread", "e2e-reports", `${session}.herdr.log`);
  // The shell opens the log itself; the server is detached so a harness crash cannot take a pane with it unnoticed.
  const child = spawn("/bin/sh", ["-c", 'log=$1; shift; exec "$@" >>"$log" 2>&1', "herdr-e2e", log, HERDR_BIN, "--session", session, "server"], {
    detached: true,
    stdio: "ignore",
    env: cleanEnv(),
    cwd: tmpdir(),
  });
  child.unref();
  const pid = child.pid;
  // One stop per server, however many callers (the row's teardown, an interrupt) ask for it.
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= stopServer(session, pid, socket));
  activeServers.set(session, stop);
  let proof = "";
  for (let i = 0; i < 100; i++) {
    const r = await spawnAsync(HERDR_BIN, ["status", "server"], herdr.env(), 5_000);
    proof = r.stdout.trim();
    if (/^status: running$/m.test(proof)) break;
    await Bun.sleep(100);
  }
  const named = /^socket: (.*)$/m.exec(proof)?.[1]?.trim();
  if (!/^status: running$/m.test(proof) || !named || resolve(named) !== resolve(socket)) {
    await stop();
    throw new Error(`isolated Herdr server ${session} did not come up on ${socket}:\n${proof}`);
  }
  assertIsolated(named);
  return { socket, session, herdr, proof, stop };
}

async function stopServer(session: string, pid: number | undefined, socket: string): Promise<void> {
  if (!session.startsWith("agt-e2e-")) throw new Error(`refusing to stop ${session}`);
  assertIsolated(socket);
  // `session stop <name>` names the isolated session explicitly, and the env names its socket: the live one is never addressed.
  const env = cleanEnv({ HERDR_SOCKET_PATH: socket });
  await spawnAsync(HERDR_BIN, ["session", "stop", session], env, 15_000);
  if (pid) {
    for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(100);
    if (alive(pid)) process.kill(pid, "SIGTERM");
    for (let i = 0; i < 30 && alive(pid); i++) await Bun.sleep(100);
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
  await spawnAsync(HERDR_BIN, ["session", "delete", session], env, 15_000);
  activeServers.delete(session);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const TEMP_PREFIX = "agt-e2e-repo-";

/**
 * The fixed scratch root of `happy-mixed-main`: the user trusts it for Claude Code once (docs/release-e2e.md), and its
 * thread worktrees under `.worktrees/` inherit that trust. The path stays the same across runs; its contents do not.
 */
export const MIXED_MAIN_ROOT = join(homedir(), ".cache", "agt-e2e", "mixed-main");

/** The check a coordinator/worker trust dialog fails in the fixed-root row: what the user has to do once. */
export const MIXED_MAIN_TRUST = "trust the e2e folder once: cd ~/.cache/agt-e2e/mixed-main && claude, then accept the trust prompt and exit";

/** How the fixed scratch root is named in messages (the user's own spelling of it). */
const FIXED_LABEL = "~/.cache/agt-e2e/mixed-main";

/** Written into the fixed scratch root after every setup: a folder holding it was made by the harness. */
export const FIXED_MARKER = ".agt-e2e-fixed";

/** True only for exactly the fixed scratch root (as given or resolved), never for anything below or beside it. */
function isFixedScratch(dir: string): boolean {
  const r = resolve(dir);
  if (r === MIXED_MAIN_ROOT) return true;
  try {
    return existsSync(MIXED_MAIN_ROOT) && r === realpathSync(MIXED_MAIN_ROOT);
  } catch {
    return false;
  }
}

/**
 * Empties a fixed scratch root and keeps the directory itself (its path is what the user trusted). It deletes files,
 * so it refuses: a missing folder (the one-time trust step was not done), a symlink, and a folder holding anything but
 * the user's `git init` (`.git`) unless the harness marker shows a previous run made it.
 */
export function prepareFixedScratch(dir: string): void {
  if (!existsSync(dir) && !isSymlink(dir)) {
    throw new Error(`${FIXED_LABEL} does not exist; one time: mkdir -p ${FIXED_LABEL} && cd ${FIXED_LABEL} && git init && claude, then accept the trust prompt and exit`);
  }
  if (isSymlink(dir)) throw new Error(`${FIXED_LABEL} is a symlink; refusing to empty it`);
  const names = readdirSync(dir);
  if (!names.includes(FIXED_MARKER) && names.some((n) => n !== ".git")) throw new Error(`${FIXED_LABEL} has unexpected files; it must only be the e2e folder (remove its contents and re-run)`);
  for (const name of names) rmSync(join(dir, name), { recursive: true, force: true });
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * A git repo made from fixture-repo/, in a new temp dir or, with `at` (only MIXED_MAIN_ROOT), in that fixed dir after
 * emptying it; `hints` are appended to its AGENTS.md before the first commit.
 */
export async function scratchRepo(hints: string[] = [], at?: string): Promise<string> {
  let dir: string;
  if (at !== undefined) {
    if (resolve(at) !== MIXED_MAIN_ROOT) throw new Error(`a fixed scratch root must be ${MIXED_MAIN_ROOT}: ${at}`);
    prepareFixedScratch(at); // checked before realpath, so a symlink is refused rather than followed
    dir = realpathSync(at);
  } else dir = realpathSync(mkdtempSync(join(tmpdir(), TEMP_PREFIX)));
  cpSync(FIXTURE, dir, { recursive: true });
  // Template files keep their real name out of this repo's `bun test` patterns.
  const untemplate = (d: string) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name);
      if (f.isDirectory()) untemplate(p);
      else if (f.name.endsWith(".tmpl")) renameSync(p, p.slice(0, -".tmpl".length));
    }
  };
  untemplate(dir);
  if (hints.length) appendFileSync(join(dir, "AGENTS.md"), `\n${hints.map((h) => `- ${h}`).join("\n")}\n`);
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "e2e@agentthread.invalid"],
    ["config", "user.name", "AgentThread e2e"],
    ["add", "-A"],
    ["commit", "-q", "-m", "fixture"],
  ]) {
    const r = await spawnAsync("git", ["-C", dir, ...args], cleanEnv(), 15_000);
    if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed in ${dir}: ${r.stderr}`);
  }
  if (at !== undefined) {
    // Marks the folder as the harness's for the next run's emptying; excluded so no agent ever commits it.
    writeFileSync(join(dir, FIXED_MARKER), "made by tests/release/harness.ts; emptied at the start of every run\n");
    appendFileSync(join(dir, ".git", "info", "exclude"), `\n/${FIXED_MARKER}\n`);
  }
  return dir;
}

/** Throws unless `root` is inside the scratch base (the temp dir that holds every harness-made folder). */
export function assertInScratchBase(root: string): void {
  const base = realpathSync(tmpdir());
  const r = existsSync(root) ? realpathSync(root) : resolve(root);
  if (r === base || !r.startsWith(`${base}/`)) throw new Error(`${root} is outside the scratch base ${base}`);
}

/** Renames `*.tmpl` template files to their real name (they keep it out of this repo's `bun test` patterns). */
function untemplate(d: string): void {
  for (const f of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, f.name);
    if (f.isDirectory()) untemplate(p);
    else if (f.name.endsWith(".tmpl")) renameSync(p, p.slice(0, -".tmpl".length));
  }
}

const GIT_IDENTITY = [
  ["config", "user.email", "e2e@agentthread.invalid"],
  ["config", "user.name", "AgentThread e2e"],
];

/**
 * A two-repo workspace made from fixture-workspace/ in a new temp dir (or, for tests, the existing `into` dir): `api`
 * and `web` are git repos with one commit on `main`, `hints` are appended to each AGENTS.md before that commit, then
 * `agt init` creates `.docs` and the config lists both repos and the stack commands. Returns the root. The agt calls
 * read `xdg` as XDG_CONFIG_HOME (the row's config home); without it, a temporary one made like a row's, so the user's
 * own agentthread config never reaches the build.
 */
export async function scratchWorkspace(hints: { api?: string[]; web?: string[] } = {}, into?: string, xdg?: string): Promise<string> {
  if (into !== undefined) assertInScratchBase(into);
  const dir = into !== undefined ? realpathSync(into) : realpathSync(mkdtempSync(join(tmpdir(), TEMP_PREFIX)));
  assertInScratchBase(dir); // before any git
  cpSync(FIXTURE_WORKSPACE, dir, { recursive: true });
  untemplate(dir);
  const sh = async (cwd: string, args: string[]) => {
    const r = await spawnAsync("git", ["-C", cwd, ...args], cleanEnv(), 15_000);
    if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed in ${cwd}: ${r.stderr}`);
  };
  for (const repo of ["api", "web"] as const) {
    const at = join(dir, repo);
    const lines = hints[repo] ?? [];
    if (lines.length) appendFileSync(join(at, "AGENTS.md"), `\n${lines.map((h) => `- ${h}`).join("\n")}\n`);
    for (const args of [["init", "-q", "-b", "main"], ...GIT_IDENTITY, ["add", "-A"], ["commit", "-q", "-m", "fixture"]]) await sh(at, args);
  }
  writeConfig(
    dir,
    { main: "claude-code", coordinator: "claude-code", worker: "claude-code" },
    {
      workspace: {
        repos: Object.fromEntries(["api", "web"].map((r) => [r, { path: r, source_branch: "main", unit: "bun test", typecheck: "bun run typecheck" }])),
      },
      workflow: { stack: { restart: "make restart TASK={task}", status: "make status" } },
    },
  );
  const home = xdg ?? rowConfigHome();
  try {
    const init = await agt(dir, ["init"], { XDG_CONFIG_HOME: home });
    if (init.exitCode !== 0) throw new Error(`agt init failed in ${dir}: ${init.stderr.trim() || init.stdout.trim()}`);
  } finally {
    if (xdg === undefined) removeConfigHome(home);
  }
  return dir;
}

/** A workspace thread's task name and its repo worktrees (repo -> path), read from the event log. */
export async function wsTask(root: string, thread: string): Promise<{ task: string; worktrees: Record<string, string> }> {
  const all = await events(root);
  const created = all.find((e) => e.type === "thread.created" && e.thread === thread) as EventOf<"thread.created"> | undefined;
  if (!created?.payload.task) throw new Error(`no thread.created with a task for ${thread}`);
  const worktrees: Record<string, string> = {};
  for (const e of all) if (e.type === "worktree.added" && e.thread === thread) worktrees[e.payload.repo] = e.payload.path;
  return { task: created.payload.task, worktrees };
}

/** Runs the agt CLI as the user for `root`, outside any pane. */
const XDG_PREFIX = "agt-e2e-xdg-";

/**
 * A row's XDG_CONFIG_HOME: every entry of the user's ~/.config linked in (agents and git keep their config), except
 * agentthread, so the user's own ~/.config/agentthread/config.yaml never merges into a row's config.
 */
export function rowConfigHome(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), XDG_PREFIX)));
  try {
    const real = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    if (existsSync(real)) {
      for (const name of readdirSync(real)) if (name !== "agentthread") symlinkSync(join(real, name), join(dir, name));
    }
    return dir;
  } catch (e) {
    removeConfigHome(dir); // the caller never gets the path, so it could not remove it
    throw e;
  }
}

export function removeConfigHome(dir: string): void {
  if (!dir.includes(XDG_PREFIX)) throw new Error(`refusing to remove ${dir}`);
  rmSync(dir, { recursive: true, force: true }); // removes the links, never what they point at
}

export function agt(root: string, args: string[], env: Record<string, string> = {}, timeoutMs = 60_000): Promise<RunResult> {
  return spawnAsync(process.execPath, [AGT, ...args], cleanEnv({ AGT_ROOT: root, ...env }), timeoutMs);
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await spawnAsync("git", ["-C", cwd, ...args], cleanEnv(), 15_000);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** The project's events: from the daemon, else (daemon down) straight from its database. */
export async function events(root: string): Promise<StoredEvent[]> {
  try {
    const r = await request(paths(root).socket, { op: "events.since", seq: 0 }, 5_000);
    if (r.ok) return r.result as StoredEvent[];
  } catch {}
  const db = paths(root).db;
  if (!existsSync(db)) return [];
  try {
    const d = new Database(db, { readonly: true });
    try {
      const rows = d.query("SELECT seq, ts, type, thread, actor, payload FROM events ORDER BY seq").all() as {
        seq: number;
        ts: string;
        type: string;
        thread: string | null;
        actor: string;
        payload: string;
      }[];
      return rows.map((r) => ({ seq: r.seq, ts: r.ts, type: r.type, ...(r.thread ? { thread: r.thread } : {}), actor: JSON.parse(r.actor), payload: JSON.parse(r.payload) }) as StoredEvent);
    } finally {
      d.close();
    }
  } catch {
    return []; // the daemon holds it exclusively while it runs
  }
}

/** The stored event of type T; also for members whose `type` is a union (session.started | agent.idle | …). */
export type EventOf<T extends StoredEvent["type"]> = StoredEvent extends infer E ? (E extends { type: infer U } ? (T extends U ? E & { type: T } : never) : never) : never;

export class TimeoutError extends Error {}

/** Polls the event log until an event of `type` (or of any of several types) matches `pred`. */
export async function waitForEvent<T extends StoredEvent["type"]>(
  root: string,
  type: T | readonly T[],
  pred: (e: EventOf<T>, all: StoredEvent[]) => boolean = () => true,
  timeoutMs = 120_000,
  what = "",
): Promise<EventOf<T>> {
  const until = Date.now() + timeoutMs;
  const types: readonly string[] = Array.isArray(type) ? type : [type];
  let all: StoredEvent[] = [];
  for (;;) {
    all = await events(root);
    const hit = all.find((e) => types.includes(e.type) && pred(e as EventOf<T>, all));
    if (hit) return hit as EventOf<T>;
    if (Date.now() > until) break;
    await Bun.sleep(2_000);
  }
  const tail = all.slice(-12).map((e) => `${e.seq} ${e.type}${e.thread ? ` ${e.thread}` : ""}`).join(", ");
  throw new TimeoutError(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${types.join(" or ")}${what ? ` (${what})` : ""}; last events: ${tail}`);
}

/** Acts as the user typing into main's pane: `herdr agent prompt`. */
export async function say(herdr: Herdr, pane: string, text: string): Promise<void> {
  await herdr.ok(["agent", "prompt", pane, text]);
}

const TRUST = /trust this folder|Do you trust the files/i;

/** How long a coordinator/worker trust dialog may show before it fails the row: agt answers it first (Plan 13 Task 5). */
export const TRUST_GRACE_MS = 30_000;

/**
 * Answers Claude Code's one-time workspace-trust dialog in main's pane, as the user would once per project. In any
 * other pane (a coordinator or worker) agt answers it itself, for the folders it created: the harness never does, and
 * `foreign` is told once per pane when a dialog is still showing after `graceMs`, so the row fails instead of the
 * harness masking a product failure. A dialog gone for two polls in a row is noted as cleared (agt's own daemon log line
 * says what it trusted); one missed poll keeps the pane's grace clock, so a flickering read cannot reset it. Every other
 * dialog is left alone (a blocked worker is a scenario's subject). Returns the panes it answered.
 */
export function watchTrustDialogs(
  herdr: Pick<Herdr, "agents" | "run">,
  mainPane: () => string,
  log: (m: string) => void,
  foreign: (pane: string) => void,
  o: { graceMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): { stop(): void; answered: string[]; done: Promise<void> } {
  const graceMs = o.graceMs ?? TRUST_GRACE_MS;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const answered: string[] = [];
  const reported = new Set<string>();
  /** Main's panes whose dialog would not select "Yes": left to the user, never tried again. */
  const leftToUser = new Set<string>();
  /** Coordinator/worker panes showing the dialog, with when it was first seen. */
  const showing = new Map<string, number>();
  /** Panes of `showing` missing from the last poll: cleared when missing from two in a row. */
  const missed = new Set<string>();
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      try {
        const seen = new Set<string>();
        for (const a of await herdr.agents()) {
          if (a.agent !== "claude" || a.agent_status !== "blocked") continue;
          if (a.pane_id !== mainPane() && reported.has(a.pane_id)) continue;
          const screen = (await herdr.run(["pane", "read", a.pane_id, "--source", "visible"])).stdout;
          if (!TRUST.test(screen)) continue;
          if (a.pane_id !== mainPane()) {
            seen.add(a.pane_id);
            missed.delete(a.pane_id);
            const since = showing.get(a.pane_id) ?? now();
            showing.set(a.pane_id, since);
            if (now() - since < graceMs) continue;
            reported.add(a.pane_id);
            showing.delete(a.pane_id);
            foreign(a.pane_id);
            log(`the Claude Code workspace-trust dialog in ${a.pane_id} was still showing after ${Math.round(graceMs / 1000)}s: agt did not answer it`);
            continue;
          }
          if (leftToUser.has(a.pane_id) || !isTrustDialog(screen, CLAUDE_TRUST_PROMPT)) continue;
          // The dialog's cursor starts on "No, exit": `enter` goes only once "Yes, I trust this folder" is selected.
          if (await answerConfirmed(herdr, a.pane_id, screen, sleep, log)) answered.push(a.pane_id);
          else leftToUser.add(a.pane_id);
        }
        for (const pane of [...showing.keys()].filter((p) => !seen.has(p))) {
          if (!missed.has(pane)) {
            missed.add(pane);
            continue;
          }
          missed.delete(pane);
          showing.delete(pane);
          log(`Claude Code workspace-trust dialog cleared in ${pane}`);
        }
      } catch {}
      if (!stopped) await sleep(o.pollMs ?? 1_500);
    }
  })();
  return { stop: () => void (stopped = true), answered, done };
}

/** How much of each pane's screen a failed row keeps in its notes. */
export const SCREEN_LINES = 40;

/** How long a failed row's screen dump may take in all; each Herdr call gets what is left, at most 10s. */
export const SCREEN_DUMP_MS = 30_000;

/**
 * A failed or timed-out row's evidence, read before its Herdr server stops: every pane's visible screen (`pane read
 * <id> --source visible`), its last SCREEN_LINES lines, as one note per pane, within one deadline (`budgetMs`): the
 * panes left when it passes are named instead. Never throws; what cannot be read is noted.
 */
export async function dumpPaneScreens(
  herdr: Pick<Herdr, "run">,
  note: (m: string) => void,
  o: { budgetMs?: number; now?: () => number } = {},
): Promise<void> {
  const now = o.now ?? Date.now;
  const budgetMs = o.budgetMs ?? SCREEN_DUMP_MS;
  const until = now() + budgetMs;
  const left = () => Math.min(10_000, until - now());
  const why = (r: { stderr: string; error?: { message: string } }) => r.error?.message ?? r.stderr.trim();
  try {
    const list = await herdr.run(["pane", "list"], left());
    if (list.exitCode !== 0) return note(`pane screens: herdr pane list failed (${why(list)})`);
    const panes = ((list.result?.panes ?? []) as { pane_id: string }[]).map((p) => p.pane_id);
    for (const [i, pane] of panes.entries()) {
      if (left() <= 0) return note(`pane screens: stopped after ${Math.round(budgetMs / 1000)}s; not read: ${panes.slice(i).join(", ")}`);
      const r = await herdr.run(["pane", "read", pane, "--source", "visible"], left());
      if (r.exitCode !== 0) note(`screen of pane ${pane}: unreadable (${why(r)})`);
      else note(`screen of pane ${pane} (last ${SCREEN_LINES} lines):\n${r.stdout.split("\n").slice(-SCREEN_LINES).join("\n")}`);
    }
  } catch (e) {
    note(`pane screens: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The folders agt trusted for Claude Code, from its spawn jobs' lines in the daemon log (src/agents/spawn-job.ts). */
export function agtTrustedFolders(daemonLog: string): string[] {
  return [...daemonLog.matchAll(/trusted (.+) for Claude Code \(a folder agt created\)$/gm)].map((m) => m[1]!);
}

/**
 * Ends a row as soon as the trust watcher gives up on a coordinator/worker trust dialog (agt did not answer it within
 * the grace): nobody else will, so waiting on would only burn the row's timeout. `promise` never resolves; `fail` rejects it once.
 */
export function trustGate(): { promise: Promise<never>; fail(pane: string, check: string): void } {
  let reject!: (e: Error) => void;
  const promise = new Promise<never>((_, r) => (reject = r));
  promise.catch(() => {}); // it may fail before anyone races it
  return { promise, fail: (pane, check) => reject(new Error(`trust dialog in coordinator/worker pane ${pane}: ${check}`)) };
}

/** Runs a scenario against its deadline and the trust gate; whichever settles first decides. */
export async function raceScenario(run: Promise<unknown>, gate: Promise<never>, msLeft: number, timeoutMessage: string): Promise<void> {
  let timer: Timer | undefined;
  await Promise.race([run, gate, new Promise((_, reject) => (timer = setTimeout(() => reject(new TimeoutError(timeoutMessage)), msLeft)))]).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * Answers the trust dialog on `screen` in `pane` as agt's spawn job does (src/agents/trust.ts): `enter` only once the
 * screen shows "Yes, I trust this folder" selected, never while "No, exit" is. Gives up after TRUST_TRIES downs, logging
 * the screen and leaving the dialog to the user. Returns whether it answered.
 */
async function answerConfirmed(herdr: Pick<Herdr, "run">, pane: string, screen: string, sleep: (ms: number) => Promise<void>, log: (m: string) => void): Promise<boolean> {
  const io = {
    read: async () => (await herdr.run(["pane", "read", pane, "--source", "visible"])).stdout,
    send: async (key: string) => void (await herdr.run(["pane", "send-keys", pane, key])),
    sleep,
  };
  const r = await answerTrustDialog(io, CLAUDE_TRUST_PROMPT, screen);
  if (r.answered) log(`answered the Claude Code workspace-trust dialog in ${pane}`);
  else
    log(
      `the Claude Code workspace-trust dialog in ${pane} still had "No, exit" selected after ${TRUST_TRIES} downs; left it to the user. Its screen:\n${r.screen.split("\n").slice(-SCREEN_LINES).join("\n")}`,
    );
  return r.answered;
}

/** Main's pane may host a bare process Herdr has not recognized yet; the trust dialog there is found by screen. */
export async function answerTrustIn(
  herdr: Pick<Herdr, "run">,
  pane: string,
  timeoutMs: number,
  log: (m: string) => void,
  o: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const until = now() + timeoutMs;
  while (now() < until) {
    const screen = (await herdr.run(["pane", "read", pane, "--source", "visible"])).stdout;
    // The full dialog (its options too): a screen that only mentions trust is not answered.
    if (TRUST.test(screen) && isTrustDialog(screen, CLAUDE_TRUST_PROMPT)) return answerConfirmed(herdr, pane, screen, sleep, log);
    await sleep(1_000);
  }
  return false;
}

// ---------- agents, config ----------

export interface RoleAgents {
  main: AgentKind;
  coordinator: AgentKind;
  worker: AgentKind;
}

const ENV_KEY = (a: AgentKind) => a.toUpperCase().replace(/-/g, "_");

/** Model and effort for an agent from AGT_E2E_MODEL_<AGENT> / AGT_E2E_EFFORT_<AGENT>; unset means the agent's default. */
export function runFor(agent: AgentKind, effort?: string): { agent: AgentKind; model?: string; effort?: string } {
  const model = process.env[`AGT_E2E_MODEL_${ENV_KEY(agent)}`];
  const e = effort ?? process.env[`AGT_E2E_EFFORT_${ENV_KEY(agent)}`];
  return { agent, ...(model ? { model } : {}), ...(e ? { effort: e } : {}) };
}

/** Writes .agentthread/config.yaml for `agents`, deep-merged with `extra`. */
export function writeConfig(root: string, agents: RoleAgents, extra: Record<string, any> = {}): void {
  const base = {
    agents: {
      roles: { main: runFor(agents.main), coordinator: runFor(agents.coordinator), worker: runFor(agents.worker) },
      autonomous: true,
    },
  };
  mkdirSync(join(root, ".agentthread"), { recursive: true });
  writeFileSync(join(root, ".agentthread", "config.yaml"), stringify(deepMerge(base, extra)));
}

/**
 * Rewrites a scratch workspace's config for a row: its workspace and workflow sections are kept, the role agents are
 * the row's (replaced, never merged with the builder's), and `extra` is merged on top.
 */
export function writeWorkspaceConfig(root: string, agents: RoleAgents, extra: Record<string, any> = {}): void {
  const { agents: _builder, ...kept } = (parse(readFileSync(join(root, ".agentthread", "config.yaml"), "utf8")) ?? {}) as Record<string, any>;
  writeConfig(root, agents, deepMerge(kept, extra));
}

// ---------- cleanup ----------

/**
 * Stops the project's daemon and every leftover process of the run: spawn jobs of `root` and anything cwd'd in it.
 * Returns the leftover processes the cwd sweep had to kill (after Herdr stopped, any is a leak).
 */
export async function cleanupProcesses(root: string, log: (m: string) => void, o: { sweepCwd?: boolean } = {}): Promise<string[]> {
  const env = cleanEnv({ AGT_ROOT: root });
  try {
    const ping = await request(paths(root).socket, { op: "ping" }, 2_000);
    const pid = ping.ok ? (ping.result as { pid: number }).pid : undefined;
    await spawnAsync(process.execPath, [AGT, "daemon", "stop"], env, 15_000);
    if (pid && alive(pid)) {
      process.kill(pid, "SIGKILL");
      log(`killed daemon ${pid}`);
    }
  } catch {}
  // `agt __spawn <base64 job>`: the job names its root.
  const ps = await spawnAsync("ps", ["-axo", "pid=,command="], cleanEnv(), 10_000);
  for (const line of ps.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, cmd] = m;
    const job = /__spawn\s+(\S+)/.exec(cmd!)?.[1];
    if (!job) continue;
    try {
      if (JSON.parse(Buffer.from(job, "base64").toString("utf8")).root === root) {
        process.kill(Number(pid), "SIGKILL");
        log(`killed leftover spawn job ${pid}`);
      }
    } catch {}
  }
  if (o.sweepCwd === false) return [];
  // Any process whose cwd is inside the scratch repo (an agent the Herdr shutdown did not take down). Give the
  // processes Herdr's shutdown just signalled a moment to exit first.
  await Bun.sleep(1_500);
  const killed: string[] = [];
  const lsof = await spawnAsync("lsof", ["-a", "-d", "cwd", "-Fpn", "-u", String(process.getuid?.() ?? "")], cleanEnv(), 20_000);
  let pid = 0;
  for (const line of lsof.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && (line.slice(1) === root || line.slice(1).startsWith(`${root}/`)) && pid && pid !== process.pid) {
      try {
        const cmd = (await spawnAsync("ps", ["-o", "command=", "-p", String(pid)], cleanEnv(), 5_000)).stdout.trim();
        process.kill(pid, "SIGKILL");
        killed.push(`${pid} ${cmd.slice(0, 120)}`);
        log(`killed leftover process ${pid} (${cmd.slice(0, 120)}) in ${line.slice(1)}`);
      } catch {}
    }
  }
  return killed;
}

export function removeScratch(root: string): void {
  if (isFixedScratch(root)) return prepareFixedScratch(MIXED_MAIN_ROOT);
  if (!root.includes(TEMP_PREFIX)) throw new Error(`refusing to remove ${root}`);
  rmSync(root, { recursive: true, force: true });
}

// ---------- reports ----------

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface RowResult {
  id: string;
  agents: RoleAgents;
  status: "PASS" | "FAIL" | "SKIPPED";
  reason?: string;
  durationS: number;
  checks: Check[];
  notes: string[];
  herdrSession?: string;
  herdrSocket?: string;
  scratch?: string;
}

const REPORT_DIR = join(REPO, ".agentthread", "e2e-reports");
export const RUN_ISO = new Date().toISOString().replace(/[:.]/g, "-");

/** Appends a row to .agentthread/e2e-reports/<iso>.md and .json in this repo (kept out of git by its own .gitignore). */
export function report(scenario: { id: string; agents: RoleAgents }, result: Omit<RowResult, "id" | "agents">): string {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, ".gitignore"), "*\n");
  const row: RowResult = { id: scenario.id, agents: scenario.agents, ...result };
  const json = join(REPORT_DIR, `${RUN_ISO}.json`);
  const rows: RowResult[] = existsSync(json) ? JSON.parse(readFileSync(json, "utf8")) : [];
  rows.push(row);
  writeFileSync(json, `${JSON.stringify(rows, null, 2)}\n`);
  const md = join(REPORT_DIR, `${RUN_ISO}.md`);
  if (!existsSync(md)) {
    writeFileSync(md, `# Release e2e ${RUN_ISO}\n\n| scenario | main | coordinator | worker | result | time | detail |\n|---|---|---|---|---|---|---|\n`);
  }
  const failed = row.checks.filter((c) => !c.ok).map((c) => `${c.name}${c.detail ? `: ${c.detail}` : ""}`);
  const detail = [row.reason, ...failed].filter(Boolean).join("; ").replace(/\|/g, "\\|").replace(/\n/g, " ");
  appendFileSync(md, `| ${row.id} | ${row.agents.main} | ${row.agents.coordinator} | ${row.agents.worker} | ${row.status}${row.status === "SKIPPED" && row.reason ? ` (${row.reason})` : ""} | ${row.durationS}s | ${detail} |\n`);
  return md;
}

/** True when `p` is a symlink whose target is `target`. */
export function isSymlinkTo(p: string, target: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink() && readlinkSync(p) === target;
  } catch {
    return false;
  }
}
