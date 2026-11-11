import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJob, encodeJob, launchSpawnJob, reportWithRetry, runSpawnJob, spawnTrustPolls, type SpawnJob } from "../../src/agents/spawn-job.ts";
import { HerdrError, type HerdrBridge } from "../../src/herdr/bridge.ts";
import { waitFor } from "../helpers.ts";
import { P8_DIALOG } from "../fixtures/trust-screens.ts";

const JOB: SpawnJob = {
  root: "/repo", herdrBin: "herdr", session: "s-1", name: "agt-ab12-w001-t1", kind: "claude",
  split: { pane: "w1:p2", direction: "right", cwd: "/wt", env: { AGT_SESSION: "s-1" } }, args: ["--session-id", "s-1"], bootstrap: "Start ticket T1 of thread 001 now.",
};

function bridge(fail?: "start" | "not_ready" | "prompt") {
  const calls: string[] = [];
  const b = {
    splitPane: (o: { pane: string }) => (calls.push(`split ${o.pane}`), "w1:p3"),
    agentStart: (o: { name: string; pane: string }) => {
      calls.push(`start ${o.name} ${o.pane}`);
      if (fail === "start") throw new HerdrError("server_unavailable", "herdr agent start: herdr server unavailable");
      if (fail === "not_ready") throw new HerdrError("agent_not_ready", "herdr agent start: agent is blocked at startup");
    },
    agentPrompt: (t: string, text: string) => {
      calls.push(`prompt ${t} ${text}`);
      if (fail === "prompt" || fail === "not_ready") throw new HerdrError("agent_blocked", "herdr agent prompt: agent is blocked");
    },
    closePane: (p: string) => void calls.push(`close ${p}`),
  } as unknown as HerdrBridge;
  return { b, calls };
}

test("encode/decode round-trips", () => {
  expect(decodeJob(encodeJob(JOB))).toEqual(JOB);
});

test("success: split, start, bootstrap, report attached", async () => {
  const { b, calls } = bridge();
  const reports: object[] = [];
  await runSpawnJob(JOB, { herdr: b, report: async (c) => (reports.push(c), true) });
  expect(calls).toEqual(["split w1:p2", "start agt-ab12-w001-t1 w1:p3", "prompt agt-ab12-w001-t1 Start ticket T1 of thread 001 now."]);
  expect(reports).toEqual([{ cmd: "session.attached", session: "s-1", pane: "w1:p3" }]);
});

test("failure closes the pane it split and reports failed", async () => {
  const { b, calls } = bridge("start");
  const reports: object[] = [];
  await runSpawnJob(JOB, { herdr: b, report: async (c) => (reports.push(c), true) });
  expect(calls.at(-1)).toBe("close w1:p3");
  expect(reports).toEqual([{ cmd: "session.failed", session: "s-1", reason: "herdr agent start: herdr server unavailable" }]);
});

test("existing pane is never closed on failure; empty bootstrap sends no prompt", async () => {
  const { b, calls } = bridge("start");
  await runSpawnJob({ ...JOB, split: undefined, pane: "w1:p2", bootstrap: "" }, { herdr: b, report: async () => true });
  expect(calls).toEqual(["start agt-ab12-w001-t1 w1:p2"]);
});

test("agent_not_ready means the agent is in the pane: keep the pane and report attached with the bootstrap pending", async () => {
  const { b, calls } = bridge("not_ready");
  const reports: object[] = [];
  await runSpawnJob(JOB, { herdr: b, report: async (c) => (reports.push(c), true) });
  expect(calls).not.toContain("close w1:p3");
  expect(reports).toEqual([{ cmd: "session.attached", session: "s-1", pane: "w1:p3", pending: "Start ticket T1 of thread 001 now." }]);
});

test("a failed bootstrap prompt still reports attached, with the bootstrap pending", async () => {
  const { b, calls } = bridge("prompt");
  const reports: object[] = [];
  await runSpawnJob(JOB, { herdr: b, report: async (c) => (reports.push(c), true) });
  expect(calls).toEqual(["split w1:p2", "start agt-ab12-w001-t1 w1:p3", "prompt agt-ab12-w001-t1 Start ticket T1 of thread 001 now."]);
  expect(reports).toEqual([{ cmd: "session.attached", session: "s-1", pane: "w1:p3", pending: "Start ticket T1 of thread 001 now." }]);
});

test("an async spawn error is written to the log instead of crashing the daemon", () => {
  const logFile = join(mkdtempSync(join(tmpdir(), "agt-spawn-")), "daemon.log");
  const child = Object.assign(new EventEmitter(), { unref: () => {} });
  launchSpawnJob(JOB, { logFile, spawn: (() => child) as never });
  child.emit("error", new Error("EAGAIN"));
  expect(readFileSync(logFile, "utf8")).toContain("spawn job for session s-1 failed: EAGAIN");
});

test("the spawner child writes to the log without handing it a parent fd (Bun closes such fds again on GC)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agt-spawn-"));
  const logFile = join(dir, "daemon.log");
  let pid: number | undefined;
  launchSpawnJob({ ...JOB, root: dir, herdrBin: "/nonexistent/herdr" }, {
    logFile,
    spawn: ((cmd: string, args: string[], o: object) => {
      const child = spawn(cmd, args, o as never);
      pid = child.pid;
      return child;
    }) as never,
  });
  // an fd opened now may reuse a number the launch used; the child's exit and a GC must leave it open
  const probe = openSync(join(dir, "probe"), "w");
  try {
    await waitFor(() => existsSync(logFile) && readFileSync(logFile, "utf8").includes("agt __spawn"), 10_000);
    await waitFor(() => {
      try {
        process.kill(pid!, 0);
        return false;
      } catch {
        return true;
      }
    }, 10_000);
    Bun.gc(true);
    await Bun.sleep(50);
    expect(() => fstatSync(probe)).not.toThrow();
  } finally {
    closeSync(probe);
  }
}, 15_000);

