import { spawn } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { HerdrError, shellQuote, type HerdrBridge, type PaneScreen } from "../herdr/bridge.ts";
import { adapterForHerdrKind } from "./adapters.ts";
import { AGT_BIN } from "./claude.ts";

export interface SpawnJob {
  root: string;
  herdrBin: string;
  herdrSocket?: string;
  session: string;
  name: string;
  kind: string;
  pane?: string;
  /**
   * With `pane`: the agent's own process env, exported in that pane's shell before the agent starts (Herdr starts the
   * agent from the pane's shell, and that pane's env is the tab's). A split carries it in `split.env` instead.
   */
  exportEnv?: Record<string, string>;
  /** The agent's working directory (a split's is also `split.cwd`): it decides whether agt answers a trust dialog. */
  cwd?: string;
  /** `fallbacks` are split from in order when `pane` is gone. */
  split?: { pane: string; fallbacks?: string[]; direction: "right" | "down"; cwd: string; env: Record<string, string> };
  args: string[];
  bootstrap: string;
}

export const encodeJob = (job: SpawnJob): string => Buffer.from(JSON.stringify(job)).toString("base64");
export const decodeJob = (s: string): SpawnJob => JSON.parse(Buffer.from(s, "base64").toString("utf8")) as SpawnJob;

/** The default report retry window, 20 × 500ms: well inside the minimum `session.spawn_timeout` (60s). */
const REPORT_ATTEMPTS = 20;
const REPORT_DELAY_MS = 500;

/** The report retry window, with AGT_SPAWN_REPORT_ATTEMPTS / AGT_SPAWN_REPORT_DELAY_MS overrides (tests keep it short). */
export function spawnReportRetry(env: Record<string, string | undefined>): { attempts: number; delayMs: number } {
  const int = (v: string | undefined, min: number, fallback: number) => {
    const n = v === undefined || v.trim() === "" ? NaN : Number(v);
    return Number.isInteger(n) && n >= min ? n : fallback;
  };
  return { attempts: int(env.AGT_SPAWN_REPORT_ATTEMPTS, 1, REPORT_ATTEMPTS), delayMs: int(env.AGT_SPAWN_REPORT_DELAY_MS, 0, REPORT_DELAY_MS) };
}

/** How many trust-dialog reads a spawn job makes (about 1s apart), with an AGT_SPAWN_TRUST_POLLS override (tests: 0). */
export function spawnTrustPolls(env: Record<string, string | undefined>): number {
  const v = env.AGT_SPAWN_TRUST_POLLS;
  const n = v === undefined || v.trim() === "" ? NaN : Number(v);
  return Number.isInteger(n) && n >= 0 ? n : TRUST_POLLS;
}

/**
 * Sends a spawn report, retrying while the daemon is down or shutting down (it may be restarting). Any other refusal is
 * final. Gives up quietly after `attempts`; the daemon's sweep then fails the session. Returns whether the report was
 * delivered and accepted.
 */
