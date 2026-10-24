import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type AsyncRunner, type RunResult, type Runner, spawnAsync, spawnRunner } from "../herdr/bridge.ts";
import { paths } from "../project/paths.ts";
import { AGENT_KINDS } from "../domain/types.ts";
import { adapterFor } from "./adapters.ts";
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
}

/** One git invocation the steps below need; a driver runs it (synchronously or not) and sends back the result. */
type GitCall = { args: string[] };
type Steps<T> = Generator<GitCall, T, RunResult>;

function* run(cwd: string, args: string[], optionalLocks: boolean): Steps<RunResult> {
  return yield { args: [...(optionalLocks ? [] : ["--no-optional-locks"]), "-C", cwd, ...args] };
}

function* git(_c: Ctx, cwd: string, args: string[]): Steps<{ ok: boolean; stdout: string }> {
  const r = yield* run(cwd, args, false);
  if (r.timedOut) throw new Error(`git ${args.join(" ")} timed out in ${cwd}`);
  return { ok: r.exitCode === 0, stdout: r.stdout };
}

function* mustGit(_c: Ctx, cwd: string, args: string[]): Steps<string> {
  const r = yield* run(cwd, args, true);
  if (r.exitCode !== 0 || r.timedOut) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.timedOut ? "timed out" : r.stderr.trim()}`);
  return r.stdout;
}

function driveSync<T>(steps: Steps<T>, runner: Runner, env: Env): T {
  let next = steps.next();
  while (!next.done) next = steps.next(runner("git", next.value.args, env, GIT_TIMEOUT_MS));
  return next.value;
}

async function driveAsync<T>(steps: Steps<T>, runner: AsyncRunner, env: Env): Promise<T> {
  let next = steps.next();
  while (!next.done) next = steps.next(await runner("git", next.value.args, env, GIT_TIMEOUT_MS));
  return next.value;
}

/** AGENTS.md, then every instruction file any adapter reads (always CLAUDE.md), each a symlink to AGENTS.md. */
const LINKS = [...new Set(["CLAUDE.md", ...AGENT_KINDS.flatMap((k) => adapterFor(k).instructionFiles)])];
const FILES = ["AGENTS.md", ...LINKS];
const EXCLUDE_LINES = FILES.map((f) => `/${f}`);
const lines = (text: string) => text.split("\n").map((l) => l.replace(/\r$/, ""));

const isInside = (wt: string, p: string) => {
  const rel = relative(wt, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** A HEAD tree entry: mode and blob content, or undefined if `file` is not in HEAD. */
function* headEntry(c: Ctx, wt: string, file: string): Steps<{ mode: string; content: string } | undefined> {
  const entry = (yield* git(c, wt, ["ls-tree", "HEAD", "--", file]));
  const mode = entry.ok ? /^(\d+) blob /.exec(entry.stdout)?.[1] : undefined;
  if (!mode) return undefined;
  const show = (yield* git(c, wt, ["show", `HEAD:${file}`]));
  return show.ok ? { mode, content: show.stdout } : undefined;
}

/**
 * The project's own instructions in `file` at HEAD. A tracked symlink counts when its target is a regular file inside
 * the worktree that is tracked at HEAD (read from HEAD, so a rewritten worktree file never feeds back in).
 */
function* projectContent(c: Ctx, wt: string, file: string): Steps<string> {
  const e = (yield* headEntry(c, wt, file));
  if (!e) return "";
  if (e.mode === "100644" || e.mode === "100755") return e.content;
  if (e.mode !== "120000") return "";
  const target = resolve(wt, e.content.trim());
  if (!isInside(wt, target)) return "";
  const t = (yield* headEntry(c, wt, relative(wt, target).split(sep).join("/")));
  return t && (t.mode === "100644" || t.mode === "100755") ? t.content : "";
}

/**
 * What the project itself says, from HEAD: AGENTS.md, else CLAUDE.md. When both are tracked and CLAUDE.md is a regular
 * file with other content, the worktree's CLAUDE.md becomes our symlink, so its content is kept under a heading.
 */
function* projectInstructions(c: Ctx, wt: string): Steps<string> {
  const agents = (yield* projectContent(c, wt, "AGENTS.md"));
  const claude = (yield* projectContent(c, wt, "CLAUDE.md"));
  if (!agents) return claude;
  const claudeMode = (yield* headEntry(c, wt, "CLAUDE.md"))?.mode;
  const regular = claudeMode === "100644" || claudeMode === "100755";
  if (!claude || !regular || claude.trim() === agents.trim()) return agents;
  return `${agents}\n\n# From the project's CLAUDE.md\n\n${claude}`;
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
function* effectiveExcludes(c: Ctx, root: string, ours: string): Steps<string> {
  const configured = (yield* git(c, root, ["config", "--path", "--get", "core.excludesFile"]));
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

function* commonInfoExclude(c: Ctx, wt: string): Steps<string> {
  return join(resolve(wt, (yield* mustGit(c, wt, ["rev-parse", "--git-common-dir"])).trim()), "info", "exclude");
}

/** Old git without per-worktree config: the shared info/exclude, which also hides the main checkout's files. */
function* excludeInCommon(c: Ctx, wt: string): Steps<void> {
  const info = (yield* commonInfoExclude(c, wt));
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
function* excludeInWorktree(c: Ctx, root: string, wt: string, log: (m: string) => void): Steps<boolean> {
  const file = join(root, ".agentthread", "worktree-excludes");
  const kept = lines((yield* effectiveExcludes(c, root, file))).filter((l) => !EXCLUDE_LINES.includes(l));
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  const text = [...kept, ...EXCLUDE_LINES].join("\n") + "\n";
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);

  const wasEnabled = (yield* git(c, root, ["config", "--get", "extensions.worktreeConfig"])).stdout.trim() === "true";
  try {
    if (!wasEnabled) (yield* mustGit(c, root, ["config", "extensions.worktreeConfig", "true"]));
    if ((yield* git(c, wt, ["config", "--worktree", "--get", "core.excludesFile"])).stdout.trim() !== file) {
      (yield* mustGit(c, wt, ["config", "--worktree", "core.excludesFile", file]));
    }
  } catch (e) {
    if (!wasEnabled) (yield* git(c, root, ["config", "--unset", "extensions.worktreeConfig"]));
    log(`per-worktree excludes unavailable, using the shared info/exclude: ${e instanceof Error ? e.message : String(e)}`);
    (yield* excludeInCommon(c, wt));
    return false;
  }

  const info = (yield* commonInfoExclude(c, wt));
  if (!existsSync(info)) return true;
  const current = readFileSync(info, "utf8");
  const filtered = current.split("\n").filter((l) => !EXCLUDE_LINES.includes(l.replace(/\r$/, "")));
  if (filtered.length !== current.split("\n").length) writeFileSync(info, filtered.join("\n"));
  return true;
}

const GUARD_MESSAGE = "AgentThread: workers do not commit; the coordinator commits.";
const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

function writeIfChanged(file: string, text: string): void {
  if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
  chmodSync(file, 0o755);
}

const HOOK_NAMES = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg",
  "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-auto-gc", "post-rewrite", "reference-transaction",
  "push-to-checkout",
];

