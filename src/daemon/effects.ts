import type { Effect } from "../commands/handler.ts";
import type { EventBody, Layout } from "../domain/types.ts";
import { HerdrCli, type HerdrBridge } from "../herdr/bridge.ts";
import { addWorktree } from "../project/git.ts";

type HerdrEffect = Extract<Effect, { kind: "herdr.tab.ensure" | "herdr.tab.close" }>;

export function createEffectRunner(opts: {
  root: string;
  layout: () => Layout | undefined;
  bridge?: (layout: Layout) => HerdrBridge;
  log?: (message: string) => void;
}): (effect: Effect) => EventBody[] {
  const log = opts.log ?? ((m: string) => console.error(m));
  const bridgeFor =
    opts.bridge ??
    ((layout: Layout) =>
      new HerdrCli({ bin: layout.herdrBin, env: { ...process.env, ...(layout.herdrSocket ? { HERDR_SOCKET_PATH: layout.herdrSocket } : {}) } }));

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
          return runHerdr(effect, bridgeFor(layout), layout, opts.root);
        } catch (e) {
          // Herdr is a view: a failure here must never fail the command. `agt start` reconciles missing tabs.
          log(`herdr ${effect.kind} for thread ${effect.thread} failed: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        }
      }
    }
  };
}

function runHerdr(effect: HerdrEffect, bridge: HerdrBridge, layout: Layout, root: string): EventBody[] {
  if (effect.kind === "herdr.tab.ensure") {
    if (effect.tab && bridge.tabExists(effect.tab)) return [];
    const { tabId, rootPaneId } = bridge.createTab({
      workspace: layout.workspace,
      cwd: effect.cwd,
      label: effect.label,
      env: { AGT_ROOT: root, AGT_THREAD: effect.thread, AGT_ROLE: "coordinator" },
    });
    return [{ type: "thread.tab_opened", thread: effect.thread, payload: { tab: tabId, rootPane: rootPaneId } }];
  }
  if (bridge.tabExists(effect.tab)) bridge.closeTab(effect.tab);
  return [{ type: "thread.tab_closed", thread: effect.thread, payload: { tab: effect.tab } }];
}
