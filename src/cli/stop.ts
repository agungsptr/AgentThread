import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { paths } from "../project/paths.ts";
import { workersTabOrder } from "../agents/spawn-job.ts";
import type { Layout } from "../domain/types.ts";
import type { State } from "../state/projection.ts";

type Tab = { tabId: string; label: string };

/** What `agt stop` closes in Herdr: every existing thread tab and workers tab (never the main tab), and the logger pane. */
export function stopTargets(state: State, tabs: Tab[]): { tabs: string[]; loggerPane?: string } {
  const main = state.layout?.mainTab;
  const ids = new Set<string>();
  const threads = [...state.threads.values()];
  for (const tab of tabs) {
    if (tab.tabId === main) continue;
    const own = threads.some((t) => t.tab === tab.tabId || workersTabOrder(tab.label, `${t.id}-${t.slug}-workers`) !== undefined);
    if (own) ids.add(tab.tabId);
  }
  return { tabs: tabs.map((t) => t.tabId).filter((id) => ids.has(id)), ...(state.layout ? { loggerPane: state.layout.loggerPane } : {}) };
}

export interface StopDeps {
  readState(): Promise<State>;
  daemonAlive(): Promise<boolean>;
  stopDaemon(): Promise<void>;
  herdr(layout: Layout): { tabList(workspace: string): Tab[]; closeTab(id: string): void; paneExists(pane: string): boolean; closePane(pane: string): void };
  /** The workspace services, as `agt stack stop`: one line per service (none when none are configured). */
  stopStack(): Promise<string[]>;
  /** The main manager: a line when it was stopped, undefined when it was not running. */
  stopMain(): string | undefined;
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * `agt stop`: the daemon first (so nothing reacts to the agents dying), then the thread and workers tabs and the logger,
 * the stack, and the main manager last (it may be the caller). A failed step is reported and the rest still runs.
 * Thread state is kept: the next `agt start` recovers as after a reboot.
 */
export async function runStop(d: StopDeps): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  let code = 0;
  const step = async (name: string, f: () => Promise<void> | void) => {
    try {
      await f();
    } catch (e) {
      lines.push(`${name}: ${why(e)}`);
      code = 1;
    }
  };
  // The state is read before the daemon goes: while it runs, it holds the event log.
  const state = await d.readState();
  await step("daemon", async () => {
    if (!(await d.daemonAlive())) return void lines.push("daemon not running");
    await d.stopDaemon();
    lines.push("daemon stopped");
  });
  const layout = state.layout;
  if (!layout) lines.push("no Herdr layout: no tabs to close");
  else
    await step("herdr", () => {
      const h = d.herdr(layout);
      const targets = stopTargets(state, h.tabList(layout.workspace));
      for (const id of targets.tabs) h.closeTab(id);
      lines.push(`closed ${targets.tabs.length} thread tab${targets.tabs.length === 1 ? "" : "s"}`);
      if (targets.loggerPane && h.paneExists(targets.loggerPane)) {
        h.closePane(targets.loggerPane);
        lines.push("logger pane closed");
      }
    });
  await step("stack", async () => void lines.push(...(await d.stopStack())));
  await step("main manager", () => void lines.push(d.stopMain() ?? "main manager not running"));
  return { code, lines };
}

/** `agt start` records the main agent's pid and binary here while it runs (one per line). */
export const mainPidFile = (root: string): string => join(paths(root).dir, "main.pid");

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Stops the main manager `agt start` launched: SIGTERM to the recorded pid, only while that process is alive and its
 * command line names the recorded binary (a recycled pid belongs to someone else). The file is removed whenever it was
 * read. Returns the line to print, or undefined when no main manager was running.
 */
export function stopMainManager(root: string, kill: (pid: number, signal: NodeJS.Signals) => void = (pid, s) => process.kill(pid, s)): string | undefined {
  const file = mainPidFile(root);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  rmSync(file, { force: true });
  const [pidText, bin] = text.split("\n").map((l) => l.trim());
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0 || !bin || !alive(pid)) return undefined;
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  if (ps.status !== 0 || !ps.stdout.includes(basename(bin))) return undefined;
  kill(pid, "SIGTERM");
  return "main manager stopped";
}
