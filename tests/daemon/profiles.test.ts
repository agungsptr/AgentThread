import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeUsage } from "../../src/agents/profiles.ts";
import type { SpawnJob } from "../../src/agents/spawn-job.ts";
import { main } from "../../src/cli/main.ts";
import { request } from "../../src/daemon/client.ts";
import { startDaemon, type Daemon } from "../../src/daemon/server.ts";
import type { Actor, StoredEvent } from "../../src/domain/types.ts";
import { initProject } from "../../src/project/init.ts";
import { paths } from "../../src/project/paths.ts";
import { FAKE_HERDR, fakeHerdrState, isolatedConfigHome, launchedSettings, tempRepo, waitFor } from "../helpers.ts";

let root: string;
let daemon: Daemon;
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

const CONFIG = "agents:\n  claude:\n    profiles:\n      - { name: personal, config_dir: /fixture/a }\n      - { name: work, config_dir: /fixture/b }\n";
const T = (min: number) => Math.floor((Date.now() + min * 60_000) / 1000);

async function boot(jobs: SpawnJob[], config = CONFIG, before: () => void = () => {}) {
  root = tempRepo();
  initProject(root, "demo");
  writeFileSync(join(root, ".agentthread", "config.yaml"), config);
  before();
  const fake = fakeHerdrState();
  process.env.FAKE_HERDR_STATE = fake.file;
  daemon = await startDaemon(root, { log: () => {}, launch: (j) => void jobs.push(j) });
  await cmd({ cmd: "layout.register", workspace: "w1", mainTab: "w1:t0", managerPane: "w1:p0", loggerPane: "w1:p00", herdrBin: FAKE_HERDR });
}
const cmd = (command: object, actor: Actor = { role: "user" }) => request(paths(root).socket, { op: "command", command, actor });
const events = async () => {
  const r = await request(paths(root).socket, { op: "events.since", seq: 0 });
  return r.ok ? (r.result as StoredEvent[]) : [];
};

test("the first coordinator launches on the profile chosen from the usage files, with its env, statusLine and hook", async () => {
  const jobs: SpawnJob[] = [];
  await boot(jobs, CONFIG, () => {
    // personal is over its five-hour threshold: the first launch goes to work
    writeUsage(root, "personal", { five_hour: { used: 93, resets_at: T(60) }, seven_day: null, seen_at: new Date().toISOString() });
  });
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  await waitFor(() => jobs.length > 0, 10_000);
  const job = jobs[0]!;
  expect(job.exportEnv?.CLAUDE_CONFIG_DIR).toBe("/fixture/b");
  const settings = launchedSettings(job.args);
  expect(settings.statusLine.command).toContain("statusline --profile 'work'");
  expect(settings.hooks.StopFailure[0].matcher).toBe("rate_limit");
  const evs = await events();
  expect(evs.find((e) => e.type === "profile.switched")).toMatchObject({ payload: { to: "work", reason: "first launch" } });
  expect(evs.find((e) => e.type === "session.created" && e.payload.role === "coordinator")).toMatchObject({ payload: { profile: "work" } });
  const tab = (await Bun.file(process.env.FAKE_HERDR_STATE!).json()) as { calls: string[][] };
  expect(JSON.stringify(tab.calls.filter((c) => c[0] === "tab" && c[1] === "create"))).toContain("CLAUDE_CONFIG_DIR=/fixture/b");
});

test("agt event rate-limited marks the profile; the next launch moves off it", async () => {
  const jobs: SpawnJob[] = [];
  await boot(jobs);
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  await waitFor(() => jobs.length > 0, 10_000);
  expect(jobs[0]!.exportEnv?.CLAUDE_CONFIG_DIR).toBe("/fixture/a");
  const code = await main(["event", "rate-limited", "--profile", "personal"], { AGT_ROOT: root, AGT_ROLE: "coordinator", AGT_THREAD: "001" }, root);
  expect(code).toBe(0);
  expect((await events()).find((e) => e.type === "profile.limited")).toMatchObject({ payload: { profile: "personal" } });
  await cmd({ cmd: "thread.new", title: "Y", type: "bug" });
  await waitFor(() => jobs.length > 1, 10_000);
  expect(jobs[1]!.exportEnv?.CLAUDE_CONFIG_DIR).toBe("/fixture/b");
  expect((await events()).filter((e) => e.type === "profile.switched").map((e) => (e.payload as { to: string }).to)).toEqual(["personal", "work"]);
});

test("profile.choose gives main its profile and agt usage reads the files and the daemon", async () => {
  const jobs: SpawnJob[] = [];
  await boot(jobs, CONFIG, () => writeUsage(root, "personal", { five_hour: { used: 25, resets_at: T(130) }, seven_day: { used: 48, resets_at: T(5000) }, seen_at: new Date().toISOString() }));
  const r = await cmd({ cmd: "profile.choose" });
  expect(r).toMatchObject({ ok: true, result: { profile: "personal", config_dir: "/fixture/a" } });
  const lines: string[] = [];
  const log = console.log;
  console.log = (m: string) => void lines.push(String(m));
  try {
    expect(await main(["usage", "--json"], { AGT_ROOT: root }, root)).toBe(0);
  } finally {
    console.log = log;
  }
  const rows = JSON.parse(lines.join("\n")) as { profile: string; current: boolean; five_hour: { used: number } | null }[];
  expect(rows.map((x) => [x.profile, x.current, x.five_hour?.used ?? null])).toEqual([["personal", true, 25], ["work", false, null]]);
});

test("a single profile or none: no switching, no statusLine, no profile events", async () => {
  const jobs: SpawnJob[] = [];
  await boot(jobs, "agents:\n  claude:\n    profiles:\n      - { name: solo, config_dir: /fixture/s }\n");
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  await waitFor(() => jobs.length > 0, 10_000);
  const settings = launchedSettings(jobs[0]!.args);
  expect(settings.statusLine).toBeUndefined();
  expect(settings.hooks.StopFailure).toBeUndefined();
  expect((await events()).some((e) => e.type.startsWith("profile."))).toBe(false);
});
