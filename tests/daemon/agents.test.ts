import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGT_BIN } from "../../src/agents/claude.ts";
import { encodeJob, type SpawnJob } from "../../src/agents/spawn-job.ts";
import { request } from "../../src/daemon/client.ts";
import { startDaemon, type Daemon } from "../../src/daemon/server.ts";
import type { Actor, StoredEvent } from "../../src/domain/types.ts";
import { initProject } from "../../src/project/init.ts";
import { paths } from "../../src/project/paths.ts";
import { FAKE_HERDR, fakeHerdrState, isolatedConfigHome, repoName, tempRepo, waitFor } from "../helpers.ts";

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

async function boot(opts: { launch?: (job: SpawnJob) => void; seed?: Parameters<typeof fakeHerdrState>[0]; config?: string } = {}) {
  root = tempRepo();
  initProject(root, "demo");
  if (opts.config) writeFileSync(join(root, ".agentthread", "config.yaml"), opts.config);
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
/** Gives thread 001 a real worktree of the (single) repo, so its tickets can spawn workers. */
async function worktree() {
  await cmd({ cmd: "worktree.add", thread: "001", repo: repoName(root), from: "main" }, coord);
  await waitFor(async () => (await events()).some((e) => e.type === "worktree.added"), 10_000);
}

test("a new thread gets a coordinator that is started through the spawner child", async () => {
  await boot();
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  await waitFor(async () => (await events()).some((e) => e.type === "session.attached"), 10_000);
  const start = fake.read().calls.find((c) => c[0] === "agent" && c[1] === "start")!;
  expect(start.slice(0, 9)).toEqual(["agent", "start", expect.stringMatching(/^agt-[0-9a-f]{4}-c001-[0-9a-f]{4}$/), "--kind", "claude", "--pane", "w1:p1", "--timeout", "60000"]);
  expect(start).not.toContain("--session-id");
  expect(start).not.toContain("--append-system-prompt");
  expect(start).toContain("bypassPermissions");
  expect(fake.read().calls.some((c) => c[0] === "agent" && c[1] === "prompt" && c[3]!.startsWith("You are the coordinator of thread 001. Read ") && c[3]!.endsWith("/brief.md, then follow AGENTS.md."))).toBe(true);
});

test("worker capacity: queue, finish, next worker spawns; coordinator gets notified when idle", async () => {
  const jobs: SpawnJob[] = [];
  await boot({ launch: (j) => void jobs.push(j) });
  await cmd({ cmd: "thread.new", title: "X", type: "bug", maxWorkers: 1 });
  const c = (await sessionOf("coordinator"))!.session;
  await cmd({ cmd: "session.attached", session: c, pane: "w1:p1" });
  await worktree();
  for (const t of ["A", "B"]) await cmd({ cmd: "ticket.add", thread: "001", title: t, repo: repoName(root), files: [t] }, coord);
  expect(await cmd({ cmd: "worker.spawn", thread: "001", ticket: "T1" }, coord)).toMatchObject({ ok: true, result: { queued: false } });
  expect(await cmd({ cmd: "worker.spawn", thread: "001", ticket: "T2" }, coord)).toMatchObject({ ok: true, result: { queued: true } });
  const w1 = (await sessionOf("worker", "T1"))!.session;
  expect(jobs.at(-1)).toMatchObject({ name: expect.stringMatching(/-w001-t1-[0-9a-f]{4}$/), split: { pane: "w1:p1", direction: "right", env: expect.objectContaining({ AGT_SESSION: w1, AGT_TICKET: "T1" }) } });
  // attach the worker pane in the fake so pane.close can find it; the coordinator's agent (launched by nobody here) is in w1:p1
  fake.update((s) => ({ panes: [...s.panes, "w1:p7"], agentPanes: [...(s.agentPanes ?? []), "w1:p1"] }));
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
  expect(fake.read().calls.filter((x) => x[0] === "agent" && x[1] === "prompt" && x[2] === "w1:p1").map((x) => x[3])).toEqual([
    `Worktree for ${repoName(root)} is ready at ${join(root, ".worktrees", "x", repoName(root))} on wip/x.\nTicket T1 is done: ok.`,
  ]);
  expect((await events()).at(-1)!.type).toBe("notice.delivered");
});

test("spawn failure: session failed, coordinator notified, slot freed", async () => {
  await boot();
  await cmd({ cmd: "thread.new", title: "X", type: "bug", maxWorkers: 1 });
  await waitFor(async () => (await events()).some((e) => e.type === "session.attached"), 10_000);
  await worktree();
  for (const t of ["A", "B"]) await cmd({ cmd: "ticket.add", thread: "001", title: t, repo: repoName(root), files: [t] }, coord);
  // make every later `agent start` fail in the fake
  fake.update(() => ({ fail: ["agent start"] }));
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
  expect(all.find((e) => e.type === "notice.queued")?.payload).toEqual({ session: c, text: expect.stringMatching(/^You are the coordinator of thread 001\. /) });
  // the dialog is dismissed; SessionStart fires at the empty prompt and delivers the bootstrap
  fake.update((s) => ({ fail: [], status: { ...s.status, "w1:p1": "idle" } }));
  await cmd({ cmd: "session.signal", session: c, signal: "started" });
  expect((await events()).at(-1)!.type).toBe("notice.delivered");
  expect(fake.read().calls.filter((x) => x[0] === "agent" && x[1] === "prompt" && x[2] === "w1:p1").map((x) => x[3]!.slice(0, 28))).toEqual(["You are the coordinator of t"]);
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

test("the daemon starts with a non-claude role", async () => {
  await boot();
  await daemon.stop();
  writeFileSync(join(root, ".agentthread", "config.yaml"), "agents:\n  default_worker: opencode\n  roles:\n    coordinator: { agent: codex }\n");
  daemon = await startDaemon(root, { log: () => {} });
  expect(await cmd({ cmd: "log", thread: "001", message: "x" })).toMatchObject({ ok: false, error: "unknown thread 001" });
});

test("configWarnings are logged once at daemon start", async () => {
  await boot();
  await daemon.stop();
  writeFileSync(join(root, ".agentthread", "config.yaml"), "agents:\n  claude:\n    permission_mode: plan\n");
  const logged: string[] = [];
  daemon = await startDaemon(root, { log: (m) => void logged.push(m) });
  expect(logged).toEqual(["warning: agents.claude.permission_mode/extra_allowed_tools are ignored while agents.autonomous is true"]);
});

test("AGT_E2E_OPENCODE_ASK is reported once at daemon start", async () => {
  await boot();
  await daemon.stop();
  const logged: string[] = [];
  process.env.AGT_E2E_OPENCODE_ASK = "worker";
  try {
    daemon = await startDaemon(root, { log: (m) => void logged.push(m) });
  } finally {
    delete process.env.AGT_E2E_OPENCODE_ASK;
  }
  expect(logged).toEqual(["warning: AGT_E2E_OPENCODE_ASK=worker is set (release e2e only): OpenCode worker sessions ask for every permission"]);
});

test("a worker of a thread uses roles.worker: its kind, args and split env come from its adapter", async () => {
  const jobs: SpawnJob[] = [];
  await boot({ launch: (j) => void jobs.push(j), config: "agents:\n  roles:\n    worker: { agent: opencode, model: p/m }\n" });
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  const c = (await sessionOf("coordinator"))!.session;
  await cmd({ cmd: "session.attached", session: c, pane: "w1:p1" });
  await worktree();
  await cmd({ cmd: "ticket.add", thread: "001", title: "A", repo: repoName(root), files: ["a"] }, coord);
  await cmd({ cmd: "worker.spawn", thread: "001", ticket: "T1" }, coord);
  expect((await sessionOf("worker", "T1")) as object).toMatchObject({ agent: "opencode", model: "p/m" });
  const job = jobs.at(-1)!;
  expect(jobs[0]!.kind).toBe("claude");
  expect(job.kind).toBe("opencode");
  expect(job.args).toEqual(["--standalone", "--auto"]);
  expect(job.split!.env).toMatchObject({ AGT_AGENT: "opencode", AGT_ROLE: "worker" });
  expect(job.split!.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  expect(JSON.parse(job.split!.env.OPENCODE_CONFIG_CONTENT!)).toMatchObject({ model: "p/m", permission: { "*": "allow" } });
});

test("a codex spawn gets the git common dir of the project", async () => {
  const jobs: SpawnJob[] = [];
  await boot({ launch: (j) => void jobs.push(j), config: "agents:\n  roles:\n    coordinator: { agent: codex }\n" });
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  const args = jobs[0]!.args;
  expect(jobs[0]!.kind).toBe("codex");
  expect(args[args.indexOf("--add-dir") + 1]).toBe(realpathSync(join(root, ".git")));
});

test("the tab env carries the coordinator adapter env", async () => {
  await boot({ launch: () => {}, config: "agents:\n  roles:\n    coordinator: { agent: opencode, model: p/m }\n" });
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  const create = fake.read().calls.find((c) => c[0] === "tab" && c[1] === "create")!;
  expect(create).toContain("AGT_AGENT=opencode");
  expect(create).toContain("AGT_ROLE=coordinator");
  expect(create.some((a) => a.startsWith("CLAUDE_CONFIG_DIR="))).toBe(false);
  const content = create.find((a) => a.startsWith("OPENCODE_CONFIG_CONTENT="))!;
  expect(JSON.parse(content.slice("OPENCODE_CONFIG_CONTENT=".length))).toMatchObject({ model: "p/m" });
});

test("a replacement for an exited coordinator carries the thread's live panes as split fallbacks", async () => {
  const jobs: SpawnJob[] = [];
  await boot({ launch: (j) => void jobs.push(j) });
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  const c = (await sessionOf("coordinator"))!.session;
  await cmd({ cmd: "session.attached", session: c, pane: "w1:p1" });
  await worktree();
  await cmd({ cmd: "ticket.add", thread: "001", title: "A", repo: repoName(root), files: ["A"] }, coord);
  await cmd({ cmd: "worker.spawn", thread: "001", ticket: "T1" }, coord);
  const w = (await sessionOf("worker", "T1"))!.session;
  await cmd({ cmd: "session.attached", session: w, pane: "w1:p7" });
  // the coordinator's root pane is closed in Herdr: its session ends and a replacement must not depend on that pane
  await cmd({ cmd: "session.signal", session: c, signal: "ended" });
  expect(jobs.at(-1)).toMatchObject({ split: { pane: "w1:p1", fallbacks: ["w1:p7"] }, bootstrap: expect.stringMatching(/^You are the new coordinator of thread 001/) });
});

test("a coordinator whose new pane is still busy (agent_pane_busy) attaches once its shell is ready", async () => {
  await boot({ seed: { busyStarts: 2 } });
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  await waitFor(async () => (await events()).some((e) => e.type === "session.attached" || e.type === "session.failed"), 15_000);
  expect((await events()).some((e) => e.type === "session.failed")).toBe(false);
  expect(fake.read().calls.filter((c) => c[0] === "agent" && c[1] === "start")).toHaveLength(3);
});

test("a command from the root-pane coordinator (no AGT_SESSION) is stored with its session", async () => {
  const jobs: SpawnJob[] = [];
  await boot({ launch: (j) => void jobs.push(j) });
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  const c = (await sessionOf("coordinator"))!.session;
  await cmd({ cmd: "session.attached", session: c, pane: "w1:p1" });
  expect(await cmd({ cmd: "thread.status", thread: "001", status: "in_progress" }, coord)).toMatchObject({ ok: true });
  const ev = (await events()).find((e) => e.type === "thread.status_changed")!;
  expect(ev.actor).toEqual({ role: "coordinator", thread: "001", session: c, via: "command" });
});

test("only a command's decided events carry via; a root-pane coordinator's hook follow-ups do not credit it", async () => {
  // the bootstrap cannot be delivered at spawn (a startup dialog), so it is queued
  await boot({ seed: { fail: ["agent start", "agent prompt"], failCode: { "agent start": "agent_not_ready", "agent prompt": "agent_blocked" } } });
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  await waitFor(async () => (await events()).some((e) => e.type === "session.attached" || e.type === "session.failed"), 10_000);
  const c = (await sessionOf("coordinator"))!.session;
  fake.update((s) => ({ fail: [], status: { ...s.status, "w1:p1": "idle" } }));
  // the root pane's hooks: AGT_ROLE + AGT_THREAD, no AGT_SESSION. Its started hook gets the bootstrap delivered under
  // that actor; the turn the bootstrap starts runs no agt command (a bad model).
  for (const signal of ["started", "active", "idle"]) expect(await cmd({ cmd: "session.signal", pane: "w1:p1", signal }, coord)).toMatchObject({ ok: true });
  const evs = await events();
  expect(evs.find((e) => e.type === "thread.created")!.actor).toEqual({ role: "user", via: "command" });
  // effect output (the tab) and reactor follow-ups of the command are unmarked
  expect(evs.find((e) => e.type === "thread.tab_opened")!.actor).toEqual({ role: "user" });
  expect(evs.find((e) => e.type === "session.created")!.actor).toEqual({ role: "user" });
  expect(evs.find((e) => e.type === "notice.delivered" && e.payload.session === c)!.actor).toEqual(coord);
  expect(evs.filter((e) => e.actor.role === "coordinator").every((e) => e.actor.via === undefined)).toBe(true);
  expect(evs.filter((e) => e.type === "session.stalled").map((e) => e.payload)).toEqual([{ session: c }]);
});
