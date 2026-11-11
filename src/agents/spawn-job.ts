import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { HerdrError, shellQuote, type HerdrBridge, type PaneLayout, type PaneScreen } from "../herdr/bridge.ts";
import { adapterForHerdrKind } from "./adapters.ts";
import { AGT_BIN } from "./claude.ts";
import { TRUST_TRIES, answerTrustDialog, isTrustDialog, trustDialogLive, trustDialogMaybe, typingUnsafe } from "./trust.ts";

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
  /**
   * A worker's split placed by layout (placeWorker): the largest pane of the thread tab `threadTab` that still splits
   * into two of at least MIN_PANE_COLS x MIN_PANE_ROWS, else a workers tab labelled `workersLabel` (then
   * `<workersLabel>-2`, …) opened with the thread tab's env `tabEnv`. Without it, or when the layout cannot be read,
   * the job splits `split.pane` in `split.direction`.
   */
  place?: { workspace: string; threadTab: string; workersLabel: string; tabEnv: Record<string, string> };
  args: string[];
  bootstrap: string;
  /**
   * When (epoch ms) the attach report must go at the latest, however long the trust watch holds the bootstrap: the
   * daemon's sweep fails a session not attached within `session.spawn_timeout` (see attachDeadline).
   */
  attachBy?: number;
}

/** What the attach report leaves of `session.spawn_timeout` for its own retries (about 10s) and the sweep's tick. */
const ATTACH_MARGIN_MS = 20_000;

/** The `attachBy` of a job the daemon makes at `now` (epoch ms), with a `session.spawn_timeout` of `spawnTimeoutMs`. */
export const attachDeadline = (now: number, spawnTimeoutMs: number): number => now + spawnTimeoutMs - ATTACH_MARGIN_MS;

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

/** Herdr's own wait for an agent start (`agent start --timeout`), at most; `attachBy` may cut it shorter, never below the minimum. */
const START_TIMEOUT_MS = 60_000;
const MIN_START_TIMEOUT_MS = 1_000;

/** How often, every BUSY_RETRY_MS, an agent start is retried while the pane's shell is still starting (about 30s). */
const BUSY_RETRIES = 60;
const BUSY_RETRY_MS = 500;

