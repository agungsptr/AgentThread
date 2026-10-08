export function isGitRepo(root: string): boolean {
  return Bun.spawnSync(["git", "-C", root, "rev-parse", "--is-inside-work-tree"], { stderr: "pipe" }).exitCode === 0;
}

export function addWorktree(root: string, branch: string, path: string): void {
  const r = Bun.spawnSync(["git", "-C", root, "worktree", "add", "-b", branch, path], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git worktree add failed: ${r.stderr.toString().trim()}`);
}
