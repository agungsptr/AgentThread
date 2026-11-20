import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { initProject } from "../../src/project/init.ts";
import { applyConfig } from "../../src/project/config-apply.ts";
import { initCommand } from "../../src/project/setup.ts";
import { isolatedConfigHome, repoName, tempRepo, twoRepoFolder } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");
const envOf = (root: string) => ({ PATH: process.env.PATH ?? "", HOME: "/nonexistent", XDG_CONFIG_HOME: isolatedConfigHome(), AGT_ROOT: root });

function agt(root: string, args: string[], stdin?: string) {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd: root,
    env: envOf(root),
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}
const cfgFile = (root: string) => join(root, ".agentthread", "config.yaml");

test("init --no-setup: fresh project, no prompts, no wizard hint", () => {
  const root = tempRepo();
  const r = agt(root, ["init", "--no-setup"]);
  expect(r.code).toBe(0);
  expect(r.out).toBe("initialized");
  expect(r.err).toBe("");
  expect(existsSync(join(root, ".agentthread", "state.db"))).toBe(true);
  expect(existsSync(cfgFile(root))).toBe(false);
});

test("init --no-setup: already initialised reports it, exits 0, changes nothing", () => {
  const root = tempRepo();
  initProject(root, "demo");
  writeFileSync(cfgFile(root), "workers:\n  max_workers: 4\n");
  const r = agt(root, ["init", "--no-setup"]);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/^already initialized at /);
  expect(readFileSync(cfgFile(root), "utf8")).toBe("workers:\n  max_workers: 4\n");
});

test("init --no-setup never reads prompts even on a TTY", async () => {
  const root = tempRepo();
  const code = await initCommand(root, { XDG_CONFIG_HOME: isolatedConfigHome(), HOME: "/nonexistent" }, "demo", true, true);
  expect(code).toBe(0);
  expect(existsSync(cfgFile(root))).toBe(false);
});

test("config show prints yaml with the layer files, and json with a sources key", () => {
  const root = tempRepo();
  initProject(root, "demo");
  writeFileSync(cfgFile(root), "workers:\n  max_workers: 4\n");
  const y = agt(root, ["config", "show"]);
  expect(y.code).toBe(0);
  expect(y.out).toContain(`# project config: ${cfgFile(root)}`);
  expect(y.out).toMatch(/# user config: .* \(not present\)/);
  expect(parse(y.out)).toMatchObject({ workers: { max_workers: 4 } });
  const j = JSON.parse(agt(root, ["config", "show", "--json"]).out);
  expect(j.config.workers.max_workers).toBe(4);
  expect(j.sources.project).toEqual({ path: cfgFile(root), exists: true });
  expect(j.sources.user.exists).toBe(false);
});

test("config apply: partial merge keeps other keys and comments, prints diff", () => {
  const root = tempRepo();
  initProject(root, "demo");
  writeFileSync(cfgFile(root), "# my config\nworkers:\n  max_workers: 4 # keep\nlanguage: en\n");
  const r = agt(root, ["config", "apply", "-"], "workers:\n  max_workers: 5\nworkflow:\n  chat_language: Indonesian\n");
  expect(r.code).toBe(0);
  expect(r.out).toContain("~ workers.max_workers: 4 -> 5");
  expect(r.out).toContain('+ workflow.chat_language: "Indonesian"');
  const text = readFileSync(cfgFile(root), "utf8");
  expect(text).toContain("# my config");
  expect(parse(text)).toEqual({ workers: { max_workers: 5 }, language: "en", workflow: { chat_language: "Indonesian" } });
  expect(text).toContain("# keep");
});

test("config apply: workspace.repos merge by repo name; null removes a key; JSON file input", () => {
  const root = twoRepoFolder();
  initProject(root, "demo");
  writeFileSync(cfgFile(root), "workspace:\n  repos:\n    a:\n      path: a\n      unit: make unit\n    b:\n      path: b\n");
  const patch = join(root, "patch.json");
  writeFileSync(patch, JSON.stringify({ workspace: { repos: { a: { typecheck: "make tc", unit: null }, b: { prod_branch: "main" } } } }));
  const r = agt(root, ["config", "apply", patch]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("- workspace.repos.a.unit:");
  expect(parse(readFileSync(cfgFile(root), "utf8")).workspace.repos).toEqual({
    a: { path: "a", typecheck: "make tc" },
    b: { path: "b", prod_branch: "main" },
  });
});

test("config apply: invalid input prints path and message, exits non-zero, writes nothing", () => {
  const root = tempRepo();
  initProject(root, "demo");
  const before = "workers:\n  max_workers: 4\n";
  writeFileSync(cfgFile(root), before);
  const r = agt(root, ["config", "apply", "-"], "workers:\n  max_workers: 99\n");
  expect(r.code).toBe(1);
  expect(r.err).toContain("workers.max_workers:");
  expect(readFileSync(cfgFile(root), "utf8")).toBe(before);
  expect(agt(root, ["config", "apply", "-"], "- not a mapping\n").code).toBe(1);
});

test("config apply --dry-run validates and prints the diff but writes nothing", () => {
  const root = tempRepo();
  initProject(root, "demo");
  const r = agt(root, ["config", "apply", "--dry-run", "-"], "workers:\n  max_workers: 7\n");
  expect(r.code).toBe(0);
  expect(r.out).toContain("+ workers.max_workers: 7");
  expect(r.out).toContain("dry run");
  expect(existsSync(cfgFile(root))).toBe(false);
});

test("config apply on a --no-setup project (no roles) works and writes banned-words via the refresh", () => {
  const root = tempRepo();
  expect(agt(root, ["init", "--no-setup"]).code).toBe(0);
  const r = agt(root, ["config", "apply", "-"], "agents:\n  roles:\n    worker:\n      agent: claude-code\nworkflow:\n  banned_words: [foo]\n");
  expect(r.code).toBe(0);
  expect(readFileSync(join(root, ".agentthread", "banned-words"), "utf8")).toBe("foo\n");
});

test("applyConfig runs the refresh only on a real write, and reports a hash change", () => {
  const root = tempRepo();
  initProject(root, "demo");
  const env = { XDG_CONFIG_HOME: isolatedConfigHome(), HOME: "/nonexistent" };
  let calls = 0;
  const refresh = () => void calls++;
  const dry = applyConfig({ root, env, text: "workers:\n  max_workers: 5\n", dryRun: true, refresh });
  expect(dry).toMatchObject({ ok: true, written: false });
  expect(calls).toBe(0);
  const bad = applyConfig({ root, env, text: "workers:\n  max_workers: 0\n", refresh });
  expect(bad.ok).toBe(false);
  expect(calls).toBe(0);
  const real = applyConfig({ root, env, text: "workers:\n  max_workers: 5\n", refresh });
  expect(real).toMatchObject({ ok: true, written: true, hashChanged: true });
  expect(calls).toBe(1);
  expect(applyConfig({ root, env, text: "workers:\n  max_workers: 5\n", refresh })).toMatchObject({ ok: true, diff: [], hashChanged: false });
  void repoName;
});