export async function reportWithRetry(
  send: () => Promise<{ ok: boolean; error?: string }>,
  o: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const attempts = o.attempts ?? REPORT_ATTEMPTS;
  const delayMs = o.delayMs ?? REPORT_DELAY_MS;
  for (let i = 1; i <= attempts; i++) {
    let error: string;
    try {
      const res = await send();
      if (res.ok) return true;
      error = res.error ?? "unknown error";
      if (error !== "daemon is shutting down") {
        console.error(`agt __spawn: ${error}`);
        return false;
      }
    } catch (e) {
      error = `cannot report to daemon: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (i === attempts) console.error(`agt __spawn: ${error}`);
    else await Bun.sleep(delayMs);
  }
  return false;
}

/** Runs in the `agt __spawn` child so the daemon never waits for an agent to boot. */
/** How often, every BUSY_RETRY_MS, an agent start is retried while the pane's shell is still starting (about 30s). */
const BUSY_RETRIES = 60;
const BUSY_RETRY_MS = 500;

export async function runSpawnJob(
  job: SpawnJob,
  deps: {
    herdr: HerdrBridge;
    report: (command: object) => Promise<boolean>;
    /** Without it, no trust dialog is answered. */
    screen?: PaneScreen;
    sleep?: (ms: number) => Promise<void>;
    log?: (message: string) => void;
    busyRetries?: number;
    /** Reads of the trust watch (default TRUST_POLLS); 0 turns it off. */
    trustPolls?: number;
  },
): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  let created: string | undefined;
  let attached: { pane: string; pending?: string };
  let trust: ReturnType<typeof watchTrust>;
  try {
    const pane = job.pane ?? (created = splitWithFallbacks(deps.herdr, job.split!));
    // A leading space keeps the line out of shell history (HISTCONTROL=ignorespace, zsh's HIST_IGNORE_SPACE).
    const exported = job.pane ? Object.entries(job.exportEnv ?? {}) : [];
    if (exported.length) deps.herdr.runInPane(pane, ` export ${exported.map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ")}`);
    const start = { name: job.name, kind: job.kind, pane, args: job.args };
    for (let attempt = 0; ; attempt++) {
      // The trust watch runs beside the start: Herdr's `agent start` waits for the agent to be ready, which a trust
      // dialog prevents, so the dialog must be answered while it waits. It goes on beside the bootstrap and the report,
      // never delaying them (a bootstrap the dialog blocks is queued for the agent's first idle as usual).
      trust ??= watchTrust(job, pane, deps.screen, deps.trustPolls ?? TRUST_POLLS, sleep, deps.log ?? ((m) => console.error(`agt __spawn: ${m}`)));
      try {
        if (deps.herdr.agentStartAsync) await deps.herdr.agentStartAsync(start);
        else deps.herdr.agentStart(start);
        trust?.launched();
        break;
      } catch (e) {
        // The agent is in the pane but waiting on a startup dialog (trust, MCP): it is started, just not ready yet.
        if (e instanceof HerdrError && e.code === "agent_not_ready") {
          trust?.launched();
          break;
        }
        // Real Herdr refuses a freshly split pane until its shell reaches the prompt. Nothing launched: the watch
        // starts again, with its whole length, on the attempt that does.
        if (e instanceof HerdrError && e.code === "agent_pane_busy" && attempt < (deps.busyRetries ?? BUSY_RETRIES)) {
          trust?.stop();
          trust = undefined;
          await sleep(BUSY_RETRY_MS);
          continue;
        }
        throw e;
      }
    }
    let pending: string | undefined;
    if (job.bootstrap) {
      try {
        deps.herdr.agentPrompt(job.name, job.bootstrap);
      } catch {
        pending = job.bootstrap; // the daemon queues it and delivers it at the agent's first idle
      }
    }
    attached = { pane, ...(pending ? { pending } : {}) };
  } catch (e) {
    trust?.stop();
    if (created) closeQuietly(deps.herdr, created);
    await deps.report({ cmd: "session.failed", session: job.session, reason: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (await deps.report({ cmd: "session.attached", session: job.session, ...attached })) {
    await trust?.done; // the job process outlives its report by the watch at most
    return;
  }
  trust?.stop();
  // The daemon refused the report (it failed the session: its spawn report was lost, and a replacement may be running),
  // or never got it (its sweep will fail the session). Either way nobody tracks this agent: stop it. Its pane is the
  // split this job made, or the thread root pane it was given (the daemon never hands a job main's pane).
  closeQuietly(deps.herdr, attached.pane);
  console.error(`agt __spawn: session ${job.session} was failed by the daemon; stopped its agent`);
}

/** The trust watch lasts about 60s: TRUST_POLLS reads, TRUST_POLL_MS apart. */
const TRUST_POLLS = 60;
const TRUST_POLL_MS = 1_000;
/** Between the keys of an answer, so the dialog has moved its cursor before `enter`. */
const TRUST_KEY_GAP_MS = 300;

/** Whether `cwd` is inside `<root>/.worktrees/`, the folders agt creates. Symlinks are resolved (macOS: /var). */
export function agtCreatedFolder(root: string, cwd: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const rel = relative(real(join(root, ".worktrees")), real(cwd));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
}

/**
 * Answers the agent's one-time folder-trust dialog, once, when its adapter has one and the agent runs in a folder agt
 * created. A non-git thread folder in a workspace does not inherit the trust the user gave the workspace root, so
 * without this every coordinator would stop at the dialog. The user's own folders are never answered for, and Claude's
 * config is never touched: agt answers the dialog on screen as the user would. Keys go only to an agent Herdr reports
 * `blocked` whose screen shows the whole dialog. Once Herdr has confirmed the launch (its start returned) and lists
 * the agent running (idle, working, done), the agent is past the dialog and the watch ends; before that such a status
 * may be the pane's previous agent. Until then, and on any error, it polls on until its end.
 */
function watchTrust(job: SpawnJob, pane: string, screen: PaneScreen | undefined, polls: number, sleep: (ms: number) => Promise<void>, log: (m: string) => void) {
  const prompt = adapterForHerdrKind(job.kind)?.trustPrompt;
  const cwd = job.cwd ?? job.split?.cwd;
  if (!screen || !prompt || polls === 0 || cwd === undefined || !agtCreatedFolder(job.root, cwd)) return undefined;
  let stopped = false;
  let launched = false;
  const done = (async () => {
    for (let i = 0; i < polls && !stopped; i++) {
      if (i > 0) await sleep(TRUST_POLL_MS);
      if (stopped) return;
      try {
        const status = (await screen.agentListAsync()).find((a) => a.pane === pane)?.status;
        if (launched && (status === "idle" || status === "working" || status === "done")) return;
        if (status !== "blocked") continue;
        const text = await screen.paneReadAsync(pane);
        if (!prompt.screen.every((re) => re.test(text))) continue;
        if (stopped) return; // stopped while reading: a busy retry's watch, a failed start or a refused report
        for (const [k, key] of prompt.keys.entries()) {
          if (k > 0) await sleep(TRUST_KEY_GAP_MS);
          await screen.paneSendKeysAsync(pane, key);
        }
        log(`trusted ${cwd} for Claude Code (a folder agt created)`);
        return;
      } catch {
        // the pane may be busy or gone; read again until the watch ends
      }
    }
  })();
  return { stop: () => void (stopped = true), launched: () => void (launched = true), done };
}

function closeQuietly(herdr: HerdrBridge, pane: string): void {
  try {
    herdr.closePane(pane);
  } catch {
    // best effort: the pane may already be gone
  }
}

function splitWithFallbacks(herdr: HerdrBridge, split: NonNullable<SpawnJob["split"]>): string {
  const { fallbacks = [], ...o } = split;
  const sources = [o.pane, ...fallbacks];
  for (let i = 0; ; i++) {
    try {
      return herdr.splitPane({ ...o, pane: sources[i]! });
    } catch (e) {
      if (!(e instanceof HerdrError && e.code === "pane_not_found") || i === sources.length - 1) throw e;
    }
  }
}

/**
 * `/bin/sh` argv that runs `argv` with stdout and stderr appended to `logFile`. The child opens the log itself: in
 * Bun 1.1.34 an fd passed in `stdio` is closed again when the ChildProcess is garbage-collected, so closing it after
 * spawn (as Node requires) makes a later GC close whatever reused that fd number, such as a daemon socket.
 */
export function loggedArgv(logFile: string, argv: string[]): [string, string[]] {
  return ["/bin/sh", ["-c", 'log=$1; shift; exec "$@" >>"$log" 2>&1', "agt-log", logFile, ...argv]];
}

export function launchSpawnJob(job: SpawnJob, opts: { logFile: string; spawn?: typeof spawn }): void {
  const [cmd, args] = loggedArgv(opts.logFile, [process.execPath, AGT_BIN, "__spawn", encodeJob(job)]);
  const child = (opts.spawn ?? spawn)(cmd, args, { stdio: "ignore", env: { ...process.env, AGT_ROOT: job.root } });
  // An async spawn error must never crash the daemon; log it instead.
  child.on("error", (e) => {
    try {
      appendFileSync(opts.logFile, `spawn job for session ${job.session} failed: ${e.message}\n`);
    } catch {
      // nothing left to report to
    }
  });
  child.unref();
}