/** The one stub, identical for every worktree: it finds the project's own hooks at run time from the worktree's config. */
function hookStub(guardDir: string): string {
  return [
    "#!/bin/sh",
    'N=${0##*/}',
    `if [ "$N" = "pre-commit" ] && [ "\${AGT_ROLE:-}" = "worker" ]; then`, `  echo ${shq(GUARD_MESSAGE)} >&2`, "  exit 1", "fi",
    "TOP=$(pwd -P)",
    'V=$(git config --worktree --get agentthread.hooksPath 2>/dev/null)',
    'if [ -z "$V" ]; then',
    '  D=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0',
    '  case "$D" in /*) ;; *) D="$TOP/$D" ;; esac',
    '  D="$D/hooks"',
    "else",
    '  case "$V" in /*) D="$V" ;; *) D="$TOP/$V" ;; esac',
    "fi",
    'R=$(cd "$D" 2>/dev/null && pwd -P) || exit 0',
    `G=$(cd ${shq(guardDir)} 2>/dev/null && pwd -P)`,
    '[ "$R" = "$G" ] && exit 0',
    '[ -x "$R/$N" ] && exec "$R/$N" "$@"',
    "exit 0",
    "",
  ].join("\n");
}

/**
 * Worker commit guard: a per-worktree core.hooksPath whose pre-commit refuses commits when $AGT_ROLE is "worker". Every
 * standard hook is a stub that then runs the project's own hook, found at run time through the worktree-scoped
 * agentthread.hooksPath (the original core.hooksPath as configured, empty when unset), so the shared stubs hold no
 * worktree-specific path. Needs extensions.worktreeConfig (set up by excludeInWorktree); the main checkout is untouched.
 */
