import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJob, encodeJob, launchSpawnJob, reportWithRetry, runSpawnJob, type SpawnJob } from "../../src/agents/spawn-job.ts";
import { HerdrError, type HerdrBridge } from "../../src/herdr/bridge.ts";
import { waitFor } from "../helpers.ts";

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
