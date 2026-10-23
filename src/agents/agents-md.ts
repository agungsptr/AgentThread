import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnRunner } from "../herdr/bridge.ts";
import { paths } from "../project/paths.ts";
import { systemPrompt } from "./prompts.ts";

type ThreadRef = { id: string; title: string; slug: string; worktree: string };

/** The role prompts without their first (identity) line: the role is stated by the bootstrap prompt instead. */
const rulesOf = (prompt: string) => prompt.split("\n").slice(1);

/** The AgentThread section of a worktree's AGENTS.md. One file serves the coordinator and the workers. */
export function agentsMd(o: { root: string; thread: ThreadRef }): string {
  const t = o.thread;
  const dir = paths(o.root).threadDir(t);
  const coordinator = rulesOf(systemPrompt({ root: o.root, role: "coordinator", thread: t }));
  const worker = rulesOf(systemPrompt({ root: o.root, role: "worker", thread: t, ticket: "<T>" }));
  return [
    "# AgentThread",
    "",
    `This worktree belongs to AgentThread thread ${t.id} ("${t.title}") of the project at ${o.root}. The worktree is ${t.worktree}.`,
    `Thread state lives in ${dir}/brief.md (the context pack: read it first), ${dir}/sub.thread.md and ${dir}/board.md.`,
    "You are either the thread's coordinator or one of its workers: your role is in your first prompt and in $AGT_ROLE. Follow the section for your role below.",
    "",
    "## Working memory (required)",
    "",
    "Sessions are disposable: whoever continues after you only knows what you recorded. Record it as you go:",
    `- agt note ${t.id} "<finding>" — something you learned that others need (a cause, a constraint, a gotcha).`,
    `- agt progress ${t.id} "<where I am>" — your current position and next step. Latest wins.`,
    `- agt question ${t.id} "<open question>" — a doubt or decision you could not settle.`,
    `Before ending a turn with meaningful progress, run agt progress ${t.id} "<where I am>".`,
    `agt ticket done always needs --summary: agt ticket done ${t.id}/<T> --summary "<one line>".`,
    "",
    "## Coordinator",
    "",
    ...coordinator,
    "- Never run git update-index --no-skip-worktree and never commit AGENTS.md or CLAUDE.md. If merging or rebasing main is blocked by them, ask with agt question.",
    `- The handoff request names the exact command (agt handoff ${t.id} --stdin) and the sections to fill. Read ${dir}/brief.md for the latest handoff when you take over.`,
    "",
    "## Worker",
    "",
    "Your ticket id (<T> below) is in your first prompt and in $AGT_TICKET.",
    ...worker,
    "",
  ].join("\n");
}

const GIT_TIMEOUT_MS = 5000;

type Env = Record<string, string | undefined>;

function git(cwd: string, args: string[], env: Env): { ok: boolean; stdout: string } {
  const r = spawnRunner("git", ["--no-optional-locks", "-C", cwd, ...args], env, GIT_TIMEOUT_MS);
  if (r.timedOut) throw new Error(`git ${args.join(" ")} timed out in ${cwd}`);
  return { ok: r.exitCode === 0, stdout: r.stdout };
}

