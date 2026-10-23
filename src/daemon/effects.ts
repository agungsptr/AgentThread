import { dirname } from "node:path";
import { AGT_BIN, agentEnv, claudeArgs, claudeConfigDir } from "../agents/claude.ts";
import { bootstrapPrompt, systemPrompt } from "../agents/prompts.ts";
import { launchSpawnJob, type SpawnJob } from "../agents/spawn-job.ts";
import type { Effect } from "../commands/handler.ts";
import type { Config } from "../config/config.ts";
import type { EventBody, Layout } from "../domain/types.ts";
import { HerdrCli, type HerdrBridge } from "../herdr/bridge.ts";
import { addWorktree } from "../project/git.ts";
import { paths } from "../project/paths.ts";
import type { Thread } from "../state/projection.ts";

type HerdrEffect = Extract<Effect, { kind: "herdr.tab.ensure" | "herdr.tab.close" }>;

export function createEffectRunner(opts: {
  root: string;
  config: Config;
  layout: () => Layout | undefined;
  thread: (id: string) => Thread | undefined;
  launch?: (job: SpawnJob) => void;
  bridge?: (layout: Layout) => HerdrBridge;
  log?: (message: string) => void;
}): (effect: Effect) => EventBody[] {
  const log = opts.log ?? ((m: string) => console.error(m));
  const launch = opts.launch ?? ((job: SpawnJob) => launchSpawnJob(job, { logFile: paths(opts.root).daemonLog }));
  const bridgeFor =
    opts.bridge ??
    ((layout: Layout) =>
      new HerdrCli({ bin: layout.herdrBin, env: { ...process.env, ...(layout.herdrSocket ? { HERDR_SOCKET_PATH: layout.herdrSocket } : {}) } }));

  const configDir = claudeConfigDir(opts.config);

  return (effect) => {
    switch (effect.kind) {
      case "git.worktree.add":
        addWorktree(opts.root, effect.branch, effect.path);
        return [];
      case "herdr.tab.ensure":
      case "herdr.tab.close": {
        const layout = opts.layout();
        if (!layout) return [];
        try {
          return runHerdr(effect, bridgeFor(layout), layout, opts.root, configDir);
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
        const prompt = { root: opts.root, role: effect.role, thread: t, ticket: effect.ticket };
        try {
          launch({
            root: opts.root,
            herdrBin: layout.herdrBin,
            ...(layout.herdrSocket ? { herdrSocket: layout.herdrSocket } : {}),
            session: effect.session,
            name: effect.name,
            kind: "claude",
            ...(effect.pane ? { pane: effect.pane } : {}),
            ...(effect.splitFrom
              ? {
                  split: {
                    pane: effect.splitFrom,
                    direction: effect.direction ?? "right",
                    cwd: effect.cwd,
                    env: agentEnv({ root: opts.root, role: effect.role, session: effect.session, thread: effect.thread, ticket: effect.ticket, configDir }),
                  },
                }
              : {}),
            args: claudeArgs({ session: effect.session, role: effect.role, systemPrompt: systemPrompt(prompt), config: opts.config, root: opts.root }),
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
          bridgeFor(layout).agentPrompt(effect.pane, effect.text);
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
          bridgeFor(layout).closePane(effect.pane);
        } catch (e) {
          log(`closing pane ${effect.pane} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return [];
      }
      case "session.probe": {
        const layout = opts.layout();
        if (!layout) return [];
        try {
          return bridgeFor(layout).agentExists(effect.pane)
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

function runHerdr(effect: HerdrEffect, bridge: HerdrBridge, layout: Layout, root: string, configDir: string): EventBody[] {
  if (effect.kind === "herdr.tab.ensure") {
    if (effect.tab && bridge.tabExists(effect.tab)) return [];
    const { tabId, rootPaneId } = bridge.createTab({
      workspace: layout.workspace,
      cwd: effect.cwd,
      label: effect.label,
      env: {
        AGT_ROOT: root,
        AGT_THREAD: effect.thread,
        AGT_ROLE: "coordinator",
        AGT_AGENT: "claude-code",
        CLAUDE_CONFIG_DIR: configDir,
        PATH: `${dirname(AGT_BIN)}:${process.env.PATH ?? ""}`,
      },
    });
    return [{ type: "thread.tab_opened", thread: effect.thread, payload: { tab: tabId, rootPane: rootPaneId } }];
  }
  if (bridge.tabExists(effect.tab)) bridge.closeTab(effect.tab);
  return [{ type: "thread.tab_closed", thread: effect.thread, payload: { tab: effect.tab } }];
}