test("a split whose source pane is gone tries the fallback panes in order", async () => {
  const calls: string[] = [];
  const b = {
    splitPane: (o: { pane: string }) => {
      calls.push(`split ${o.pane}`);
      if (o.pane !== "w1:p5") throw new HerdrError("pane_not_found", "herdr pane split: pane not found");
      return "w1:p6";
    },
    agentStart: (o: { name: string; pane: string }) => void calls.push(`start ${o.pane}`),
    agentPrompt: () => {},
    closePane: (p: string) => void calls.push(`close ${p}`),
  } as unknown as HerdrBridge;
  const reports: object[] = [];
  await runSpawnJob({ ...JOB, split: { ...JOB.split!, fallbacks: ["w1:p4", "w1:p5"] } }, { herdr: b, report: async (c) => (reports.push(c), true) });
  expect(calls).toEqual(["split w1:p2", "split w1:p4", "split w1:p5", "start w1:p6"]);
  expect(reports).toEqual([{ cmd: "session.attached", session: "s-1", pane: "w1:p6" }]);
  // any other split error is not retried
  calls.length = 0;
  const other = { ...b, splitPane: (o: { pane: string }) => { calls.push(`split ${o.pane}`); throw new HerdrError("server_unavailable", "down"); } } as unknown as HerdrBridge;
  await runSpawnJob({ ...JOB, split: { ...JOB.split!, fallbacks: ["w1:p5"] } }, { herdr: other, report: async () => true });
  expect(calls).toEqual(["split w1:p2"]);
});

test("agent start in a just-split pane whose shell is not at its prompt yet (agent_pane_busy) is retried", async () => {
  // Real Herdr 0.9.3 answers agent_pane_busy right after a pane split, until the new shell reaches its prompt.
  const calls: string[] = [];
  let busy = 2;
  const b = {
    splitPane: () => "w1:p3",
    agentStart: (o: { pane: string }) => {
      calls.push(`start ${o.pane}`);
      if (busy-- > 0) throw new HerdrError("agent_pane_busy", "herdr agent start: agent target pane w1:p3 is not an available shell");
    },
    agentPrompt: () => {},
    closePane: (p: string) => void calls.push(`close ${p}`),
  } as unknown as HerdrBridge;
  const reports: object[] = [];
  await runSpawnJob(JOB, { herdr: b, report: async (c) => (reports.push(c), true), sleep: async () => {} });
  expect(calls).toEqual(["start w1:p3", "start w1:p3", "start w1:p3"]);
  expect(reports).toEqual([{ cmd: "session.attached", session: "s-1", pane: "w1:p3" }]);
  // a pane that stays busy fails in the end, and the split pane is closed again
  calls.length = 0;
  busy = 1e9;
  const failed: object[] = [];
  await runSpawnJob(JOB, { herdr: b, report: async (c) => (failed.push(c), true), sleep: async () => {}, busyRetries: 3 });
  expect(calls).toEqual(["start w1:p3", "start w1:p3", "start w1:p3", "start w1:p3", "close w1:p3"]);
  expect(failed).toEqual([{ cmd: "session.failed", session: "s-1", reason: "herdr agent start: agent target pane w1:p3 is not an available shell" }]);
});

test("reportWithRetry retries a connect error and a shutting-down reply, and stops at the first ok", async () => {
  const replies: Array<() => { ok: boolean; error?: string }> = [
    () => { throw new Error("connect ENOENT"); },
    () => ({ ok: false, error: "daemon is shutting down" }),
    () => ({ ok: true }),
    () => { throw new Error("must not be called"); },
  ];
  let calls = 0;
  await reportWithRetry(async () => replies[calls++]!(), { delayMs: 1 });
  expect(calls).toBe(3);
});

test("reportWithRetry gives up after the attempts, and never retries another refusal", async () => {
  let calls = 0;
  await reportWithRetry(async () => (calls++, { ok: false, error: "unknown session x" }), { delayMs: 1 });
  expect(calls).toBe(1);
  calls = 0;
  await reportWithRetry(async () => { calls++; throw new Error("down"); }, { attempts: 4, delayMs: 1 });
  expect(calls).toBe(4);
  calls = 0;
  await reportWithRetry(async () => (calls++, { ok: false, error: "daemon is shutting down" }), { delayMs: 1 });
  expect(calls).toBe(20);
});

test("reportWithRetry says whether the report was delivered and accepted", async () => {
  expect(await reportWithRetry(async () => ({ ok: true }), { delayMs: 1 })).toBe(true);
  expect(await reportWithRetry(async () => ({ ok: false, error: "session s-1 is no longer live" }), { delayMs: 1 })).toBe(false);
  expect(await reportWithRetry(async () => { throw new Error("down"); }, { attempts: 2, delayMs: 1 })).toBe(false);
  expect(await reportWithRetry(async () => ({ ok: false, error: "daemon is shutting down" }), { attempts: 2, delayMs: 1 })).toBe(false);
});

