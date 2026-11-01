import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type AsyncRunner, type RunResult, type Runner, spawnAsync, spawnRunner } from "../herdr/bridge.ts";
import type { Config } from "../config/config.ts";
import { paths } from "../project/paths.ts";
import { AGENT_KINDS } from "../domain/types.ts";
import { adapterFor } from "./adapters.ts";
import { systemPrompt, type PromptThread } from "./prompts.ts";
import { GENERATED_RELS, generatedExcludes, SKILL_EXCLUDES, SKILL_ROOTS, skillExclude, writeSkills } from "./skill.ts";

type ThreadRef = PromptThread;

/** The role prompts without their first (identity) line: the role is stated by the bootstrap prompt instead. */
export const rulesOf = (prompt: string) => prompt.split("\n").slice(1);

/**
 * The AgentThread section of the AGENTS.md in a thread directory (or a legacy thread's worktree). One file serves the
 * coordinator and the workers.
 */
export function agentsMd(o: { root: string; thread: ThreadRef; config?: Config }): string {
  const t = o.thread;
  const dir = paths(o.root).threadDir(t);
  const coordinator = rulesOf(systemPrompt({ root: o.root, role: "coordinator", thread: t, ...(o.config ? { config: o.config } : {}) }));
  const worker = rulesOf(systemPrompt({ root: o.root, role: "worker", thread: t, ticket: "<T>", ...(o.config ? { config: o.config } : {}) }));
  return [
    "# AgentThread",
    "",
    t.dir === undefined
      ? `This worktree belongs to AgentThread thread ${t.id} ("${t.title}") of the project at ${o.root}. The worktree is ${t.worktree}.`
      : `This folder belongs to AgentThread thread ${t.id} ("${t.title}") of the project at ${o.root}. The thread directory is ${t.dir}; the thread's repo worktrees go inside it.`,
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
/** Every file agt writes into a thread directory, relative to it: the instruction files and the generated skills. */
export const THREAD_DIR_FILES: readonly string[] = [...FILES, ...GENERATED_RELS];
const EXCLUDE_LINES = FILES.map((f) => `/${f}`);
/** The lines the worktree excludes carry: the instruction files, and the generated skills when they are on. */
const excludeLines = (skill: boolean) => (skill ? [...EXCLUDE_LINES, ...SKILL_EXCLUDES] : EXCLUDE_LINES);
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
function* effectiveExcludes(c: Ctx, root: string, ours: string[]): Steps<string> {
  const configured = (yield* git(c, root, ["config", "--path", "--get", "core.excludesFile"]));
  let file = configured.ok ? configured.stdout.trim() : "";
  if (file) file = resolve(root, file);
  if (ours.includes(file)) file = "";
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
function* excludeInCommon(c: Ctx, wt: string, skill: boolean, root: string): Steps<void> {
  const info = (yield* commonInfoExclude(c, wt));
  let current = existsSync(info) ? readFileSync(info, "utf8") : "";
  const have = lines(current);
  // the shared file covers the root too: no line for a skill the root has its own copy of
  for (const line of [...EXCLUDE_LINES, ...(skill ? generatedExcludes(root).map((rel) => skillExclude("", rel)) : [])]) {
    if (have.includes(line)) continue;
    current = `${current}${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  mkdirSync(dirname(info), { recursive: true });
  writeFileSync(info, current);
}

/**
 * Earlier versions kept one shared excludes file at `<root>/.agentthread/worktree-excludes`, where the per-repo
 * folder now goes: the worktrees of `repo` that still point at it are moved over to `file`, then it is removed.
 */
function* migrateSharedExcludes(c: Ctx, repo: string, shared: string, file: string): Steps<void> {
  let isFile = false;
  try {
    isFile = lstatSync(shared).isFile();
  } catch {}
  if (!isFile) return;
  const users: string[] = [];
  const list = (yield* git(c, repo, ["worktree", "list", "--porcelain"]));
  for (const line of list.ok ? lines(list.stdout) : []) {
    if (!line.startsWith("worktree ")) continue;
    const wt = line.slice("worktree ".length);
    if (existsSync(wt) && (yield* git(c, wt, ["config", "--worktree", "--get", "core.excludesFile"])).stdout.trim() === shared) users.push(wt);
  }
  const text = readFileSync(shared, "utf8");
  rmSync(shared, { force: true });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  for (const wt of users) yield* git(c, wt, ["config", "--worktree", "core.excludesFile", file]);
}

/**
 * Hides untracked AGENTS.md/CLAUDE.md in thread worktrees only: a per-worktree core.excludesFile (one file per repo,
 * `<root>/.agentthread/worktree-excludes/<repo>`), so the main checkout can still add its own. Also removes the lines
 * that earlier versions put in the shared info/exclude.
 */
function* excludeInWorktree(c: Ctx, root: string, repo: string, repoName: string, wt: string, skill: boolean, log: (m: string) => void): Steps<boolean> {
  const shared = join(root, ".agentthread", "worktree-excludes");
  const file = join(shared, repoName);
  yield* migrateSharedExcludes(c, repo, shared, file);
  const kept = lines((yield* effectiveExcludes(c, repo, [file, shared]))).filter((l) => !EXCLUDE_LINES.includes(l) && !SKILL_EXCLUDES.includes(l));
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  const text = [...kept, ...excludeLines(skill)].join("\n") + "\n";
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);

  const wasEnabled = (yield* git(c, repo, ["config", "--get", "extensions.worktreeConfig"])).stdout.trim() === "true";
  try {
    if (!wasEnabled) (yield* mustGit(c, repo, ["config", "extensions.worktreeConfig", "true"]));
    if ((yield* git(c, wt, ["config", "--worktree", "--get", "core.excludesFile"])).stdout.trim() !== file) {
      (yield* mustGit(c, wt, ["config", "--worktree", "core.excludesFile", file]));
    }
  } catch (e) {
    if (!wasEnabled) (yield* git(c, repo, ["config", "--unset", "extensions.worktreeConfig"]));
    log(`per-worktree excludes unavailable, using the shared info/exclude: ${e instanceof Error ? e.message : String(e)}`);
    (yield* excludeInCommon(c, wt, skill, root));
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
const WORKER_BRANCH_MESSAGE = "AgentThread: workers commit only on wip/<task>.";
const COORDINATOR_BRANCH_MESSAGE = "AgentThread: the coordinator commits only the squash on feat/<task>.";
const STAGE8_PREFIX = "AgentThread: stage 8 (browser check) is not done; record it with agt stage ";
const STAGE8_SUFFIX = " 8 done|na first.";
const NO_LIST_PREFIX = "AgentThread: no file list for ticket ";
const PUSH_MESSAGE = "AgentThread: agents never push; the user pushes.";
const MSG_PREFIX = "AgentThread: the commit message mentions ";
const MSG_SUFFIX = "; write a plain conventional commit (no AI attribution, ticket ids, .docs paths or banned words).";
const MSG_UNREADABLE = "AgentThread: cannot read the commit message; commit refused.";
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
    "# Prints $AGT_ROOT/.agentthread/threads/<$AGT_THREAD-slug>/$1 when that file exists, else nothing.",
    "agt_thread_file() {",
    '  for T in "${AGT_ROOT:-/nonexistent}"/.agentthread/threads/"${AGT_THREAD:-}"-*/; do',
    '    [ -f "${T}$1" ] && { printf "%s" "${T}$1"; return 0; }',
    "  done",
    "  return 0",
    "}",
    "# Role rules apply to agent processes only: a user's shell in a thread tab inherits AGT_ROLE but not this marker.",
    '[ "${AGT_AGENT_PROCESS:-}" = 1 ] && AGENT=${AGT_ROLE:-} || AGENT=',
    `if [ "$N" = "pre-push" ] && [ -n "$AGENT" ]; then`, `  echo ${shq(PUSH_MESSAGE)} >&2`, "  exit 1", "fi",
    "# An agent's commit message: no AI attribution, .docs paths, ticket ids (T<n>, case-sensitive) or banned words (comment lines and the",
    "# scissors section that git commit -v appends are not part of it). Legacy thread/* branches keep no message rules.",
    'if [ "$N" = "commit-msg" ] && [ -n "$AGENT" ]; then',
    '  case "$(git symbolic-ref -q --short HEAD 2>/dev/null)" in',
    "    thread/*) ;;",
    "    *)",
    `      agt_refuse_msg() { printf '%s%s%s\\n' ${shq(MSG_PREFIX)} "$1" ${shq(MSG_SUFFIX)} >&2; exit 1; }`,
    `      [ -n "\${1:-}" ] && [ -f "$1" ] && [ -r "$1" ] || { echo ${shq(MSG_UNREADABLE)} >&2; exit 1; }`,
    `      M=$(sed -e '/^# -* >8 -*$/,$d' -e '/^#/d' "$1") || { echo ${shq(MSG_UNREADABLE)} >&2; exit 1; }`,
    "      has() { printf '%s\\n' \"$M\" | grep \"$@\" >/dev/null 2>&1; }",
    "      has -Fi -e 'co-authored-by:' -e 'generated with' && agt_refuse_msg 'AI attribution'",
    "      has -Fi -e '.docs/' && agt_refuse_msg 'a .docs path'",
    "      has -E -e '(^|[^[:alnum:]_])T[0-9]{1,4}([^[:alnum:]_]|$)' && agt_refuse_msg 'a ticket id'",
    '      W="${AGT_ROOT:-/nonexistent}/.agentthread/banned-words"',
    '      if [ -f "$W" ]; then',
    "        CR=$(printf '\\r')",
    "        while IFS= read -r WORD || [ -n \"$WORD\" ]; do",
    '          WORD=${WORD%"$CR"}',
    '          [ -n "$WORD" ] && has -Fiw -e "$WORD" && agt_refuse_msg "the banned word \\"$WORD\\""',
    '        done < "$W"',
    "      fi ;;",
    "  esac",
    "fi",
    'if [ "$N" = "pre-commit" ]; then',
    "  B=$(git symbolic-ref -q --short HEAD 2>/dev/null)",
    '  case "$AGENT" in',
    "    worker)",
    '      case "$B" in',
    `        thread/*) echo ${shq(GUARD_MESSAGE)} >&2; exit 1 ;;`,
    `        wip/*) [ -n "\${AGT_TASK:-}" ] && [ "$B" = "wip/$AGT_TASK" ] || { echo ${shq(WORKER_BRANCH_MESSAGE)} >&2; exit 1; }`,
    '          L=$(agt_thread_file "tickets/${AGT_TICKET:-}.files")',
    `          [ -n "\${AGT_TICKET:-}" ] && [ -n "$L" ] || { echo "${NO_LIST_PREFIX}\${AGT_TICKET:-}; ask the coordinator." >&2; exit 1; }`,
    "          BAD=",
    '          NL=$(printf "\\nx"); NL=${NL%x}',
    "          S=$(git -c core.quotePath=false diff --cached --name-only --no-renames --diff-filter=ACDMRT) || { echo 'AgentThread: cannot read the staged files; commit refused.' >&2; exit 1; }",
    "          OLDIFS=$IFS; IFS=$NL; set -f",
    "          for P in $S; do",
    '            grep -Fxq -- "$P" "$L" || BAD="${BAD:+$BAD }$P"',
    "          done",
    "          set +f; IFS=$OLDIFS",
    `          [ -z "$BAD" ] || { echo "AgentThread: these files are not in ticket $AGT_TICKET: $BAD." >&2; exit 1; } ;;`,
    `        *) echo ${shq(WORKER_BRANCH_MESSAGE)} >&2; exit 1 ;;`,
    "      esac ;;",
    "    coordinator)",
    '      case "$B" in',
    "        thread/*) ;;",
    `        feat/*) [ -n "\${AGT_TASK:-}" ] && [ "$B" = "feat/$AGT_TASK" ] || { echo ${shq(COORDINATOR_BRANCH_MESSAGE)} >&2; exit 1; }
          [ -n "$(agt_thread_file stage8)" ] || { echo "${STAGE8_PREFIX}\${AGT_THREAD:-<thread>}${STAGE8_SUFFIX}" >&2; exit 1; } ;;`,
    `        *) echo ${shq(COORDINATOR_BRANCH_MESSAGE)} >&2; exit 1 ;;`,
    "      esac ;;",
    "  esac",
    "fi",
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
 * Worker commit guard: a per-worktree core.hooksPath whose pre-commit refuses commits by role and branch (workers on wip/<task>, the coordinator on feat/<task>), pre-push refuses any push by an agent. Every
 * standard hook is a stub that then runs the project's own hook, found at run time through the worktree-scoped
 * agentthread.hooksPath (the original core.hooksPath as configured, empty when unset), so the shared stubs hold no
 * worktree-specific path. Needs extensions.worktreeConfig (set up by excludeInWorktree); the main checkout is untouched.
 */
function* guardInWorktree(c: Ctx, root: string, repo: string, wt: string, log: (m: string) => void): Steps<void> {
  const dir = join(root, ".agentthread", "hooks");
  try {
    // --path expands a leading ~/ as git itself does when it runs hooks; the stub reads the value back verbatim.
    const configured = (yield* git(c, repo, ["config", "--path", "--get", "core.hooksPath"]));
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
  /** The main checkout of the worktree's repository, where repo-wide git config is read and set (default: root). */
  repo?: string;
  /** The repo's name: its excludes file is `<root>/.agentthread/worktree-excludes/<repoName>` (default: the repo folder's name). */
  repoName?: string;
  worktree: string;
  content: string;
  /** With agents.skill not false, the generated skills are written too. */
  config: Config;
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
  const skill = o.config.agents.skill !== false;
  const repo = o.repo ?? o.root;
  const perWorktree = yield* excludeInWorktree(c, o.root, repo, o.repoName ?? basename(repo), wt, skill, log);
  if (perWorktree) yield* guardInWorktree(c, o.root, repo, wt, log);
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
  if (skill) {
    const listed = yield* git(c, wt, ["ls-files", "--", ...SKILL_ROOTS]);
    const tracked = new Set(listed.ok ? lines(listed.stdout).filter(Boolean) : []);
    writeSkills(wt, { root: o.root, config: o.config, tracked, log });
  }
}

/**
 * A thread directory is not in git: AGENTS.md (`content` only), the instruction-file symlinks and the skill are written
 * plainly, with no git call, no exclude and no guard. Never writes through a symlink. Synchronous plain fs, so the
 * daemon may call it.
 */
export function writeThreadDirFiles(o: { root: string; dir: string; content: string; config: Config; log?: (message: string) => void }): void {
  const log = o.log ?? ((m) => console.error(m));
  const agents = join(o.dir, "AGENTS.md");
  let regular = false;
  try {
    regular = lstatSync(agents).isFile();
  } catch {}
  if (!regular) removeIfPresent(agents);
  writeFileSync(agents, o.content);
  for (const link of LINKS) {
    removeIfPresent(join(o.dir, link));
    symlinkSync("AGENTS.md", join(o.dir, link));
  }
  writeSkills(o.dir, { root: o.root, config: o.config, tracked: new Set(), log });
}
