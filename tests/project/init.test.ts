import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree } from "../../src/project/git.ts";
import { initProject } from "../../src/project/init.ts";
import { paths } from "../../src/project/paths.ts";
import { findRoot } from "../../src/project/root.ts";
import { EventStore } from "../../src/store/event-store.ts";
import { tempRepo } from "../helpers.ts";

test("init creates the event store, gitignore entries and main thread", () => {
  const root = tempRepo();
  initProject(root, "demo");
  const p = paths(root);
  const store = new EventStore(p.db);
  expect(store.all().map((e) => e.type)).toEqual(["project.initialized"]);
  store.close();
  expect(readFileSync(p.mainThread, "utf8")).toContain("# Main Thread — demo");
  const ignore = readFileSync(join(root, ".gitignore"), "utf8");
  expect(ignore).toContain(".worktrees/\n.agentthread/*\n!.agentthread/config.yaml\n");
});

test("init refuses to run twice", () => {
  const root = tempRepo();
  initProject(root);
  expect(() => initProject(root)).toThrow("already initialized");
});

test("init refuses a directory that is not a git repo", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agt-nogit-")));
  expect(() => initProject(dir)).toThrow("not a git repository");
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
