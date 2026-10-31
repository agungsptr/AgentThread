import { expect, test } from "bun:test";
import { ConfigSchema } from "../../src/config/config.ts";
import { basename } from "node:path";
import { discoverRepos, isWorkspaceProject, workspaceRepos } from "../../src/project/workspace.ts";
import { tempRepo, twoRepoFolder } from "../helpers.ts";

test("discoverRepos returns only the child git repos", () => {
  const root = twoRepoFolder();
  expect(discoverRepos(root)).toEqual({ a: { path: "a" }, b: { path: "b" } });
  expect(isWorkspaceProject(root)).toBe(true);
});

test("a git root is its own single repo", () => {
  const root = tempRepo();
  expect(discoverRepos(root)).toEqual({ [basename(root)]: { path: "." } });
  expect(isWorkspaceProject(root)).toBe(false);
});

test("workspaceRepos prefers config over discovery", () => {
  const root = twoRepoFolder();
  expect(Object.keys(workspaceRepos(root, ConfigSchema.parse({})))).toEqual(["a", "b"]);
  const c = ConfigSchema.parse({ workspace: { repos: { a: { path: "a", source_branch: "dev" } } } });
  expect(workspaceRepos(root, c)).toEqual({ a: { path: "a", source_branch: "dev" } });
});
