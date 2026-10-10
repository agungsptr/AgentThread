import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGT_BIN } from "../../src/agents/claude.ts";
import { encodeJob, type SpawnJob } from "../../src/agents/spawn-job.ts";
import { request } from "../../src/daemon/client.ts";
import { startDaemon, type Daemon } from "../../src/daemon/server.ts";
import type { Actor, StoredEvent } from "../../src/domain/types.ts";
import { initProject } from "../../src/project/init.ts";
import { paths } from "../../src/project/paths.ts";
import { FAKE_HERDR, fakeHerdrState, isolatedConfigHome, tempRepo, waitFor } from "../helpers.ts";

let root: string;
let daemon: Daemon;
let fake: ReturnType<typeof fakeHerdrState>;
const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, FAKE_HERDR_STATE: process.env.FAKE_HERDR_STATE };

beforeAll(() => {
  process.env.XDG_CONFIG_HOME = isolatedConfigHome();
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});
afterEach(async () => {
  await daemon.stop();
});

async function boot(opts: { launch?: (job: SpawnJob) => void; seed?: Parameters<typeof fakeHerdrState>[0] } = {}) {
  root = tempRepo();
  initProject(root, "demo");
  fake = fakeHerdrState(opts.seed);
  process.env.FAKE_HERDR_STATE = fake.file;
  daemon = await startDaemon(root, { log: () => {}, ...(opts.launch ? { launch: opts.launch } : {}) });
  await cmd({ cmd: "layout.register", workspace: "w1", mainTab: "w1:t0", managerPane: "w1:p0", loggerPane: "w1:p00", herdrBin: FAKE_HERDR });
}

const cmd = (command: object, actor: Actor = { role: "user" }) => request(paths(root).socket, { op: "command", command, actor });
const events = async () => {
  const r = await request(paths(root).socket, { op: "events.since", seq: 0 });
  return r.ok ? (r.result as StoredEvent[]) : [];
};
const sessionOf = async (role: string, ticket?: string) =>
  (await events()).find((e) => e.type === "session.created" && e.payload.role === role && (ticket === undefined || e.payload.ticket === ticket))
    ?.payload as { session: string } | undefined;
const coord: Actor = { role: "coordinator", thread: "001" };

test("a new thread gets a coordinator that is started through the spawner child", async () => {
  await boot();
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  await waitFor(async () => (await events()).some((e) => e.type === "session.attached"), 10_000);
  const start = fake.read().calls.find((c) => c[0] === "agent" && c[1] === "start")!;
  expect(start.slice(0, 9)).toEqual(["agent", "start", expect.stringMatching(/^agt-[0-9a-f]{4}-c001$/), "--kind", "claude", "--pane", "w1:p1", "--timeout", "60000"]);
  expect(start).toContain("--session-id");
  expect(start).toContain("acceptEdits");
  expect(fake.read().calls.some((c) => c[0] === "agent" && c[1] === "prompt" && c[3]!.startsWith("Start coordinating thread 001."))).toBe(true);
});

test("worker capacity: queue, finish, next worker spawns; coordinator gets notified when idle", async () => {
  const jobs: SpawnJob[] = [];
  await boot({ launch: (j) => void jobs.push(j) });
  await cmd({ cmd: "thread.new", title: "X", type: "bug", maxWorkers: 1 });
  const c = (await sessionOf("coordinator"))!.session;
  await cmd({ cmd: "session.attached", session: c, pane: "w1:p1" });
  for (const t of ["A", "B"]) await cmd({ cmd: "ticket.add", thread: "001", title: t, scope: [t] }, coord);
  expect(await cmd({ cmd: "worker.spawn", thread: "001", ticket: "T1" }, coord)).toMatchObject({ ok: true, result: { queued: false } });
  expect(await cmd({ cmd: "worker.spawn", thread: "001", ticket: "T2" }, coord)).toMatchObject({ ok: true, result: { queued: true } });
  const w1 = (await sessionOf("worker", "T1"))!.session;
  expect(jobs.at(-1)).toMatchObject({ name: expect.stringMatching(/-w001-t1-[0-9a-f]{4}$/), split: { pane: "w1:p1", direction: "right", env: expect.objectContaining({ AGT_SESSION: w1, AGT_TICKET: "T1" }) } });
  // attach the worker pane in the fake so pane.close can find it
  const s = fake.read();
  writeFileSync(fake.file, JSON.stringify({ ...s, panes: [...s.panes, "w1:p7"] }));
  await cmd({ cmd: "session.attached", session: w1, pane: "w1:p7" });
  const worker: Actor = { role: "worker", thread: "001", session: w1, ticket: "T1" };
  await cmd({ cmd: "ticket.claim", thread: "001", ticket: "T1" }, worker);
  await cmd({ cmd: "ticket.done", thread: "001", ticket: "T1", summary: "ok" }, worker);
  await cmd({ cmd: "session.signal", session: w1, signal: "idle" }, worker);
  expect(fake.read().calls.some((c) => c.join(" ") === "pane close w1:p7")).toBe(true);
  expect(await sessionOf("worker", "T2")).toBeDefined();
  expect(jobs.filter((j) => j.split)).toHaveLength(2);
  // coordinator idle → one delivery with the queued notice
  await cmd({ cmd: "session.signal", session: c, signal: "idle" });
  expect(fake.read().calls.filter((x) => x[0] === "agent" && x[1] === "prompt" && x[2] === "w1:p1").map((x) => x[3])).toEqual(["Ticket T1 is done: ok."]);
  expect((await events()).at(-1)!.type).toBe("notice.delivered");
});