/** Runs `fn` with console.error captured. */
async function captureErrors(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return lines;
}

test("an attach report the daemon refuses or never gets stops the agent: the split pane is closed", async () => {
  const { b, calls } = bridge();
  const reports: object[] = [];
  const logged = await captureErrors(() => runSpawnJob(JOB, { herdr: b, report: async (c) => (reports.push(c), false) }));
  expect(calls).toEqual(["split w1:p2", "start agt-ab12-w001-t1 w1:p3", "prompt agt-ab12-w001-t1 Start ticket T1 of thread 001 now.", "close w1:p3"]);
  // no session.failed report follows: the daemon already failed the session (or cannot be reached)
  expect(reports).toEqual([{ cmd: "session.attached", session: "s-1", pane: "w1:p3" }]);
  expect(logged).toEqual(["agt __spawn: session s-1 was failed by the daemon; stopped its agent"]);
});

test("a refused attach report for an agent started in a given root pane closes that pane only", async () => {
  const { b, calls } = bridge();
  const logged = await captureErrors(() =>
    runSpawnJob({ ...JOB, split: undefined, pane: "w1:p2" }, { herdr: b, report: async () => false }),
  );
  expect(calls).toEqual(["start agt-ab12-w001-t1 w1:p2", "prompt agt-ab12-w001-t1 Start ticket T1 of thread 001 now.", "close w1:p2"]);
  expect(logged).toEqual(["agt __spawn: session s-1 was failed by the daemon; stopped its agent"]);
  // an accepted report closes nothing
  calls.length = 0;
  await runSpawnJob({ ...JOB, split: undefined, pane: "w1:p2" }, { herdr: b, report: async () => true });
  expect(calls.some((c) => c.startsWith("close"))).toBe(false);
});

test("the report retry window is overridable from the environment (tests keep spawn jobs short-lived)", async () => {
  const { spawnReportRetry } = await import("../../src/agents/spawn-job.ts");
  expect(spawnReportRetry({})).toEqual({ attempts: 20, delayMs: 500 });
  expect(spawnReportRetry({ AGT_SPAWN_REPORT_ATTEMPTS: "3", AGT_SPAWN_REPORT_DELAY_MS: "50" })).toEqual({ attempts: 3, delayMs: 50 });
  expect(spawnReportRetry({ AGT_SPAWN_REPORT_ATTEMPTS: "x", AGT_SPAWN_REPORT_DELAY_MS: "-1" })).toEqual({ attempts: 20, delayMs: 500 });
});

test("a pane job exports its process env in that pane before the agent starts; a split job carries it in the split env", async () => {
  const calls: string[] = [];
  const b = {
    splitPane: (o: { pane: string; env: Record<string, string> }) => (calls.push(`split ${o.pane} ${JSON.stringify(o.env)}`), "w1:p3"),
    runInPane: (p: string, cmd: string) => void calls.push(`run ${p} ${cmd}`),
    agentStart: (o: { pane: string }) => void calls.push(`start ${o.pane}`),
    agentPrompt: () => {},
    closePane: () => {},
  } as unknown as HerdrBridge;
  await runSpawnJob({ ...JOB, split: undefined, pane: "w1:p1", exportEnv: { AGT_AGENT_PROCESS: "1" }, bootstrap: "" }, { herdr: b, report: async () => true });
  expect(calls).toEqual(["run w1:p1  export AGT_AGENT_PROCESS='1'", "start w1:p1"]);
  calls.length = 0;
  await runSpawnJob({ ...JOB, bootstrap: "" }, { herdr: b, report: async () => true });
  expect(calls).toEqual([`split w1:p2 {"AGT_SESSION":"s-1"}`, "start w1:p3"]);
});

// ---------- Claude Code's workspace-trust dialog in folders agt created ----------

const TRUST_SCREEN = "Accessing workspace:\n\n Quick safety check: Is this a project you created or one you trust?\n ❯ 1. No, exit\n   2. Yes, I trust this folder";

/** A root with a thread folder under `.worktrees/`, at its unresolved tmpdir path (macOS: /var, really /private/var). */
function trustRoot(): { root: string; thread: string } {
  const root = mkdtempSync(join(tmpdir(), "agt-trust-"));
  const thread = join(root, ".worktrees", "001-task");
  mkdirSync(thread, { recursive: true });
  return { root, thread };
}

type Status = "idle" | "working" | "blocked" | "done" | "unknown" | "absent";

/**
 * A fake Herdr screen: successive polls see `polls[i]` (the last one repeats), a pane's agent status and its visible
 * screen. Answering the dialog (enter) clears it, as Claude Code does. `events` records reads, keys and anything else.
 */
function screen(polls: { status: Status; text: string }[], events: string[] = []) {
  let i = 0;
  let answered = false;
  let moved = false; // `down` moves the dialog's cursor to "Yes"
  const select = (p: { status: Status; text: string }) => (moved ? { ...p, text: p.text.replace("❯ 1. No", "  1. No").replace("  2. Yes", "❯ 2. Yes") } : p);
  const now = () => (answered ? { status: "working" as Status, text: "Welcome to Claude Code" } : select(polls[Math.min(i, polls.length - 1)]!));
  return {
    events,
    reads: () => events.filter((e) => e.startsWith("read")).length,
    keys: () => events.filter((e) => e.startsWith("keys")),
    agentListAsync: async () => {
      const st = now().status;
      i++;
      return st === "absent" ? [] : ["w1:p1", "w1:p3"].map((pane) => ({ pane, status: st, kind: "claude" }));
    },
    paneReadAsync: async (pane: string) => (events.push(`read ${pane}`), now().text),
    paneSendKeysAsync: async (pane: string, key: string) => {
      events.push(`keys ${pane} ${key}`);
      if (key === "down") moved = true;
      if (key === "enter") answered = true;
    },
  } as const;
}

