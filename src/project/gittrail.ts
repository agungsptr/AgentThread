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

function* trailSteps(o: { root: string; worktree: string; branch: string; base?: string }): Steps<GitTrail | undefined> {
  let base = o.base;
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

export function gitTrail(o: { root: string; worktree: string; branch: string; base?: string }, runner: Runner = spawnRunner): GitTrail | undefined {
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
export async function gitTrailAsync(o: { root: string; worktree: string; branch: string; base?: string }, runner: AsyncRunner = spawnAsync): Promise<GitTrail | undefined> {
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

type TrailThread = { id: string; status: string; worktree: string; branch: string };

/**
 * Each thread's trail, cached for `ttlMs` so frequent re-renders do not run git every time. `refresh` recomputes the
 * expired (or invalidated) ones without blocking; `get` reads the cache synchronously for rendering.
 */
export function trailCache(
  root: string,
  ttlMs: number,
  now: () => number = Date.now,
  compute: (t: TrailThread) => Promise<GitTrail | undefined> = (t) => gitTrailAsync({ root, worktree: t.worktree, branch: t.branch }),
): { get(t: TrailThread): GitTrail | undefined; refresh(threads: Iterable<TrailThread>): Promise<void>; invalidate(thread: string): void } {
  const cache = new Map<string, { at: number; value: GitTrail | undefined }>();
  return {
    get: (t) => (t.status === "done" ? undefined : cache.get(t.id)?.value),
    async refresh(threads) {
      const stale = [...threads].filter((t) => {
        const hit = cache.get(t.id);
        return t.status !== "done" && !(hit && now() - hit.at < ttlMs);
      });
      await Promise.all(stale.map(async (t) => cache.set(t.id, { at: now(), value: await compute(t) })));
    },
    invalidate: (thread) => void cache.delete(thread),
  };
}
