import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpawnJob } from "../../src/agents/spawn-job.ts";
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
const rootPane = (all: StoredEvent[]) =>
  (all.filter((e) => e.type === "thread.tab_opened").at(-1)!.payload as { rootPane: string }).rootPane;
const coordinator = async () =>
  (await events()).filter((e) => e.type === "session.created" && e.payload.role === "coordinator").map((e) => e.payload as { session: string }).at(-1)!.session;

test("reconcile probe → lost → a generated handoff and a fresh coordinator split from the root pane", async () => {
  await boot();
  const c = await coordinator();
  await cmd({ cmd: "session.attached", session: c, pane: "w1:p1" }); // fake: pane w1:p1 exists but has no agent
  const before = jobs.length;
  await cmd({ cmd: "layout.reconcile" });
  const all = await events();
  const types = all.map((e) => e.type);
  expect(types).toContain("session.lost");
  expect(types).not.toContain("session.resuming");
  expect(all.find((e) => e.type === "handoff.submitted")).toMatchObject({ payload: { generated: true } });
  expect(jobs.length).toBe(before + 1);
  const job = jobs.at(-1)!;
  expect(job.session).not.toBe(c);
  expect(job.args).not.toContain("--resume");
  expect(job.bootstrap.startsWith("You are the new coordinator of thread 001;")).toBe(true);
  // split from the root pane (own AGT_SESSION env), not started in the lost session's pane
  expect(job.pane).toBeUndefined();
  expect(job.split).toMatchObject({ pane: rootPane(all) });
  expect(job.split!.env.AGT_SESSION).toBe(job.session);
});

test("a coordinator that exited normally is replaced by the next reconcile", async () => {
  await boot();
  const c = await coordinator();
  await cmd({ cmd: "session.attached", session: c, pane: "w1:p1" });
  await cmd({ cmd: "session.signal", session: c, signal: "ended" }, { role: "coordinator", thread: "001", session: c });
  const before = jobs.length;
  expect(jobs.length).toBe(before); // SessionEnd alone does not respawn
  await cmd({ cmd: "layout.reconcile" });
  const all = await events();
  expect(all.find((e) => e.type === "session.lost")).toMatchObject({ payload: { session: c, reason: "coordinator exited" } });
  expect(jobs.length).toBe(before + 1);
  const job = jobs.at(-1)!;
  expect(job.session).not.toBe(c);
  expect(job.args).not.toContain("--resume");
  expect(job.split).toMatchObject({ pane: rootPane(all) });
});

test("handoff timeout: the sweep generates a handoff and rotates", async () => {
  await boot("session:\n  handoff:\n    timeout: 1s\n", 200);
  const c = await coordinator();
  await cmd({ cmd: "session.attached", session: c, pane: "w1:p1" });
  await cmd({ cmd: "session.signal", session: c, signal: "started" }); // the sweep ignores a coordinator still starting
  await cmd({ cmd: "session.signal", session: c, signal: "compacting" });
  await waitFor(async () => (await events()).some((e) => e.type === "session.rotated"), 5000);
  const all = await events();
  expect(all.find((e) => e.type === "handoff.submitted")).toMatchObject({ payload: { generated: true } });
  // events are readable while the follow-up renders the brief; the spawn comes right after
  await waitFor(() => jobs.length >= 2);
  expect(jobs.at(-1)).toMatchObject({ split: { pane: "w1:p1" } });
});

test("tab env carries CLAUDE_CONFIG_DIR", async () => {
  await boot();
  const create = fake.read().calls.find((x) => x[0] === "tab" && x[1] === "create")!;
  expect(create).toContain(`CLAUDE_CONFIG_DIR=${claudeDir}`);
});
