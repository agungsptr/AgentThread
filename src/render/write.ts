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
  trail?: (t: Thread) => GitTrail | undefined,
): void {
  let head: string | undefined;
  let headDone = false;
  const mainHead = () => {
    if (!headDone) {
      headDone = true;
      head = Bun.spawnSync(["git", "--no-optional-locks", "-C", root, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim() || undefined;
    }
    return head;
  };
  const trailOf =
    trail ?? ((t: Thread) => (t.status === "done" ? undefined : gitTrail({ root, worktree: t.worktree, branch: t.branch, mainHead })));
  const p = paths(root);
  mkdirSync(p.threadsDir, { recursive: true });
  writeAtomic(p.mainThread, renderMain(state, config));
  for (const t of state.threads.values()) {
    const dir = p.threadDir(t);
    mkdirSync(dir, { recursive: true });
    writeAtomic(join(dir, "sub.thread.md"), renderSub(t, [...state.sessions.values()].filter((s) => s.thread === t.id)));
    writeAtomic(join(dir, "brief.md"), renderBrief({ thread: t, trail: trailOf(t) }));
    writeAtomic(join(dir, "board.md"), renderBoard(t));
    writeAtomic(join(dir, "log.md"), renderLog(t));
  }
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}
