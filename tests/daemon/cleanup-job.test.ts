import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupThread, type CleanupEffect } from "../../src/daemon/cleanup-job.ts";

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim() };
};

/** A workspace with repo `api` and a doc thread's detached worktree of it at .worktrees/rv-1/api. */
function docThread(): { root: string; api: string; path: string; effect: CleanupEffect } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agt-clean-")));
  const api = join(root, "api");
  mkdirSync(api);
  git(api, "init", "-q", "-b", "main");
  git(api, "commit", "-q", "--allow-empty", "-m", "init");
  const dir = join(root, ".worktrees", "rv-1");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "api");
  git(api, "worktree", "add", "-q", "--detach", path, "main");
  return { root, api, path, effect: { kind: "git.thread.cleanup", thread: "001", task: "rv-1", doc: true, dir, repos: [{ repo: "api", repoPath: api, path }] } };
}

describe("cleanup of a doc thread", () => {
  test("with no worktrees, its thread directory of agt's files goes", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agt-clean-")));
    const dir = join(root, ".worktrees", "rv-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "# AgentThread\n");
    expect(await cleanupThread({ kind: "git.thread.cleanup", thread: "001", task: "rv-1", doc: true, dir, repos: [] })).toEqual({ ok: true, repos: [] });
    expect(existsSync(dir)).toBe(false);
  });

  test("stops when the detached HEAD has commits made after the checkout (a user's own)", async () => {
    const t = docThread();
    git(t.path, "commit", "-q", "--allow-empty", "-m", "mine");
    const out = await cleanupThread(t.effect);
    expect(out).toMatchObject({ ok: false, repo: "api" });
    expect(out.ok ? "" : out.error).toBe(`${t.path} has commits made after its checkout; keep them on a branch (git -C ${t.path} switch -c <name>), then run cleanup again`);
    expect(existsSync(t.path)).toBe(true);
  });

  test("a detached HEAD whose new commits are on a branch is removed", async () => {
    const t = docThread();
    git(t.path, "commit", "-q", "--allow-empty", "-m", "mine");
    git(t.path, "branch", "keep-mine");
    expect(await cleanupThread(t.effect)).toEqual({ ok: true, repos: ["api"] });
  });

  test("removes a worktree with uncommitted throwaway files", async () => {
    const t = docThread();
    writeFileSync(join(t.path, "repro.test.ts"), "throwaway\n");
    expect(await cleanupThread(t.effect)).toEqual({ ok: true, repos: ["api"] });
    expect(existsSync(t.path)).toBe(false);
  });

  test("deletes a wip/<task> without commits of its own", async () => {
    const t = docThread();
    git(t.api, "branch", "wip/rv-1", "main");
    expect(await cleanupThread(t.effect)).toEqual({ ok: true, repos: ["api"] });
    expect(git(t.api, "rev-parse", "--verify", "--quiet", "refs/heads/wip/rv-1").ok).toBe(false);
  });

  test("keeps a wip/<task> with commits of its own, and says so", async () => {
    const t = docThread();
    git(t.api, "branch", "wip/rv-1", "main");
    const other = join(t.root, "other");
    git(t.api, "worktree", "add", "-q", other, "wip/rv-1");
    git(other, "commit", "-q", "--allow-empty", "-m", "own");
    git(t.api, "worktree", "remove", other);
    expect(await cleanupThread(t.effect)).toEqual({ ok: true, repos: ["api"], notes: ["kept wip/rv-1 in api: it has commits of its own"] });
    expect(git(t.api, "rev-parse", "--verify", "--quiet", "refs/heads/wip/rv-1").ok).toBe(true);
  });
});