test("spawn failure: session failed, coordinator notified, slot freed", async () => {
  await boot();
  await cmd({ cmd: "thread.new", title: "X", type: "bug", maxWorkers: 1 });
  await waitFor(async () => (await events()).some((e) => e.type === "session.attached"), 10_000);
  for (const t of ["A", "B"]) await cmd({ cmd: "ticket.add", thread: "001", title: t, scope: [t] }, coord);
  // make every later `agent start` fail in the fake
  const s = fake.read();
  writeFileSync(fake.file, JSON.stringify({ ...s, fail: ["agent start"] }));
  await cmd({ cmd: "worker.spawn", thread: "001", ticket: "T1" }, coord);
  await cmd({ cmd: "worker.spawn", thread: "001", ticket: "T2" }, coord);
  await waitFor(async () => (await events()).filter((e) => e.type === "session.failed").length >= 2, 10_000);
  const all = await events();
  expect(all.some((e) => e.type === "notice.queued" && (e.payload as { text: string }).text.startsWith("Worker for T1 failed:"))).toBe(true);
  // the split pane of the failed worker was closed again
  expect(fake.read().calls.filter((c) => c[0] === "pane" && c[1] === "close").length).toBeGreaterThanOrEqual(1);
});

test("a coordinator blocked at a startup dialog is attached and gets its bootstrap when its session starts", async () => {
  await boot({ seed: { fail: ["agent start", "agent prompt"], failCode: { "agent start": "agent_not_ready", "agent prompt": "agent_blocked" } } });
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  await waitFor(async () => (await events()).some((e) => e.type === "session.attached" || e.type === "session.failed"), 10_000);
  const all = await events();
  expect(all.some((e) => e.type === "session.failed")).toBe(false);
  const c = (await sessionOf("coordinator"))!.session;
  expect(all.find((e) => e.type === "notice.queued")?.payload).toEqual({ session: c, text: expect.stringMatching(/^Start coordinating thread 001\./) });
  // the dialog is dismissed; SessionStart fires at the empty prompt and delivers the bootstrap
  const s = fake.read();
  writeFileSync(fake.file, JSON.stringify({ ...s, fail: [] }));
  await cmd({ cmd: "session.signal", session: c, signal: "started" });
  expect((await events()).at(-1)!.type).toBe("notice.delivered");
  expect(fake.read().calls.filter((x) => x[0] === "agent" && x[1] === "prompt" && x[2] === "w1:p1").map((x) => x[3]!.slice(0, 26))).toEqual(["Start coordinating thread "]);
});

test("a hanging agent start never blocks the daemon", async () => {
  // The spawner child waits on the fake's hang until its own ~70s watchdog; start it ourselves so we can kill it.
  const pids: number[] = [];
  try {
    await boot({
      seed: { hang: ["agent start"] },
      launch: (job) => {
        const child = spawn(process.execPath, [AGT_BIN, "__spawn", encodeJob(job)], { stdio: "ignore", env: { ...process.env, AGT_ROOT: job.root } });
        child.unref();
        if (child.pid) pids.push(child.pid);
      },
    });
    await cmd({ cmd: "thread.new", title: "X", type: "bug" });
    const t0 = Date.now();
    expect(await cmd({ cmd: "log", thread: "001", message: "still responsive" })).toEqual({ ok: true, result: null });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(pids).toHaveLength(1);
  } finally {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already exited
      }
    }
  }
});

test("non-claude agents refuse to start the daemon", async () => {
  await boot();
  await daemon.stop();
  writeFileSync(join(root, ".agentthread", "config.yaml"), "agents:\n  default_worker: opencode\n");
  await expect(startDaemon(root, { log: () => {} })).rejects.toThrow("agents.default_worker: opencode is not supported yet");
  writeFileSync(join(root, ".agentthread", "config.yaml"), "");
  daemon = await startDaemon(root, { log: () => {} });
});