const DIALOG = { status: "blocked", text: TRUST_SCREEN } as const;
const STARTING = { status: "absent", text: "" } as const;
const noSleep = async () => {};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

test("a blocked agent showing the trust dialog in a pane under <root>/.worktrees/ is answered once (down, enter), and logged", async () => {
  const { root, thread } = trustRoot();
  const { b } = bridge("not_ready");
  const s = screen([STARTING, DIALOG]);
  const logs: string[] = [];
  await runSpawnJob(
    { ...JOB, root, split: { ...JOB.split!, cwd: thread } },
    { herdr: b, screen: s, report: async () => true, sleep: noSleep, log: (m) => void logs.push(m) },
  );
  expect(s.keys()).toEqual(["keys w1:p3 down", "keys w1:p3 enter"]);
  expect(logs).toEqual([`trusted ${thread} for Claude Code (a folder agt created)`]);
});

test("the dialog is answered while Herdr's agent start is still waiting for the agent to be ready", async () => {
  const { root, thread } = trustRoot();
  const { b } = bridge();
  const events: string[] = [];
  const s = screen([STARTING, DIALOG], events);
  // Real Herdr's `agent start --timeout` returns only once the agent is ready, which the dialog prevents.
  (b as { agentStartAsync?: unknown }).agentStartAsync = async () => {
    for (let i = 0; i < 1_000 && s.keys().length < 2; i++) await tick();
    events.push("start resolved");
  };
  await runSpawnJob({ ...JOB, root, split: undefined, pane: "w1:p1", cwd: thread }, { herdr: b, screen: s, report: async () => true, sleep: tick, log: () => {} });
  expect(events.filter((e) => !e.startsWith("read"))).toEqual(["keys w1:p1 down", "keys w1:p1 enter", "start resolved"]);
});

test("dialog text that is not waiting (no footer last) on an agent that is not blocked is never answered, and holds the bootstrap", async () => {
  const { root, thread } = trustRoot();
  for (const status of ["working", "idle"] as const) {
    const { b, calls } = bridge();
    const s = screen([STARTING, { status, text: TRUST_SCREEN }]);
    const reports: object[] = [];
    await runSpawnJob({ ...JOB, root, split: { ...JOB.split!, cwd: thread } }, { herdr: b, screen: s, report: async (c) => (reports.push(c), true), sleep: noSleep, log: () => {} });
    expect(s.keys()).toEqual([]);
    // Herdr may list an agent at a dialog idle (Task 8): before an answer, its fragments on screen mean it is not past it.
    expect(calls.filter((c) => c.startsWith("prompt"))).toEqual([]);
    expect(reports).toEqual([{ cmd: "session.attached", session: "s-1", pane: "w1:p3", pending: JOB.bootstrap }]);
  }
});

test("a blocked agent whose screen only mentions trust (no dialog options) is not answered", async () => {
  const { root, thread } = trustRoot();
  const { b } = bridge("not_ready");
  const s = screen([{ status: "blocked", text: "Do you trust the files? (a message, not the dialog)" }]);
  await runSpawnJob({ ...JOB, root, split: { ...JOB.split!, cwd: thread } }, { herdr: b, screen: s, report: async () => true, sleep: noSleep, log: () => {} });
  expect(s.keys()).toEqual([]);
});

test("a pane outside <root>/.worktrees/ is never answered: that trust is the user's choice; its one read is the bootstrap's check", async () => {
  const { root } = trustRoot();
  for (const cwd of [root, join(root, "api"), `${root}/.worktrees-other/x`]) {
    const { b } = bridge("not_ready");
    const s = screen([DIALOG]);
    await runSpawnJob({ ...JOB, root, split: { ...JOB.split!, cwd } }, { herdr: b, screen: s, report: async () => true, sleep: noSleep, log: () => {} });
    expect(s.events).toEqual(["read w1:p3"]);
  }
});

test("no trust dialog within the watch (about 60s) sends no keys, and the watch ends", async () => {
  const { root, thread } = trustRoot();
  const { b } = bridge("not_ready");
  const s = screen([{ status: "blocked", text: "An MCP server needs approval" }]);
  await runSpawnJob({ ...JOB, root, split: { ...JOB.split!, cwd: thread } }, { herdr: b, screen: s, report: async () => true, sleep: noSleep, log: () => {} });
  expect(s.reads()).toBe(61); // 60 by the watch, then the bootstrap's check (the watch never saw the agent ready)
  expect(s.keys()).toEqual([]);
});

test("another agent kind is never answered (adapters opt in through trustPrompt)", async () => {
  const { root, thread } = trustRoot();
  const { b } = bridge("not_ready");
  const s = screen([DIALOG]);
  await runSpawnJob({ ...JOB, kind: "opencode", root, split: { ...JOB.split!, cwd: thread } }, { herdr: b, screen: s, report: async () => true, sleep: noSleep, log: () => {} });
  expect(s.events).toEqual([]);
});

