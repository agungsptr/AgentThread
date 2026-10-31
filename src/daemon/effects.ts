import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { agentEnv, claudeConfigDir } from "../agents/claude.ts";
import { adapterFor } from "../agents/adapters.ts";
import { bootstrapPrompt } from "../agents/prompts.ts";
import { agentsMd, writeAgentsFilesAsync, writeThreadDirFiles } from "../agents/agents-md.ts";
import { launchSpawnJob, type SpawnJob } from "../agents/spawn-job.ts";
import type { Effect } from "../commands/handler.ts";
import type { Command } from "../commands/schema.ts";
import type { Config } from "../config/config.ts";
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
  /** The worktree_setup command's time limit (default 5 minutes). */
  setupTimeoutMs?: number;
}): (effect: Effect) => Promise<EventBody[]> {
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

  return async (effect) => {
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
        void (async () => {
          let error: string | undefined;
          try {
            await addRepoWorktree(e, opts.root, opts.config, opts.setupTimeoutMs ?? SETUP_TIMEOUT_MS);
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
        })();
        return [];
      }
      case "thread.dir.ensure":
        // Only from a command (thread.new): a failure to make the directory fails the command.
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
        const prompt = { root: opts.root, role: effect.role, thread: t, ticket: effect.ticket };
        const common = await gitCommonDir();
        try {
          const adapter = adapterFor(effect.run.agent);
          const launched = adapter.launch({
            role: effect.role,
            run: effect.run,
            config: opts.config,
            root: opts.root,
            worktree: effect.cwd,
            ...(common ? { gitCommonDir: common } : {}),
          });
          launch({
            root: opts.root,
            herdrBin: layout.herdrBin,
            ...(layout.herdrSocket ? { herdrSocket: layout.herdrSocket } : {}),
            session: effect.session,
            name: effect.name,
            kind: adapter.herdrKind,
            ...(effect.pane ? { pane: effect.pane } : {}),
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
                    },
                  },
                }
              : {}),
            args: launched.args,
            bootstrap: bootstrapPrompt(prompt, effect.bootstrap ?? "start"),
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
}

type RepoWorktreeEffect = Extract<Effect, { kind: "git.worktree.add"; repo: string }>;

const SETUP_TIMEOUT_MS = 5 * 60_000;
const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/**
 * Runs `sh -c <script>` in its own process group without blocking. On a timeout the whole group is killed, and so is
 * whatever it left running when it fails: nothing it started may act after the caller cleans up. Resolves once the
 * group's main process has exited.
 */
export function runShellGroup(script: string, timeoutMs: number): Promise<{ exitCode: number; stderr: string; timedOut: boolean }> {
  return new Promise((done) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("sh", ["-c", script], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    } catch (e) {
      done({ exitCode: 127, stderr: e instanceof Error ? e.message : String(e), timedOut: false });
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (b: Buffer) => {
      if (stderr.length < 16_384) stderr += b.toString();
    });
    child.stdout?.on("data", () => {});
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    const finish = (exitCode: number) => {
      clearTimeout(timer);
      if (timedOut || exitCode !== 0) killGroup();
      // A grandchild may hold the pipes open: stop reading instead of waiting for them to close.
      child.stdout?.destroy();
      child.stderr?.destroy();
      done({ exitCode, stderr, timedOut });
    };
    child.once("error", () => finish(127));
    child.once("exit", (code, signal) => finish(code ?? (signal ? 128 + 9 : 1)));
  });
}

/** `p` with its existing ancestors resolved (macOS /var is /private/var), so git's paths compare equal. */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(canonical(parent), basename(p));
  }
}

/**
 * Creates a task worktree: the config's worktree_setup command (run with `sh -c` in the root in its own process group,
 * placeholders filled in and shell-quoted, then checked), else git worktree add. On any failure it removes what this
 * run made (a worktree registered at the path during the run, else a folder that was not there, and a wip/<task>
 * branch that did not exist before) and throws.
 */
async function addRepoWorktree(e: RepoWorktreeEffect, root: string, config: Config, setupTimeoutMs: number): Promise<void> {
  const git = (args: string[], timeoutMs = 30_000) => spawnAsync("git", ["-C", e.repoPath, ...args], process.env, timeoutMs);
  const branchExists = async () => (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${e.branch}`])).exitCode === 0;
  const registered = async () => {
    const r = await git(["worktree", "list", "--porcelain"]);
    const want = canonical(e.path);
    return r.stdout.split("\n").some((l) => l.startsWith("worktree ") && canonical(l.slice("worktree ".length)) === want);
  };
  const hadBranch = await branchExists();
  const wasRegistered = await registered();
  const hadPath = existsSync(e.path);
  try {
    const setup = config.workspace.worktree_setup;
    if (setup === undefined) {
      await addWorktreeFromAsync(e.repoPath, e.branch, e.path, e.source);
      return;
    }
    const values: Record<string, string> = { root, task: e.branch.replace(/^wip\//, ""), repo: e.repo, src: e.source, path: e.path };
    const command = setup.replace(/\{(root|task|repo|src|path)\}/g, (_, k: string) => shq(values[k]!));
    const r = await runShellGroup(`cd ${shq(root)} || exit 1\n${command}`, setupTimeoutMs);
    if (r.exitCode !== 0 || r.timedOut) {
      const why = r.timedOut ? `timed out after ${Math.round(setupTimeoutMs / 1000)}s` : `exit ${r.exitCode}${r.stderr.trim() ? `: ${r.stderr.trim()}` : ""}`;
      throw new Error(`worktree setup for ${e.repo} failed (${why})`);
    }
    const head = existsSync(e.path) ? await spawnAsync("git", ["-C", e.path, "rev-parse", "--abbrev-ref", "HEAD"], process.env, 10_000) : undefined;
    if (!head || head.exitCode !== 0 || head.stdout.trim() !== e.branch) {
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
