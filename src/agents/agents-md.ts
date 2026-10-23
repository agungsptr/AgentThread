import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const r = spawnRunner("git", ["--no-optional-locks", "-C", cwd, ...args], process.env as Record<string, string>, GIT_TIMEOUT_MS);
  if (r.timedOut) throw new Error(`git ${args.join(" ")} timed out in ${cwd}`);
  return { ok: r.exitCode === 0, stdout: r.stdout };
}

function mustGit(cwd: string, args: string[]): string {
  const r = spawnRunner("git", ["-C", cwd, ...args], process.env as Record<string, string>, GIT_TIMEOUT_MS);
  if (r.exitCode !== 0 || r.timedOut) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.timedOut ? "timed out" : r.stderr.trim()}`);
  return r.stdout;
}

const isTracked = (wt: string, file: string) => git(wt, ["ls-files", "--error-unmatch", "--", file]).ok;

/** The file's content at the worktree's HEAD, if it is tracked there as a regular file (not a symlink). */
function trackedContent(wt: string, file: string): string {
  const entry = git(wt, ["ls-tree", "HEAD", "--", file]);
  if (!entry.ok || !/^100(644|755) blob /.test(entry.stdout)) return "";
  const show = git(wt, ["show", `HEAD:${file}`]);
  return show.ok ? show.stdout : "";
}

function ensureExcluded(wt: string, line: string): void {
  const common = resolve(wt, mustGit(wt, ["rev-parse", "--git-common-dir"]).trim());
  const file = join(common, "info", "exclude");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.split("\n").includes(line)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
}

/**
 * Writes `<worktree>/AGENTS.md` (the project's own instructions, then `content`) and makes `CLAUDE.md` a symlink to
 * it. Neither ever shows up in `git status` or a commit: tracked paths get skip-worktree, the others are excluded.
 */
export function writeAgentsFiles(o: { root: string; worktree: string; content: string }): void {
  const wt = o.worktree;
  const project = trackedContent(wt, "AGENTS.md") || trackedContent(wt, "CLAUDE.md");
  writeFileSync(join(wt, "AGENTS.md"), `${project}${project ? "\n\n" : ""}${o.content}`);
  const claude = join(wt, "CLAUDE.md");
  let exists = false;
  try {
    lstatSync(claude);
    exists = true;
  } catch {}
  if (exists) rmSync(claude, { force: true, recursive: true });
  symlinkSync("AGENTS.md", claude);
  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    if (isTracked(wt, file)) mustGit(wt, ["update-index", "--skip-worktree", "--", file]);
    else ensureExcluded(wt, `/${file}`);
  }
}
