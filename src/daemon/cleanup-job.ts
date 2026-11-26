import { existsSync, realpathSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { threadDirFiles } from "../agents/agents-md.ts";
import type { Effect } from "../commands/handler.ts";
import { spawnAsync } from "../herdr/bridge.ts";

export type CleanupEffect = Extract<Effect, { kind: "git.thread.cleanup" }>;
/** A stopped job names the repo and the reason, and the repos it had already removed. */
export type CleanupOutcome = { ok: true; repos: string[]; notes?: string[] } | { ok: false; repo: string; error: string; removed: string[] };

const GIT_TIMEOUT_MS = 60_000;

/**
 * `agt thread cleanup`'s background job (never blocking the daemon). Every worktree is checked first with `git status
 * --porcelain` (which honours ignores and the generated files' excludes), and where the squash branch (feat/fix/chore/<task>) is missing, wip/<task>
 * must have no commits that no other branch has: either stops the job before anything is removed. Then, per repo, `git worktree remove` without --force (git refuses again if a file appeared since the check,
 * so uncommitted work is never deleted) and `git branch -D wip/<task>`; the squash branch is never touched. A worktree or
 * branch already gone (an earlier cleanup that stopped mid-way, or a folder deleted by hand) is skipped or only
 * unregistered, so the job can run again. Last, the thread
 * directory goes if only agt's own files are left in it.
 */
export async function cleanupThread(e: CleanupEffect, stopping: () => boolean = () => false): Promise<CleanupOutcome> {
  const git = (cwd: string, args: string[], env: Record<string, string | undefined> = process.env) => spawnAsync("git", ["-C", cwd, ...args], env, GIT_TIMEOUT_MS);
  const why = (r: { exitCode: number; stderr: string; timedOut?: boolean }) => (r.timedOut ? "timed out" : r.stderr.trim() || `exit ${r.exitCode}`);
  const removed: string[] = [];
  const notes: string[] = [];
  const stop = (repo: string, error: string): CleanupOutcome => ({ ok: false, repo, error: removed.length ? `${error} (already removed: ${removed.join(", ")})` : error, removed });
  const branch = `wip/${e.task}`;
  const hasBranch = async (repoPath: string, name: string) => (await git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])).exitCode === 0;
  for (const r of e.repos) {
    if (stopping()) return stop(r.repo, "the daemon is stopping");
    // Without the squash branch the squash may never have happened: wip/<task> commits no other branch has would be lost.
    // (A thread made before the branch followed its type squashed onto feat/<task>.)
    // A doc thread commits nothing: no squash to check, and its worktrees hold only throwaway files. A commit the user
    // made on the detached HEAD (only an agent is refused) would be lost by the forced remove: stop for it.
    if (e.doc) {
      if (!existsSync(r.path)) continue;
      const lost = await commitsAfterCheckout(r.path);
      if (lost === undefined) return stop(r.repo, `cannot read the history of ${r.path}`);
      if (lost) return stop(r.repo, `${r.path} has commits made after its checkout; keep them on a branch (git -C ${r.path} switch -c <name>), then run cleanup again`);
      continue;
    }
    const squashed = (e.squashBranch !== undefined && (await hasBranch(r.repoPath, e.squashBranch))) || (await hasBranch(r.repoPath, `feat/${e.task}`));
    if (!squashed && (await hasBranch(r.repoPath, branch))) {
      const own = await git(r.repoPath, ["rev-list", `refs/heads/${branch}`, "--not", `--exclude=${branch}`, "--branches"]);
      if (own.exitCode !== 0 || own.timedOut) return stop(r.repo, `git rev-list failed: ${why(own)}`);
      if (own.stdout.trim()) return stop(r.repo, `${branch} has commits that were never squashed; if it was merged another way, delete it with git branch -D ${branch} and run cleanup again`);
    }
    if (!existsSync(r.path)) continue;
    // git may not search above the worktree (the thread directory, or a workspace root that is itself a repo).
    const st = await git(r.path, ["status", "--porcelain"], { ...process.env, GIT_CEILING_DIRECTORIES: dirname(r.path) });
    if (st.exitCode !== 0 || st.timedOut) return stop(r.repo, `git status failed: ${why(st)}`);
    if (st.stdout.trim()) return stop(r.repo, "uncommitted changes");
  }
  for (const r of e.repos) {
    if (stopping()) return stop(r.repo, "the daemon is stopping");
    // A folder deleted by hand leaves a stale (prunable) entry: `git worktree remove` on its path drops that entry
    // alone, where `git worktree prune` would drop every stale entry in the user's checkout.
    if (existsSync(r.path) || (await registered(r.repoPath, r.path))) {
      const out = await git(r.repoPath, ["worktree", "remove", ...(e.doc ? ["--force"] : []), r.path]);
      if (out.exitCode !== 0 || out.timedOut) return stop(r.repo, `git worktree remove failed: ${why(out)}`);
    }
    // A doc thread's wip branch (a worktree_setup may make one) goes only when no commit would be lost with it.
    if (e.doc && (await hasBranch(r.repoPath, branch))) {
      const own = await git(r.repoPath, ["rev-list", `refs/heads/${branch}`, "--not", `--exclude=${branch}`, "--branches"]);
      if (own.exitCode !== 0 || own.timedOut) return stop(r.repo, `git rev-list failed: ${why(own)}`);
      if (own.stdout.trim()) {
        notes.push(`kept ${branch} in ${r.repo}: it has commits of its own`);
        removed.push(r.repo);
        continue;
      }
    }
    if (await hasBranch(r.repoPath, branch)) {
      const out = await git(r.repoPath, ["branch", "-D", branch]);
      if (out.exitCode !== 0 || out.timedOut) return stop(r.repo, `git branch -D ${branch} failed: ${why(out)}`);
    }
    removed.push(r.repo);
  }
  if (await onlyGenerated(e.dir)) await rm(e.dir, { recursive: true, force: true });
  return { ok: true, repos: removed, ...(notes.length ? { notes } : {}) };
}

