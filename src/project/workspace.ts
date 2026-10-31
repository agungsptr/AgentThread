import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "../config/config.ts";

export type RepoEntry = { path: string; source_branch?: string };

/** The git top level of `dir`, or null when `dir` is not inside a work tree. Sync: CLI paths only. */
function topLevel(dir: string): string | null {
  const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) return null;
  const out = r.stdout.toString().trim();
  try {
    return realpathSync(out);
  } catch {
    return out;
  }
}

function isTopLevel(dir: string): boolean {
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    return false;
  }
  return topLevel(dir) === real;
}

/** True when root is not itself a git top level (a folder of repos). */
export function isWorkspaceProject(root: string): boolean {
  return !isTopLevel(root);
}

/** The repos of a root: itself when it is a git top level, else its direct (non-hidden) child folders that are git top levels. */
export function discoverRepos(root: string): Record<string, { path: string }> {
  if (isTopLevel(root)) return { [basename(root)]: { path: "." } };
  const repos: Record<string, { path: string }> = {};
  if (!existsSync(root)) return repos;
  const names = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort();
  for (const name of names) if (isTopLevel(join(root, name))) repos[name] = { path: name };
  return repos;
}

export function workspaceRepos(root: string, config: Config): Record<string, RepoEntry> {
  return config.workspace.repos ?? discoverRepos(root);
}
