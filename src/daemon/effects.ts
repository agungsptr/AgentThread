import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { agentEnv, claudeConfigDir } from "../agents/claude.ts";
import { adapterFor } from "../agents/adapters.ts";
import { bootstrapPrompt } from "../agents/prompts.ts";
import { agentsMd, writeAgentsFilesAsync, writeThreadDirFiles } from "../agents/agents-md.ts";
import { attachDeadline, launchSpawnJob, type SpawnJob } from "../agents/spawn-job.ts";
import { canonical, cleanupThread, type CleanupOutcome } from "./cleanup-job.ts";
import type { Effect } from "../commands/handler.ts";
import type { Command } from "../commands/schema.ts";
import { durationMs, type Config } from "../config/config.ts";
import type { EventBody, Layout } from "../domain/types.ts";
import { HerdrCli, spawnAsync } from "../herdr/bridge.ts";
import { addWorktreeAsync, addWorktreeFromAsync } from "../project/git.ts";
import { paths } from "../project/paths.ts";
import { threadGitEnv } from "../orchestration/sessions.ts";
import type { Thread } from "../state/projection.ts";

type HerdrEffect = Extract<Effect, { kind: "herdr.tab.ensure" | "herdr.tab.close" }>;

/** The Herdr calls effects make. They may answer synchronously (test doubles) or not (HerdrCli's async twins). */
export interface EffectBridge {
  createTab(o: { workspace: string; cwd: string; label: string; env: Record<string, string> }): Promise<{ tabId: string; rootPaneId: string }> | { tabId: string; rootPaneId: string };
  closeTab(tabId: string): Promise<void> | void;
  tabExists(tabId: string): Promise<boolean> | boolean;
  agentPrompt(target: string, text: string): Promise<void> | void;
  closePane(pane: string): Promise<void> | void;
  agentExists(target: string): Promise<boolean> | boolean;
}

/** HerdrCli through its non-blocking calls: the daemon never runs a synchronous child process after startup. */
export function asyncHerdr(cli: HerdrCli): EffectBridge {
  return {
    createTab: (o) => cli.createTabAsync(o),
    closeTab: (tab) => cli.closeTabAsync(tab),
    tabExists: (tab) => cli.tabExistsAsync(tab),
    agentPrompt: (target, text) => cli.agentPromptAsync(target, text),
    closePane: (pane) => cli.closePaneAsync(pane),
    agentExists: (target) => cli.agentExistsAsync(target),
  };
}

