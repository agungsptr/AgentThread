import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { agentEnv, claudeConfigDir } from "../agents/claude.ts";
import { adapterFor, prepareLaunch } from "../agents/adapters.ts";
import { bootstrapPrompt } from "../agents/prompts.ts";
import { addCopiedExcludes, agentsMd, writeAgentsFilesAsync, writeThreadDirFiles } from "../agents/agents-md.ts";
import { attachDeadline, launchSpawnJob, workersTabOrder, type SpawnJob } from "../agents/spawn-job.ts";
import { typingUnsafe } from "../agents/trust.ts";
import { canonical, cleanupThread, type CleanupOutcome } from "./cleanup-job.ts";
import type { Effect } from "../commands/handler.ts";
import type { Command } from "../commands/schema.ts";
import { durationMs, type Config } from "../config/config.ts";
import type { EventBody, Layout, ThreadType } from "../domain/types.ts";
import { HerdrCli, HerdrError, spawnAsync } from "../herdr/bridge.ts";
import { addDetachedWorktreeAsync, addWorktreeAsync, addWorktreeFromAsync } from "../project/git.ts";
import { installCommand } from "../project/prefill.ts";
import { anchoredExclude, copyIntoWorktree, guardLinkedInstall, linkIntoWorktree, lockfilesDiffer, redactSecrets } from "../project/worktree-copy.ts";
import { paths } from "../project/paths.ts";
import { NOTICE_HELD_CAPPED_AT, NOTICE_RETRY_MAX_MS } from "../orchestration/reactor.ts";
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
  /** The workspace's tabs: a thread tab's close closes its workers tabs too. Without it, they are left to close with their last pane. */
  tabList?(workspace: string): Promise<{ tabId: string; label: string }[]> | { tabId: string; label: string }[];
  /** The pane's visible screen: a notice is not typed into an agent's trust dialog. Without it, nothing is checked. */
  paneRead?(pane: string): Promise<string> | string;
}

