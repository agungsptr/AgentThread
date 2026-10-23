import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "../../src/daemon/client.ts";
import { runFollowUps, startDaemon, type Daemon } from "../../src/daemon/server.ts";
import type { Actor, StoredEvent } from "../../src/domain/types.ts";
import { EventStore } from "../../src/store/event-store.ts";
import { initProject } from "../../src/project/init.ts";
import { paths } from "../../src/project/paths.ts";
import { isolatedConfigHome, tempRepo } from "../helpers.ts";

let root: string;
let daemon: Daemon;
const savedXdg = process.env.XDG_CONFIG_HOME;

beforeAll(() => {
  process.env.XDG_CONFIG_HOME = isolatedConfigHome();
});

afterAll(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
});

beforeEach(async () => {
  root = tempRepo();
  initProject(root, "demo");
  daemon = await startDaemon(root);
});

afterEach(async () => {
  await daemon.stop();
});

const sock = () => paths(root).socket;
const cmd = (command: object, actor: Actor = { role: "user" }) => request(sock(), { op: "command", command, actor });
const COORD: Actor = { role: "coordinator", thread: "001", session: "c1" };

const HANDOFF = (risks: string) =>
  ["Goal status", "Work done", "Decisions", "Next steps"].map((s) => `## ${s}\n${s} text`).join("\n") + `\n## Risks\n${risks}`;

test("ping returns the pid", async () => {
  expect(await request(sock(), { op: "ping" })).toEqual({ ok: true, result: { pid: process.pid } });
});

test("thread.new creates the worktree and renders markdown", async () => {
  const r = await cmd({ cmd: "thread.new", title: "Fix race", type: "bug" });
  expect(r).toEqual({ ok: true, result: { thread: "001", worktree: join(root, ".worktrees", "001-fix-race") } });
  expect(existsSync(join(root, ".worktrees", "001-fix-race", ".git"))).toBe(true);
  expect(readFileSync(join(root, ".agentthread/threads/001-fix-race/sub.thread.md"), "utf8")).toContain("title: Fix race");
  expect(readFileSync(paths(root).mainThread, "utf8")).toContain("| 001 | Fix race | bug | open |");
});

test("invalid commands return validation errors without writing events", async () => {
  const r = await cmd({ cmd: "thread.new", title: "", type: "nope" });
  expect(r.ok).toBe(false);
  const events = await request(sock(), { op: "events.since", seq: 0 });
  expect((events.ok && (events.result as StoredEvent[]).length) || 0).toBe(1);
});

test("concurrent overlapping claims: exactly one succeeds", async () => {
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  await cmd({ cmd: "ticket.add", thread: "001", title: "A", scope: ["src/a"] }, COORD);
  await cmd({ cmd: "ticket.add", thread: "001", title: "B", scope: ["src/a/b.ts"] }, COORD);
  const results = await Promise.all([
    cmd({ cmd: "ticket.claim", thread: "001", ticket: "T1" }, { role: "worker", thread: "001", session: "w1" }),
    cmd({ cmd: "ticket.claim", thread: "001", ticket: "T2" }, { role: "worker", thread: "001", session: "w2" }),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  const failed = results.find((r) => !r.ok);
  expect(failed && !failed.ok && failed.error).toMatch(/overlaps in-progress ticket/);
});

test("state survives a restart and ids keep counting", async () => {
  await cmd({ cmd: "thread.new", title: "First", type: "feature" });
  await daemon.stop();
  daemon = await startDaemon(root);
  expect(await cmd({ cmd: "thread.new", title: "Second", type: "feature" })).toMatchObject({
    ok: true,
    result: { thread: "002" },
  });
});

test("refuses a second daemon and recovers from a stale socket", async () => {
  await expect(startDaemon(root)).rejects.toThrow("daemon already running");
  await daemon.stop();
  writeFileSync(sock(), "stale");
  daemon = await startDaemon(root);
  expect((await request(sock(), { op: "ping" })).ok).toBe(true);
});

test("large payloads round-trip", async () => {
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  const big = "é".repeat(200_000);
  expect(await cmd({ cmd: "handoff", thread: "001", content: HANDOFF(big) }, COORD)).toEqual({ ok: true, result: null });
  expect(readFileSync(join(root, ".agentthread/threads/001-x/sub.thread.md"), "utf8")).toContain(big);
});

test("a failing effect rejects the command and writes no event", async () => {
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  Bun.spawnSync(["git", "-C", root, "branch", "thread/002-y"]);
  const r = await cmd({ cmd: "thread.new", title: "Y", type: "bug" });
  expect(r.ok).toBe(false);
  const events = await request(sock(), { op: "events.since", seq: 0 });
  expect(events.ok && (events.result as StoredEvent[]).map((e) => e.type)).toEqual(["project.initialized", "thread.created"]);
});

test("a second daemon on the same project is refused even without its socket", async () => {
  rmSync(sock(), { force: true });
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = join(root, "other-tmp");
  try {
    await expect(startDaemon(root)).rejects.toThrow("daemon already running");
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
});

test("socket path does not depend on TMPDIR", () => {
  const saved = process.env.TMPDIR;
  const before = paths(root).socket;
  process.env.TMPDIR = "/somewhere/else";
  try {
    expect(paths(root).socket).toBe(before);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
});

test("commands are rejected once shutdown is requested", async () => {
  await request(sock(), { op: "shutdown" });
  const r = await cmd({ cmd: "thread.new", title: "Late", type: "bug" }).catch((e: Error) => ({ ok: false, error: e.message }));
  expect(r.ok).toBe(false);
});

test("a refused start never touches the socket of the daemon that holds the lock", async () => {
  await daemon.stop();
  const holder = new EventStore(paths(root).db, { exclusive: true });
  writeFileSync(sock(), "sentinel");
  try {
    await expect(startDaemon(root)).rejects.toThrow("daemon already running");
    expect(readFileSync(sock(), "utf8")).toBe("sentinel");
  } finally {
    holder.close();
    rmSync(sock(), { force: true });
  }
  daemon = await startDaemon(root);
});

test("socket directory is forced back to 0700", async () => {
  await daemon.stop();
  chmodSync(paths(root).socketDir, 0o755);
  daemon = await startDaemon(root);
  expect(statSync(paths(root).socketDir).mode & 0o777).toBe(0o700);
});

test("follow-up rounds stop at the cap and say so; a settled chain logs nothing", async () => {
  const ev = { seq: 1 } as StoredEvent;
  const logged: string[] = [];
  let rounds = 0;
  await runFollowUps([ev], () => (rounds++, [ev]), (m) => logged.push(m));
  expect(rounds).toBe(10);
  expect(logged).toEqual(["reactor stopped after 10 rounds"]);
  rounds = 0;
  await runFollowUps([ev], () => (++rounds < 3 ? [ev] : []), (m) => logged.push(m));
  expect(rounds).toBe(3);
  expect(logged).toHaveLength(1);
});
