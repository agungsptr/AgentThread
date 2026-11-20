import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config, type ServiceConfig } from "../../src/config/config.ts";
import { listeners, pidAlive, portHeld } from "../../src/stack/health.ts";
import { formatStatus, readPid, restartStack, stackStatus, startStack, stopStack } from "../../src/stack/runner.ts";
import { readTask, resolveTarget, startOrder } from "../../src/stack/target.ts";
import { createdTempDirs, tempRepo, twoRepoFolder } from "../helpers.ts";

const STAMPS: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (STAMPS.length) await STAMPS.pop()!();
});

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const p = s.port!;
  await s.stop(true);
  return p;
}

const serverCmd = (port: number, extra = "") => `bun -e 'Bun.serve({port:${port},fetch:()=>new Response("ok")});${extra}setInterval(()=>{},1000)'`;

function svc(s: Partial<ServiceConfig> & { repo: string; start: string }): ServiceConfig {
  return { dir: ".", enabled: true, ...s } as ServiceConfig;
}

function cfg(repos: Record<string, { path: string }>, services: Record<string, ServiceConfig>): Config {
  return { ...DEFAULT_CONFIG, workspace: { ...DEFAULT_CONFIG.workspace, repos, services } } as Config;
}

const quiet = { out: () => {}, healthTimeoutMs: 20_000, healthIntervalMs: 100, killGraceMs: 3000 };

/** Registers cleanup of everything the config could have started. */
function guard(root: string, config: Config) {
  STAMPS.push(async () => {
    await stopStack({ root, config, ...quiet });
  });
}

function twoServices(root: string, pa: number, pb: number) {
  return cfg(
    { a: { path: "a" }, b: { path: "b" } },
    {
      api: svc({ repo: "a", start: serverCmd(pa), port: pa, health: `http://127.0.0.1:${pa}/`, after: ["db"] }),
      db: svc({ repo: "b", start: serverCmd(pb), port: pb }),
    },
  );
}

test("starts services in after order, healthy, with pid and log files", async () => {
  const root = twoRepoFolder();
  const [pa, pb] = [await freePort(), await freePort()];
  const config = twoServices(root, pa, pb);
  guard(root, config);
  const lines: string[] = [];
  const res = await startStack({ root, config, ...quiet, out: (l) => lines.push(l) });
  expect(res.map((r) => [r.name, r.outcome])).toEqual([["db", "started"], ["api", "started"]]);
  expect(lines[0]).toBe("target: main");
  expect(lines.findIndex((l) => l.startsWith("db:"))).toBeLessThan(lines.findIndex((l) => l.startsWith("api:")));
  expect(await portHeld(pa)).toBe(true);
  expect(await portHeld(pb)).toBe(true);
  for (const n of ["api", "db"]) {
    expect(pidAlive(readPid(root, n)!)).toBe(true);
    expect(existsSync(join(root, ".local-run", `${n}.log`))).toBe(true);
    expect(existsSync(join(root, ".local-run", `${n}.stamp`))).toBe(true);
  }
  expect(readTask(root)).toBe("main");
  expect(startOrder(resolveTarget(root, config).services).map((s) => s.name)).toEqual(["db", "api"]);
});

test("a second start skips running services; --only limits", async () => {
  const root = twoRepoFolder();
  const [pa, pb] = [await freePort(), await freePort()];
  const config = twoServices(root, pa, pb);
  guard(root, config);
  await startStack({ root, config, ...quiet });
  const pid = readPid(root, "db");
  const res = await startStack({ root, config, ...quiet });
  expect(res.map((r) => r.outcome)).toEqual(["skipped", "skipped"]);
  expect(readPid(root, "db")).toBe(pid);
  await stopStack({ root, config, ...quiet, only: ["api"] });
  expect(await portHeld(pa)).toBe(false);
  expect(await portHeld(pb)).toBe(true);
  const only = await startStack({ root, config, ...quiet, only: ["api"] });
  expect(only.map((r) => [r.name, r.outcome])).toEqual([["api", "started"]]);
});