test("a failed start or a refused report ends the trust watch without keys", async () => {
  const { root, thread } = trustRoot();
  const failed = bridge("start");
  const s1 = screen([STARTING, STARTING, DIALOG]);
  await runSpawnJob({ ...JOB, root, split: { ...JOB.split!, cwd: thread } }, { herdr: failed.b, screen: s1, report: async () => true, sleep: noSleep, log: () => {} });
  expect(s1.keys()).toEqual([]);
  // A watch still running when the attach deadline releases the report: refused, the report stops it before the dialog.
  const refused = bridge("not_ready");
  const s2 = screen([STARTING, STARTING, STARTING, STARTING, DIALOG]);
  let now = 0;
  await runSpawnJob(
    { ...JOB, root, split: { ...JOB.split!, cwd: thread }, attachBy: 1_000 },
    { herdr: refused.b, screen: s2, report: async () => false, now: () => now, sleep: async (ms) => ((now += ms), tick()), log: () => {} },
  );
  expect(s2.keys()).toEqual([]);
});

test("a start retried while the pane's shell is busy keeps one watch, which answers after the launch", async () => {
  const { root, thread } = trustRoot();
  const { b } = bridge();
  let busy = 3;
  const events: string[] = [];
  (b as { agentStart: unknown }).agentStart = () => {
    if (busy-- > 0) throw new HerdrError("agent_pane_busy", "busy");
    events.push("launched");
    throw new HerdrError("agent_not_ready", "blocked at startup");
  };
  const s = screen([STARTING, DIALOG], events);
  await runSpawnJob({ ...JOB, root, split: { ...JOB.split!, cwd: thread } }, { herdr: b, screen: s, report: async () => true, sleep: noSleep, log: () => {} });
  expect(s.keys()).toEqual(["keys w1:p3 down", "keys w1:p3 enter"]);
  expect(events.indexOf("launched")).toBeLessThan(events.indexOf("keys w1:p3 down"));
});

test("the trust watch's length is overridable from the environment, and 0 turns it off (tests keep jobs short-lived)", async () => {
  expect(spawnTrustPolls({})).toBe(60);
  expect(spawnTrustPolls({ AGT_SPAWN_TRUST_POLLS: "0" })).toBe(0);
  expect(spawnTrustPolls({ AGT_SPAWN_TRUST_POLLS: "-1" })).toBe(60);
  const { root, thread } = trustRoot();
  const { b } = bridge("not_ready");
  const s = screen([DIALOG]);
  await runSpawnJob({ ...JOB, root, split: { ...JOB.split!, cwd: thread } }, { herdr: b, screen: s, trustPolls: 0, report: async () => true, sleep: noSleep, log: () => {} });
  expect(s.events).toEqual(["read w1:p3"]); // only the bootstrap's check
});

test("before Herdr confirms the launch, the pane's previous agent seen idle or done does not end the watch", async () => {
  const { root, thread } = trustRoot();
  const { b } = bridge();
  const events: string[] = [];
  // The pane's earlier agent is listed done until the new one starts and shows the dialog.
  const s = screen([{ status: "done", text: "" }, { status: "done", text: "" }, DIALOG], events);
  (b as { agentStartAsync?: unknown }).agentStartAsync = async () => {
    for (let i = 0; i < 1_000 && s.keys().length < 2; i++) await tick();
  };
  await runSpawnJob({ ...JOB, root, split: undefined, pane: "w1:p1", cwd: thread }, { herdr: b, screen: s, report: async () => true, sleep: tick, log: () => {} });
  expect(s.keys()).toEqual(["keys w1:p1 down", "keys w1:p1 enter"]);
});

// ---------- screen evidence in the daemon log ----------

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

test("a failed agent start writes the pane's visible screen (its last 40 lines) to the log before closing the pane", async () => {
  const { b, calls } = bridge("start");
  const events: string[] = [];
  const s = screen([{ status: "unknown", text: lines(50) }], events);
  const logs: string[] = [];
  await runSpawnJob(JOB, { herdr: b, screen: s, report: async () => true, sleep: noSleep, log: (m) => void logs.push(m) });
  expect(logs).toEqual([`agent start failed in pane w1:p3 (session s-1); its screen:\n${lines(50).split("\n").slice(-40).join("\n")}`]);
  expect(calls.at(-1)).toBe("close w1:p3");
});

test("a failed start whose screen cannot be read still reports failed", async () => {
  const { b } = bridge("start");
  const s = { ...screen([STARTING]), paneReadAsync: async () => Promise.reject(new Error("gone")) };
  const reports: object[] = [];
  const logs: string[] = [];
  await runSpawnJob(JOB, { herdr: b, screen: s, report: async (c) => (reports.push(c), true), sleep: noSleep, log: (m) => void logs.push(m) });
  expect(reports).toEqual([expect.objectContaining({ cmd: "session.failed" })]);
  expect(logs).toEqual([]);
});

test("a trust watch that ends without answering while the agent is blocked writes its screen to the log", async () => {
  const { root, thread } = trustRoot();
  const { b } = bridge("not_ready");
  const s = screen([{ status: "blocked", text: "An MCP server needs approval" }]);
  const logs: string[] = [];
  await runSpawnJob({ ...JOB, root, split: { ...JOB.split!, cwd: thread } }, { herdr: b, screen: s, report: async () => true, sleep: noSleep, log: (m) => void logs.push(m) });
  expect(s.reads()).toBe(61); // the watch's last (60th) read is the one logged; the 61st is the bootstrap's check
  expect(logs).toEqual(["the trust watch ended unanswered while the agent in pane w1:p3 (session s-1) was blocked; its screen:\nAn MCP server needs approval"]);
});

