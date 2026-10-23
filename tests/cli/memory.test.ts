import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedConfigHome, tempRepo } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");

let root: string;
let xdg: string;

function agt(args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", XDG_CONFIG_HOME: xdg, AGT_ROOT: root, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

const COORD = { AGT_ROLE: "coordinator", AGT_THREAD: "001", AGT_SESSION: "c1" };
const WORKER = { AGT_ROLE: "worker", AGT_THREAD: "001", AGT_SESSION: "w1", AGT_TICKET: "T1" };

beforeEach(() => {
  xdg = isolatedConfigHome();
  root = tempRepo();
  expect(agt(["init", "--name", "demo"]).code).toBe(0);
});

afterEach(() => {
  agt(["daemon", "stop"]);
});

test("note, progress and question round-trip into sub.thread.md", () => {
  agt(["daemon", "start"]);
  agt(["thread", "new", "Fix", "--type", "bug"]);
  expect(agt(["note", "001", "root", "cause", "is", "the", "lock"], COORD).out).toBe("ok");
  expect(agt(["progress", "001", "fix", "done,", "tests", "next"], WORKER).out).toBe("ok");
  expect(agt(["question", "001", "keep", "the", "old", "API?"], COORD).out).toBe("ok");
  const md = readFileSync(join(root, ".agentthread/threads/001-fix/sub.thread.md"), "utf8");
  expect(agt(["progress", "001", "plan", "made"], COORD).out).toBe("ok");
  const after = readFileSync(join(root, ".agentthread/threads/001-fix/sub.thread.md"), "utf8");
  expect(md).toMatch(/## Progress\n\n_None yet._\n- T1 \S+ \(worker T1\) fix done, tests next/);
  expect(after).toMatch(/## Progress\n\n\S+ \(coordinator\) plan made\n- T1 \S+ \(worker T1\) fix done, tests next/);
  expect(md).toMatch(/## Findings\n\n- \S+ root cause is the lock/);
  expect(md).toMatch(/## Open questions\n\n- \S+ keep the old API\?/);
});

test("ticket done without --summary is a usage error", () => {
  const r = agt(["ticket", "done", "001/T1"], WORKER);
  expect(r.code).toBe(2);
  expect(r.err).toContain("--summary");
});
