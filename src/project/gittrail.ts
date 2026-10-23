import { spawnRunner } from "../herdr/bridge.ts";

export interface GitTrail {
  commits: string[];
  diffStat: string;
  untracked: number;
}

const TIMEOUT_MS = 2000;

function git(cwd: string, args: string[]): string | undefined {
  try {
    const r = spawnRunner("git", ["--no-optional-locks", "-C", cwd, ...args], process.env as Record<string, string>, TIMEOUT_MS);
    return r.exitCode === 0 && !r.timedOut ? r.stdout : undefined;
  } catch {
    return undefined;
  }
}

/** `mainHead` lets a caller compute the main repo's HEAD once for many threads; it is only used as a fallback. */
export function gitTrail(o: {
  root: string;
  worktree: string;
  branch: string;
  base?: string;
  mainHead?: () => string | undefined;
}): GitTrail | undefined {
  let base = o.base;
  if (!base) {
    // The commit the thread branch was created at: stays right after the branch is merged or main moves.
    const reflog = git(o.worktree, ["reflog", "show", "--format=%H", o.branch])?.split("\n").filter(Boolean);
    base = reflog?.[reflog.length - 1]?.trim();
  }
  if (!base) {
    const mainHead = o.mainHead ? o.mainHead() : git(o.root, ["rev-parse", "HEAD"])?.trim();
    if (!mainHead) return undefined;
    base = git(o.worktree, ["merge-base", "HEAD", mainHead])?.trim();
    if (!base) return undefined;
  }
  const log = git(o.worktree, ["log", "--oneline", "-n", "20", `${base}..HEAD`]);
  if (log === undefined) return undefined;
  const stat = git(o.worktree, ["diff", "--stat", "HEAD"]);
  const status = git(o.worktree, ["status", "--porcelain"]);
  if (stat === undefined || status === undefined) return undefined;
  const lines = stat.split("\n").filter((l) => l.trim());
  return {
    commits: log.split("\n").filter(Boolean).slice(0, 20),
    diffStat: (lines[lines.length - 1] ?? "").trim(),
    untracked: status.split("\n").filter((l) => l.startsWith("??")).length,
  };
}

/** Caches each thread's trail for `ttlMs` so frequent re-renders do not spawn git every time. */
export function memoizedTrail(
  root: string,
  ttlMs: number,
  now: () => number = Date.now,
): (t: { id: string; status: string; worktree: string; branch: string }) => GitTrail | undefined {
  const cache = new Map<string, { at: number; value: GitTrail | undefined }>();
  return (t) => {
    if (t.status === "done") return undefined;
    const hit = cache.get(t.id);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = gitTrail({ root, worktree: t.worktree, branch: t.branch });
    cache.set(t.id, { at: now(), value });
    return value;
  };
}