test("a trust watch that ends with the agent running, or never blocked, logs no screen", async () => {
  const { root, thread } = trustRoot();
  for (const polls of [[STARTING, { status: "idle", text: "" }], [STARTING]] as { status: Status; text: string }[][]) {
    const { b } = bridge();
    const s = screen(polls);
    const logs: string[] = [];
    await runSpawnJob({ ...JOB, root, split: { ...JOB.split!, cwd: thread } }, { herdr: b, screen: s, report: async () => true, sleep: noSleep, log: (m) => void logs.push(m) });
    expect(logs).toEqual([]);
  }
});

// ---------- Plan 13 Task 7: a confirmed trust choice, and the bootstrap after the dialog ----------

/** Claude Code's dialog as heavy rerun 3's pane screens show it; the `❯` marks the selected option. */
const drawDialog = (yes: boolean) =>
  ` Quick safety check: Is this a project you created or one you trust?\n\n ${yes ? " " : "❯"} No, exit\n ${yes ? "❯" : " "} Yes, I trust this folder\n\n Enter to confirm · Esc to cancel`;

/**
 * A fake Herdr around one Claude Code start in pane w1:p3, whose screen changes per read. The agent is absent for
 * `absent` polls, then blocked on the trust dialog. `down` is ignored `deaf` times (the dialog does not take input
 * yet), then moves the cursor to "Yes"; with `stuck` it never moves. `enter` on "Yes" trusts the folder: Herdr still
 * lists the agent blocked for `lag` polls, then idle. `enter` on "No, exit" exits Claude (the pane shows a shell).
 * `agentPrompt` is refused while the agent is not idle, as Herdr does; `events` records keys, prompts and reports.
 */
function claudeStart(
  o: {
    absent?: number; deaf?: number; stuck?: boolean; lag?: number; blockedText?: string; trusted?: boolean; draw?: (yes: boolean) => string; listedIdle?: boolean;
    /** The first `blankReads` reads show an empty screen: Claude has not drawn its dialog yet. */
    blankReads?: number;
    /** Once trusted, the screen keeps showing the answered dialog while Herdr lists the agent blocked (`lag`). */
    stale?: boolean;
  } = {},
) {
  const events: string[] = [];
  let polls = 0;
  let deaf = o.deaf ?? 0;
  let yes = false;
  let state: "dialog" | "trusted" | "exited" = o.trusted ? "trusted" : "dialog";
  let lag = o.lag ?? 0;
  const draw = o.draw ?? drawDialog;
  // `listedIdle`: Herdr does not see the dialog (its footer is wrapped in a narrow pane) and lists the agent idle.
  const atDialog = (): Status => (o.listedIdle ? "idle" : "blocked");
  const status = (): Status => (polls <= (o.absent ?? 0) ? "absent" : state === "exited" ? "absent" : state === "trusted" ? (lag > 0 ? "blocked" : "idle") : atDialog());
  let blank = o.blankReads ?? 0;
  const text = () =>
    blank-- > 0
      ? ""
      : state === "dialog"
        ? (o.blockedText ?? draw(yes))
        : state === "trusted"
          ? o.stale && lag > 0 ? draw(true) : "Welcome to Claude Code\n\n> "
          : `${draw(false)}\n$ `;
  const herdr = {
    splitPane: () => "w1:p3",
    agentStart: () => {
      events.push("start");
      throw new HerdrError("agent_not_ready", "blocked at startup");
    },
    agentPrompt: (_name: string, t: string) => {
      if (status() !== "idle") {
        events.push("prompt refused");
        throw new HerdrError("agent_blocked", "herdr agent prompt: agent is blocked and requires interactive input");
      }
      // Herdr types the text and Enter: at the dialog, Enter picks the selected option.
      if (state === "dialog") {
        events.push(`prompt typed into the dialog: enter on ${yes ? "Yes" : "No, exit"}`);
        state = yes ? "trusted" : "exited";
        return;
      }
      events.push(`prompt ${t}`);
    },
    closePane: (p: string) => void events.push(`close ${p}`),
  } as unknown as HerdrBridge;
  const s = {
    agentListAsync: async () => {
      polls++;
      const st = status();
      if (state === "trusted" && lag > 0) lag--;
      return st === "absent" ? [] : [{ pane: "w1:p3", status: st, kind: "claude" }];
    },
    paneReadAsync: async () => text(),
    paneSendKeysAsync: async (_pane: string, key: string) => {
      events.push(`keys ${key}`);
      if (key === "down" && !o.stuck && deaf-- <= 0) yes = true;
      if (key === "enter") state = yes ? "trusted" : "exited";
    },
  };
  return { herdr, screen: s, events, keys: () => events.filter((e) => e.startsWith("keys")) };
}

const trustJob = (thread: string, root: string) => ({ ...JOB, root, split: { ...JOB.split!, cwd: thread } });
const report = (events: string[]) => async (c: object) => (events.push(`report ${JSON.stringify(c)}`), true);

test("a down that lands before the dialog takes input is sent again: enter goes only once 'Yes' is selected", async () => {
  const { root, thread } = trustRoot();
  const c = claudeStart({ absent: 1, deaf: 1 });
  const logs: string[] = [];
  await runSpawnJob(trustJob(thread, root), { herdr: c.herdr, screen: c.screen, report: report(c.events), sleep: noSleep, log: (m) => void logs.push(m) });
  expect(c.keys()).toEqual(["keys down", "keys down", "keys enter"]);
  expect(logs).toEqual([`trusted ${thread} for Claude Code (a folder agt created)`]);
});