export function createEffectRunner(opts: {
  root: string;
  config: Config;
  layout: () => Layout | undefined;
  thread: (id: string) => Thread | undefined;
  launch?: (job: SpawnJob) => void;
  bridge?: (layout: Layout) => EffectBridge;
  log?: (message: string) => void;
  /**
   * Sends a command back through the daemon's queue: the background worktree job reports its outcome with it. Without
   * one (tests), the outcome is only logged.
   */
  report?: (command: Extract<Command, { cmd: "worktree.report" }>) => void;
  /** The same for the background cleanup job's outcome. */
  reportCleanup?: (command: Extract<Command, { cmd: "thread.cleanup_report" }>) => void;
  /** The worktree_setup command's time limit (default 5 minutes). */
  setupTimeoutMs?: number;
}): EffectRunner {
  const log = opts.log ?? ((m: string) => console.error(m));
  const launch = opts.launch ?? ((job: SpawnJob) => launchSpawnJob(job, { logFile: paths(opts.root).daemonLog }));
  const bridgeFor =
    opts.bridge ??
    ((layout: Layout) =>
      asyncHerdr(new HerdrCli({ bin: layout.herdrBin, env: { ...process.env, ...(layout.herdrSocket ? { HERDR_SOCKET_PATH: layout.herdrSocket } : {}) } })));

  const configDir = claudeConfigDir(opts.config);

  // The repository's git dir (shared by every worktree), asked of git once without blocking; undefined if git fails.
  let commonDir: Promise<string | undefined> | undefined;
  const gitCommonDir = () =>
    (commonDir ??= spawnAsync("git", ["-C", opts.root, "rev-parse", "--git-common-dir"], process.env, 10_000).then(
      (r) => (r.exitCode === 0 && !r.timedOut && r.stdout.trim() ? resolve(opts.root, r.stdout.trim()) : undefined),
      () => undefined,
    ));

  // AGENTS.md carries the role rules; a failure to write it is logged and never blocks the worktree or a spawn.
  const writeAgents = async (thread: { id: string; title: string; slug: string }, worktree: string) => {
    try {
      await writeAgentsFilesAsync({ root: opts.root, worktree, content: agentsMd({ root: opts.root, thread: { ...thread, worktree }, config: opts.config }), config: opts.config, log });
    } catch (e) {
      log(`writing AGENTS.md for thread ${thread.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  // A thread directory is not in git: its files are written plainly, with the same failure handling.
  const writeDirAgents = (thread: { id: string; title: string; slug: string }, dir: string) => {
    try {
      writeThreadDirFiles({ root: opts.root, dir, content: agentsMd({ root: opts.root, thread: { ...thread, dir }, config: opts.config }), config: opts.config, log });
    } catch (e) {
      log(`writing AGENTS.md for thread ${thread.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Background worktree jobs: one at a time per repo (keyed by its path), and setup commands one at a time in the
  // workspace. stop() kills the setup groups still running and waits (bounded) for the jobs to clean up.
  const jobs = new Set<Promise<void>>();
  const repoChains = new Map<string, Promise<void>>();
  const bg: Background = { groups: new Set(), setupChain: Promise.resolve(), stopped: false };
  // A job over several repos (a cleanup) joins every repo's chain at once: it starts when all of them are free, and
  // each repo's next job waits for it. Joining happens synchronously, so two such jobs can never wait on each other.
  const inRepoChains = (keys: string[], fn: () => Promise<void>): Promise<void> => {
    const next = Promise.all(keys.map((k) => repoChains.get(k) ?? Promise.resolve())).then(fn);
    const tail = next.catch(() => {});
    for (const key of keys) {
      repoChains.set(key, tail);
      void tail.then(() => {
        if (repoChains.get(key) === tail) repoChains.delete(key);
      });
    }
    return next;
  };
  const inRepoChain = (key: string, fn: () => Promise<void>): Promise<void> => inRepoChains([key], fn);
  const stop = async (): Promise<void> => {
    bg.stopped = true;
    for (const pid of bg.groups) killGroup(pid);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...jobs]), new Promise<void>((r) => (timer = setTimeout(r, STOP_WAIT_MS)))]);
    clearTimeout(timer);
  };

  const run = async (effect: Effect): Promise<EventBody[]> => {
    switch (effect.kind) {
      case "git.worktree.add": {
        // Only from a command: it runs before the command's events commit, so a failure fails the command.
        if (!("repo" in effect)) {
          // The legacy form (an old thread's own worktree of the root repo).
          await addWorktreeAsync(opts.root, effect.branch, effect.path);
          await writeAgents(effect.thread, effect.path);
          return [];
        }
        // A task worktree can take minutes (a setup command): it is made in the background, never holding the
        // command queue, and its outcome re-enters the queue as a worktree.report command.
        const e = effect;
        const job = inRepoChain(e.repoPath, async () => {
          let error: string | undefined;
          try {
            await addRepoWorktree(e, opts.root, opts.config, opts.setupTimeoutMs ?? SETUP_TIMEOUT_MS, bg);
            const t = opts.thread(e.thread);
            if (t) {
              try {
                await writeAgentsFilesAsync({ root: opts.root, repo: e.repoPath, repoName: e.repo, worktree: e.path, content: agentsMd({ root: opts.root, thread: t, config: opts.config }), config: opts.config, log });
              } catch (err) {
                log(`writing AGENTS.md for thread ${t.id} in ${e.path} failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
            log(`worktree for ${e.repo} of thread ${e.thread} failed: ${error}`);
          }
          try {
            opts.report?.({ cmd: "worktree.report", thread: e.thread, repo: e.repo, ok: error === undefined, ...(error !== undefined ? { error } : {}) });
          } catch (err) {
            log(`reporting the worktree for ${e.repo} of thread ${e.thread} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
        jobs.add(job);
        void job.finally(() => jobs.delete(job));
        return [];
      }
      case "git.thread.cleanup": {
        // Like a task worktree, in the background and outside the command queue; it holds every repo it touches, so
        // it never races a worktree add (or another cleanup) in the same repo. Its outcome re-enters as a command.
        const e = effect;
        const job = inRepoChains([...new Set(e.repos.map((r) => r.repoPath))], async () => {
          let outcome: CleanupOutcome;
          try {
            outcome = await cleanupThread(e, () => bg.stopped);
          } catch (err) {
            outcome = { ok: false, repo: e.repos[0]?.repo ?? "(all)", error: err instanceof Error ? err.message : String(err), removed: [] };
          }
          if (!outcome.ok) log(`cleanup of thread ${e.thread} stopped at ${outcome.repo}: ${outcome.error}`);
          try {
            opts.reportCleanup?.(
              outcome.ok
                ? { cmd: "thread.cleanup_report", thread: e.thread, ok: true, repos: outcome.repos }
                : { cmd: "thread.cleanup_report", thread: e.thread, ok: false, repo: outcome.repo, error: outcome.error, removed: outcome.removed },
            );
          } catch (err) {
            log(`reporting the cleanup of thread ${e.thread} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
        jobs.add(job);
        void job.finally(() => jobs.delete(job));
        return [];
      }
      case "thread.dir.ensure":
        // Only from a command (thread.new): a failure to make the directory fails the command. A non-empty folder
        // already there is someone else's: it is never adopted.
        if ((await readdir(effect.thread.dir).catch(() => [])).length > 0) throw new Error(`${effect.thread.dir} already exists and is not empty`);
        await mkdir(effect.thread.dir, { recursive: true });
        writeDirAgents(effect.thread, effect.thread.dir);
        return [];
      case "herdr.tab.ensure":
      case "herdr.tab.close": {
        const layout = opts.layout();
        if (!layout) return [];
        try {
          return await runHerdr(effect, bridgeFor(layout), layout);
        } catch (e) {
          // Herdr is a view: a failure here must never fail the command. `agt start` reconciles missing tabs.
          log(`herdr ${effect.kind} for thread ${effect.thread} failed: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        }
      }
      case "agent.spawn": {
        const layout = opts.layout();
        const t = opts.thread(effect.thread);
        const failed = (reason: string): EventBody[] => [{ type: "session.failed", thread: effect.thread, payload: { session: effect.session, reason } }];
        if (!layout) return failed("no Herdr layout registered");
        if (!t) return failed(`unknown thread ${effect.thread}`);
        if (t.legacy || t.dir === undefined) await writeAgents(t, t.worktree!);
        else writeDirAgents(t, t.dir);
        const legacy = t.legacy || t.dir === undefined;
        // A task-thread worker's ticket doc: its bootstrap names it and Claude's allow rules let it write that file only.
        const ticketDoc = legacy || effect.role !== "worker" ? undefined : t.tickets.find((k) => k.id === effect.ticket)?.doc;
        const prompt = { root: opts.root, role: effect.role, thread: t, ticket: effect.ticket, ...(ticketDoc !== undefined ? { ticketDoc } : {}) };
        const common = await gitCommonDir();
        try {
          const adapter = adapterFor(effect.run.agent);
          const launched = adapter.launch({
            role: effect.role,
            run: effect.run,
            config: opts.config,
            root: opts.root,
            worktree: effect.cwd,
            legacy,
            ...(ticketDoc !== undefined ? { ticketDoc } : {}),
            ...(common ? { gitCommonDir: common } : {}),
          });
          launch({
            root: opts.root,
            herdrBin: layout.herdrBin,
            ...(layout.herdrSocket ? { herdrSocket: layout.herdrSocket } : {}),
            session: effect.session,
            name: effect.name,
            kind: adapter.herdrKind,
            cwd: effect.cwd,
            ...(effect.pane ? { pane: effect.pane, exportEnv: launched.processEnv } : {}),
            ...(effect.splitFrom
              ? {
                  split: {
                    pane: effect.splitFrom,
                    ...(effect.splitFallbacks?.length ? { fallbacks: effect.splitFallbacks } : {}),
                    direction: effect.direction ?? "right",
                    cwd: effect.cwd,
                    env: {
                      ...agentEnv({ root: opts.root, role: effect.role, agent: effect.run.agent, session: effect.session, thread: effect.thread, ticket: effect.ticket, ...(t.dir !== undefined && t.task ? { task: t.task } : {}), configDir }),
                      ...launched.env,
                      ...threadGitEnv(t, opts.root),
                      ...launched.processEnv,
                    },
                  },
                }
              : {}),
            args: launched.args,
            bootstrap: bootstrapPrompt(prompt, effect.bootstrap ?? "start", effect.notice),
            attachBy: attachDeadline(Date.now(), durationMs(opts.config.session.spawn_timeout)),
          });
          return [];
        } catch (e) {
          return failed(e instanceof Error ? e.message : String(e));
        }
      }
      case "notice.deliver": {
        const layout = opts.layout();
        if (!layout) return [];
        try {
          await bridgeFor(layout).agentPrompt(effect.pane, effect.text);
          return [{ type: "notice.delivered", ...(effect.thread ? { thread: effect.thread } : {}), payload: { session: effect.session, count: effect.count } }];
        } catch (e) {
          log(`notice delivery to session ${effect.session} failed: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        }
      }
      case "pane.close": {
        const layout = opts.layout();
        if (!layout) return [];
        try {
          await bridgeFor(layout).closePane(effect.pane);
        } catch (e) {
          log(`closing pane ${effect.pane} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return [];
      }
      case "session.probe": {
        const layout = opts.layout();
        if (!layout) return [];
        try {
          return (await bridgeFor(layout).agentExists(effect.pane))
            ? []
            : [{ type: "session.lost", ...(effect.thread ? { thread: effect.thread } : {}), payload: { session: effect.session, reason: `no agent in pane ${effect.pane}` } }];
        } catch (e) {
          log(`probing pane ${effect.pane} failed: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        }
      }
    }
  };
  return Object.assign(run, { stop });
}

/** Runs an effect; stop() ends the background worktree jobs (the daemon calls it when it stops). */
export type EffectRunner = ((effect: Effect) => Promise<EventBody[]>) & { stop(): Promise<void> };

type RepoWorktreeEffect = Extract<Effect, { kind: "git.worktree.add"; repo: string }>;

/** The background jobs' shared state: running setup process groups, the workspace's setup queue, and the stop flag. */
interface Background {
  groups: Set<number>;
  setupChain: Promise<unknown>;
  stopped: boolean;
}

const SETUP_TIMEOUT_MS = 5 * 60_000;
const STOP_WAIT_MS = 5_000;

const killGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
};
const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/**
 * Runs `sh -c <script>` in its own process group without blocking. On a timeout the whole group is killed, and so is
 * whatever it left running when it fails: nothing it started may act after the caller cleans up. Resolves once the
 * group's main process has exited.
 */
export function runShellGroup(
  script: string,
  timeoutMs: number,
  groups?: Set<number>,
): Promise<{ exitCode: number; stderr: string; timedOut: boolean; pid?: number }> {
  return new Promise((done) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("sh", ["-c", script], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    } catch (e) {
      done({ exitCode: 127, stderr: e instanceof Error ? e.message : String(e), timedOut: false });
      return;
    }
    // While its main process runs, the group is listed in `groups`, so a stopping daemon can kill it.
    const pid = child.pid;
    if (pid) groups?.add(pid);
    let stderr = "";
    child.stderr?.on("data", (b: Buffer) => {
      if (stderr.length < 16_384) stderr += b.toString();
    });
    child.stdout?.on("data", () => {});
    const kill = () => {
      if (pid) killGroup(pid);
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    let finished = false;
    const finish = (exitCode: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (pid) groups?.delete(pid);
      if (timedOut || exitCode !== 0) kill();
      // A grandchild may hold the pipes open: stop reading instead of waiting for them to close.
      child.stdout?.destroy();
      child.stderr?.destroy();
      done({ exitCode, stderr, timedOut, ...(pid ? { pid } : {}) });
    };
    child.once("error", () => finish(127));
    child.once("exit", (code, signal) => finish(code ?? (signal ? 128 + 9 : 1)));
  });
}


/**
 * Creates a task worktree: the config's worktree_setup command (run with `sh -c` in the root in its own process group,
 * placeholders filled in and shell-quoted, then checked), else git worktree add. On any failure it removes what this
 * run made (a worktree registered at the path during the run, else a folder that was not there, and a wip/<task>
 * branch that did not exist before) and throws.
 */
async function addRepoWorktree(e: RepoWorktreeEffect, root: string, config: Config, setupTimeoutMs: number, bg: Background): Promise<void> {
  const git = (args: string[], timeoutMs = 30_000) => spawnAsync("git", ["-C", e.repoPath, ...args], process.env, timeoutMs);
  // The branch checked out at the path itself: git may not search above it (the thread directory, or the root).
  const onBranch = async () => {
    if (!existsSync(e.path)) return false;
    const head = await spawnAsync("git", ["-C", e.path, "rev-parse", "--abbrev-ref", "HEAD"], { ...process.env, GIT_CEILING_DIRECTORIES: dirname(e.path) }, 10_000);
    return head.exitCode === 0 && !head.timedOut && head.stdout.trim() === e.branch;
  };
  const branchExists = async () => (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${e.branch}`])).exitCode === 0;
  const registered = async () => {
    const r = await git(["worktree", "list", "--porcelain"]);
    const want = canonical(e.path);
    return r.stdout.split("\n").some((l) => l.startsWith("worktree ") && canonical(l.slice("worktree ".length)) === want);
  };
  const hadBranch = await branchExists();
  const wasRegistered = await registered();
  // A worktree a previous job finished but never reported (the daemon stopped first) is adopted as it is.
  if (wasRegistered && (await onBranch())) return;
  const hadPath = existsSync(e.path);
  try {
    if (bg.stopped) throw new Error("the daemon is stopping");
    const setup = config.workspace.worktree_setup;
    if (setup === undefined) {
      await addWorktreeFromAsync(e.repoPath, e.branch, e.path, e.source);
      return;
    }
    const values: Record<string, string> = { root, task: e.branch.replace(/^wip\//, ""), repo: e.repo, src: e.source, path: e.path };
    const command = setup.replace(/\{(root|task|repo|src|path)\}/g, (_, k: string) => shq(values[k]!));
    // One setup at a time in the workspace: setups often share caches, ports or a package store.
    const ran = bg.setupChain.then(() => (bg.stopped ? undefined : runShellGroup(`cd ${shq(root)} || exit 1\n${command}`, setupTimeoutMs, bg.groups)));
    bg.setupChain = ran.catch(() => {});
    const r = await ran;
    if (!r) throw new Error("the daemon is stopping");
    if (r.exitCode !== 0 || r.timedOut) {
      const why = bg.stopped ? "the daemon stopped" : r.timedOut ? `timed out after ${Math.round(setupTimeoutMs / 1000)}s` : `exit ${r.exitCode}${r.stderr.trim() ? `: ${r.stderr.trim()}` : ""}`;
      throw new Error(`worktree setup for ${e.repo} failed (${why})`);
    }
    if (!(await registered()) || !(await onBranch())) {
      // Whatever the setup left running must not act after the cleanup below.
      if (r.pid) killGroup(r.pid);
      throw new Error(`worktree setup for ${e.repo} did not produce ${e.path} on ${e.branch}`);
    }
  } catch (err) {
    if (!wasRegistered && (await registered())) {
      const removed = await git(["worktree", "remove", "--force", e.path]);
      if (removed.exitCode !== 0) {
        await rm(e.path, { recursive: true, force: true });
        await git(["worktree", "prune"]);
      }
    } else if (!hadPath && existsSync(e.path)) {
      await rm(e.path, { recursive: true, force: true });
    }
    if (!hadBranch && (await branchExists())) await git(["branch", "-D", e.branch]);
    throw err;
  }
}

async function runHerdr(effect: HerdrEffect, bridge: EffectBridge, layout: Layout): Promise<EventBody[]> {
  if (effect.kind === "herdr.tab.ensure") {
    if (effect.tab && (await bridge.tabExists(effect.tab))) return [];
    const { tabId, rootPaneId } = await bridge.createTab({ workspace: layout.workspace, cwd: effect.cwd, label: effect.label, env: effect.env });
    return [{ type: "thread.tab_opened", thread: effect.thread, payload: { tab: tabId, rootPane: rootPaneId } }];
  }
  if (await bridge.tabExists(effect.tab)) await bridge.closeTab(effect.tab);
  return [{ type: "thread.tab_closed", thread: effect.thread, payload: { tab: effect.tab } }];
}
