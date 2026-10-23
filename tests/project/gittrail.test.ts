import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitTrail, memoizedTrail } from "../../src/project/gittrail.ts";
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
  expect(gitTrail({ root, worktree: wt, branch: "thread/002-y" })).toEqual({ commits: [], diffStat: "", untracked: 0 });
});

test("gitTrail is undefined when the worktree does not exist", () => {
  expect(gitTrail({ root: tempRepo(), worktree: "/nonexistent/wt", branch: "b" })).toBeUndefined();
});

test("gitTrail still lists thread commits after the branch is merged into main", () => {
  const root = tempRepo();
  const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "agt-wt-"))), "wt");
  git(root, "worktree", "add", "-q", "-b", "thread/003-z", wt);
  writeFileSync(join(wt, "m.txt"), "m\n");
  git(wt, "add", "m.txt");
  git(wt, "-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-q", "-m", "merged work");
  git(root, "-c", "user.email=t@e.com", "-c", "user.name=T", "merge", "-q", "--no-ff", "-m", "merge", "thread/003-z");
  const trail = gitTrail({ root, worktree: wt, branch: "thread/003-z" })!;
  expect(trail.commits).toHaveLength(1);
  expect(trail.commits[0]).toContain("merged work");
});

test("gitTrail counts untracked files", () => {
  const root = tempRepo();
  const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "agt-wt-"))), "wt");
  git(root, "worktree", "add", "-q", "-b", "thread/004-u", wt);
  writeFileSync(join(wt, "new.txt"), "n\n");
  expect(gitTrail({ root, worktree: wt, branch: "thread/004-u" })!.untracked).toBe(1);
});

test("memoizedTrail caches for the ttl", () => {
  const root = tempRepo();
  const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "agt-wt-"))), "wt");
  git(root, "worktree", "add", "-q", "-b", "thread/005-c", wt);
  let now = 0;
  const memo = memoizedTrail(root, 3000, () => now);
  const t = { id: "005", status: "open", worktree: wt, branch: "thread/005-c" };
  expect(memo(t)!.untracked).toBe(0);
  writeFileSync(join(wt, "n.txt"), "n\n");
  expect(memo(t)!.untracked).toBe(0);
  now = 3001;
  expect(memo(t)!.untracked).toBe(1);
});
