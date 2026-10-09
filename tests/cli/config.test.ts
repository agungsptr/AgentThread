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
