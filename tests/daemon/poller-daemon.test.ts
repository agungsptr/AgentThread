import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "../../src/daemon/client.ts";
import { startDaemon, type Daemon } from "../../src/daemon/server.ts";
import type { Actor, StoredEvent } from "../../src/domain/types.ts";
import { project } from "../../src/state/projection.ts";
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

const cmd = (command: object, actor: Actor = { role: "user" }) => request(paths(root).socket, { op: "command", command, actor });
const events = async () => {
  const r = await request(paths(root).socket, { op: "events.since", seq: 0 });
  return r.ok ? (r.result as StoredEvent[]) : [];
};
const count = async (type: string) => (await events()).filter((e) => e.type === type).length;
const patch = (f: (s: ReturnType<typeof fake.read>) => object) => fake.update(f);

async function boot() {
  root = tempRepo();
  initProject(root, "demo");
  writeFileSync(join(root, ".agentthread", "config.yaml"), "herdr:\n  poll_interval: 100ms\n");
  fake = fakeHerdrState();
  process.env.FAKE_HERDR_STATE = fake.file;
  daemon = await startDaemon(root, { log: () => {}, launch: () => {} });
  await cmd({ cmd: "layout.register", workspace: "w1", mainTab: "w1:t0", managerPane: "w1:p0", loggerPane: "w1:p00", herdrBin: FAKE_HERDR });
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  const created = (await events()).find((e) => e.type === "session.created" && e.payload.role === "coordinator")!;
  const session = (created.payload as { session: string }).session;
  patch((s) => ({ panes: [...s.panes, "w1:p9"], agentPanes: ["w1:p9"], status: { "w1:p9": "idle" } }));
  await cmd({ cmd: "session.attached", session, pane: "w1:p9" });
  return session;
}

test("polled status drives started, active, idle (one turn), then ended after two misses", async () => {
  const sid = await boot();
  await waitFor(async () => (await count("session.started")) === 1);
  patch(() => ({ status: { "w1:p9": "working" } }));
  await waitFor(async () => (await count("session.active")) >= 1);
  patch(() => ({ status: { "w1:p9": "idle" } }));
  await waitFor(async () => (await count("agent.idle")) === 1);
  await Bun.sleep(400);
  expect(await count("agent.idle")).toBe(1);
  expect(project(await events()).sessions.get(sid)!.turns).toBe(1);
  patch(() => ({ agentPanes: [] }));
  await waitFor(async () => (await count("session.ended")) === 1);
});

test("blocked is reported once", async () => {
  await boot();
  await waitFor(async () => (await count("session.started")) === 1);
  patch(() => ({ status: { "w1:p9": "blocked" } }));
  await waitFor(async () => (await count("agent.blocked")) === 1);
  await Bun.sleep(400);
  expect(await count("agent.blocked")).toBe(1);
});

test("a herdr error during a poll produces no events", async () => {
  await boot();
  await waitFor(async () => (await count("session.started")) === 1);
  patch(() => ({ fail: ["agent list"], agentPanes: [] }));
  const before = (await events()).length;
  await Bun.sleep(600);
  expect((await events()).length).toBe(before);
});
