import { describe, expect, test } from "bun:test";
import type { Layout } from "../../src/domain/types.ts";
import { mainPidFile, removeMainPid, runStop, stopMainManager, stopTargets, writeMainPid, type StopDeps } from "../../src/cli/stop.ts";
import { INIT, stateOf, taskThreadCreated } from "../helpers.ts";
import type { State } from "../../src/state/projection.ts";

const LAYOUT: Layout = { workspace: "w1", mainTab: "w1:t1", managerPane: "w1:p1", loggerPane: "w1:p2", herdrBin: "herdr" };

/** Two threads with tabs, one with a workers tab, and the layout registered. */
function state(withLayout = true): State {
  return stateOf(
    INIT,
    ...(withLayout ? [{ type: "layout.registered" as const, payload: LAYOUT }] : []),
    taskThreadCreated("001", "pay-1"),
    { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p3" } },
    taskThreadCreated("002", "rv-1", { threadType: "review" }),
    { type: "thread.tab_opened", thread: "002", payload: { tab: "w1:t3", rootPane: "w1:p4" } },
  );
}

const TABS = [
  { tabId: "w1:t1", label: "main" },
  { tabId: "w1:t2", label: "001-thread-001" },
  { tabId: "w1:t3", label: "002-thread-002" },
  { tabId: "w1:t4", label: "001-thread-001-workers" },
  { tabId: "w1:t5", label: "001-thread-001-workers-2" },
  { tabId: "w1:t6", label: "my own tab" },
];

function fakes(o: { state?: State; alive?: boolean; tabs?: { tabId: string; label: string }[]; herdrThrows?: boolean; logger?: boolean } = {}) {
  const calls: string[] = [];
  const deps: StopDeps = {
    readState: async () => o.state ?? state(),
    daemonAlive: async () => o.alive ?? true,
    stopDaemon: async () => void calls.push("stopDaemon"),
    herdr: () => ({
      tabList: () => {
        if (o.herdrThrows) throw new Error("herdr is not running");
        return o.tabs ?? TABS;
      },
      closeTab: (id) => void calls.push(`closeTab ${id}`),
      paneExists: () => o.logger ?? true,
      closePane: (p) => void calls.push(`closePane ${p}`),
    }),
    stopStack: async () => {
      calls.push("stopStack");
      return ["stack: api stopped"];
    },
    stopMain: () => {
      calls.push("stopMain");
      return "main manager stopped";
    },
  };
  return { calls, deps };
}

describe("stopTargets", () => {
  test("every thread and workers tab that exists, never the main tab or a tab of the user's own", () => {
    expect(stopTargets(state(), TABS)).toEqual({ tabs: ["w1:t2", "w1:t3", "w1:t4", "w1:t5"], loggerPane: "w1:p2" });
  });

  test("a tab already closed by hand is skipped", () => {
    expect(stopTargets(state(), TABS.filter((t) => t.tabId !== "w1:t3")).tabs).toEqual(["w1:t2", "w1:t4", "w1:t5"]);
  });
});

describe("stopTargets: recorded ids", () => {
  test("a recorded thread tab id whose label is not agt's (a recycled id) is never closed", () => {
    const tabs = [{ tabId: "w1:t2", label: "my notes" }, ...TABS.filter((t) => t.tabId !== "w1:t2")];
    expect(stopTargets(state(), tabs).tabs).toEqual(["w1:t3", "w1:t4", "w1:t5"]);
  });
});

describe("runStop", () => {
  test("a state that cannot be read: the daemon, stack and main still stop, no tabs are touched", async () => {
    const { calls, deps } = fakes();
    deps.readState = async () => {
      throw new Error("database is locked");
    };
    const r = await runStop(deps);
    expect(calls).toEqual(["stopDaemon", "stopStack", "stopMain"]);
    expect(r.lines).toContain("state: database is locked; no tabs closed");
    expect(r.code).toBe(1);
  });

  test("one tab that fails to close does not keep the others open; a tab already gone is not an error", async () => {
    const { calls, deps } = fakes();
    const h = deps.herdr;
    deps.herdr = (l) => ({
      ...h(l),
      closeTab: (id) => {
        if (id === "w1:t2") throw new Error("tab_not_found: w1:t2");
        if (id === "w1:t3") throw new Error("permission denied");
        calls.push(`closeTab ${id}`);
      },
    });
    const r = await runStop(deps);
    expect(calls).toEqual(["stopDaemon", "closeTab w1:t4", "closeTab w1:t5", "closePane w1:p2", "stopStack", "stopMain"]);
    expect(r.lines).toContain("closed 2 thread tabs");
    expect(r.lines).toContain("herdr: closing tab w1:t3: permission denied");
    expect(r.code).toBe(1);
  });

  test("Herdr not reachable (after a reboot): nothing to close, not an error", async () => {
    const { calls, deps } = fakes({ herdrThrows: true });
    const r = await runStop(deps);
    expect(calls).toEqual(["stopDaemon", "stopStack", "stopMain"]);
    expect(r.lines).toContain("Herdr not reachable (herdr is not running): no tabs to close");
    expect(r.code).toBe(0);
  });

  test("stops the daemon, closes the tabs and the logger, stops the stack, then the main manager, in that order", async () => {
    const { calls, deps } = fakes();
    const r = await runStop(deps);
    expect(calls).toEqual(["stopDaemon", "closeTab w1:t2", "closeTab w1:t3", "closeTab w1:t4", "closeTab w1:t5", "closePane w1:p2", "stopStack", "stopMain"]);
    expect(r).toEqual({ code: 0, lines: ["daemon stopped", "closed 4 thread tabs", "logger pane closed", "stack: api stopped", "main manager stopped"] });
  });

  test("a daemon that is not running: the rest still stops", async () => {
    const { calls, deps } = fakes({ alive: false });
    const r = await runStop(deps);
    expect(calls[0]).toBe("closeTab w1:t2");
    expect(r.lines[0]).toBe("daemon not running");
    expect(r.code).toBe(0);
  });

  test("no Herdr layout: no Herdr calls, the daemon, stack and main still stop", async () => {
    const { calls, deps } = fakes({ state: state(false) });
    const r = await runStop(deps);
    expect(calls).toEqual(["stopDaemon", "stopStack", "stopMain"]);
    expect(r.lines).toContain("no Herdr layout: no tabs to close");
  });

  test("a logger pane already gone is not closed; a main manager not running says so", async () => {
    const { calls, deps } = fakes({ logger: false });
    deps.stopMain = () => undefined;
    const r = await runStop(deps);
    expect(calls).not.toContain("closePane w1:p2");
    expect(r.lines).toContain("main manager not running");
  });
});

describe("stopMainManager", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const project = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agt-stop-")));
    mkdirSync(join(root, ".agentthread"), { recursive: true });
    return root;
  };

  test("signals the recorded main agent with SIGTERM and removes the file", async () => {
    const root = project();
    const child = Bun.spawn(["sleep", "30"]);
    writeFileSync(mainPidFile(root), `${child.pid}\nsleep\n`);
    expect(stopMainManager(root)).toBe("main manager stopped");
    expect(await child.exited).not.toBe(0);
    expect(child.signalCode).toBe("SIGTERM");
    expect(existsSync(mainPidFile(root))).toBe(false);
  });

  test("a pid whose process is not the recorded agent is never signalled", () => {
    const root = project();
    const child = Bun.spawn(["sleep", "30"]);
    writeFileSync(mainPidFile(root), `${child.pid}\nclaude\n`);
    const sent: number[] = [];
    expect(stopMainManager(root, (pid) => void sent.push(pid))).toBeUndefined();
    expect(sent).toEqual([]);
    expect(existsSync(mainPidFile(root))).toBe(false);
    child.kill();
  });

  test("a dead pid or no file: nothing signalled", () => {
    const root = project();
    const sent: number[] = [];
    expect(stopMainManager(root, (pid) => void sent.push(pid))).toBeUndefined();
    writeFileSync(mainPidFile(root), "999999\nclaude\n");
    expect(stopMainManager(root, (pid) => void sent.push(pid))).toBeUndefined();
    expect(sent).toEqual([]);
    expect(existsSync(mainPidFile(root))).toBe(false);
  });
});