/** Runs in the `agt __spawn` child so the daemon never waits for an agent to boot. */
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
    /** The clock `job.attachBy` is read against (default Date.now). */
    now?: () => number;
    /** Runs the pane's creation alone among concurrent spawn jobs (placementLock); default: unlocked. */
    lock?: <T>(fn: () => T) => T;
  },
): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const log = deps.log ?? ((m: string) => console.error(`agt __spawn: ${m}`));
  let created: string | undefined;
  let started: string | undefined; // the pane the agent start ran in
  let attached: { pane: string; pending?: string };
  let trust: ReturnType<typeof watchTrust>;
  try {
    let pane: string;
    let exportEnv = job.exportEnv;
    if (job.pane) pane = job.pane;
    else {
      // Two jobs reading one layout at once would both split its largest pane: the read and the split go together.
      const placed = (deps.lock ?? ((fn) => fn()))(() => placeWorker(deps.herdr, job, log) ?? { pane: splitWithFallbacks(deps.herdr, job.split!) });
      pane = created = placed.pane;
      exportEnv = placed.exportEnv;
    }
    // A leading space keeps the line out of shell history (HISTCONTROL=ignorespace, zsh's HIST_IGNORE_SPACE).
    const exported = Object.entries(exportEnv ?? {});
    if (exported.length) deps.herdr.runInPane(pane, ` export ${exported.map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ")}`);
    started = pane;
    const now = deps.now ?? Date.now;
    for (let attempt = 0; ; attempt++) {
      // Herdr's start waits for the agent to be ready: never past `attachBy`, so a slow start cannot outrun the sweep's
      // spawn_timeout (the attach report must still go in time).
      const timeoutMs = job.attachBy === undefined ? START_TIMEOUT_MS : Math.max(MIN_START_TIMEOUT_MS, Math.min(START_TIMEOUT_MS, job.attachBy - now()));
      const start = { name: job.name, kind: job.kind, pane, args: job.args, timeoutMs };
      // The trust watch runs beside the start: Herdr's `agent start` waits for the agent to be ready, which a trust
      // dialog prevents, so the dialog must be answered while it waits.
      trust ??= watchTrust(job, pane, deps.screen, deps.trustPolls ?? TRUST_POLLS, sleep, log, now);
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
    // A bootstrap typed while the trust dialog is up is refused or lost, and so would the daemon's later delivery be: the
    // watch holds it, and the attach report with it (until then the daemon does not poll the pane, so it raises no
    // blocked notice for a dialog agt answers), until the agent is past the dialog, the watch gives up, or `attachBy`.
    await trust?.released;
    let pending: string | undefined;
    // Herdr types the prompt and Enter, and may take a trust dialog's agent for idle: Enter would pick "No, exit".
    // Unless the watch saw the agent past the dialog, the screen is checked first.
    if (job.bootstrap && !trust?.ready && (await trustDialogUp(job.kind, pane, deps.screen))) pending = job.bootstrap;
    else if (job.bootstrap) {
      try {
        deps.herdr.agentPrompt(job.name, job.bootstrap);
      } catch {
        pending = job.bootstrap; // the daemon queues it and delivers it at the agent's first idle
      }
    }
    attached = { pane, ...(pending ? { pending } : {}) };
  } catch (e) {
    trust?.stop();
    // What the agent's pane showed is the only trace of why it did not start: keep it in the daemon log.
    if (started && deps.screen) {
      const text = await deps.screen.paneReadAsync(started).catch(() => undefined);
      if (text !== undefined) log(`agent start failed in pane ${started} (session ${job.session}); its screen:\n${lastLines(text)}`);
    }
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

/** How much of a pane's screen goes to the daemon log. */
const SCREEN_LINES = 40;
const lastLines = (text: string) => text.split("\n").slice(-SCREEN_LINES).join("\n");

/**
 * Whether `pane` may show its agent kind's trust dialog: read whole, or only its chopped fragments (trustDialogMaybe).
 * A screen that cannot be read is taken as no.
 */
async function trustDialogUp(kind: string, pane: string, screen: PaneScreen | undefined): Promise<boolean> {
  const prompt = adapterForHerdrKind(kind)?.trustPrompt;
  if (!prompt || !screen) return false;
  const text = await screen.paneReadAsync(pane).catch(() => undefined);
  return text !== undefined && typingUnsafe(text, prompt);
}

/** The trust watch lasts about 60s: TRUST_POLLS reads, TRUST_POLL_MS apart. */
const TRUST_POLLS = 60;
const TRUST_POLL_MS = 1_000;

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
 * `blocked` whose screen shows the whole dialog, or to one it lists running whose screen shows the dialog waiting
 * (trustDialogLive: Herdr misses a dialog wrapped by a narrow pane), and `confirm` only once the trusting option is
 * seen selected (answerTrustDialog); a dialog whose cursor will not move there is logged and left to the user. Once
 * Herdr has confirmed the launch (its start returned) and lists the agent running (idle, working, done) on two reads in
 * a row with no dialog on its screen, not even its fragments before an answer (trustDialogMaybe: a pane a few columns
 * wide chops it beyond reading), the agent is past the dialog (`ready`) and the watch ends; before the launch such a
 * status may be the pane's previous agent. Until then, and on any error, it polls on until its end. A watch that ends unanswered while
 * the agent is blocked (another dialog, or one it did not recognize) writes the screen it last read to the log.
 *
 * `released` resolves when the bootstrap may go: the watch ended (the agent is ready, or it gave up), or `attachBy`
 * came first (the watch then goes on beside the report).
 *
 * Each poll, by Herdr's status of the pane's agent and what its screen shows:
 *
 * | status                         | screen                                   | action                                          |
 * |--------------------------------|------------------------------------------|-------------------------------------------------|
 * | absent, or running pre-launch  | (not read)                               | poll again (`clear` = 0)                        |
 * | blocked                        | whole dialog, not yet answered           | answer it (answerTrustDialog); log on give-up   |
 * | blocked                        | anything else, or answered already       | poll again, keeping the screen for the end log  |
 * | running (launched)             | dialog waiting (trustDialogLive)         | as blocked                                      |
 * | running (launched)             | fragments only, not yet answered         | poll again, bootstrap held (`clear` = 0)        |
 * | running (launched)             | no dialog (or stale fragments, answered) | `clear`++; at 2 the agent is `ready`: end       |
 * | any read error                 |                                          | poll again                                      |
 *
 * The watch also ends on `stop()` (a busy retry, a failed start, a refused report) and after `polls` reads.
 */
function watchTrust(
  job: SpawnJob,
  pane: string,
  screen: PaneScreen | undefined,
  polls: number,
  sleep: (ms: number) => Promise<void>,
  log: (m: string) => void,
  now: () => number,
) {
  const adapter = adapterForHerdrKind(job.kind);
  const cwd = job.cwd ?? job.split?.cwd;
  if (!screen || !adapter?.trustPrompt || polls === 0 || cwd === undefined || !agtCreatedFolder(job.root, cwd)) return undefined;
  const prompt = adapter.trustPrompt;
  let stopped = false;
  let launched = false;
  let answered = false;
  /** Set when the watch saw the launched agent running with no dialog on its screen, twice in a row. */
  let ready = false;
  /** Consecutive reads of the launched agent running with no dialog: one may come before the dialog is drawn. */
  let clear = 0;
  /** The screen read at the last poll when the agent was blocked; cleared by any other status. */
  let blocked: string | undefined;
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const done = (async () => {
    for (let i = 0; i < polls && !stopped; i++) {
      if (i > 0) await sleep(TRUST_POLL_MS);
      if (stopped) return;
      if (job.attachBy !== undefined && now() >= job.attachBy) release();
      try {
        const status = (await screen.agentListAsync()).find((a) => a.pane === pane)?.status;
        const running = status === "idle" || status === "working" || status === "done";
        blocked = undefined;
        if (!(status === "blocked" || (launched && running))) {
          clear = 0;
          continue;
        }
        const text = await screen.paneReadAsync(pane);
        // Herdr lists an agent idle at a dialog it does not see (heavy rerun 4: the second split's narrow pane wrapped
        // the footer). Running with no dialog waiting on screen, twice, is past it. Before an answer, fragments of the
        // dialog that cannot be read whole are not past it: nothing is answered, and the bootstrap is held.
        if (running && !trustDialogLive(text, prompt)) {
          if (!answered && trustDialogMaybe(text, prompt)) {
            clear = 0;
            blocked = text;
            continue;
          }
          if (++clear < 2) continue;
          ready = true;
          return;
        }
        clear = 0;
        // After the answer, the dialog's own screen still read is stale, not a second dialog to log.
        blocked = answered && trustDialogMaybe(text, prompt) ? undefined : text;
        // Answered: Herdr may list the agent blocked a little longer, or a second startup dialog follows. The watch waits
        // for the agent to be ready, keeping the screen so a watch that ends with the agent still blocked logs it.
        if (answered || !isTrustDialog(text, prompt)) continue;
        if (stopped) return; // stopped while reading: a busy retry's watch, a failed start or a refused report
        const io = { read: () => screen.paneReadAsync(pane), send: (key: string) => screen.paneSendKeysAsync(pane, key), sleep };
        const r = await answerTrustDialog(io, prompt, text);
        if (r.answered) {
          answered = true;
          blocked = undefined;
          log(`trusted ${cwd} for ${adapter.displayName} (a folder agt created)`);
          continue;
        }
        if (stopped) return;
        blocked = r.screen;
        if (!isTrustDialog(r.screen, prompt)) continue; // the dialog went away meanwhile: look again
        log(`the trust dialog in pane ${pane} (session ${job.session}) did not show "Yes" selected after ${TRUST_TRIES} ${prompt.move}s; left it to the user. Its screen:\n${lastLines(r.screen)}`);
        return;
      } catch {
        // the pane may be busy or gone; read again until the watch ends
      }
    }
    if (!stopped && blocked !== undefined) log(`the trust watch ended unanswered while the agent in pane ${pane} (session ${job.session}) was blocked; its screen:\n${lastLines(blocked)}`);
  })().finally(release);
  return {
    stop: () => void (stopped = true),
    launched: () => void (launched = true),
    released,
    done,
    get ready() {
      return ready;
    },
  };
}

function closeQuietly(herdr: HerdrBridge, pane: string): void {
  try {
    herdr.closePane(pane);
  } catch {
    // best effort: the pane may already be gone
  }
}

/** No worker pane is made narrower or shorter than this; a split needs twice as much. */
export const MIN_PANE_COLS = 80;
export const MIN_PANE_ROWS = 20;

/**
 * Where a worker splits a tab: the largest pane (by area) that splits into two panes of at least MIN_PANE_COLS x
 * MIN_PANE_ROWS, to the right when it is at least twice MIN_PANE_COLS wide, else down when twice MIN_PANE_ROWS tall
 * (plus one cell for the divider either way).
 * Undefined when no pane can (the tab is full), or the tab is zoomed (its rects may not be the real ones).
 */
export function chooseSplit(layout: PaneLayout): { pane: string; direction: "right" | "down" } | undefined {
  if (layout.zoomed) return undefined;
  const fits = layout.panes
    .map(({ paneId, rect }) => ({
      pane: paneId,
      area: rect.width * rect.height,
      // A split spends one cell on the divider between its two panes.
      direction: rect.width >= 2 * MIN_PANE_COLS + 1 ? ("right" as const) : rect.height >= 2 * MIN_PANE_ROWS + 1 ? ("down" as const) : undefined,
    }))
    .filter((p) => p.direction !== undefined);
  const best = fits.reduce<(typeof fits)[number] | undefined>((a, p) => (!a || p.area > a.area ? p : a), undefined);
  return best && { pane: best.pane, direction: best.direction! };
}

/** A workers tab's place in its thread's row: `<base>` is 1, `<base>-N` is N (N ≥ 2); undefined for any other label. */
export function workersTabOrder(label: string, base: string): number | undefined {
  if (label === base) return 1;
  const m = label.startsWith(`${base}-`) ? /^[1-9][0-9]*$/.exec(label.slice(base.length + 1)) : null;
  const n = m ? Number(m[0]) : NaN;
  return n >= 2 ? n : undefined;
}

/**
 * Places a worker by layout (see SpawnJob.place): a split of the thread tab, else of a workers tab, else a new workers
 * tab, whose root pane the worker takes (with its env exported there, since the tab has the thread tab's env).
 * Undefined, for the job's plain split, when the job has no placement, the bridge cannot read layouts, or the thread
 * tab's layout cannot be read. Closing the worker's pane closes a workers tab with it once it is its last (Herdr
 * closes a tab with its last pane), as `herdr.close_worker_pane_on_end` and the thread tab's close do.
 */
function placeWorker(herdr: HerdrBridge, job: SpawnJob, log: (m: string) => void): { pane: string; exportEnv?: Record<string, string> } | undefined {
  const place = job.place;
  const split = job.split!;
  if (!place || !herdr.paneLayout || !herdr.paneList || !herdr.tabList) return undefined;
  const unreadable = (e: unknown) => void log(`cannot read the layout for session ${job.session}, splitting as before: ${e instanceof Error ? e.message : String(e)}`);
  let panes: { paneId: string; tabId: string }[];
  try {
    panes = herdr.paneList(place.workspace);
  } catch (e) {
    return unreadable(e);
  }
  const layoutOf = (tab: string): PaneLayout | undefined => {
    const any = panes.find((p) => p.tabId === tab);
    if (!any) return undefined;
    try {
      return herdr.paneLayout!(any.paneId);
    } catch (e) {
      return unreadable(e);
    }
  };
  // The chosen pane may close between the read and the split: then the job splits as before.
  const splitAt = (at: { pane: string; direction: "right" | "down" }) => {
    try {
      return { pane: herdr.splitPane({ pane: at.pane, direction: at.direction, cwd: split.cwd, env: split.env }) };
    } catch (e) {
      if (!(e instanceof HerdrError && e.code === "pane_not_found")) throw e;
      log(`pane ${at.pane} closed before session ${job.session} could split it; splitting as before`);
      return undefined;
    }
  };
  const home = layoutOf(place.threadTab);
  if (!home || home.zoomed) return undefined;
  const at = chooseSplit(home);
  if (at) return splitAt(at);
  let tabs: { tabId: string; label: string }[];
  try {
    tabs = herdr.tabList(place.workspace);
  } catch (e) {
    return unreadable(e);
  }
  const ours = tabs
    .flatMap((t) => {
      const n = workersTabOrder(t.label, place.workersLabel);
      return n === undefined ? [] : [{ ...t, n }];
    })
    .sort((a, b) => a.n - b.n);
  for (const t of ours) {
    const l = layoutOf(t.tabId);
    const there = l && chooseSplit(l);
    if (there) return splitAt(there);
  }
  let n = 1;
  while (ours.some((t) => t.n === n)) n++;
  const label = n === 1 ? place.workersLabel : `${place.workersLabel}-${n}`;
  const { rootPaneId } = herdr.createTab({ workspace: place.workspace, cwd: split.cwd, label, env: place.tabEnv });
  return { pane: rootPaneId, exportEnv: split.env };
}

/**
 * Runs `fn` holding a lock directory at `dir` (spawn jobs are separate processes), with the holder's pid in `dir/pid`.
 * A lock whose holder is dead is taken over at once; one older than STALE_LOCK_MS too (a backstop, as for a lock whose
 * pid was never written). After `waitMs` of waiting (placementWait), or when the lock cannot be made at all, `fn` runs
 * anyway. The lock is removed afterwards only while it still holds this process's pid.
 */
export function placementLock<T>(dir: string, fn: () => T, o: { waitMs?: number; staleMs?: number } = {}): T {
  const deadline = Date.now() + (o.waitMs ?? LOCK_WAIT_MS);
  const pidFile = join(dir, "pid");
  const holder = (): number | undefined => {
    try {
      const n = Number(readFileSync(pidFile, "utf8").trim());
      return Number.isInteger(n) && n > 0 ? n : undefined;
    } catch {
      return undefined;
    }
  };
  let held = false;
  while (!held) {
    try {
      mkdirSync(dir);
      writeFileSync(pidFile, String(process.pid));
      held = true;
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") break; // no place for a lock (no project dir): run unlocked
      try {
        const pid = holder();
        if ((pid !== undefined && !alive(pid)) || Date.now() - statSync(dir).mtimeMs > (o.staleMs ?? STALE_LOCK_MS)) {
          rmSync(dir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // released meanwhile
      }
      if (Date.now() >= deadline) break;
      Bun.sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    if (held && holder() === process.pid) rmSync(dir, { recursive: true, force: true });
  }
}

/** Whether process `pid` exists (EPERM: it does, as another user's). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

/** How long a job waits for the placement lock: LOCK_WAIT_MS, cut so the attach report still goes in time (`attachBy`, 5s spare). */
export function placementWait(attachBy: number | undefined, now: number): number {
  return attachBy === undefined ? LOCK_WAIT_MS : Math.max(0, Math.min(LOCK_WAIT_MS, attachBy - now - LOCK_SPARE_MS));
}

const LOCK_WAIT_MS = 30_000;
const LOCK_SPARE_MS = 5_000;
const STALE_LOCK_MS = 120_000;

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
