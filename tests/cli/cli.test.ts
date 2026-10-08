import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempRepo } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");

let root: string;

function agt(args: string[], opts: { env?: Record<string, string>; cwd?: string; root?: boolean } = {}) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...opts.env };
  if (opts.root !== false) env.AGT_ROOT = root;
  const r = Bun.spawnSync([process.execPath, BIN, ...args], { cwd: opts.cwd ?? root, env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

const COORD = { AGT_ROLE: "coordinator", AGT_THREAD: "001", AGT_SESSION: "c1" };
const WORKER = { AGT_ROLE: "worker", AGT_THREAD: "001", AGT_SESSION: "w1" };

beforeEach(() => {
  root = tempRepo();
  expect(agt(["init", "--name", "demo"]).code).toBe(0);
});

afterEach(() => {
  agt(["daemon", "stop"]);
});

test("daemon lifecycle", () => {
  expect(agt(["daemon", "status"]).code).toBe(1);
  expect(agt(["daemon", "start"])).toMatchObject({ code: 0, out: "daemon started" });
  expect(agt(["daemon", "status"]).out).toMatch(/^running \(pid \d+\)$/);
  expect(agt(["daemon", "stop"])).toMatchObject({ code: 0, out: "daemon stopped" });
  expect(agt(["daemon", "status"]).code).toBe(1);
});

test("commands without a daemon explain how to start it", () => {
  expect(agt(["log", "001", "hi"])).toMatchObject({ code: 1, err: "agt: daemon is not running; run `agt daemon start`" });
});

test("thread, ticket and log commands", () => {
  agt(["daemon", "start"]);
  expect(JSON.parse(agt(["thread", "new", "Fix", "race", "--type", "bug", "--criteria", "no double charge"]).out)).toMatchObject({
    thread: "001",
  });
  expect(agt(["ticket", "add", "001", "Lock", "fix", "--scope", "src/lock.ts"], { env: COORD }).out).toBe('{"ticket":"T1"}');
  expect(agt(["ticket", "claim", "001/T1"], { env: WORKER }).out).toBe("ok");
  expect(agt(["ticket", "done", "001/T1", "--summary", "fixed"], { env: WORKER }).out).toBe("ok");
  expect(agt(["log", "001", "all", "good"], { env: WORKER }).out).toBe("ok");
  const logs = agt(["logs"]).out.split("\n");
  expect(logs.at(-1)).toMatch(/^\d+ \S+ log\.appended 001 worker:w1$/);
});

test("permission errors surface from the daemon", () => {
  agt(["daemon", "start"]);
  agt(["thread", "new", "X", "--type", "bug"]);
  expect(agt(["ticket", "add", "001", "T", "--scope", "a"])).toMatchObject({
    code: 1,
    err: "agt: role user may not run ticket.add",
  });
});

test("invalid AGT_ROLE is rejected locally", () => {
  expect(agt(["log", "001", "x"], { env: { AGT_ROLE: "boss" } })).toMatchObject({ code: 1, err: "agt: invalid AGT_ROLE boss" });
});

test("handoff reads the file", () => {
  agt(["daemon", "start"]);
  agt(["thread", "new", "X", "--type", "bug"]);
  const file = join(root, "handoff.md");
  writeFileSync(file, ["Goal status", "Work done", "Decisions", "Next steps", "Risks"].map((s) => `## ${s}\nx`).join("\n"));
  expect(agt(["handoff", "001", "--file", file], { env: COORD }).out).toBe("ok");
});

test("finds the project from a worktree subdirectory without AGT_ROOT", () => {
  agt(["daemon", "start"]);
  agt(["thread", "new", "X", "--type", "bug"]);
  const sub = join(root, ".worktrees", "001-x", "src");
  mkdirSync(sub, { recursive: true });
  expect(agt(["log", "001", "from worktree"], { cwd: sub, root: false, env: WORKER }).out).toBe("ok");
});

test("unknown commands print usage", () => {
  expect(agt(["frobnicate"]).code).toBe(2);
});
