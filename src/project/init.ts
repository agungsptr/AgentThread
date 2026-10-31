import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { writeAll } from "../render/write.ts";
import { project } from "../state/projection.ts";
import { EventStore } from "../store/event-store.ts";
import { isGitRepo } from "./git.ts";
import { discoverRepos, isWorkspaceProject } from "./workspace.ts";
import { paths } from "./paths.ts";

const IGNORE_LINES = [".worktrees/", ".agentthread/*", "!.agentthread/config.yaml"];

export function initProject(root: string, name: string = basename(root)): void {
  const p = paths(root);
  if (existsSync(p.db)) throw new Error(`already initialized at ${p.dir}`);
  const repos = discoverRepos(root);
  const names = Object.keys(repos);
  if (names.length === 0) throw new Error(`no git repositories found in ${root}`);
  mkdirSync(p.threadsDir, { recursive: true });
  if (isGitRepo(root)) ensureGitignore(root);
  if (isWorkspaceProject(root)) ensureDocs(root, names);
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

const DOC_KINDS = ["issues", "specs", "plans", "adr", "notes", "agents"];

/** Creates the workspace's private `.docs/` git repo when it is missing. */
function ensureDocs(root: string, repos: string[]): void {
  const dir = join(root, ".docs");
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
  for (const scope of ["shared", ...repos]) {
    for (const kind of DOC_KINDS) {
      mkdirSync(join(dir, scope, kind), { recursive: true });
      writeFileSync(join(dir, scope, kind, ".gitkeep"), "");
    }
  }
  writeFileSync(join(dir, "README.md"), `# ${basename(root)} docs\n\nPrivate, locally versioned specs, issues and plans for this workspace.\n`);
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed in ${dir}: ${r.stderr.toString().trim()}`);
    return r.stdout.toString().trim();
  };
  git("init", "-q");
  // A commit needs an identity; fall back only when the user has none configured.
  const has = (k: string) => Bun.spawnSync(["git", "-C", dir, "config", k], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  const id = [...(has("user.name") ? [] : ["-c", "user.name=AgentThread"]), ...(has("user.email") ? [] : ["-c", "user.email=agentthread@localhost"])];
  git("add", "-A");
  git(...id, "commit", "-q", "-m", "docs: initial structure");
}
