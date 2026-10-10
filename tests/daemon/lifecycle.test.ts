import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpawnJob } from "../../src/agents/spawn-job.ts";
import { claudeSessionFile } from "../../src/agents/claude.ts";
import { request } from "../../src/daemon/client.ts";
import { startDaemon, type Daemon } from "../../src/daemon/server.ts";
import type { Actor, StoredEvent } from "../../src/domain/types.ts";
import { initProject } from "../../src/project/init.ts";
import { paths } from "../../src/project/paths.ts";
import { FAKE_HERDR, fakeHerdrState, isolatedConfigHome, tempRepo, waitFor } from "../helpers.ts";

let root: string;
let daemon: Daemon;
let fake: ReturnType<typeof fakeHerdrState>;
let claudeDir: string;
let jobs: SpawnJob[];
const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, FAKE_HERDR_STATE: process.env.FAKE_HERDR_STATE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };

beforeAll(() => {
  process.env.XDG_CONFIG_HOME = isolatedConfigHome();
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});
afterEach(async () => {
  await daemon.stop();
});

async function boot(configYaml = "", sweepIntervalMs?: number) {
  root = tempRepo();
  initProject(root, "demo");
  writeFileSync(join(root, ".agentthread", "config.yaml"), configYaml);
  fake = fakeHerdrState();
  process.env.FAKE_HERDR_STATE = fake.file;
  claudeDir = isolatedConfigHome();
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  jobs = [];
  daemon = await startDaemon(root, { log: () => {}, launch: (j) => void jobs.push(j), ...(sweepIntervalMs ? { sweepIntervalMs } : {}) });
  await cmd({ cmd: "layout.register", workspace: "w1", mainTab: "w1:t0", managerPane: "w1:p0", loggerPane: "w1:p00", herdrBin: FAKE_HERDR });
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
}

const cmd = (command: object, actor: Actor = { role: "user" }) => request(paths(root).socket, { op: "command", command, actor });
const events = async () => {
  const r = await request(paths(root).socket, { op: "events.since", seq: 0 });
  return r.ok ? (r.result as StoredEvent[]) : [];
};
const coordinator = async () =>
  (await events()).filter((e) => e.type === "session.created" && e.payload.role === "coordinator").map((e) => e.payload as { session: string }).at(-1)!.session;

test("reconcile probe → lost → resumed with --resume when the transcript exists", async () => {
  await boot();
  const c = await coordinator();
  await cmd({ cmd: "session.attached", session: c, pane: "w1:p1" }); // fake: pane w1:p1 exists but has no agent
  const file = claudeSessionFile({ configDir: claudeDir, cwd: join(root, ".worktrees", "001-x"), session: c });
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "{}\n");
  await cmd({ cmd: "layout.reconcile" });
  const types = (await events()).map((e) => e.type);
  expect(types).toContain("session.lost");
  expect(types).toContain("session.resuming");
  const job = jobs.at(-1)!;
  expect(job.session).toBe(c);
  expect(job.pane).toBe("w1:p1");
  expect(job.args.slice(0, 2)).toEqual(["--resume", c]);
  expect(job.bootstrap.startsWith("You were resumed after an interruption.")).toBe(true);
});

test("no transcript: resume fails, a handoff is generated, a fresh coordinator takes the pane", async () => {
  await boot();
  const c = await coordinator();
  await cmd({ cmd: "session.attached", session: c, pane: "w1:p1" });
  await cmd({ cmd: "layout.reconcile" });
  const all = await events();
  expect(all.map((e) => e.type)).toContain("session.resume_failed");
  expect(all.find((e) => e.type === "handoff.submitted")).toMatchObject({ payload: { generated: true } });
  const job = jobs.at(-1)!;
  expect(job.session).not.toBe(c);
  expect(job.args.slice(0, 2)).toEqual(["--session-id", job.session]);
  expect(job.bootstrap.startsWith("Continue coordinating thread 001 as its new coordinator.")).toBe(true);
});

test("handoff timeout: the sweep generates a handoff and rotates", async () => {
  await boot("session:\n  handoff:\n    timeout: 1s\n", 200);
  const c = await coordinator();
  await cmd({ cmd: "session.attached", session: c, pane: "w1:p1" });
  await cmd({ cmd: "session.signal", session: c, signal: "compacting" });
  await waitFor(async () => (await events()).some((e) => e.type === "session.rotated"), 5000);
  const all = await events();
  expect(all.find((e) => e.type === "handoff.submitted")).toMatchObject({ payload: { generated: true } });
  expect(jobs.at(-1)).toMatchObject({ split: { pane: "w1:p1" } });
});

test("tab env carries CLAUDE_CONFIG_DIR", async () => {
  await boot();
  const create = fake.read().calls.find((x) => x[0] === "tab" && x[1] === "create")!;
  expect(create).toContain(`CLAUDE_CONFIG_DIR=${claudeDir}`);
});