describe("main.pid identity and removal", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const project = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agt-stop-")));
    mkdirSync(join(root, ".agentthread"), { recursive: true });
    return root;
  };

  test("a recorded start time that differs (a recycled pid) is never signalled", () => {
    const root = project();
    const child = Bun.spawn(["sleep", "30"]);
    writeFileSync(mainPidFile(root), `${child.pid}\nsleep\nMon Jan  1 00:00:00 2001\n`);
    const sent: number[] = [];
    expect(stopMainManager(root, (pid) => void sent.push(pid))).toBeUndefined();
    expect(sent).toEqual([]);
    child.kill();
  });

  test("the recorded start time of the live process matches: signalled", async () => {
    const root = project();
    const child = Bun.spawn(["sleep", "30"]);
    writeMainPid(root, child.pid, "sleep");
    expect(stopMainManager(root)).toBe("main manager stopped");
    await child.exited;
    expect(child.signalCode).toBe("SIGTERM");
  });

  test("removeMainPid removes the file only while it still holds that pid", () => {
    const root = project();
    writeFileSync(mainPidFile(root), "111\nclaude\n");
    removeMainPid(root, 222);
    expect(existsSync(mainPidFile(root))).toBe(true);
    removeMainPid(root, 111);
    expect(existsSync(mainPidFile(root))).toBe(false);
  });
});
