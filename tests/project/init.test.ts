import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree } from "../../src/project/git.ts";
import { initProject } from "../../src/project/init.ts";
import { paths } from "../../src/project/paths.ts";
import { findRoot } from "../../src/project/root.ts";
import { EventStore } from "../../src/store/event-store.ts";
import { tempRepo, twoRepoFolder } from "../helpers.ts";

test("init creates the event store, gitignore entries and main thread", () => {
  const root = tempRepo();
  initProject(root, "demo");
  const p = paths(root);
  const store = new EventStore(p.db);
  expect(store.all().map((e) => e.type)).toEqual(["project.initialized"]);
  store.close();
  expect(readFileSync(p.mainThread, "utf8")).toContain("# Main Thread — demo");
  const ignore = readFileSync(join(root, ".gitignore"), "utf8");
  expect(ignore).toContain(".worktrees/\n.agentthread/*\n!.agentthread/config.yaml\n.local-run/\n");
});

test("init refuses to run twice", () => {
  const root = tempRepo();
  initProject(root);
  expect(() => initProject(root)).toThrow("already initialized");
});

test("init refuses a folder with no git repositories", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agt-nogit-")));
  expect(() => initProject(dir)).toThrow(`no git repositories found in ${dir}`);
});

test("init works in a folder of repos and creates a .docs git repo", () => {
  const root = twoRepoFolder();
  initProject(root, "ws");
  expect(existsSync(paths(root).db)).toBe(true);
  expect(existsSync(join(root, ".gitignore"))).toBe(false);
  const docs = join(root, ".docs");
  expect(Bun.spawnSync(["git", "-C", docs, "rev-parse", "--show-toplevel"]).stdout.toString().trim()).toBe(docs);
  expect(Bun.spawnSync(["git", "-C", docs, "log", "--format=%s"]).stdout.toString().trim()).not.toBe("");
  for (const scope of ["shared", "a", "b"]) for (const k of ["issues", "specs", "plans", "adr", "notes", "agents"]) expect(existsSync(join(docs, scope, k, ".gitkeep"))).toBe(true);
  expect(existsSync(join(docs, "plain"))).toBe(false);
  expect(existsSync(join(docs, ".docs"))).toBe(false);
});

test("findRoot walks up from a worktree subdirectory", () => {
  const root = tempRepo();
  initProject(root);
  const deep = join(root, ".worktrees", "001-x", "src", "lib");
  mkdirSync(deep, { recursive: true });
  expect(findRoot(deep, {})).toBe(root);
});

test("findRoot honors AGT_ROOT and fails outside a project", () => {
  expect(findRoot("/", { AGT_ROOT: "/some/root" })).toBe("/some/root");
  expect(findRoot("/", { AGT_ROOT: tmpdir() })).toBe(realpathSync(tmpdir()));
  expect(() => findRoot(realpathSync(tmpdir()), {})).toThrow("not inside an AgentThread project");
});

test("addWorktree creates the branch and directory", () => {
  const root = tempRepo();
  const path = join(root, ".worktrees", "001-x");
  addWorktree(root, "thread/001-x", path);
  expect(existsSync(join(path, ".git"))).toBe(true);
  expect(() => addWorktree(root, "thread/001-x", join(root, ".worktrees", "dup"))).toThrow("git worktree add failed");
});

test("init renders files from the project's config: banned-words lists its banned_words", () => {
  const root = tempRepo();
  mkdirSync(join(root, ".agentthread"), { recursive: true });
  writeFileSync(join(root, ".agentthread", "config.yaml"), "workflow:\n  banned_words: [Zentro, acme corp]\n");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agt-home-")));
  initProject(root, "demo", { HOME: home, XDG_CONFIG_HOME: join(home, "xdg") });
  expect(readFileSync(join(root, ".agentthread", "banned-words"), "utf8")).toBe("Zentro\nacme corp\n");
});
