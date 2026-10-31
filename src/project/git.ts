import { spawnAsync } from "../herdr/bridge.ts";

export function isGitRepo(root: string): boolean {
  return Bun.spawnSync(["git", "-C", root, "rev-parse", "--is-inside-work-tree"], { stderr: "pipe" }).exitCode === 0;
}

export function addWorktree(root: string, branch: string, path: string): void {
  const r = Bun.spawnSync(["git", "-C", root, "worktree", "add", "-b", branch, path], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git worktree add failed: ${r.stderr.toString().trim()}`);
}

/** addWorktree without blocking the event loop (the daemon's effects). */
export async function addWorktreeAsync(root: string, branch: string, path: string): Promise<void> {
  const r = await spawnAsync("git", ["-C", root, "worktree", "add", "-b", branch, path], process.env, 30_000);
  if (r.exitCode !== 0 || r.timedOut) throw new Error(`git worktree add failed: ${r.timedOut ? "timed out" : r.stderr.trim()}`);
}

/**
 * `git -C <repoDir> worktree add -b <branch> <path> <source>` without blocking. A `<remote>/<branch>` source that is
 * not yet present locally is fetched from that remote first.
 */
export async function addWorktreeFromAsync(repoDir: string, branch: string, path: string, source: string): Promise<void> {
  const git = (args: string[], timeoutMs = 30_000) => spawnAsync("git", ["-C", repoDir, ...args], process.env, timeoutMs);
  const slash = source.indexOf("/");
  if (slash > 0 && (await git(["rev-parse", "--verify", "--quiet", `${source}^{commit}`])).exitCode !== 0) {
    const remote = source.slice(0, slash);
    const remotes = await git(["remote"]);
    if (remotes.exitCode === 0 && remotes.stdout.split("\n").map((l) => l.trim()).includes(remote)) {
      const f = await git(["fetch", "--quiet", remote, source.slice(slash + 1)], 120_000);
      if (f.exitCode !== 0 || f.timedOut) throw new Error(`git fetch ${remote} ${source.slice(slash + 1)} failed: ${f.timedOut ? "timed out" : f.stderr.trim()}`);
    }
  }
  const r = await git(["worktree", "add", "-b", branch, path, source]);
  if (r.exitCode !== 0 || r.timedOut) throw new Error(`git worktree add failed: ${r.timedOut ? "timed out" : r.stderr.trim()}`);
}
