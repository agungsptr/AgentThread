import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../src/cli/main.ts";
import { portHeld } from "../../src/stack/health.ts";
import { initProject } from "../../src/project/init.ts";
import { isolatedConfigHome, twoRepoFolder } from "../helpers.ts";

let toStop: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await toStop?.();
  toStop = undefined;
});

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    return { code: await fn(), out: lines.join("\n") };
  } finally {
    console.log = orig;
  }
}

test("agt stack start/status/logs/stop through the CLI; init ignores .local-run", async () => {
  const root = twoRepoFolder();
  const s = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const port = s.port!;
  await s.stop(true);
  const env = { XDG_CONFIG_HOME: isolatedConfigHome() };
  initProject(root, "demo", env);
  expect(await Bun.file(join(root, ".gitignore")).exists()).toBe(false); // workspace folder, not a repo
  mkdirSync(join(root, ".agentthread"), { recursive: true });
  writeFileSync(
    join(root, ".agentthread", "config.yaml"),
    `workspace:\n  repos:\n    a: { path: a }\n  services:\n    web:\n      repo: a\n      start: "bun -e 'Bun.serve({port:${port},fetch:()=>new Response(\\"ok\\")});console.log(\\"hello-log\\");setInterval(()=>{},1000)'"\n      port: ${port}\n`,
  );
  toStop = () => main(["stack", "stop"], env, root);
  const start = await capture(() => main(["stack", "start", "--main"], env, root));
  expect(start.code).toBe(0);
  expect(start.out).toContain("web: started");
  expect(await portHeld(port)).toBe(true);
  const json = await capture(() => main(["stack", "status", "--json"], env, root));
  const parsed = JSON.parse(json.out);
  expect(parsed.lock).toBeNull();
  expect(parsed.services[0]).toMatchObject({ service: "web", state: "running", port });
  const table = await capture(() => main(["stack", "status"], env, root));
  expect(table.out).toContain("service");
  expect(table.out).toContain("lock: daemon not running");
  const logs = await capture(() => main(["stack", "logs", "web", "-n", "5"], env, root));
  expect(logs.code).toBe(0);
  const stop = await capture(() => main(["stack", "stop"], env, root));
  expect(stop.out).toContain("web: stopped");
  expect(await portHeld(port)).toBe(false);
});

test("start, stop and restart without services say so and exit 0", async () => {
  const root = twoRepoFolder();
  const env = { XDG_CONFIG_HOME: isolatedConfigHome() };
  initProject(root, "demo", env);
  for (const sub of ["start", "stop", "restart"]) {
    const r = await capture(() => main(["stack", sub], env, root));
    expect(r).toEqual({ code: 0, out: "no services configured (workspace.services)" });
  }
});

test("agt stack restart detaches, writes restart.log and returns at once; --wait runs in the foreground", async () => {
  const root = twoRepoFolder();
  const s = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const port = s.port!;
  await s.stop(true);
  const env = { XDG_CONFIG_HOME: isolatedConfigHome() };
  initProject(root, "demo", env);
  writeFileSync(
    join(root, ".agentthread", "config.yaml"),
    `workspace:\n  repos:\n    a: { path: a }\n  services:\n    web:\n      repo: a\n      start: "bun -e 'Bun.serve({port:${port},fetch:()=>new Response(\\"ok\\")});setInterval(()=>{},1000)'"\n      port: ${port}\n`,
  );
  toStop = () => main(["stack", "stop"], env, root);
  const bg = await capture(() => main(["stack", "restart", "--main"], env, root));
  expect(bg.code).toBe(0);
  expect(bg.out).toContain(join(root, ".local-run", "restart.log"));
  const log = join(root, ".local-run", "restart.log");
  const deadline = Date.now() + 30_000;
  const text = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  while (Date.now() < deadline && !text().includes("web: started")) await Bun.sleep(200);
  expect(text()).toContain("web: started");
  expect(await portHeld(port)).toBe(true);
  const fg = await capture(() => main(["stack", "restart", "--main", "--wait"], env, root));
  expect(fg.code).toBe(0);
  expect(fg.out).toContain("web: started");
  expect(readFileSync(log, "utf8")).toContain("web: started");
}, 60_000);