/**
 * Whether a doc thread's detached worktree has commits made after its checkout that no branch or remote holds: its
 * oldest HEAD reflog entry is the checkout. Undefined when git cannot tell.
 */
async function commitsAfterCheckout(path: string): Promise<boolean | undefined> {
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(path) };
  const log = await spawnAsync("git", ["-C", path, "reflog", "show", "--format=%H", "HEAD"], env, GIT_TIMEOUT_MS);
  if (log.exitCode !== 0 || log.timedOut) return undefined;
  const first = log.stdout.trim().split("\n").filter(Boolean).pop();
  if (!first) return false;
  const own = await spawnAsync("git", ["-C", path, "rev-list", "HEAD", `^${first}`, "--not", "--branches", "--remotes"], env, GIT_TIMEOUT_MS);
  if (own.exitCode !== 0 || own.timedOut) return undefined;
  return own.stdout.trim() !== "";
}

/** Whether git lists a worktree at `path` (it may be stale: its folder gone). */
async function registered(repoPath: string, path: string): Promise<boolean> {
  const r = await spawnAsync("git", ["-C", repoPath, "worktree", "list", "--porcelain"], process.env, GIT_TIMEOUT_MS);
  const want = canonical(path);
  return r.stdout.split("\n").some((l) => l.startsWith("worktree ") && canonical(l.slice("worktree ".length)) === want);
}

/** `p` with its existing ancestors resolved (macOS /var is /private/var), so git's paths compare equal. */
export function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(canonical(parent), basename(p));
  }
}

/** Whether `dir` exists and holds nothing but agt's files (and the folders they sit in). Symlinks are never followed. */
async function onlyGenerated(dir: string): Promise<boolean> {
  const files = threadDirFiles();
  const GENERATED = new Set(files);
  const GENERATED_DIRS = new Set(files.flatMap((f) => f.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))));
  const walk = async (rel: string): Promise<boolean> => {
    for (const name of await readdir(join(dir, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      const st = await lstat(join(dir, r));
      if (st.isDirectory() ? !GENERATED_DIRS.has(r) || !(await walk(r)) : !GENERATED.has(r)) return false;
    }
    return true;
  };
  try {
    return await walk("");
  } catch {
    return false;
  }
}
