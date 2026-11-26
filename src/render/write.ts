import { asCodeType, squashBranch } from "../domain/branches.ts";
import { isDocType } from "../domain/types.ts";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  writeBannedWords(root, config);
  for (const t of state.threads.values()) {
    const dir = p.threadDir(t);
    mkdirSync(dir, { recursive: true });
    const sessions = [...state.sessions.values()].filter((s) => s.thread === t.id);
    writeAtomic(join(dir, "sub.thread.md"), renderSub(t, sessions, config));
    writeAtomic(join(dir, "brief.md"), renderBrief({ thread: t, sessions, trail: t.legacy ? trailOf(t) : undefined, trails: t.legacy ? undefined : Object.fromEntries(Object.keys(t.worktrees).map((r) => [r, trailOf(t, r)])), config }));
    writeAtomic(join(dir, "board.md"), renderBoard(t));
    // The files each task-thread ticket may change, one repo-relative path per line (the worker's commit hook reads them).
    if (!t.legacy) {
      mkdirSync(join(dir, "tickets"), { recursive: true });
      for (const k of t.tickets) if (k.files) writeAtomic(join(dir, "tickets", `${k.id}.files`), k.files.map((f) => `${f}\n`).join(""));
      // The coordinator's commit hook reads the squash branch from this file without the daemon (so it survives a restart).
      // Written once, never overwritten: an older thread keeps the branch its coordinator already made.
      const codeType = asCodeType(t.type);
      if (isDocType(t.type)) {
        // A doc (review, report) thread: the commit hook refuses every agent commit in its worktrees; no squash, no gate.
        writeAtomic(join(dir, "doc-thread"), `${t.type}\n`);
      } else {
        if (t.task !== undefined && !existsSync(join(dir, "squash-branch"))) writeAtomic(join(dir, "squash-branch"), `${squashBranch(codeType, t.task, config.workflow.branch_prefix)}\n`);
        // The squash gate: the coordinator's commit hook on the squash branch reads this file without the daemon.
        const s8 = t.stages[8]?.state;
        if (s8 === "done" || s8 === "na" || s8 === "skipped") writeAtomic(join(dir, "stage8"), `${s8}\n`);
        else rmSync(join(dir, "stage8"), { force: true });
      }
    }
    writeAtomic(join(dir, "log.md"), renderLog(t));
  }
}

/** The commit-msg hook refuses an agent's message with one of these: one word per line, no file when there are none. */
export function writeBannedWords(root: string, config: Config): void {
  const banned = (config.workflow.banned_words ?? []).map((w) => w.replace(/[\r\n]+/g, " ").trim()).filter((w) => w !== "");
  const file = join(root, ".agentthread", "banned-words");
  mkdirSync(join(root, ".agentthread"), { recursive: true });
  if (banned.length) writeAtomic(file, banned.map((w) => `${w}\n`).join(""));
  else rmSync(file, { force: true });
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}