test("'No, exit' still selected after 5 downs: enter is never pressed, the screen is logged and the dialog is left to the user", async () => {
  const { root, thread } = trustRoot();
  const c = claudeStart({ absent: 1, stuck: true });
  const logs: string[] = [];
  await runSpawnJob(trustJob(thread, root), { herdr: c.herdr, screen: c.screen, report: report(c.events), sleep: noSleep, log: (m) => void logs.push(m) });
  expect(c.keys()).toEqual(Array(5).fill("keys down"));
  expect(logs).toEqual([
    `the trust dialog in pane w1:p3 (session s-1) did not show "Yes" selected after 5 downs; left it to the user. Its screen:\n${drawDialog(false)}`,
  ]);
  // The agent is still at the dialog: the bootstrap waits in the daemon's queue.
  expect(c.events.at(-1)).toBe(`report ${JSON.stringify({ cmd: "session.attached", session: "s-1", pane: "w1:p3", pending: JOB.bootstrap })}`);
});

test("the bootstrap is held while the trust dialog is up and prompted once it is gone and the agent is idle; the attach report follows", async () => {
  const { root, thread } = trustRoot();
  // Herdr still lists the agent blocked for two polls after the answer, as in heavy rerun 3.
  const c = claudeStart({ absent: 1, lag: 2 });
  await runSpawnJob(trustJob(thread, root), { herdr: c.herdr, screen: c.screen, report: report(c.events), sleep: noSleep, log: () => {} });
  expect(c.events).toEqual([
    "start",
    "keys down",
    "keys enter",
    `prompt ${JOB.bootstrap}`,
    `report ${JSON.stringify({ cmd: "session.attached", session: "s-1", pane: "w1:p3" })}`,
  ]);
});

test("no blocked notice while agt's trust watch runs: the daemon gets the pane to poll only once the watch resolves", async () => {
  const { root, thread } = trustRoot();
  const c = claudeStart({ absent: 2, deaf: 2, lag: 1 });
  await runSpawnJob(trustJob(thread, root), { herdr: c.herdr, screen: c.screen, report: report(c.events), sleep: noSleep, log: () => {} });
  const reported = c.events.findIndex((e) => e.startsWith("report"));
  expect(reported).toBeGreaterThan(c.events.indexOf("keys enter"));
  expect(c.events.filter((e) => e.startsWith("report"))).toHaveLength(1);
});

test("a watch still running at the job's attach deadline releases the report (bootstrap pending) so the sweep does not fail the spawn", async () => {
  const { root, thread } = trustRoot();
  // A dialog agt does not recognize: the watch would read for its whole length.
  const c = claudeStart({ blockedText: "An MCP server needs approval" });
  let now = 1_000;
  await runSpawnJob(
    { ...trustJob(thread, root), attachBy: 11_000 },
    {
      herdr: c.herdr, screen: c.screen, log: () => {}, now: () => now,
      sleep: async (ms) => void (now += ms),
      report: async (cmd) => (c.events.push(`report at ${now}`), expect(cmd).toEqual({ cmd: "session.attached", session: "s-1", pane: "w1:p3", pending: JOB.bootstrap }), true),
    },
  );
  const at = Number(c.events.find((e) => e.startsWith("report at"))!.slice("report at ".length));
  expect(at).toBeGreaterThanOrEqual(11_000);
  expect(at).toBeLessThan(13_000);
});

test("without a dialog the bootstrap goes as soon as the launched agent is listed running", async () => {
  const { root, thread } = trustRoot();
  // Trusted already: the agent comes up idle.
  const c = claudeStart({ absent: 1, trusted: true });
  (c.herdr as { agentStart: unknown }).agentStart = () => void c.events.push("start");
  await runSpawnJob(trustJob(thread, root), { herdr: c.herdr, screen: c.screen, report: report(c.events), sleep: noSleep, log: () => {} });
  expect(c.events).toEqual(["start", `prompt ${JOB.bootstrap}`, `report ${JSON.stringify({ cmd: "session.attached", session: "s-1", pane: "w1:p3" })}`]);
});

test("after the answer the watch keeps reading a still-blocked agent: a second startup dialog's screen is logged when it ends", async () => {
  const { root, thread } = trustRoot();
  const c = claudeStart({ absent: 1 });
  // Once trusted, another startup dialog (not the trust one) keeps the agent blocked.
  const list = c.screen.agentListAsync;
  let trusted = false;
  c.screen.agentListAsync = async () => (trusted ? [{ pane: "w1:p3", status: "blocked", kind: "claude" }] : list());
  const read = c.screen.paneReadAsync;
  c.screen.paneReadAsync = async () => (trusted ? "An MCP server needs approval" : read());
  const send = c.screen.paneSendKeysAsync;
  c.screen.paneSendKeysAsync = async (p, k) => (await send(p, k), void (k === "enter" && (trusted = true)));
  const logs: string[] = [];
  await runSpawnJob(trustJob(thread, root), { herdr: c.herdr, screen: c.screen, report: report(c.events), sleep: noSleep, log: (m) => void logs.push(m) });
  expect(c.keys()).toEqual(["keys down", "keys enter"]);
  expect(logs).toEqual([
    `trusted ${thread} for Claude Code (a folder agt created)`,
    "the trust watch ended unanswered while the agent in pane w1:p3 (session s-1) was blocked; its screen:\nAn MCP server needs approval",
  ]);
});

