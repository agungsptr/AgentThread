/**
 * Safety net, preloaded by bunfig.toml. A test that starts a daemon through the CLI (`agt start`, `agt daemon start`)
 * spawns it detached, so it outlives the test: when the test fails or times out, or stops the daemon before it has
 * bound its socket (the CLI gave up waiting while the machine was loaded), nothing stops it afterwards. After each
 * test file (and at exit) this kills any `agt daemon run` / `__spawn` process whose cwd is inside a temp dir this
 * test process created, and says so on stderr so the leaking test can be fixed.
 */
import { afterAll } from "bun:test";
import { createdTempDirs } from "./helpers.ts";

function leaked(): { pid: number; cwd: string; cmd: string }[] {
  if (createdTempDirs.size === 0) return [];
  const ps = Bun.spawnSync(["pgrep", "-f", "agt.*(daemon run|__spawn)"], { stdout: "pipe", stderr: "ignore" });
  const out: { pid: number; cwd: string; cmd: string }[] = [];
  for (const line of ps.stdout.toString().split("\n")) {
    const pid = Number(line.trim());
    if (!pid || pid === process.pid) continue;
    const l = Bun.spawnSync(["lsof", "-a", "-d", "cwd", "-Fn", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const cwd = /^n(.*)$/m.exec(l.stdout.toString())?.[1];
    if (!cwd || ![...createdTempDirs].some((d) => cwd === d || cwd.startsWith(`${d}/`))) continue;
    const cmd = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe" }).stdout.toString().trim();
    out.push({ pid, cwd, cmd });
  }
  return out;
}

function reap(where: string): void {
  for (const p of leaked()) {
    process.stderr.write(`leak-guard: ${where}: killing ${p.cmd.slice(0, 120)} (pid ${p.pid}, cwd ${p.cwd})\n`);
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {}
  }
}

afterAll(() => {
  // Give a just-stopped daemon a moment to exit before judging it leaked.
  Bun.sleepSync(300);
  reap("after file");
});
process.on("exit", () => reap("at exit"));
