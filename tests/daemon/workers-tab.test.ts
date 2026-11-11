import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { createEffectRunner, type EffectBridge } from "../../src/daemon/effects.ts";
import type { Thread } from "../../src/state/projection.ts";

const LAYOUT = { workspace: "w1", mainTab: "w1:t0", managerPane: "w1:p0", loggerPane: "w1:p00", herdrBin: "/nonexistent/herdr" };

function runner(tabs: { tabId: string; label: string }[], listFails = false) {
  const closed: string[] = [];
  const logs: string[] = [];
  const bridge = {
    tabExists: (tab: string) => tabs.some((t) => t.tabId === tab),
    closeTab: (tab: string) => void closed.push(tab),
    tabList: () => {
      if (listFails) throw new Error("herdr tab list: response missing tabs");
      return tabs;
    },
  } as unknown as EffectBridge;
  const thread = { id: "001", slug: "x" } as Thread;
  const run = createEffectRunner({ root: "/repo", config: DEFAULT_CONFIG, layout: () => LAYOUT, thread: () => thread, bridge: () => bridge, log: (m) => void logs.push(m) });
  return { run, closed, logs };
}

const TABS = [
  { tabId: "w1:t1", label: "001-x" },
  { tabId: "w1:t4", label: "001-x-workers" },
  { tabId: "w1:t6", label: "001-x-workers-2" },
  { tabId: "w1:t7", label: "002-y-workers" },
  { tabId: "w1:t8", label: "001-x-workersish" },
];

test("a done thread's tab close closes its workers tabs too, and no other tab", async () => {
  const r = runner(TABS);
  expect(await r.run({ kind: "herdr.tab.close", thread: "001", tab: "w1:t1", workers: true })).toEqual([{ type: "thread.tab_closed", thread: "001", payload: { tab: "w1:t1" } }]);
  expect(r.closed).toEqual(["w1:t1", "w1:t4", "w1:t6"]);
});

test("a tab closed to be reopened keeps the workers tabs: their workers run on", async () => {
  const r = runner(TABS);
  await r.run({ kind: "herdr.tab.close", thread: "001", tab: "w1:t1" });
  expect(r.closed).toEqual(["w1:t1"]);
});

test("a tab list that fails is logged; the thread tab is still recorded closed", async () => {
  const r = runner(TABS, true);
  expect(await r.run({ kind: "herdr.tab.close", thread: "001", tab: "w1:t1", workers: true })).toEqual([{ type: "thread.tab_closed", thread: "001", payload: { tab: "w1:t1" } }]);
  expect(r.logs).toEqual(["closing the workers tabs of thread 001 failed: herdr tab list: response missing tabs"]);
});
