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