test("install and migrate run only when the stamp changed", async () => {
  const root = tempRepo();
  const port = await freePort();
  const repo = root.split("/").pop()!;
  const config = cfg({ [repo]: { path: "." } }, { web: svc({ repo, start: serverCmd(port), port, migrate: "echo m >> migrations.txt" }) });
  config.workspace.repos = { [repo]: { path: ".", install: "echo i >> installs.txt" } } as Config["workspace"]["repos"];
  guard(root, config);
  await startStack({ root, config, ...quiet });
  const count = (f: string) => readFileSync(join(root, f), "utf8").trim().split("\n").length;
  expect(count("migrations.txt")).toBe(1);
  expect(count("installs.txt")).toBe(1);
  await stopStack({ root, config, ...quiet });
  // the files the commands wrote changed the work tree; the first start recorded the stamp before them, so refresh it
  await startStack({ root, config, ...quiet });
  await stopStack({ root, config, ...quiet });
  const before = [count("migrations.txt"), count("installs.txt")];
  await startStack({ root, config, ...quiet });
  expect([count("migrations.txt"), count("installs.txt")]).toEqual(before);
  await stopStack({ root, config, ...quiet });
  writeFileSync(join(root, "change.txt"), "x");
  await startStack({ root, config, ...quiet });
  expect(count("migrations.txt")).toBe(before[0]! + 1);
});

test("a failing migrate stops that service only and exits as failed", async () => {
  const root = twoRepoFolder();
  const [pa, pb] = [await freePort(), await freePort()];
  const config = twoServices(root, pa, pb);
  config.workspace.services!.api!.migrate = "exit 3";
  config.workspace.services!.api!.after = [];
  guard(root, config);
  const res = await startStack({ root, config, ...quiet });
  expect(res.find((r) => r.name === "api")!.outcome).toBe("failed");
  expect(res.find((r) => r.name === "db")!.outcome).toBe("started");
  expect(await portHeld(pa)).toBe(false);
});

test("a service that never becomes healthy warns with its log tail and does not stop the others", async () => {
  const root = twoRepoFolder();
  const pb = await freePort();
  const config = cfg(
    { a: { path: "a" }, b: { path: "b" } },
    {
      bad: svc({ repo: "a", start: "echo boot-failure-line; sleep 30", port: await freePort() }),
      good: svc({ repo: "b", start: serverCmd(pb), port: pb }),
    },
  );
  guard(root, config);
  const lines: string[] = [];
  const res = await startStack({ root, config, ...quiet, healthTimeoutMs: 600, out: (l) => lines.push(l) });
  expect(res.map((r) => [r.name, r.outcome])).toEqual([["bad", "failed"], ["good", "started"]]);
  expect(lines.some((l) => l.includes("WARNING") && l.includes("not healthy"))).toBe(true);
  expect(lines.some((l) => l.includes("boot-failure-line"))).toBe(true);
});

test("stop kills the whole process group and removes the pid file", async () => {
  const root = twoRepoFolder();
  const config = cfg({ a: { path: "a" } }, { w: svc({ repo: "a", start: "sleep 300 & echo $! > child.pid; wait" }) });
  guard(root, config);
  await startStack({ root, config, ...quiet });
  for (let i = 0; i < 50 && !existsSync(join(root, "a", "child.pid")); i++) await Bun.sleep(100);
  const child = Number(readFileSync(join(root, "a", "child.pid"), "utf8"));
  expect(pidAlive(child)).toBe(true);
  await stopStack({ root, config, ...quiet });
  expect(pidAlive(child)).toBe(false);
  expect(existsSync(join(root, ".local-run", "w.pid"))).toBe(false);
});

test("stop falls back to the port listener when the pid file is gone", async () => {
  const root = twoRepoFolder();
  const port = await freePort();
  const config = cfg({ a: { path: "a" } }, { w: svc({ repo: "a", start: serverCmd(port), port }) });
  guard(root, config);
  await startStack({ root, config, ...quiet });
  writeFileSync(join(root, ".local-run", "w.pid"), "999999\n");
  expect(listeners(port).length).toBeGreaterThan(0);
  await stopStack({ root, config, ...quiet });
  expect(await portHeld(port)).toBe(false);
  expect(existsSync(join(root, ".local-run", "w.pid"))).toBe(false);
});

