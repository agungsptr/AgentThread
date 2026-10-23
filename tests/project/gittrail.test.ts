import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitTrail } from "../../src/project/gittrail.ts";
import { tempRepo } from "../helpers.ts";

const git = (dir: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};

test("gitTrail lists thread commits and the uncommitted diff stat", () => {
  const root = tempRepo();
  const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "agt-wt-"))), "wt");
  git(root, "worktree", "add", "-q", "-b", "thread/001-x", wt);
  writeFileSync(join(wt, "a.txt"), "one\n");
  git(wt, "add", "a.txt");
  git(wt, "-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-q", "-m", "add a");
  writeFileSync(join(wt, "a.txt"), "one\ntwo\n");
  const trail = gitTrail({ root, worktree: wt, branch: "thread/001-x" })!;
  expect(trail.commits).toHaveLength(1);
  expect(trail.commits[0]).toContain("add a");
  expect(trail.diffStat).toContain("1 file changed");
});

test("gitTrail has an empty diffStat when clean", () => {
  const root = tempRepo();
  const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "agt-wt-"))), "wt");
  git(root, "worktree", "add", "-q", "-b", "thread/002-y", wt);
  expect(gitTrail({ root, worktree: wt, branch: "thread/002-y" })).toEqual({ commits: [], diffStat: "" });
});

test("gitTrail is undefined when the worktree does not exist", () => {
  expect(gitTrail({ root: tempRepo(), worktree: "/nonexistent/wt", branch: "b" })).toBeUndefined();
});
