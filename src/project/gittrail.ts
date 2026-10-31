import { type AsyncRunner, type RunResult, type Runner, spawnAsync, spawnRunner } from "../herdr/bridge.ts";

export interface GitTrail {
  commits: string[];
  diffStat: string;
  untracked: number;
}

const TIMEOUT_MS = 2000;

/** The git calls a trail needs; a driver runs each one (synchronously or not) and sends back its result. */
type Steps<T> = Generator<{ args: string[] }, T, RunResult>;

function* git(cwd: string, args: string[]): Steps<string | undefined> {
  const r = yield { args: ["--no-optional-locks", "-C", cwd, ...args] };
  return r.exitCode === 0 && !r.timedOut ? r.stdout : undefined;
}

type TrailOpts = { root: string; worktree: string; branch: string; base?: string; source?: string };

function* trailSteps(o: TrailOpts): Steps<GitTrail | undefined> {
  let base = o.base;
  // A task worktree trails from where it left its source branch.
  if (!base && o.source) base = (yield* git(o.worktree, ["merge-base", "HEAD", o.source]))?.trim() || undefined;
  if (!base) {
    // The commit the thread branch was created at: stays right after the branch is merged or main moves.
    const reflog = (yield* git(o.worktree, ["reflog", "show", "--format=%H", o.branch]))?.split("\n").filter(Boolean);
    base = reflog?.[reflog.length - 1]?.trim();
  }
  if (!base) {
    const mainHead = (yield* git(o.root, ["rev-parse", "HEAD"]))?.trim();
    if (!mainHead) return undefined;
    base = (yield* git(o.worktree, ["merge-base", "HEAD", mainHead]))?.trim();
    if (!base) return undefined;
  }
  const log = yield* git(o.worktree, ["log", "--oneline", "-n", "20", `${base}..HEAD`]);
  if (log === undefined) return undefined;
  const stat = yield* git(o.worktree, ["diff", "--stat", "HEAD"]);
  const status = yield* git(o.worktree, ["status", "--porcelain"]);
  if (stat === undefined || status === undefined) return undefined;
  const lines = stat.split("\n").filter((l) => l.trim());
  return {
    commits: log.split("\n").filter(Boolean).slice(0, 20),
    diffStat: (lines[lines.length - 1] ?? "").trim(),
    untracked: status.split("\n").filter((l) => l.startsWith("??")).length,
  };
}

const failed = (e: unknown): RunResult => ({ exitCode: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) });

export function gitTrail(o: TrailOpts, runner: Runner = spawnRunner): GitTrail | undefined {
  const steps = trailSteps(o);
  let next = steps.next();
  while (!next.done) {
    let r: RunResult;
    try {
      r = runner("git", next.value.args, process.env, TIMEOUT_MS);
    } catch (e) {
      r = failed(e);
    }
    next = steps.next(r);
  }
  return next.value;
}

/** gitTrail without blocking the event loop (the daemon renders briefs with it). */
export async function gitTrailAsync(o: TrailOpts, runner: AsyncRunner = spawnAsync): Promise<GitTrail | undefined> {
  const steps = trailSteps(o);
  let next = steps.next();
  while (!next.done) {
    let r: RunResult;
    try {
      r = await runner("git", next.value.args, process.env, TIMEOUT_MS);
    } catch (e) {
      r = failed(e);
    }
    next = steps.next(r);
  }
  return next.value;
}

/** A legacy thread has one worktree and branch to trail; a thread directory has one trail per repo worktree. */
type TrailThread = {
  id: string;
  status: string;
  worktree?: string;
  branch?: string;
  worktrees?: Record<string, { path: string; branch: string; source: string }>;
};

const keyOf = (thread: string, repo?: string) => (repo === undefined ? thread : `${thread}\0${repo}`);

/**
 * Each thread's (and each repo worktree's) trail, cached for `ttlMs` so frequent re-renders do not run git every time.
 * `refresh` recomputes the expired (or invalidated) ones without blocking; `get`/`getRepo` read the cache synchronously.
 */
export function trailCache(
  root: string,
  ttlMs: number,
  now: () => number = Date.now,
  compute: (t: TrailThread, repo?: string) => Promise<GitTrail | undefined> = (t, repo) => {
    if (repo !== undefined) {
      const w = t.worktrees?.[repo];
      return w ? gitTrailAsync({ root, worktree: w.path, branch: w.branch, source: w.source }) : Promise.resolve(undefined);
    }
    return t.worktree !== undefined && t.branch !== undefined ? gitTrailAsync({ root, worktree: t.worktree, branch: t.branch }) : Promise.resolve(undefined);
  },
): {
  get(t: TrailThread): GitTrail | undefined;
  getRepo(t: TrailThread, repo: string): GitTrail | undefined;
  refresh(threads: Iterable<TrailThread>): Promise<void>;
  invalidate(thread: string): void;
} {
  const cache = new Map<string, { at: number; value: GitTrail | undefined }>();
  return {
    get: (t) => (t.status === "done" ? undefined : cache.get(keyOf(t.id))?.value),
    getRepo: (t, repo) => (t.status === "done" ? undefined : cache.get(keyOf(t.id, repo))?.value),
    async refresh(threads) {
      const jobs: { t: TrailThread; repo?: string }[] = [];
      for (const t of threads) {
        if (t.status === "done") continue;
        jobs.push({ t });
        for (const repo of Object.keys(t.worktrees ?? {})) jobs.push({ t, repo });
      }
      const stale = jobs.filter(({ t, repo }) => {
        const hit = cache.get(keyOf(t.id, repo));
        return !(hit && now() - hit.at < ttlMs);
      });
      await Promise.all(stale.map(async ({ t, repo }) => cache.set(keyOf(t.id, repo), { at: now(), value: await compute(t, repo) })));
    },
    invalidate: (thread) => {
      for (const k of [...cache.keys()]) if (k === thread || k.startsWith(`${thread}\0`)) cache.delete(k);
    },
  };
}
