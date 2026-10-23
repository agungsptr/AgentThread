export interface GitTrail {
  commits: string[];
  diffStat: string;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", timeout: 2000 });
    return r.exitCode === 0 ? r.stdout.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function gitTrail(o: { root: string; worktree: string; branch: string; base?: string }): GitTrail | undefined {
  let base = o.base;
  if (!base) {
    const mainHead = git(o.root, ["rev-parse", "HEAD"])?.trim();
    if (!mainHead) return undefined;
    base = git(o.worktree, ["merge-base", "HEAD", mainHead])?.trim();
    if (!base) return undefined;
  }
  const log = git(o.worktree, ["log", "--oneline", `${base}..HEAD`]);
  if (log === undefined) return undefined;
  const stat = git(o.worktree, ["diff", "--stat", "HEAD"]);
  if (stat === undefined) return undefined;
  const lines = stat.split("\n").filter((l) => l.trim());
  return { commits: log.split("\n").filter(Boolean).slice(0, 20), diffStat: (lines[lines.length - 1] ?? "").trim() };
}
