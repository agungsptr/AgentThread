import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { writeAll } from "../render/write.ts";
import { project } from "../state/projection.ts";
import { EventStore } from "../store/event-store.ts";
import { isGitRepo } from "./git.ts";
import { paths } from "./paths.ts";

const IGNORE_LINES = [".worktrees/", ".agentthread/*", "!.agentthread/config.yaml"];

export function initProject(root: string, name: string = basename(root)): void {
  const p = paths(root);
  if (!isGitRepo(root)) throw new Error(`${root} is not a git repository`);
  if (existsSync(p.db)) throw new Error(`already initialized at ${p.dir}`);
  mkdirSync(p.threadsDir, { recursive: true });
  ensureGitignore(root);
  const store = new EventStore(p.db);
  try {
    const events = store.append([{ type: "project.initialized", payload: { name } }], { role: "user" });
    writeAll(root, project(events));
  } finally {
    store.close();
  }
}

function ensureGitignore(root: string): void {
  const file = join(root, ".gitignore");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const present = new Set(current.split(/\r?\n/));
  const missing = IGNORE_LINES.filter((line) => !present.has(line));
  if (!missing.length) return;
  const sep = current && !current.endsWith("\n") ? "\n" : "";
  writeFileSync(file, `${current}${sep}# AgentThread\n${missing.join("\n")}\n`);
}
