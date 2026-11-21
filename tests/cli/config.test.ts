import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { initProject } from "../../src/project/init.ts";
import { isolatedConfigHome, tempRepo } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");

function agt(root: string, args: string[]) {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", XDG_CONFIG_HOME: isolatedConfigHome(), AGT_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

test("agt config prints the effective config", () => {
  const root = tempRepo();
  initProject(root, "demo");
  writeFileSync(join(root, ".agentthread", "config.yaml"), "workers:\n  max_workers: 4\n");
  const r = agt(root, ["config"]);
  expect(r.code).toBe(0);
  expect(parse(r.out)).toMatchObject({ language: "en", workers: { max_workers: 4 }, herdr: { main_tab_label: "main" } });
});

test("agt config reports invalid config", () => {
  const root = tempRepo();
  initProject(root, "demo");
  writeFileSync(join(root, ".agentthread", "config.yaml"), "herdr:\n  close_tab_on_done: maybe\n");
  const r = agt(root, ["config"]);
  expect(r.code).toBe(1);
  expect(r.err).toMatch(/^agt: invalid config .*herdr\.close_tab_on_done/);
});

test("config show and apply warn about tracked copy entries and browser ports with no service", () => {
  const root = tempRepo();
  initProject(root, "demo");
  // tempRepo is a git repo: track a file there, then name it in copy
  writeFileSync(join(root, ".env"), "X=1\n");
  Bun.spawnSync(["git", "-C", root, "add", ".env"]);
  const repoDir = root.split("/").pop()!;
  const patch = join(root, "patch.yaml");
  writeFileSync(
    patch,
    `workspace:\n  repos:\n    app: { path: ".", copy: [".env", "nothere"] }\n  services:\n    web: { repo: app, start: "true", port: 3000 }\nworkflow:\n  browser:\n    urls: ["http://localhost:3000/", "http://localhost:9001/", "https://example.com/"]\n`,
  );
  void repoDir;
  const dry = agt(root, ["config", "apply", "--dry-run", patch]);
  expect(dry.code).toBe(0);
  expect(dry.err).toContain("copy app/.env is tracked by git: agt marks it skip-worktree in each worktree");
  expect(dry.err).toContain("port 9001 matches no service port (3000)");
  expect(dry.err).not.toContain("nothere");
  expect(dry.err).not.toContain("example.com");
  expect(agt(root, ["config", "apply", patch]).code).toBe(0);
  const show = agt(root, ["config", "show"]);
  expect(show.err).toContain("copy app/.env is tracked by git");
  expect(show.err).toContain("port 9001");
});

test("service env values are redacted in config, config show (yaml and json) and the apply diff", () => {
  const root = tempRepo();
  initProject(root, "demo");
  const patch = join(root, "patch.yaml");
  writeFileSync(patch, `workspace:\n  repos:\n    app: { path: "." }\n  services:\n    web: { repo: app, start: "true", env: { TOKEN: "hunter2" } }\n`);
  const dry = agt(root, ["config", "apply", "--dry-run", patch]);
  expect(dry.out).toContain("workspace.services.web.env.TOKEN: ***");
  expect(dry.out + dry.err).not.toContain("hunter2");
  expect(agt(root, ["config", "apply", patch]).code).toBe(0);
  writeFileSync(patch, `workspace:\n  services:\n    web: { env: { TOKEN: "other-secret" } }\n`);
  const change = agt(root, ["config", "apply", "--dry-run", patch]);
  expect(change.out).toContain("~ workspace.services.web.env.TOKEN: ***");
  expect(change.out).not.toContain("secret");
  for (const args of [["config"], ["config", "show"], ["config", "show", "--json"]]) {
    const r = agt(root, args);
    expect(r.out).toContain("***");
    expect(r.out).toContain("TOKEN");
    expect(r.out).not.toContain("hunter2");
  }
});
