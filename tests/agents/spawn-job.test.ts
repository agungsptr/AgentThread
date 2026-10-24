import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJob, encodeJob, launchSpawnJob, runSpawnJob, type SpawnJob } from "../../src/agents/spawn-job.ts";
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
  await runSpawnJob(JOB, { herdr: b, report: async (c) => void reports.push(c) });
  expect(calls).toEqual(["split w1:p2", "start agt-ab12-w001-t1 w1:p3", "prompt agt-ab12-w001-t1 Start ticket T1 of thread 001 now."]);
  expect(reports).toEqual([{ cmd: "session.attached", session: "s-1", pane: "w1:p3" }]);
});

test("failure closes the pane it split and reports failed", async () => {
  const { b, calls } = bridge("start");
  const reports: object[] = [];
  await runSpawnJob(JOB, { herdr: b, report: async (c) => void reports.push(c) });
  expect(calls.at(-1)).toBe("close w1:p3");
  expect(reports).toEqual([{ cmd: "session.failed", session: "s-1", reason: "herdr agent start: herdr server unavailable" }]);
});

test("existing pane is never closed on failure; empty bootstrap sends no prompt", async () => {
  const { b, calls } = bridge("start");
  await runSpawnJob({ ...JOB, split: undefined, pane: "w1:p2", bootstrap: "" }, { herdr: b, report: async () => {} });
  expect(calls).toEqual(["start agt-ab12-w001-t1 w1:p2"]);
});

test("agent_not_ready means the agent is in the pane: keep the pane and report attached with the bootstrap pending", async () => {
  const { b, calls } = bridge("not_ready");
  const reports: object[] = [];
  await runSpawnJob(JOB, { herdr: b, report: async (c) => void reports.push(c) });
  expect(calls).not.toContain("close w1:p3");
  expect(reports).toEqual([{ cmd: "session.attached", session: "s-1", pane: "w1:p3", pending: "Start ticket T1 of thread 001 now." }]);
});

test("a failed bootstrap prompt still reports attached, with the bootstrap pending", async () => {
  const { b, calls } = bridge("prompt");
  const reports: object[] = [];
  await runSpawnJob(JOB, { herdr: b, report: async (c) => void reports.push(c) });
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