function* guardInWorktree(c: Ctx, root: string, wt: string, log: (m: string) => void): Steps<void> {
  const dir = join(root, ".agentthread", "hooks");
  try {
    const configured = (yield* git(c, root, ["config", "--get", "core.hooksPath"]));
    const original = configured.ok ? configured.stdout.trim() : "";
    mkdirSync(dir, { recursive: true });
    // One script, every hook name a symlink to it: a freshly written executable costs a one-off scan on some systems.
    writeIfChanged(join(dir, "stub"), hookStub(dir));
    for (const name of HOOK_NAMES) {
      const link = join(dir, name);
      let current = "";
      try {
        current = readlinkSync(link);
      } catch {}
      if (current !== "stub") {
        removeIfPresent(link);
        symlinkSync("stub", link);
      }
    }
    const current = (yield* git(c, wt, ["config", "--worktree", "--get", "agentthread.hooksPath"]));
    // Unset means empty (the runners drop an empty argument, so an empty value cannot be passed).
    if (original === "") {
      if (current.ok && current.stdout.trim() !== "") (yield* mustGit(c, wt, ["config", "--worktree", "--unset", "agentthread.hooksPath"]));
    } else if (!current.ok || current.stdout.trim() !== original) {
      (yield* mustGit(c, wt, ["config", "--worktree", "agentthread.hooksPath", original]));
    }
    if ((yield* git(c, wt, ["config", "--worktree", "--get", "core.hooksPath"])).stdout.trim() !== dir) {
      (yield* mustGit(c, wt, ["config", "--worktree", "core.hooksPath", dir]));
    }
  } catch {
    log("worker commit guard unavailable: git without worktree config");
  }
}

/**
 * Writes `<worktree>/AGENTS.md` (the project's own instructions, then `content`) and makes `CLAUDE.md` a symlink to
 * it. Neither ever shows up in `git status` or a commit: tracked paths get skip-worktree, the others are excluded
 * through a per-worktree excludes file (set up first, so the files are never visible). Never writes through a symlink.
 */
type WriteOptions = {
  root: string;
  worktree: string;
  content: string;
  env?: Env;
  log?: (message: string) => void;
};

export function writeAgentsFiles(o: WriteOptions & { runner?: Runner }): void {
  driveSync(writeSteps(o), o.runner ?? spawnRunner, o.env ?? (process.env as Env));
}

/** writeAgentsFiles without blocking the event loop: the daemon's effects use this one. */
export function writeAgentsFilesAsync(o: WriteOptions & { runner?: AsyncRunner }): Promise<void> {
  return driveAsync(writeSteps(o), o.runner ?? spawnAsync, o.env ?? (process.env as Env));
}

function* writeSteps(o: WriteOptions): Steps<void> {
  const wt = o.worktree;
  const c: Ctx = { env: o.env ?? (process.env as Env) };
  const log = o.log ?? ((m) => console.error(m));
  const perWorktree = yield* excludeInWorktree(c, o.root, wt, log);
  if (perWorktree) yield* guardInWorktree(c, o.root, wt, log);
  else log("worker commit guard unavailable: git without worktree config");
  const project = yield* projectInstructions(c, wt);
  const agents = join(wt, "AGENTS.md");
  let regular = false;
  try {
    regular = lstatSync(agents).isFile();
  } catch {}
  if (!regular) removeIfPresent(agents);
  writeFileSync(agents, `${project}${project ? "\n\n" : ""}${o.content}`);
  for (const link of LINKS) {
    removeIfPresent(join(wt, link));
    symlinkSync("AGENTS.md", join(wt, link));
  }
  for (const file of FILES) {
    if ((yield* git(c, wt, ["ls-files", "--error-unmatch", "--", file])).ok) yield* mustGit(c, wt, ["update-index", "--skip-worktree", "--", file]);
  }
}
