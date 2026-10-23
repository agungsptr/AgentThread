import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "../../src/daemon/client.ts";
import { startDaemon } from "../../src/daemon/server.ts";
import type { Actor, StoredEvent } from "../../src/domain/types.ts";
import { initProject } from "../../src/project/init.ts";
import { paths } from "../../src/project/paths.ts";
import { FAKE_HERDR, fakeHerdrState, isolatedConfigHome, tempRepo, waitFor } from "../helpers.ts";

// Timer-driven work (the poll tick and the sweep) renders briefs with a git trail after every signal. In Bun 1.1.34 a
// Bun.spawnSync from timer-started work once stalled with no child alive; this keeps that path busy and checks that
// the daemon still stops promptly and the file exits on its own.
const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, FAKE_HERDR_STATE: process.env.FAKE_HERDR_STATE };
beforeAll(() => {
  process.env.XDG_CONFIG_HOME = isolatedConfigHome();
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

test("busy poll and sweep with a git worktree: stop() resolves promptly", async () => {
  const root = tempRepo();
  initProject(root, "demo");
  writeFileSync(join(root, ".agentthread", "config.yaml"), "checkpoint:\n  reminder_turns: 1\n");
  const fake = fakeHerdrState();
  process.env.FAKE_HERDR_STATE = fake.file;
  const daemon = await startDaemon(root, { log: () => {}, launch: () => {}, sweepIntervalMs: 50, pollIntervalMs: 50 });
  const cmd = (command: object, actor: Actor = { role: "user" }) => request(paths(root).socket, { op: "command", command, actor });
  const events = async () => {
    const r = await request(paths(root).socket, { op: "events.since", seq: 0 });
    return r.ok ? (r.result as StoredEvent[]) : [];
  };
  let stopped = false;
  try {
    await cmd({ cmd: "layout.register", workspace: "w1", mainTab: "w1:t0", managerPane: "w1:p0", loggerPane: "w1:p00", herdrBin: FAKE_HERDR });
    await cmd({ cmd: "thread.new", title: "X", type: "bug" });
    const created = (await events()).find((e) => e.type === "session.created" && e.payload.role === "coordinator")!;
    const session = (created.payload as { session: string }).session;
    fake.update((s) => ({ panes: [...s.panes, "w1:p9"], agentPanes: ["w1:p9"], status: { "w1:p9": "idle" } }));
    await cmd({ cmd: "session.attached", session, pane: "w1:p9" });

    // Flip the pane between working and idle; every flip is a signal, a render and a git trail.
    let working = false;
    const flip = setInterval(() => {
      working = !working;
      fake.update(() => ({ status: { "w1:p9": working ? "working" : "idle" } }));
    }, 30);
    await Bun.sleep(3000);
    clearInterval(flip);
    const idles = (await events()).filter((e) => e.type === "agent.idle").length;
    expect(idles).toBeGreaterThan(3);

    const t0 = Date.now();
    const outcome = await Promise.race([daemon.stop().then(() => "stopped"), Bun.sleep(5000).then(() => "stalled")]);
    stopped = outcome === "stopped";
    expect(outcome).toBe("stopped");
    expect(Date.now() - t0).toBeLessThan(5000);
  } finally {
    if (!stopped) void daemon.stop();
  }
  await waitFor(() => true);
}, 20_000);
