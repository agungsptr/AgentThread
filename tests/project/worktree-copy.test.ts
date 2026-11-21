import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyIntoWorktree, linkIntoWorktree, lockfilesDiffer } from "../../src/project/worktree-copy.ts";

const sh = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(a, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
};
const dir = () => realpathSync(mkdtempSync(join(tmpdir(), "agt-wc-")));
function pair() {
  const main = dir();
  sh(main, "git", "init", "-q", "-b", "main");
  sh(main, "git", "config", "user.email", "t@t");
  sh(main, "git", "config", "user.name", "t");
  writeFileSync(join(main, ".env"), "TRACKED=1\n");
  writeFileSync(join(main, "a.txt"), "a\n");
  sh(main, "git", "add", "-A");
  sh(main, "git", "commit", "-qm", "init");
  const wt = join(dir(), "wt");
  sh(main, "git", "worktree", "add", "-q", "-b", "wip/x", wt);
  return { main, wt: realpathSync(wt) };
}

test("copies a directory recursively, keeps modes, never overwrites, skips symlinks", async () => {
  const { main, wt } = pair();
  mkdirSync(join(main, "e2e/.auth/sub"), { recursive: true });
  writeFileSync(join(main, "e2e/.auth/a.json"), "A");
  writeFileSync(join(main, "e2e/.auth/sub/b.json"), "B");
  chmodSync(join(main, "e2e/.auth/sub/b.json"), 0o600);
  symlinkSync("/etc/hosts", join(main, "e2e/.auth/link"));
  mkdirSync(join(wt, "e2e/.auth"), { recursive: true });
  writeFileSync(join(wt, "e2e/.auth/a.json"), "KEEP");
  const r = await copyIntoWorktree(main, wt, ["e2e/.auth"]);
  expect(readFileSync(join(wt, "e2e/.auth/a.json"), "utf8")).toBe("KEEP");
  expect(readFileSync(join(wt, "e2e/.auth/sub/b.json"), "utf8")).toBe("B");
  expect(statSync(join(wt, "e2e/.auth/sub/b.json")).mode & 0o777).toBe(0o600);
  expect(existsSync(join(wt, "e2e/.auth/link"))).toBe(false);
  expect(r.copied).toEqual(["e2e/.auth/sub/b.json"]);
  expect(r.notes.join("\n")).toContain("1 skipped, 1 copied");
});

test("a directory symlinked out of the repo is refused", async () => {
  const { main, wt } = pair();
  const outside = dir();
  writeFileSync(join(outside, "x"), "x");
  symlinkSync(outside, join(main, "esc"));
  const r = await copyIntoWorktree(main, wt, ["esc"]);
  expect(r.copied).toEqual([]);
  expect(r.notes[0]).toContain("refused");
});

test("a tracked file with local edits is copied over the checkout and marked skip-worktree", async () => {
  const { main, wt } = pair();
  writeFileSync(join(main, ".env"), "TRACKED=local\n");
  const r = await copyIntoWorktree(main, wt, [".env"]);
  expect(readFileSync(join(wt, ".env"), "utf8")).toBe("TRACKED=local\n");
  expect(r.skipWorktree).toEqual([".env"]);
  expect(sh(wt, "git", "status", "--porcelain")).toBe("");
  sh(wt, "git", "add", "-A");
  expect(sh(wt, "git", "diff", "--cached", "--name-only")).toBe("");
});

test("a tracked file the worktree already modified is not overwritten", async () => {
  const { main, wt } = pair();
  writeFileSync(join(main, ".env"), "TRACKED=local\n");
  writeFileSync(join(wt, ".env"), "mine\n");
  const r = await copyIntoWorktree(main, wt, [".env"]);
  expect(readFileSync(join(wt, ".env"), "utf8")).toBe("mine\n");
  expect(r.skipWorktree).toEqual([]);
});

test("links directories, refuses escapes, leaves existing ones", async () => {
  const { main, wt } = pair();
  mkdirSync(join(main, "node_modules/x"), { recursive: true });
  const outside = dir();
  symlinkSync(outside, join(main, "esc"));
  const r = await linkIntoWorktree(main, wt, ["node_modules", "esc", "missing", "a.txt"]);
  expect(r.linked).toEqual(["node_modules"]);
  expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(wt, "node_modules"))).toBe(join(main, "node_modules"));
  expect(r.notes.filter((n) => /refused|skipped/.test(n)).length).toBe(3);
  expect((await linkIntoWorktree(main, wt, ["node_modules"])).notes[0]).toContain("already exists");
});

test("lockfilesDiffer compares lockfile content", async () => {
  const a = dir();
  const b = dir();
  writeFileSync(join(a, "yarn.lock"), "1");
  writeFileSync(join(b, "yarn.lock"), "1");
  expect(await lockfilesDiffer(a, b)).toEqual([]);
  writeFileSync(join(b, "yarn.lock"), "2");
  expect(await lockfilesDiffer(a, b)).toEqual(["yarn.lock"]);
});

test("a re-run never clobbers a worker's edit of a skip-worktree file", async () => {
  const { main, wt } = pair();
  writeFileSync(join(main, ".env"), "TRACKED=local\n");
  await copyIntoWorktree(main, wt, [".env"]);
  writeFileSync(join(wt, ".env"), "worker edit\n");
  const r = await copyIntoWorktree(main, wt, ["./.env"]);
  expect(readFileSync(join(wt, ".env"), "utf8")).toBe("worker edit\n");
  expect(r.copied).toEqual([]);
  expect(r.notes[0]).toContain("already exists");
});

test("a directory over the file cap is refused", async () => {
  const { main, wt } = pair();
  mkdirSync(join(main, "big"));
  for (let i = 0; i < 5001; i++) writeFileSync(join(main, "big", `f${i}`), "");
  const r = await copyIntoWorktree(main, wt, ["big"]);
  expect(r.copied).toEqual([]);
  expect(r.notes[0]).toContain("refused (more than 5000 files");
});
