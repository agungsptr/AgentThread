import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchDaemon } from "../src/cli/daemon-launch.ts";
import { createdTempDirs, tempRepo } from "./helpers.ts";
import { reap } from "./leak-guard.ts";

/** A long-lived process whose command line matches the guard's pattern, running in `cwd`. */
function fakeDaemon(cwd: string) {
  return Bun.spawn(["sh", "-c", 'exec -a "agt daemon run" sleep 60'], { cwd, stdout: "ignore", stderr: "ignore" });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("the leak guard kills a daemon-like process in a temp dir this process created, and only that", async () => {
  const dir = tempRepo();
  expect(createdTempDirs.has(dir)).toBe(true); // the preload and the tests share one registry
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "agt-outside-")));
  const leaked = fakeDaemon(dir);
  const bystander = fakeDaemon(outside);
  try {
    await Bun.sleep(300);
    expect(alive(leaked.pid)).toBe(true);
    const killed = reap("test");
    expect(killed).toContain(leaked.pid);
    expect(killed).not.toContain(bystander.pid);
    await leaked.exited;
    expect(alive(bystander.pid)).toBe(true);
  } finally {
    bystander.kill("SIGKILL");
    leaked.kill("SIGKILL");
  }
});

test("a daemon that never answers is killed when the start times out", async () => {
  const dir = tempRepo();
  let pid = 0;
  // `sleep` ignores nothing: SIGTERM ends it. The command line records its pid so the test can check it is gone.
  const file = join(dir, "pid");
  await expect(
    launchDaemon({
      cmd: "/bin/sh",
      args: ["-c", `echo $$ > ${file}; exec sleep 60`],
      cwd: dir,
      env: { PATH: process.env.PATH },
      socket: join(dir, "none.sock"),
      logFile: join(dir, "daemon.log"),
      timeoutMs: 700,
      graceMs: 500,
    }),
  ).rejects.toThrow(/daemon failed to start; see .*daemon\.log/);
  pid = Number((await Bun.file(file).text()).trim());
  await Bun.sleep(100);
  expect(pid).toBeGreaterThan(0);
  expect(alive(pid)).toBe(false);
});

test("a daemon that ignores SIGTERM is killed after the grace period", async () => {
  const dir = tempRepo();
  const file = join(dir, "pid");
  await expect(
    launchDaemon({
      cmd: "/bin/sh",
      args: ["-c", `trap '' TERM; echo $$ > ${file}; while :; do sleep 1; done`],
      cwd: dir,
      env: { PATH: process.env.PATH },
      socket: join(dir, "none.sock"),
      logFile: join(dir, "daemon.log"),
      timeoutMs: 500,
      graceMs: 300,
    }),
  ).rejects.toThrow(/daemon failed to start/);
  const pid = Number((await Bun.file(file).text()).trim());
  await Bun.sleep(200);
  expect(alive(pid)).toBe(false);
});

test("a daemon that exits early fails the start at once, naming the log", async () => {
  const dir = tempRepo();
  const t = Date.now();
  await expect(
    launchDaemon({
      cmd: "/bin/sh",
      args: ["-c", "exit 3"],
      cwd: dir,
      env: { PATH: process.env.PATH },
      socket: join(dir, "none.sock"),
      logFile: join(dir, "daemon.log"),
      timeoutMs: 10_000,
    }),
  ).rejects.toThrow(/exited with code 3\); see .*daemon\.log/);
  expect(Date.now() - t).toBeLessThan(3000);
});