function mustGit(cwd: string, args: string[], env: Env): string {
  const r = spawnRunner("git", ["-C", cwd, ...args], env, GIT_TIMEOUT_MS);
  if (r.exitCode !== 0 || r.timedOut) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.timedOut ? "timed out" : r.stderr.trim()}`);
  return r.stdout;
}

const FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const EXCLUDE_LINES = FILES.map((f) => `/${f}`);
const lines = (text: string) => text.split("\n").map((l) => l.replace(/\r$/, ""));

const isInside = (wt: string, p: string) => {
  const rel = relative(wt, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** A HEAD tree entry: mode and blob content, or undefined if `file` is not in HEAD. */
function headEntry(wt: string, file: string, env: Env): { mode: string; content: string } | undefined {
  const entry = git(wt, ["ls-tree", "HEAD", "--", file], env);
  const mode = entry.ok ? /^(\d+) blob /.exec(entry.stdout)?.[1] : undefined;
  if (!mode) return undefined;
  const show = git(wt, ["show", `HEAD:${file}`], env);
  return show.ok ? { mode, content: show.stdout } : undefined;
}

/**
 * The project's own instructions in `file` at HEAD. A tracked symlink counts when its target is a regular file inside
 * the worktree that is tracked at HEAD (read from HEAD, so a rewritten worktree file never feeds back in).
 */
function projectContent(wt: string, file: string, env: Env): string {
  const e = headEntry(wt, file, env);
  if (!e) return "";
  if (e.mode === "100644" || e.mode === "100755") return e.content;
  if (e.mode !== "120000") return "";
  const target = resolve(wt, e.content.trim());
  if (!isInside(wt, target)) return "";
  const t = headEntry(wt, relative(wt, target).split(sep).join("/"), env);
  return t && (t.mode === "100644" || t.mode === "100755") ? t.content : "";
}

function removeIfPresent(p: string): void {
  try {
    lstatSync(p);
  } catch {
    return;
  }
  rmSync(p, { force: true, recursive: true });
}

/** The user's global excludes file, which a per-worktree core.excludesFile would otherwise replace. */
function globalExcludes(env: Env): string {
  const home = env.HOME ?? "";
  const configured = spawnRunner("git", ["config", "--global", "--get", "core.excludesFile"], env, GIT_TIMEOUT_MS);
  let file = configured.exitCode === 0 && !configured.timedOut ? configured.stdout.trim() : "";
  if (file.startsWith("~/")) file = join(home, file.slice(2));
  if (!file) file = env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "git", "ignore") : join(home, ".config", "git", "ignore");
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * Hides untracked AGENTS.md/CLAUDE.md in thread worktrees only: a per-worktree core.excludesFile, so the main
 * checkout can still add its own. Also removes the lines that earlier versions put in the shared info/exclude.
 */
function excludeInWorktree(root: string, wt: string, env: Env): void {
  const file = join(root, ".agentthread", "worktree-excludes");
  const kept = lines(globalExcludes(env)).filter((l) => !EXCLUDE_LINES.includes(l));
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  const text = [...kept, ...EXCLUDE_LINES].join("\n") + "\n";
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
  if (git(root, ["config", "--get", "extensions.worktreeConfig"], env).stdout.trim() !== "true") {
    mustGit(root, ["config", "extensions.worktreeConfig", "true"], env);
  }
  if (git(wt, ["config", "--worktree", "--get", "core.excludesFile"], env).stdout.trim() !== file) {
    mustGit(wt, ["config", "--worktree", "core.excludesFile", file], env);
  }
  const common = resolve(wt, mustGit(wt, ["rev-parse", "--git-common-dir"], env).trim());
  const info = join(common, "info", "exclude");
  if (!existsSync(info)) return;
  const current = readFileSync(info, "utf8");
  const filtered = current.split("\n").filter((l) => !EXCLUDE_LINES.includes(l.replace(/\r$/, "")));
  if (filtered.length !== current.split("\n").length) writeFileSync(info, filtered.join("\n"));
}

/**
 * Writes `<worktree>/AGENTS.md` (the project's own instructions, then `content`) and makes `CLAUDE.md` a symlink to
 * it. Neither ever shows up in `git status` or a commit: tracked paths get skip-worktree, the others are excluded
 * through a per-worktree excludes file. Never writes through a symlink.
 */
export function writeAgentsFiles(o: { root: string; worktree: string; content: string; env?: Env }): void {
  const wt = o.worktree;
  const env = o.env ?? (process.env as Env);
  const project = projectContent(wt, "AGENTS.md", env) || projectContent(wt, "CLAUDE.md", env);
  const agents = join(wt, "AGENTS.md");
  let regular = false;
  try {
    regular = lstatSync(agents).isFile();
  } catch {}
  if (!regular) removeIfPresent(agents);
  writeFileSync(agents, `${project}${project ? "\n\n" : ""}${o.content}`);
  removeIfPresent(join(wt, "CLAUDE.md"));
  symlinkSync("AGENTS.md", join(wt, "CLAUDE.md"));
  for (const file of FILES) {
    if (git(wt, ["ls-files", "--error-unmatch", "--", file], env).ok) mustGit(wt, ["update-index", "--skip-worktree", "--", file], env);
  }
  excludeInWorktree(o.root, wt, env);
}