test("status lists state, port, pid, cwd, branch and target; stopped services show dashes", async () => {
  const root = twoRepoFolder();
  const [pa, pb] = [await freePort(), await freePort()];
  const config = twoServices(root, pa, pb);
  guard(root, config);
  await startStack({ root, config, ...quiet, only: ["db"] });
  const rows = await stackStatus({ root, config });
  const db = rows.find((r) => r.service === "db")!;
  expect(db).toMatchObject({ state: "running", port: pb, branch: "main", target: "main" });
  expect(db.pid).toBe(readPid(root, "db")!);
  expect(db.cwd).toBe(join(root, "b"));
  expect(rows.find((r) => r.service === "api")).toMatchObject({ state: "stopped", pid: null, cwd: null, branch: null, target: null });
  const table = formatStatus(rows, root);
  expect(table[1]).toMatch(/^service\s+state\s+port\s+pid\s+cwd\s+branch\s+target$/);
  expect(table.join("\n")).toContain("running");
});

test("--task runs from the worktree when it exists, else from main; the target is remembered", async () => {
  const root = twoRepoFolder();
  const [pa, pb] = [await freePort(), await freePort()];
  mkdirSync(join(root, ".worktrees", "t1", "a"), { recursive: true });
  Bun.spawnSync(["git", "-C", join(root, ".worktrees", "t1", "a"), "init", "-q", "-b", "wip/t1"]);
  const config = twoServices(root, pa, pb);
  guard(root, config);
  const lines: string[] = [];
  await startStack({ root, config, ...quiet, task: "t1", out: (l) => lines.push(l) });
  expect(readTask(root)).toBe("t1");
  const rows = await stackStatus({ root, config });
  expect(rows.find((r) => r.service === "api")).toMatchObject({ cwd: join(root, ".worktrees", "t1", "a"), branch: "wip/t1", target: "t1" });
  expect(rows.find((r) => r.service === "db")).toMatchObject({ cwd: join(root, "b"), target: "main" });
  expect(lines.find((l) => l.startsWith("api:"))).toContain("(worktree)");
  expect(lines.find((l) => l.startsWith("db:"))).toContain("main checkout, no worktree");
});

test("target: --main overrides, and .local-run/task is the fallback", () => {
  const root = twoRepoFolder();
  mkdirSync(join(root, ".worktrees", "t2", "a"), { recursive: true });
  const config = twoServices(root, 1, 2);
  const cwdOf = (o: { task?: string; main?: boolean }, name = "api") => resolveTarget(root, config, o).services.find((s) => s.name === name)!.cwd;
  expect(readTask(root)).toBe("main");
  expect(cwdOf({})).toBe(join(root, "a"));
  mkdirSync(join(root, ".local-run"), { recursive: true });
  writeFileSync(join(root, ".local-run", "task"), "t2\n");
  expect(cwdOf({})).toBe(join(root, ".worktrees", "t2", "a"));
  expect(cwdOf({ main: true })).toBe(join(root, "a"));
  expect(cwdOf({ task: "none" })).toBe(join(root, "a"));
  expect(() => resolveTarget(root, config, { task: "t2", main: true })).toThrow("exclude");
});

test("restart stops, starts again with a new pid and writes restart.log", async () => {
  const root = twoRepoFolder();
  const port = await freePort();
  const config = cfg({ a: { path: "a" } }, { w: svc({ repo: "a", start: serverCmd(port), port }) });
  guard(root, config);
  await startStack({ root, config, ...quiet });
  const pid = readPid(root, "w");
  await restartStack({ root, config, ...quiet });
  expect(readPid(root, "w")).not.toBe(pid);
  expect(await portHeld(port)).toBe(true);
  expect(readFileSync(join(root, ".local-run", "restart.log"), "utf8")).toContain("w: started");
});

test("temp dirs are registered with the leak guard", () => {
  expect(createdTempDirs.size).toBeGreaterThan(0);
});