// ---------- Plan 13 Task 8: Herdr lists an agent idle while its narrow pane shows the trust dialog ----------

/** Heavy rerun 4's pane w1:p5 (ws-cleanup, about 27 columns): the footer "Esc to cancel" is wrapped. */
const drawNarrow = (yes: boolean) =>
  ` Quick safety check: Is\n this a project you\n created or one you trust?\n\n ${yes ? " " : "❯"} No, exit\n ${yes ? "❯" : " "} Yes, I trust this folder\n\n Enter to confirm · Esc to\n cancel`;

test("heavy rerun 4: Herdr lists the agent idle at a wrapped trust dialog; the watch answers it and the bootstrap goes after", async () => {
  const { root, thread } = trustRoot();
  const c = claudeStart({ absent: 1, draw: drawNarrow, listedIdle: true });
  const logs: string[] = [];
  await runSpawnJob(trustJob(thread, root), { herdr: c.herdr, screen: c.screen, report: report(c.events), sleep: noSleep, log: (m) => void logs.push(m) });
  // Before the fix the watch took "idle" for "past the dialog": the bootstrap's Enter picked "No, exit" and Claude exited.
  expect(c.events).toEqual([
    "start",
    "keys down",
    "keys enter",
    `prompt ${JOB.bootstrap}`,
    `report ${JSON.stringify({ cmd: "session.attached", session: "s-1", pane: "w1:p3" })}`,
  ]);
  expect(logs).toEqual([`trusted ${thread} for Claude Code (a folder agt created)`]);
});

test("a dialog agt cannot answer while Herdr lists the agent idle gets no bootstrap: it waits in the daemon's queue", async () => {
  const { root, thread } = trustRoot();
  const c = claudeStart({ absent: 1, draw: drawNarrow, listedIdle: true, stuck: true });
  await runSpawnJob(trustJob(thread, root), { herdr: c.herdr, screen: c.screen, report: report(c.events), sleep: noSleep, log: () => {} });
  expect(c.keys()).toEqual(Array(5).fill("keys down"));
  expect(c.events.filter((e) => e.startsWith("prompt"))).toEqual([]);
  expect(c.events.at(-1)).toBe(`report ${JSON.stringify({ cmd: "session.attached", session: "s-1", pane: "w1:p3", pending: JOB.bootstrap })}`);
});

test("in the user's own folder (no watch) a trust dialog Herdr lists idle gets no keys and no bootstrap", async () => {
  const { root } = trustRoot();
  // Listed from the start (absent: -1): no watch polls Herdr here.
  const c = claudeStart({ absent: -1, draw: drawNarrow, listedIdle: true });
  await runSpawnJob({ ...JOB, root, split: { ...JOB.split!, cwd: join(root, "api") } }, { herdr: c.herdr, screen: c.screen, report: report(c.events), sleep: noSleep, log: () => {} });
  expect(c.events).toEqual(["start", `report ${JSON.stringify({ cmd: "session.attached", session: "s-1", pane: "w1:p3", pending: JOB.bootstrap })}`]);
});

// ---------- Plan 13 Task 8 fix round 1 ----------

test("a dialog chopped beyond reading in a 4-column pane that Herdr lists idle: no keys, no bootstrap, and its screen is logged", async () => {
  const { root, thread } = trustRoot();
  const c = claudeStart({ absent: 1, draw: () => P8_DIALOG, listedIdle: true });
  const logs: string[] = [];
  await runSpawnJob(trustJob(thread, root), { herdr: c.herdr, screen: c.screen, report: report(c.events), sleep: noSleep, log: (m) => void logs.push(m) });
  // Before this round the watch took the idle agent for ready and the bootstrap's Enter picked "No, exit".
  expect(c.events).toEqual(["start", `report ${JSON.stringify({ cmd: "session.attached", session: "s-1", pane: "w1:p3", pending: JOB.bootstrap })}`]);
  expect(logs).toEqual([`the trust watch ended unanswered while the agent in pane w1:p3 (session s-1) was blocked; its screen:\n${P8_DIALOG}`]);
});

test("an agent listed idle before it draws the dialog is not ready on one clear read: the dialog that follows is answered", async () => {
  const { root, thread } = trustRoot();
  const c = claudeStart({ absent: 1, draw: drawNarrow, listedIdle: true, blankReads: 1 });
  await runSpawnJob(trustJob(thread, root), { herdr: c.herdr, screen: c.screen, report: report(c.events), sleep: noSleep, log: () => {} });
  expect(c.events).toEqual(["start", "keys down", "keys enter", `prompt ${JOB.bootstrap}`, `report ${JSON.stringify({ cmd: "session.attached", session: "s-1", pane: "w1:p3" })}`]);
});

test("after the answer, the answered dialog's stale screen while Herdr still lists the agent blocked is not logged as unanswered", async () => {
  const { root, thread } = trustRoot();
  const c = claudeStart({ absent: 1, lag: 100, stale: true });
  const logs: string[] = [];
  await runSpawnJob(trustJob(thread, root), { herdr: c.herdr, screen: c.screen, report: report(c.events), sleep: noSleep, log: (m) => void logs.push(m) });
  expect(c.keys()).toEqual(["keys down", "keys enter"]);
  expect(logs).toEqual([`trusted ${thread} for Claude Code (a folder agt created)`]);
});