/** HerdrCli through its non-blocking calls: the daemon never runs a synchronous child process after startup. */
export function asyncHerdr(cli: HerdrCli): EffectBridge {
  return {
    createTab: (o) => cli.createTabAsync(o),
    closeTab: (tab) => cli.closeTabAsync(tab),
    tabExists: (tab) => cli.tabExistsAsync(tab),
    tabList: (workspace) => cli.tabListAsync(workspace),
    agentPrompt: (target, text) => cli.agentPromptAsync(target, text),
    closePane: (pane) => cli.closePaneAsync(pane),
    agentExists: (target) => cli.agentExistsAsync(target),
    paneRead: (pane) => cli.paneReadAsync(pane, NOTICE_READ_MS),
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
  /** How long a notice delivery waits for the pane's screen (default NOTICE_READ_MS). */
  noticeReadMs?: number;
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
  const writeAgents = async (thread: { id: string; title: string; slug: string; task?: string; type?: ThreadType }, worktree: string) => {
    try {
      await writeAgentsFilesAsync({ root: opts.root, worktree, ...(thread.task !== undefined ? { task: thread.task } : {}), content: agentsMd({ root: opts.root, thread: { ...thread, worktree }, config: opts.config }), config: opts.config, log });
    } catch (e) {
      log(`writing AGENTS.md for thread ${thread.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  // A thread directory is not in git: its files are written plainly, with the same failure handling.
  const writeDirAgents = (thread: { id: string; title: string; slug: string; task?: string; type?: ThreadType }, dir: string) => {
    try {
      writeThreadDirFiles({ root: opts.root, dir, ...(thread.task !== undefined ? { task: thread.task } : {}), content: agentsMd({ root: opts.root, thread: { ...thread, dir }, config: opts.config }), config: opts.config, log });
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
            await addRepoWorktree(e, opts.root, opts.config, opts.setupTimeoutMs ?? SETUP_TIMEOUT_MS, bg, log);
            const t = opts.thread(e.thread);
            if (t) {
              try {
                await writeAgentsFilesAsync({ root: opts.root, repo: e.repoPath, repoName: e.repo, worktree: e.path, ...(t.task !== undefined ? { task: t.task } : {}), content: agentsMd({ root: opts.root, thread: t, config: opts.config }), config: opts.config, log });
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
                ? { cmd: "thread.cleanup_report", thread: e.thread, ok: true, repos: outcome.repos, ...(outcome.notes?.length ? { notes: outcome.notes } : {}), ...(outcome.dirRemoved !== undefined ? { dirRemoved: outcome.dirRemoved } : {}) }
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
          return await runHerdr(effect, bridgeFor(layout), layout, opts.thread(effect.thread), log);
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
        const prompt = { root: opts.root, role: effect.role, thread: t, ticket: effect.ticket, config: opts.config, ...(ticketDoc !== undefined ? { ticketDoc } : {}) };
        const common = await gitCommonDir();
        try {
          const adapter = adapterFor(effect.run.agent);
          const input = {
            role: effect.role,
            run: effect.run,
            config: opts.config,
            root: opts.root,
            worktree: effect.cwd,
            legacy,
            ...(effect.profile ? { profile: effect.profile } : {}),
            ...(ticketDoc !== undefined ? { ticketDoc } : {}),
            ...(common ? { gitCommonDir: common } : {}),
          };
          const launched = prepareLaunch(adapter, input, adapter.launch(input), log);
          launch({
            root: opts.root,
            herdrBin: layout.herdrBin,
            ...(layout.herdrSocket ? { herdrSocket: layout.herdrSocket } : {}),
            session: effect.session,
            name: effect.name,
            kind: adapter.herdrKind,
            cwd: effect.cwd,
            // A root pane's tab env was fixed when the tab opened; the profile's dir (a path, no secret) is exported too.
            ...(effect.pane ? { pane: effect.pane, exportEnv: { ...launched.processEnv, ...(effect.profile && launched.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: launched.env.CLAUDE_CONFIG_DIR } : {}) } } : {}),
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
            // A worker is placed by the thread tab's layout, or in the thread's workers tab when that tab is full.
            ...(effect.role === "worker" && effect.splitFrom && t.tab
              ? { place: { workspace: layout.workspace, threadTab: t.tab, workersLabel: workersLabel(t), processEnv: launched.processEnv } }
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
        const bridge = bridgeFor(layout);
        // Herdr may list an agent at its trust dialog idle (a narrow pane wraps or chops the dialog), and a prompt's
        // Enter would pick "No, exit". Only the session's own agent's dialog is checked (an agent without one is never
        // held): read whole it always holds the delivery, its fragments hold it while only Herdr's poll says the agent
        // started (typingUnsafe), and a screen not read in time holds it too. Held or failed, the notice stays queued and
        // notice.held lets the sweep retry it: an agent that is already idle may never go idle again.
        const held = (why: string): EventBody[] => {
          // One line when a stretch starts and one when its backoff first caps: a session stuck for hours must not flood the log.
          const holds = (effect.held ?? 0) + 1;
          if (holds === 1) log(`notice delivery to session ${effect.session} held: ${why}; agt retries it shortly`);
          else if (holds === NOTICE_HELD_CAPPED_AT) log(`notice delivery to ${effect.session} keeps being held (${why}); retrying every ${NOTICE_RETRY_MAX_MS / 60_000}m`);
          return [{ type: "notice.held", ...(effect.thread ? { thread: effect.thread } : {}), payload: { session: effect.session, reason: why } }];
        };
        const prompt = adapterFor(effect.agent).trustPrompt;
        if (prompt && bridge.paneRead) {
          const screen = await readWithin(bridge.paneRead(effect.pane), opts.noticeReadMs ?? NOTICE_READ_MS);
          if (screen === "timeout") return held(`pane ${effect.pane}'s screen was not read within ${opts.noticeReadMs ?? NOTICE_READ_MS}ms`);
          if (screen !== undefined && typingUnsafe(screen, prompt, { confirmed: effect.unconfirmed !== true })) return held(`pane ${effect.pane} shows a trust dialog`);
        }
        try {
          await bridge.agentPrompt(effect.pane, effect.text);
          return [{ type: "notice.delivered", ...(effect.thread ? { thread: effect.thread } : {}), payload: { session: effect.session, count: effect.count, ...(effect.texts ? { texts: effect.texts } : {}) } }];
        } catch (e) {
          return held(`delivery failed: ${e instanceof Error ? e.message : String(e)}`);
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

/** How long a notice delivery waits for the pane's screen before it holds the notice for the next trigger. */
const NOTICE_READ_MS = 3_000;

/** The screen, "timeout" when it took longer than `ms` (Herdr's own timeout too), or undefined when it could not be read. */
async function readWithin(read: Promise<string> | string, ms: number): Promise<string | "timeout" | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(read).catch((e: unknown) => (e instanceof HerdrError && e.code === "timeout" ? ("timeout" as const) : undefined)),
      new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), ms))),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
async function addRepoWorktree(e: RepoWorktreeEffect, root: string, config: Config, setupTimeoutMs: number, bg: Background, log?: (m: string) => void): Promise<void> {
  const git = (args: string[], timeoutMs = 30_000) => spawnAsync("git", ["-C", e.repoPath, ...args], process.env, timeoutMs);
  // The branch checked out at the path itself: git may not search above it (the thread directory, or the root).
  const onBranch = async () => {
    if (!existsSync(e.path)) return false;
    const head = await spawnAsync("git", ["-C", e.path, "rev-parse", "--abbrev-ref", "HEAD"], { ...process.env, GIT_CEILING_DIRECTORIES: dirname(e.path) }, 10_000);
    // A doc thread's worktree is detached: `rev-parse --abbrev-ref HEAD` prints HEAD.
    return head.exitCode === 0 && !head.timedOut && head.stdout.trim() === (e.detach ? "HEAD" : e.branch);
  };
  // The wip branch this run may create: the task branch itself, or (detached) one a worktree_setup made anyway.
  const task = e.task ?? e.branch.replace(/^wip\//, "");
  const wip = e.detach ? `wip/${task}` : e.branch;
  const branchExists = async () => (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${wip}`])).exitCode === 0;
  const registered = async () => {
    const r = await git(["worktree", "list", "--porcelain"]);
    const want = canonical(e.path);
    return r.stdout.split("\n").some((l) => l.startsWith("worktree ") && canonical(l.slice("worktree ".length)) === want);
  };
  const hadBranch = await branchExists();
  const wasRegistered = await registered();
  // The built-in step: the repo's env files from the main checkout (git-ignored in the worktree), then its dependencies.
  // Copying never overwrites, so running it again is safe.
  const builtin = async () => {
    const repoCfg = config.workspace.repos?.[e.repo];
    const { notes, copied } = await copyIntoWorktree(e.repoPath, e.path, repoCfg?.copy ?? []);
    for (const note of notes) log?.(`worktree ${e.repo}: ${note}`);
    // Links: node_modules is linked only while the lockfile is the main checkout's; otherwise it is installed, and says why.
    const isNm = (n: string) => n.replace(/\/+$/, "") === "node_modules";
    const wanted = repoCfg?.link ?? [];
    const differs = wanted.some(isNm) ? await lockfilesDiffer(e.repoPath, e.path) : [];
    if (differs.length) log?.(`worktree ${e.repo}: link node_modules: not linked, ${differs.join(", ")} differs from the main checkout; installing instead`);
    const linkedRes = await linkIntoWorktree(e.repoPath, e.path, differs.length ? wanted.filter((n) => !isNm(n)) : wanted);
    for (const note of linkedRes.notes) log?.(`worktree ${e.repo}: ${note}`);
    const guard = await guardLinkedInstall(e.repoPath, e.path);
    if (guard.note) log?.(`worktree ${e.repo}: ${guard.note}`);
    const excludes = [...copied, ...linkedRes.linked];
    if (excludes.length) {
      try {
        addCopiedExcludes(root, e.repo, excludes.map(anchoredExclude));
      } catch (err) {
        log?.(`worktree ${e.repo}: could not git-ignore the copied files: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const install = guard.skip ? null : installCommand(e.path, repoCfg?.install);
    if (install !== null) {
      const ran = bg.setupChain.then(() => (bg.stopped ? undefined : runShellGroup(`cd ${shq(e.path)} || exit 1\n${install}`, setupTimeoutMs, bg.groups)));
      bg.setupChain = ran.catch(() => {});
      const r = await ran;
      if (!r) throw new Error("the daemon is stopping");
      if (r.exitCode !== 0 || r.timedOut) {
        const tail = redactSecrets(r.stderr.trim().split("\n").slice(-10).join("\n"));
        const why = bg.stopped ? "the daemon stopped" : r.timedOut ? `timed out after ${Math.round(setupTimeoutMs / 1000)}s` : `exit ${r.exitCode}${tail ? `: ${tail}` : ""}`;
        throw new Error(`install for ${e.repo} failed (${why})`);
      }
    }
  };
  // The ready marker lives in the worktree's own git dir, never in the working tree.
  const markReady = async () => {
    const gd = await spawnAsync("git", ["-C", e.path, "rev-parse", "--absolute-git-dir"], { ...process.env, GIT_CEILING_DIRECTORIES: dirname(e.path) }, 10_000);
    if (gd.exitCode === 0) await writeFile(join(gd.stdout.trim(), "agt-ready"), "");
  };
  const isReady = async () => {
    const gd = await spawnAsync("git", ["-C", e.path, "rev-parse", "--absolute-git-dir"], { ...process.env, GIT_CEILING_DIRECTORIES: dirname(e.path) }, 10_000);
    return gd.exitCode === 0 && existsSync(join(gd.stdout.trim(), "agt-ready"));
  };
  const hadPath = existsSync(e.path);
  try {
    if (bg.stopped) throw new Error("the daemon is stopping");
    const setup = config.workspace.worktree_setup;
    // A worktree a previous job created but never reported (the daemon stopped first) is adopted; one without the
    // ready marker had its copy and install cut short, so that step runs again first (a worktree_setup cannot be re-run).
    if (wasRegistered && (await onBranch())) {
      if (!(await isReady())) {
        if (setup === undefined) await builtin();
        await markReady();
      }
      return;
    }
    if (setup === undefined) {
      if (e.detach) await addDetachedWorktreeAsync(e.repoPath, e.path, e.source);
      else await addWorktreeFromAsync(e.repoPath, e.branch, e.path, e.source);
      await builtin();
      await markReady();
      return;
    }
    const values: Record<string, string> = { root, task, repo: e.repo, src: e.source, path: e.path };
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
    // A doc thread's worktree is detached after the setup, and a wip branch the setup made for it goes.
    if (e.detach && (await registered()) && existsSync(e.path)) {
      await spawnAsync("git", ["-C", e.path, "switch", "--detach", "--quiet"], { ...process.env, GIT_CEILING_DIRECTORIES: dirname(e.path) }, 10_000);
      if (!hadBranch && (await branchExists())) await git(["branch", "-D", wip]);
    }
    if (!(await registered()) || !(await onBranch())) {
      // Whatever the setup left running must not act after the cleanup below.
      if (r.pid) killGroup(r.pid);
      throw new Error(`worktree setup for ${e.repo} did not produce ${e.path} on ${e.branch}`);
    }
    await markReady();
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
    if (!hadBranch && (await branchExists())) await git(["branch", "-D", wip]);
    throw err;
  }
}

/** The label of a thread's (first) workers tab: its tab's label with `-workers`. */
const workersLabel = (t: { id: string; slug: string }) => `${t.id}-${t.slug}-workers`;

async function runHerdr(effect: HerdrEffect, bridge: EffectBridge, layout: Layout, t: Thread | undefined, log: (m: string) => void): Promise<EventBody[]> {
  if (effect.kind === "herdr.tab.ensure") {
    if (effect.tab && (await bridge.tabExists(effect.tab))) return [];
    const { tabId, rootPaneId } = await bridge.createTab({ workspace: layout.workspace, cwd: effect.cwd, label: effect.label, env: effect.env });
    return [{ type: "thread.tab_opened", thread: effect.thread, payload: { tab: tabId, rootPane: rootPaneId } }];
  }
  if (await bridge.tabExists(effect.tab)) await bridge.closeTab(effect.tab);
  // A done thread's workers tabs go with its tab (a tab closed to be reopened keeps them: their workers run on). A
  // failure here is only logged: the thread tab is closed.
  if (effect.workers && t && bridge.tabList) {
    try {
      for (const w of await bridge.tabList(layout.workspace)) if (workersTabOrder(w.label, workersLabel(t)) !== undefined) await bridge.closeTab(w.tabId);
    } catch (e) {
      log(`closing the workers tabs of thread ${t.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return [{ type: "thread.tab_closed", thread: effect.thread, payload: { tab: effect.tab } }];
}
