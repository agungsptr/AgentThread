import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Runner, spawnRunner } from "../herdr/bridge.ts";
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
interface Ctx {
  env: Env;
  run: Runner;
}

function git(c: Ctx, cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const r = c.run("git", ["--no-optional-locks", "-C", cwd, ...args], c.env, GIT_TIMEOUT_MS);
  if (r.timedOut) throw new Error(`git ${args.join(" ")} timed out in ${cwd}`);
  return { ok: r.exitCode === 0, stdout: r.stdout };
}

function mustGit(c: Ctx, cwd: string, args: string[]): string {
  const r = c.run("git", ["-C", cwd, ...args], c.env, GIT_TIMEOUT_MS);
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
function headEntry(c: Ctx, wt: string, file: string): { mode: string; content: string } | undefined {
  const entry = git(c, wt, ["ls-tree", "HEAD", "--", file]);
  const mode = entry.ok ? /^(\d+) blob /.exec(entry.stdout)?.[1] : undefined;
  if (!mode) return undefined;
  const show = git(c, wt, ["show", `HEAD:${file}`]);
  return show.ok ? { mode, content: show.stdout } : undefined;
}

/**
 * The project's own instructions in `file` at HEAD. A tracked symlink counts when its target is a regular file inside
 * the worktree that is tracked at HEAD (read from HEAD, so a rewritten worktree file never feeds back in).
 */
function projectContent(c: Ctx, wt: string, file: string): string {
  const e = headEntry(c, wt, file);
  if (!e) return "";
  if (e.mode === "100644" || e.mode === "100755") return e.content;
  if (e.mode !== "120000") return "";
  const target = resolve(wt, e.content.trim());
  if (!isInside(wt, target)) return "";
  const t = headEntry(c, wt, relative(wt, target).split(sep).join("/"));
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

/**
 * The excludes the main checkout uses (global, included, system or repo-local core.excludesFile, else git's XDG
 * default). A per-worktree core.excludesFile replaces it, so its patterns are copied in. Read from the main checkout,
 * never from a thread worktree, so our own per-worktree value is never read back.
 */
function effectiveExcludes(c: Ctx, root: string, ours: string): string {
  const configured = git(c, root, ["config", "--path", "--get", "core.excludesFile"]);
  let file = configured.ok ? configured.stdout.trim() : "";
  if (file) file = resolve(root, file);
  if (file === ours) file = "";
  if (!file) {
    const home = c.env.HOME ?? "";
    file = c.env.XDG_CONFIG_HOME ? join(c.env.XDG_CONFIG_HOME, "git", "ignore") : join(home, ".config", "git", "ignore");
  }
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function commonInfoExclude(c: Ctx, wt: string): string {
  return join(resolve(wt, mustGit(c, wt, ["rev-parse", "--git-common-dir"]).trim()), "info", "exclude");
}

/** Old git without per-worktree config: the shared info/exclude, which also hides the main checkout's files. */
function excludeInCommon(c: Ctx, wt: string): void {
  const info = commonInfoExclude(c, wt);
  let current = existsSync(info) ? readFileSync(info, "utf8") : "";
  const have = lines(current);
  for (const line of EXCLUDE_LINES) {
    if (have.includes(line)) continue;
    current = `${current}${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  mkdirSync(dirname(info), { recursive: true });
  writeFileSync(info, current);
}

/**
 * Hides untracked AGENTS.md/CLAUDE.md in thread worktrees only: a per-worktree core.excludesFile, so the main
 * checkout can still add its own. Also removes the lines that earlier versions put in the shared info/exclude.
 */
function excludeInWorktree(c: Ctx, root: string, wt: string, log: (m: string) => void): void {
  const file = join(root, ".agentthread", "worktree-excludes");
  const kept = lines(effectiveExcludes(c, root, file)).filter((l) => !EXCLUDE_LINES.includes(l));
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  const text = [...kept, ...EXCLUDE_LINES].join("\n") + "\n";
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);

  const wasEnabled = git(c, root, ["config", "--get", "extensions.worktreeConfig"]).stdout.trim() === "true";
  try {
    if (!wasEnabled) mustGit(c, root, ["config", "extensions.worktreeConfig", "true"]);
    if (git(c, wt, ["config", "--worktree", "--get", "core.excludesFile"]).stdout.trim() !== file) {
      mustGit(c, wt, ["config", "--worktree", "core.excludesFile", file]);
    }
  } catch (e) {
    if (!wasEnabled) git(c, root, ["config", "--unset", "extensions.worktreeConfig"]);
    log(`per-worktree excludes unavailable, using the shared info/exclude: ${e instanceof Error ? e.message : String(e)}`);
    excludeInCommon(c, wt);
    return;
  }

  const info = commonInfoExclude(c, wt);
  if (!existsSync(info)) return;
  const current = readFileSync(info, "utf8");
  const filtered = current.split("\n").filter((l) => !EXCLUDE_LINES.includes(l.replace(/\r$/, "")));
  if (filtered.length !== current.split("\n").length) writeFileSync(info, filtered.join("\n"));
}

/**
 * Writes `<worktree>/AGENTS.md` (the project's own instructions, then `content`) and makes `CLAUDE.md` a symlink to
 * it. Neither ever shows up in `git status` or a commit: tracked paths get skip-worktree, the others are excluded
 * through a per-worktree excludes file (set up first, so the files are never visible). Never writes through a symlink.
 */
export function writeAgentsFiles(o: {
  root: string;
  worktree: string;
  content: string;
  env?: Env;
  runner?: Runner;
  log?: (message: string) => void;
}): void {
  const wt = o.worktree;
  const c: Ctx = { env: o.env ?? (process.env as Env), run: o.runner ?? spawnRunner };
  excludeInWorktree(c, o.root, wt, o.log ?? ((m) => console.error(m)));
  const project = projectContent(c, wt, "AGENTS.md") || projectContent(c, wt, "CLAUDE.md");
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
    if (git(c, wt, ["ls-files", "--error-unmatch", "--", file]).ok) mustGit(c, wt, ["update-index", "--skip-worktree", "--", file]);
  }
}
