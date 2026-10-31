import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { agentEnv, claudeConfigDir } from "../agents/claude.ts";
import { adapterFor } from "../agents/adapters.ts";
import { bootstrapPrompt } from "../agents/prompts.ts";
import { agentsMd, writeAgentsFilesAsync, writeThreadDirFiles } from "../agents/agents-md.ts";
import { launchSpawnJob, type SpawnJob } from "../agents/spawn-job.ts";
import type { Effect } from "../commands/handler.ts";
import type { Config } from "../config/config.ts";
import type { EventBody, Layout } from "../domain/types.ts";
import { HerdrCli, spawnAsync } from "../herdr/bridge.ts";
import { addWorktreeAsync } from "../project/git.ts";
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
      case "git.worktree.add":
        // Only from a command (thread.new): it runs before the command's events commit, so a failure fails the command.
        await addWorktreeAsync(opts.root, effect.branch, effect.path);
        await writeAgents(effect.thread, effect.path);
        return [];
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
                      ...agentEnv({ root: opts.root, role: effect.role, agent: effect.run.agent, session: effect.session, thread: effect.thread, ticket: effect.ticket, configDir }),
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

async function runHerdr(effect: HerdrEffect, bridge: EffectBridge, layout: Layout): Promise<EventBody[]> {
  if (effect.kind === "herdr.tab.ensure") {
    if (effect.tab && (await bridge.tabExists(effect.tab))) return [];
    const { tabId, rootPaneId } = await bridge.createTab({ workspace: layout.workspace, cwd: effect.cwd, label: effect.label, env: effect.env });
    return [{ type: "thread.tab_opened", thread: effect.thread, payload: { tab: tabId, rootPane: rootPaneId } }];
  }
  if (await bridge.tabExists(effect.tab)) await bridge.closeTab(effect.tab);
  return [{ type: "thread.tab_closed", thread: effect.thread, payload: { tab: effect.tab } }];
}
