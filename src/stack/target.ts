import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config, ServiceConfig } from "../config/config.ts";
import { workspaceRepos } from "../project/workspace.ts";

export const MAIN = "main";

export const runDir = (root: string): string => join(root, ".local-run");

export type ResolvedService = {
  name: string;
  service: ServiceConfig;
  /** The repo checkout the service runs in (install, stamp and branch use it). */
  repoDir: string;
  /** Where `start` runs: the repo checkout plus the service dir. */
  cwd: string;
  /** "worktree" when .worktrees/<slug>/<repo> was used, else the main checkout. */
  from: "worktree" | "main";
};

export type Target = { target: string; services: ResolvedService[] };

const TASK_NAME = /^[A-Za-z0-9._-]+$/;

/** A task slug is one safe path segment: letters, digits, dot, underscore, dash; never "." or "..". */
export function validTaskName(t: string): boolean {
  return TASK_NAME.test(t) && t !== "." && t !== "..";
}

/** The target recorded in .local-run/task ("main" when absent or empty). */
export function readTask(root: string): string {
  try {
    return readFileSync(join(runDir(root), "task"), "utf8").trim() || MAIN;
  } catch {
    return MAIN;
  }
}

export function writeTask(root: string, target: string): void {
  mkdirSync(runDir(root), { recursive: true });
  writeFileSync(join(runDir(root), "task"), `${target}\n`);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where each service runs. `--main` uses the main checkouts; `--task <slug>` uses .worktrees/<slug>/<repo> when it
 * exists (else the main checkout); with neither the recorded target applies. Does not write the target.
 */
export function resolveTarget(root: string, config: Config, opts: { task?: string | undefined; main?: boolean | undefined } = {}): Target {
  if (opts.task !== undefined && opts.main) throw new Error("--task and --main exclude each other");
  const target = opts.main ? MAIN : (opts.task ?? readTask(root));
  if (!validTaskName(target)) throw new Error(`invalid task "${target}": use letters, digits, ".", "_" and "-" (not "." or "..")`);
  const repos = workspaceRepos(root, config);
  const services: ResolvedService[] = [];
  for (const [name, service] of Object.entries(config.workspace.services ?? {})) {
    const repo = repos[service.repo];
    if (!repo) throw new Error(`service ${name}: unknown repo "${service.repo}"`);
    const wt = target === MAIN ? undefined : join(root, ".worktrees", target, service.repo);
    const worktree = wt !== undefined && isDir(wt);
    const repoDir = worktree ? wt! : resolve(root, repo.path);
    services.push({ name, service, repoDir, cwd: resolve(repoDir, service.dir), from: worktree ? "worktree" : "main" });
  }
  return { target, services };
}

/** The services in start order: `after` first, then by name. Only `only` (when given) are kept. */
export function startOrder(services: ResolvedService[], only?: string[]): ResolvedService[] {
  const by = new Map(services.map((s) => [s.name, s]));
  const done = new Set<string>();
  const out: ResolvedService[] = [];
  const visit = (name: string) => {
    if (done.has(name)) return;
    done.add(name);
    const s = by.get(name);
    if (!s) return;
    for (const a of [...(s.service.after ?? [])].sort()) visit(a);
    out.push(s);
  };
  for (const name of [...by.keys()].sort()) visit(name);
  return only ? out.filter((s) => only.includes(s.name)) : out;
}

export function checkOnly(config: Config, only: string[] | undefined): void {
  const known = config.workspace.services ?? {};
  for (const n of only ?? []) if (!(n in known)) throw new Error(`unknown service "${n}" (configured: ${Object.keys(known).join(", ") || "none"})`);
}

export const hasServices = (config: Config): boolean => Object.keys(config.workspace.services ?? {}).length > 0;
