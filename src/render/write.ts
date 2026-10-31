import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../config/config.ts";
import { gitTrail, type GitTrail } from "../project/gittrail.ts";
import { paths } from "../project/paths.ts";
import type { State, Thread } from "../state/projection.ts";
import { renderBrief } from "./brief.ts";
import { renderBoard, renderLog, renderMain, renderSub } from "./markdown.ts";

export function writeAll(
  root: string,
  state: State,
  config: Config = DEFAULT_CONFIG,
  trail?: (t: Thread, repo?: string) => GitTrail | undefined,
): void {
  const trailOf =
    trail ??
    ((t: Thread, repo?: string) => {
      if (t.status === "done") return undefined;
      if (repo !== undefined) {
        const w = t.worktrees[repo];
        return w ? gitTrail({ root, worktree: w.path, branch: w.branch, source: w.source }) : undefined;
      }
      return t.worktree === undefined || t.branch === undefined ? undefined : gitTrail({ root, worktree: t.worktree, branch: t.branch });
    });
  const p = paths(root);
  mkdirSync(p.threadsDir, { recursive: true });
  writeAtomic(p.mainThread, renderMain(state, config));
  for (const t of state.threads.values()) {
    const dir = p.threadDir(t);
    mkdirSync(dir, { recursive: true });
    const sessions = [...state.sessions.values()].filter((s) => s.thread === t.id);
    writeAtomic(join(dir, "sub.thread.md"), renderSub(t, sessions, config));
    writeAtomic(join(dir, "brief.md"), renderBrief({ thread: t, sessions, trail: t.legacy ? trailOf(t) : undefined, trails: t.legacy ? undefined : Object.fromEntries(Object.keys(t.worktrees).map((r) => [r, trailOf(t, r)])), config }));
    writeAtomic(join(dir, "board.md"), renderBoard(t));
    writeAtomic(join(dir, "log.md"), renderLog(t));
  }
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}
