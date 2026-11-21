import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { AGENT_KINDS, type AgentKind, type StoredEvent } from "../../../src/domain/types.ts";
import { shellQuote, spawnAsync } from "../../../src/herdr/bridge.ts";
import { paths } from "../../../src/project/paths.ts";
import { AGT, agt as agtRun, assertInScratchBase, cleanEnv, git, isSymlinkTo, runClock, say, TimeoutError, wsTask, type EventOf, type RoleAgents } from "../harness.ts";
import { actingCoordinator, askForThread, closeThread, mainIdle, sessionsOf, tiers, type H, type Scenario } from "./common.ts";

/** The shared workspace task (plan Global Constraints, verbatim). */
export const WS_TASK =
  "Add a `slugify(s)` function to api (`src/slugify.ts`, unit tests) and use it in web to display a slug of the title (`src/title.ts`, unit tests). Use the source branch `main`; do not ask me about it.";

/** Leaves the details to the agents, so a row is not held up by questions. */
const DECIDE = "Decide details yourself with your recommendations; only stop for me if something is truly blocked.";

/** The request to main: the task, with the confirmation given up front and the details left to the agents. */
export const WS_ASK_MAIN = `${WS_TASK} You have my confirmation already: create the thread without asking me to confirm it. ${DECIDE}`;

/** ws-edge-out-of-ticket: api's AGENTS.md asks for a file that no ticket lists. */
export const OUT_OF_TICKET_HINT = "Whenever you change src/slugify.ts, also add a line to CHANGELOG.md.";
/** ws-edge-out-of-ticket: added to the coordinator's task text, so only the worker is tempted by the hint. */
export const NOT_IN_TICKET_LINE = "CHANGELOG.md is not part of this task; do not put it in any ticket.";
/** ws-edge-return: added to the coordinator's task text. */
export const RETURN_LINE = "Return the first ticket once with 'add a test for an empty string' before accepting it.";
/** ws-stack-lock: added to each coordinator's task text (the fixture's Makefile is at the workspace root). */
export const RESTART_LINE = "Restart the stack before testing (the configured stack restart, run in the workspace root).";
/** ws-stack-lock's second task, beside WS_TASK. */
const WS_TASK_B = "Add a `capitalize(s)` function to api (`src/capitalize.ts`, unit tests). Use the source branch `main`; do not ask me about it.";
/** ws-tab-shell: a coordinator with nothing to do (the row only needs its process and its tab). */
const TAB_SHELL_GOAL =
  "Release e2e check of a user shell in this thread's tab. There is no work: do not add worktrees, tickets or workers, do not commit, and do not wait for the user.";

/** What the user types into the coordinator's pane when the thread waits for them. */
export const WAITING_ANSWER = "Go with your recommendations; decide the rest yourself and don't wait for me again.";

/** Time kept after the review wait for the row's own checks: two `bun test` runs, git, and the tab closing. */
const BUN_TEST_MS = 120_000;
const AFTER_REVIEW_MS = 2 * BUN_TEST_MS + 120_000;

const REPOS = ["api", "web"] as const;

/** What a squash commit message must not carry, as the product's commit-msg guard has it (agents-md.ts). */
const BANNED: { name: string; re: RegExp }[] = [
  { name: "Co-Authored-By", re: /co-authored-by:/i },
  { name: "Generated with", re: /generated with/i },
  { name: ".docs/", re: /\.docs\//i },
  { name: "T<n>", re: /\bT[0-9]{1,4}\b/ },
];

/** The banned markers in a commit message, in a fixed order; empty when the message is clean. */
export function commitMessageProblems(message: string): string[] {
  return BANNED.filter((b) => b.re.test(message)).map((b) => b.name);
}

/**
 * The commits of `repo` that leave their ticket: each commit's files must all be in one ticket of that repo. Returns
 * "<sha>: <why>" for each offending commit; empty when every commit stays inside a ticket.
 */
export function commitsOutsideTickets(
  repo: string,
  commits: { sha: string; files: string[] }[],
  tickets: { ticket: string; repo?: string; files?: string[] }[],
): string[] {
  const own = tickets.filter((t) => t.repo === repo).map((t) => new Set(t.files ?? []));
  const out: string[] = [];
  for (const c of commits) {
    if (!c.files.length || own.some((s) => c.files.every((f) => s.has(f)))) continue;
    const listed = new Set(own.flatMap((s) => [...s]));
    const stray = c.files.filter((f) => !listed.has(f));
    out.push(`${c.sha}: ${stray.length ? stray.join(", ") : `spans more than one ticket (${c.files.join(", ")})`}`);
  }
  return out;
}

/**
 * What is wrong with a repo's feat diff: it must change something, and only files the repo's tickets list (their
 * union: the squash carries every ticket). Empty when it is fine.
 */
export function featDiffProblems(repo: string, files: string[], tickets: { repo?: string; files?: string[] }[]): string[] {
  if (!files.length) return ["no changes"];
  const listed = new Set(tickets.filter((t) => t.repo === repo).flatMap((t) => t.files ?? []));
  const stray = files.filter((f) => !listed.has(f));
  return stray.length ? [`outside the tickets: ${stray.join(", ")}`] : [];
}

/** The most threads that held the stack lock at once, replaying stack.acquired and stack.released in order. */
export function maxHolders(all: StoredEvent[]): number {
  const holders = new Set<string>();
  let max = 0;
  for (const e of all) {
    // A queued thread's release (it left the queue) frees nothing: it was never in the set.
    if (e.type === "stack.acquired") holders.add(e.payload.thread);
    else if (e.type === "stack.released") holders.delete(e.payload.thread);
    max = Math.max(max, holders.size);
  }
  return max;
}

/** What the fixture's `make restart` takes: it logs its start, then sleeps this long. */
const RESTART_SECONDS = 5;

/**
 * What is wrong with `.stack.log` ("<task> <epoch seconds>" per restart): a line that does not read, a task with no
 * restart, or a restart that started before the previous one's sleep was over. Empty when it is fine.
 */
export function stackLogProblems(text: string, tasks: string[]): string[] {
  const out: string[] = [];
  const runs: { task: string; at: number }[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const m = /^(\S+) (\d+)$/.exec(line);
    if (m) runs.push({ task: m[1]!, at: Number(m[2]) });
    else out.push(`unreadable line: ${line}`);
  }
  for (const t of tasks) if (!runs.some((r) => r.task === t)) out.push(`no restart for ${t}`);
  runs.sort((a, b) => a.at - b.at);
  for (let i = 1; i < runs.length; i++) {
    const [prev, cur] = [runs[i - 1]!, runs[i]!];
    const gap = cur.at - prev.at;
    if (gap < RESTART_SECONDS) out.push(`${cur.task} at ${cur.at} overlaps ${prev.task} at ${prev.at} (${gap}s apart, a restart takes ${RESTART_SECONDS}s)`);
  }
  return out;
}

const GONE = ["session.ended", "session.lost", "session.rotated", "session.failed"];

/**
 * What is wrong with a returned ticket's path: it was reviewed, returned, reviewed again, then accepted. The second
 * review is the same worker's when that worker was still live at the return (a rotation's replacement counts as the
 * same worker); otherwise a new worker session for the ticket started after the return. A new session is "another
 * session taking the ticket" only while the worker live at the return (or its replacement) had not yet ended or been
 * lost: once it is gone, a fresh worker is legitimate. Empty when it is fine.
 */
export function returnProblems(all: StoredEvent[], thread: string, ticket: string): string[] {
  const own = all.filter((e) => e.thread === thread);
  const returned = own.find((e): e is EventOf<"ticket.returned"> => e.type === "ticket.returned" && e.payload.ticket === ticket);
  if (!returned) return [`${ticket} was never returned`];
  const reviews = own.filter((e): e is EventOf<"ticket.reviewed"> => e.type === "ticket.reviewed" && e.payload.ticket === ticket);
  if (!reviews.some((r) => r.seq < returned.seq)) return [`${ticket} was returned before any review`];
  const out: string[] = [];
  const again = reviews.find((r) => r.seq > returned.seq);
  if (!again) out.push(`no ticket.reviewed for ${ticket} after the return`);
  else {
    const workers = own.filter((e): e is EventOf<"session.created"> => e.type === "session.created" && e.payload.role === "worker" && e.payload.ticket === ticket);
    const goneAt = new Map<string, number>();
    for (const e of all) {
      const s = (e.payload as { session?: string }).session;
      if (GONE.includes(e.type) && s && !goneAt.has(s)) goneAt.set(s, e.seq);
    }
    const liveAt = (session: string, seq: number) => (goneAt.get(session) ?? Infinity) > seq;
    const live = workers.filter((w) => w.seq < returned.seq && liveAt(w.payload.session, returned.seq)).map((w) => w.payload.session);
    const fresh = workers.filter((w) => w.seq > returned.seq && w.seq < again.seq);
    // The worker live at the return and its rotations' replacements; a fresh session counts against it only while one runs.
    const same = new Set(live);
    const held = new Set<string>();
    const others: string[] = [];
    for (const f of fresh) {
      if (same.has(f.payload.replaces ?? "")) {
        same.add(f.payload.session);
        continue;
      }
      const running = [...same].filter((s) => liveAt(s, f.seq));
      if (!running.length) continue;
      running.forEach((s) => held.add(s));
      others.push(f.payload.session);
    }
    if (others.length) out.push(`worker ${[...held].join(",")} was still live, but another session took ${ticket} after the return: ${others.join(",")}`);
    if (!live.length && !fresh.length) out.push(`the first worker had ended, but no new worker session for ${ticket} started after the return`);
  }
  const after = again?.seq ?? returned.seq;
  if (!own.some((e) => e.type === "ticket.accepted" && e.payload.ticket === ticket && e.seq > after)) out.push(`${ticket} is not accepted after the return`);
  return out;
}

/**
 * ws-edge-out-of-ticket: the api ticket for src/slugify.ts (the hinted file's trigger), with how it ended so far:
 * reviewed, or blocked with its reason. Undefined until that ticket exists.
 */
export function outOfTicketOutcome(
  all: StoredEvent[],
  thread: string,
): { ticket: string; files: string[]; outcome?: "reviewed" | "blocked"; detail?: string } | undefined {
  const made = all.find(
    (e): e is EventOf<"ticket.created"> => e.type === "ticket.created" && e.thread === thread && e.payload.repo === "api" && !!e.payload.files?.includes("src/slugify.ts"),
  );
  if (!made) return undefined;
  const base = { ticket: made.payload.ticket, files: made.payload.files ?? [] };
  const end = all.find(
    (e): e is EventOf<"ticket.reviewed" | "ticket.blocked"> => (e.type === "ticket.reviewed" || e.type === "ticket.blocked") && e.thread === thread && e.payload.ticket === base.ticket,
  );
  if (!end) return base;
  return end.type === "ticket.blocked" ? { ...base, outcome: "blocked", detail: end.payload.reason } : { ...base, outcome: "reviewed" };
}

const AGT_VAR = /^(AGT_[A-Z0-9_]+)=(.*)$/;

/** The AGT_ variables in `ps -E` (macOS) output: the command, then the environment as space-separated K=V words. */
export function agtVarsFromPs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const word of line.split(/\s+/)) {
    const m = AGT_VAR.exec(word);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** The AGT_ variables of `env` output or /proc/<pid>/environ: one K=V per line (or per NUL). */
export function agtVarsFromEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/[\n\0]/)) {
    const m = AGT_VAR.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

const threadIdOf = (out: string): string => {
  const id = /"thread":"(\d+)"/.exec(out)?.[1];
  if (!id) throw new Error(`cannot read the thread id from: ${out}`);
  return id;
};

/** `git log --name-only` of `range` in `cwd`, without merges: each commit's sha and changed files. */
async function commitsIn(cwd: string, range: string): Promise<{ sha: string; files: string[] }[]> {
  const out = await git(cwd, "log", "--no-merges", "--format=%x1e%H", "--name-only", range);
  return out
    .split("\x1e")
    .filter((c) => c.trim())
    .map((c) => {
      const [sha = "", ...files] = c.split("\n").map((l) => l.trim()).filter(Boolean);
      return { sha: sha.slice(0, 12), files };
    });
}

/**
 * True when agt recorded `stage` of `thread` as na and no later record of that stage has another state (a coordinator
 * re-recording na is fine).
 */
export function stageNaByAgt(all: StoredEvent[], thread: string, stage: number): boolean {
  const records = all.filter((e): e is EventOf<"stage.recorded"> => e.type === "stage.recorded" && e.thread === thread && e.payload.stage === stage);
  const i = records.findLastIndex((r) => r.payload.state === "na" && r.payload.by === "agt");
  return i >= 0 && records.slice(i + 1).every((r) => r.payload.state === "na");
}

const stageRecords = (all: StoredEvent[], thread: string, stage: number) =>
  all
    .filter((e): e is EventOf<"stage.recorded"> => e.type === "stage.recorded" && e.thread === thread && e.payload.stage === stage)
    .map((e) => `${e.payload.state} by ${e.payload.by}`)
    .join(", ") || "none";

const latestStage = (all: StoredEvent[], thread: string, stage: number) =>
  all.filter((e): e is EventOf<"stage.recorded"> => e.type === "stage.recorded" && e.thread === thread && e.payload.stage === stage).at(-1)?.payload;

/** Reads brief.md until it has `want`, or a timeout; returns the last text read ("" when it never existed). */
async function briefWith(file: string, want: RegExp[], timeoutMs: number): Promise<string> {
  let text = "";
  for (const until = runClock.now() + timeoutMs; ; ) {
    text = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (want.every((w) => w.test(text)) || runClock.now() >= until) return text;
    await Bun.sleep(500);
  }
}

/** The path of a worktree.added event; throws the failure reason of a worktree.failed one. */
export function worktreeResult(e: EventOf<"worktree.added"> | EventOf<"worktree.failed">): string {
  if (e.type === "worktree.failed") throw new Error(`worktree for ${e.payload.repo} failed: ${e.payload.reason}`);
  return e.payload.path;
}

/** Waits for the repo's worktree.added or worktree.failed; a failure fails the row at once with its reason. */
async function waitWorktree(h: H, thread: string, repo: string, ms: number): Promise<string> {
  return worktreeResult(await h.waitFor(["worktree.added", "worktree.failed"] as const, (e) => e.thread === thread && e.payload.repo === repo, ms, `worktree for ${repo}`));
}

/** No model calls: the user does what the coordinator would (thread with a task name, a worktree per repo). */
async function smokeWorktrees(h: H): Promise<void> {
  const task = "pay-1";
  // A proposed tier that waits an hour: the thread gets no tab and no coordinator, so nothing calls a model.
  const thread = threadIdOf(await h.agtOk(["thread", "new", "PAY smoke", "--type", "feature", "--goal", "workspace worktrees smoke", "--task", task, "--tier", "low", "--reason", "smoke row: no coordinator"]));
  for (const repo of REPOS) await h.agtOk(["worktree", "add", thread, repo]);
  for (const repo of REPOS) await waitWorktree(h, thread, repo, 120_000);

  const all = await h.events();
  const created = all.find((e): e is EventOf<"thread.created"> => e.type === "thread.created" && e.thread === thread)!;
  h.check("the thread has the task name", created.payload.task === task, created.payload.task);
  for (const repo of REPOS) {
    const want = join(h.root, ".worktrees", task, repo);
    const added = all.find((e): e is EventOf<"worktree.added"> => e.type === "worktree.added" && e.thread === thread && e.payload.repo === repo)!;
    h.check(`${repo}: worktree at .worktrees/${task}/${repo}`, added.payload.path === want && existsSync(want), added.payload.path);
    const head = existsSync(want) ? (await git(want, "rev-parse", "--abbrev-ref", "HEAD")).trim() : "(missing)";
    h.check(`${repo}: worktree on wip/${task}`, head === `wip/${task}` && added.payload.branch === `wip/${task}`, head);
    h.check(`${repo}: AGENTS.md has the AgentThread section`, existsSync(join(want, "AGENTS.md")) && readFileSync(join(want, "AGENTS.md"), "utf8").includes("# AgentThread"));
    h.check(`${repo}: CLAUDE.md links to AGENTS.md`, isSymlinkTo(join(want, "CLAUDE.md"), "AGENTS.md"));
    h.check(`${repo}: the generated agt skill is there`, existsSync(join(want, ".claude", "skills", "agt", "SKILL.md")));
    const status = existsSync(want) ? (await git(want, "status", "--porcelain", "--untracked-files=all")).trim() : "(missing)";
    h.check(`${repo}: instruction files and generated skills hidden from git status`, status === "", status || "clean");
  }
  const brief = join(paths(h.root).threadDir({ id: thread, slug: created.payload.slug }), "brief.md");
  const text = await briefWith(brief, [/^### api$/m, /^### web$/m], 20_000);
  const lists = /^### api$/m.test(text) && /^### web$/m.test(text);
  h.check("brief.md lists both repos", lists, lists ? brief : `${brief}: ${text ? text.slice(-600) : "never written"}`);
  const sessions = (await h.events()).filter((e) => e.type === "session.created" && e.thread === thread);
  h.check("no session started for the proposed thread (no model calls)", sessions.length === 0, `${sessions.length}`);
}

// ---- ws-stack-runner: no agents; the stack runner, the worktree copy and the generated Makefile ----

export type StackRow = { service: string; state: string; port: number | null; pid: number | null; cwd: string | null };

/** The partial project config of the row: a tiny Bun server per repo (web after api), `.env` copied into worktrees. */
export function stackConfigPatch(ports: { api: number; web: number }): Record<string, unknown> {
  const svc = (repo: "api" | "web", extra: Record<string, unknown> = {}) => ({
    repo,
    start: `PORT=${ports[repo]} bun serve.ts`,
    port: ports[repo],
    health: `http://127.0.0.1:${ports[repo]}/`,
    ...extra,
  });
  return {
    workspace: {
      repos: { api: { copy: [".env"] }, web: { copy: [".env"] } },
      services: { api: svc("api"), web: svc("web", { after: ["api"] }) },
    },
  };
}

/** The services of `agt stack status --json` ({services, lock}); [] when the text is not that. */
export function parseStackStatus(text: string): StackRow[] {
  try {
    const v = JSON.parse(text) as { services?: unknown };
    if (!Array.isArray(v.services)) return [];
    return v.services.filter((r): r is StackRow => typeof r === "object" && r !== null && typeof (r as StackRow).service === "string");
  } catch {
    return [];
  }
}

/** Whether `cwd` (absolute or relative to `root`) is inside .worktrees/<task>/<repo>. */
export function inTaskWorktree(root: string, task: string, repo: string, cwd: string | null): boolean {
  if (!cwd) return false;
  const want = join(root, ".worktrees", task, repo);
  const abs = cwd.startsWith("/") ? cwd : join(root, cwd);
  return abs === want || abs.startsWith(`${want}/`);
}

/** True when every named service is running with a pid; with `before`, every pid differs from that earlier one. */
export function allRunning(rows: StackRow[], names: readonly string[], before?: Record<string, number>): boolean {
  return names.every((n) => {
    const r = rows.find((x) => x.service === n);
    return !!r && r.state === "running" && r.pid !== null && (before === undefined || r.pid !== before[n]);
  });
}

async function freePorts(n: number): Promise<number[]> {
  const servers = Array.from({ length: n }, () => Bun.serve({ port: 0, fetch: () => new Response("") }));
  const ports = servers.map((s) => s.port as number);
  for (const s of servers) s.stop(true);
  return ports;
}

const portOpen = (port: number): Promise<boolean> =>
  new Promise((res) => {
    const s = connect({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), res(true)));
    s.once("error", () => res(false));
  });

async function httpOk(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3_000) })).ok;
  } catch {
    return false;
  }
}

async function stackRunner(h: H): Promise<void> {
  const task = "stack-1";
  const names = ["api", "web"] as const;
  const [pa, pb] = await freePorts(2);
  const ports = { api: pa!, web: pb! };
  // The fixture's own Makefile is the user's: remove it so agt writes the generated one.
  rmSync(join(h.root, "Makefile"), { force: true });
  for (const repo of REPOS) writeFileSync(join(h.root, repo, ".env"), `REPO=${repo}\n`); // untracked, never committed
  const cfg = Bun.spawn([process.execPath, AGT, "config", "apply", "-"], { cwd: h.root, env: cleanEnv({ AGT_ROOT: h.root }), stdin: new Response(JSON.stringify(stackConfigPatch(ports))), stdout: "pipe", stderr: "pipe" });
  const [cfgOut, cfgErr] = await Promise.all([new Response(cfg.stdout).text(), new Response(cfg.stderr).text(), cfg.exited]);
  h.check("agt config apply - accepts the services and copy config", cfg.exitCode === 0, cfg.exitCode === 0 ? undefined : `${cfgErr.trim() || cfgOut.trim()}`.slice(0, 400));

  const status = async () => parseStackStatus((await h.agt(["stack", "status", "--json"])).stdout);
  try {
    const thread = threadIdOf(await h.agtOk(["thread", "new", "Stack runner", "--type", "feature", "--goal", "stack runner row", "--task", task, "--tier", "low", "--reason", "stack row: no coordinator"]));
    for (const repo of REPOS) await h.agtOk(["worktree", "add", thread, repo]);
    for (const repo of REPOS) await waitWorktree(h, thread, repo, 180_000);
    for (const repo of REPOS) {
      const wt = join(h.root, ".worktrees", task, repo);
      h.check(`${repo}: .env copied into the worktree`, existsSync(join(wt, ".env")) && readFileSync(join(wt, ".env"), "utf8") === `REPO=${repo}\n`);
      const porcelain = existsSync(wt) ? (await git(wt, "status", "--porcelain")).trim() : "(missing)";
      h.check(`${repo}: git status --porcelain is clean (the copy is excluded)`, porcelain === "", porcelain || "clean");
      const gd = existsSync(wt) ? (await git(wt, "rev-parse", "--absolute-git-dir")).trim() : "";
      h.check(`${repo}: the agt-ready marker is in the worktree's git dir`, !!gd && existsSync(join(gd, "agt-ready")), gd);
    }

    const start = await agtRun(h.root, ["stack", "start", "--task", task], {}, 240_000);
    h.check("agt stack start --task stack-1 exits 0", start.exitCode === 0, `${start.stdout}${start.stderr}`.trim().slice(-400));
    const rows = await status();
    for (const n of names) {
      const r = rows.find((x) => x.service === n);
      h.check(`status: ${n} is running`, r?.state === "running" && r.pid !== null, JSON.stringify(r ?? null));
      h.check(`status: ${n} runs inside .worktrees/${task}/${n}`, inTaskWorktree(h.root, task, n, r?.cwd ?? null), r?.cwd ?? "no cwd");
      h.check(`${n}: HTTP GET on port ${ports[n]} succeeds`, await httpOk(ports[n]));
    }
    const before = Object.fromEntries(rows.filter((r) => r.pid !== null).map((r) => [r.service, r.pid as number]));

    const mk = join(h.root, "Makefile");
    h.check("the generated Makefile is at the root", existsSync(mk) && readFileSync(mk, "utf8").includes("generated by agt"));
    const make = await spawnAsync("make", ["-C", h.root, "restart", `TASK=${task}`, `AGT=${process.execPath} ${AGT}`], cleanEnv({ AGT_ROOT: h.root }), 60_000);
    h.check("make restart TASK=stack-1 exits 0", make.exitCode === 0, `${make.stdout}${make.stderr}`.trim().slice(-400));
    let now: StackRow[] = [];
    for (const end = runClock.now() + 180_000; runClock.now() < end; await Bun.sleep(2_000)) {
      now = await status();
      if (allRunning(now, names, before)) break;
    }
    h.check("after make restart both services run again with new pids", allRunning(now, names, before), JSON.stringify(now.map((r) => [r.service, r.state, r.pid])));
    for (const n of names) h.check(`${n}: HTTP GET on port ${ports[n]} succeeds after the restart`, await httpOk(ports[n]));

    const stop = await h.agt(["stack", "stop"]);
    h.check("agt stack stop exits 0", stop.exitCode === 0, `${stop.stdout}${stop.stderr}`.trim().slice(-300));
    for (const n of names) {
      h.check(`${n}: port ${ports[n]} is free after stop`, !(await portOpen(ports[n])));
      h.check(`${n}: pid file is gone`, !existsSync(join(h.root, ".local-run", `${n}.pid`)));
    }
  } finally {
    await h.agt(["stack", "stop", "--force"]).catch(() => undefined);
  }
}

/** Main is asked for the workspace task; the thread runs to review, then the event log and git are checked. */
async function wsHappy(h: H): Promise<void> {
  await mainIdle(h);
  const thread = await askForThread(h, WS_ASK_MAIN);
  await reviewAnsweringWaits(h, thread);
  await verifyWsThread(h, thread);
  await closeThread(h, thread);
}

/** Waits for the thread to reach review, keeping AFTER_REVIEW_MS for the checks; answers each thread.waiting on the way. */
async function reviewAnsweringWaits(h: H, thread: string): Promise<void> {
  const inReview = (all: StoredEvent[]) => all.some((e) => e.type === "thread.status_changed" && e.thread === thread && e.payload.to === "review") || undefined;
  await answeringWaits(h, [thread], inReview, h.left() - AFTER_REVIEW_MS, `thread ${thread} in review`);
}

/**
 * Polls the event log until `until` returns a value. Each thread.waiting of `threads` on the way is answered once, as
 * the user would: typed into that thread's acting coordinator pane (the coordinator talks to the user there).
 */
async function answeringWaits<T>(h: H, threads: string[], until: (all: StoredEvent[]) => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const ms = Math.max(1_000, Math.min(timeoutMs, h.left()));
  const answered = new Set<number>();
  for (const end = runClock.now() + ms; ; ) {
    const all = await h.events();
    const hit = until(all);
    if (hit !== undefined) return hit;
    for (const e of all) {
      if (e.type !== "thread.waiting" || !threads.includes(e.thread) || answered.has(e.seq)) continue;
      answered.add(e.seq);
      const c = actingCoordinator(all, e.thread);
      if (!c?.pane) {
        h.note(`thread ${e.thread} waits (${e.payload.what}) but has no coordinator pane to answer in`);
        continue;
      }
      await say(h.herdr, c.pane, c.agent, WAITING_ANSWER);
      h.note(`thread ${e.thread} waited for the user (${e.payload.what}); answered in coordinator pane ${c.pane}`);
    }
    if (runClock.now() >= end) {
      const tail = all.slice(-12).map((e) => `${e.seq} ${e.type}${e.thread ? ` ${e.thread}` : ""}`).join(", ");
      throw new TimeoutError(`timed out after ${Math.round(ms / 1000)}s waiting for ${what}; last events: ${tail}`);
    }
    await Bun.sleep(2_000);
  }
}

export async function verifyWsThread(h: H, thread: string): Promise<void> {
  const all = await h.events();
  const created = all.find((e): e is EventOf<"thread.created"> => e.type === "thread.created" && e.thread === thread)!;
  const task = created.payload.task ?? "";
  h.check("the thread has a task name", !!task, task || "none");

  const coords = sessionsOf(all, thread, "coordinator");
  h.check("coordinator runs the row's agent", coords.length > 0 && coords.every((c) => c.payload.agent === h.agents.coordinator), coords.map((c) => c.payload.agent).join(","));
  const workers = sessionsOf(all, thread, "worker");
  h.check("workers run the row's agent", workers.length > 0 && workers.every((w) => w.payload.agent === h.agents.worker), workers.map((w) => w.payload.agent).join(",") || "no workers");

  const added = new Map(all.filter((e): e is EventOf<"worktree.added"> => e.type === "worktree.added" && e.thread === thread).map((e) => [e.payload.repo, e.payload]));
  for (const repo of REPOS) h.check(`worktree.added for ${repo}`, added.has(repo), added.get(repo)?.path ?? "missing");

  const tickets = all.filter((e): e is EventOf<"ticket.created"> => e.type === "ticket.created" && e.thread === thread).map((e) => e.payload);
  h.check("at least 2 tickets", tickets.length >= 2, `${tickets.length}`);
  const bare = tickets.filter((t) => !t.repo || !t.files?.length).map((t) => t.ticket);
  h.check("every ticket has a repo and files", tickets.length > 0 && bare.length === 0, bare.join(",") || tickets.map((t) => `${t.ticket}:${t.repo}`).join(","));
  const accepted = new Set(all.filter((e): e is EventOf<"ticket.accepted"> => e.type === "ticket.accepted" && e.thread === thread).map((e) => e.payload.ticket));
  const open = tickets.filter((t) => !accepted.has(t.ticket)).map((t) => t.ticket);
  h.check("every ticket accepted", tickets.length > 0 && open.length === 0, open.join(",") || "all accepted");

  for (const repo of REPOS) {
    const repoPath = join(h.root, repo);
    const source = added.get(repo)?.source ?? "main";
    const commits = await commitsIn(repoPath, `${source}..wip/${task}`).catch((e) => (h.note(`${repo}: ${e}`), []));
    h.check(`${repo}: wip/${task} has commits`, commits.length > 0, `${commits.length}`);
    const stray = commitsOutsideTickets(repo, commits, tickets);
    h.check(`${repo}: wip/${task} commits touch only their ticket's files`, stray.length === 0, stray.join("; ") || `${commits.length} commits`);
  }

  h.check("stage 7 na by agt (no e2e commands in config)", stageNaByAgt(all, thread, 7), stageRecords(all, thread, 7));
  h.check("stage 8 na by agt (no browser in config)", stageNaByAgt(all, thread, 8), stageRecords(all, thread, 8));
  const s10 = latestStage(all, thread, 10);
  h.check("stage 10 done", s10?.state === "done", JSON.stringify(s10 ?? null));
  const status = all.filter((e): e is EventOf<"thread.status_changed"> => e.type === "thread.status_changed" && e.thread === thread).at(-1)?.payload.to;
  h.check("thread status review", status === "review", status ?? "none");

  const feat = `feat/${task}`;
  const ready: string[] = [];
  for (const repo of REPOS) {
    const repoPath = join(h.root, repo);
    try {
      const parent = (await git(repoPath, "rev-parse", `${feat}^`)).trim();
      const main = (await git(repoPath, "rev-parse", "main")).trim();
      const count = (await git(repoPath, "rev-list", "--count", `main..${feat}`)).trim();
      h.check(`${repo}: ${feat} is one commit over main`, parent === main && count === "1", `${count} commits, parent ${parent.slice(0, 12)}`);
      const diff = (await git(repoPath, "diff", "--name-only", "main", feat)).split("\n").filter(Boolean);
      const outside = featDiffProblems(repo, diff, tickets);
      h.check(`${repo}: ${feat} changes only its tickets' files`, outside.length === 0, outside.join("; ") || diff.join(", "));
      const problems = commitMessageProblems(await git(repoPath, "log", "-1", "--format=%B", feat));
      h.check(`${repo}: ${feat} message has no attribution, .docs/ path or ticket id`, problems.length === 0, problems.join(", ") || "clean");
      ready.push(repo);
    } catch (e) {
      h.check(`${repo}: ${feat} exists`, false, String(e));
    }
  }
  await testFeatCheckouts(h, feat, ready);
}

/**
 * `bun test` in a temporary detached checkout of each repo's feat branch, laid out like the workspace
 * (`<root>/.e2e-feat/<repo>`, so a relative import of a sibling repo finds its feat checkout), removed afterwards.
 */
async function testFeatCheckouts(h: H, feat: string, repos: string[]): Promise<void> {
  if (!repos.length) return;
  const base = join(h.root, ".e2e-feat");
  assertInScratchBase(base);
  const made: string[] = [];
  try {
    for (const repo of repos) {
      const at = join(base, repo);
      assertInScratchBase(at);
      await git(join(h.root, repo), "worktree", "add", "--detach", at, feat);
      made.push(repo);
    }
    for (const repo of made) {
      const r = await spawnAsync("sh", ["-c", 'cd "$1" && exec "$2" test', "sh", join(base, repo), process.execPath], cleanEnv(), BUN_TEST_MS);
      const tail = (r.stderr + r.stdout).trim().split("\n").slice(-3).join(" | ");
      h.check(`${repo}: bun test passes on ${feat}`, r.exitCode === 0 && !r.timedOut, tail);
    }
  } finally {
    for (const repo of made) await git(join(h.root, repo), "worktree", "remove", "--force", join(base, repo)).catch((e) => h.note(`removing the ${repo} check-out: ${e}`));
    rmSync(base, { recursive: true, force: true });
  }
}

/** A task thread created as the user with its tier chosen at once, so its coordinator starts; returns the thread id. */
async function newTaskThread(h: H, title: string, task: string, goal: string): Promise<string> {
  return threadIdOf(await h.agtOk(["thread", "new", title, "--type", "feature", "--goal", goal, "--task", task, "--tier", "low", "--reason", "release row: the user picks the tier", "--now"]));
}

const branchExists = async (repoPath: string, name: string) =>
  (await spawnAsync("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`], cleanEnv(), 15_000)).exitCode === 0;

/** Polls until `file` exists (a pane writes it with a final mv), or a timeout; returns its text ("" when it never came). */
async function fileFrom(file: string, timeoutMs: number): Promise<string> {
  for (const until = runClock.now() + timeoutMs; runClock.now() < until; await Bun.sleep(500)) if (existsSync(file)) return readFileSync(file, "utf8");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/**
 * api's AGENTS.md asks for CHANGELOG.md, which no ticket lists: the worker must not commit it (it may block instead).
 * If a ticket lists it after all, the premise is not met: an inconclusive note, not a failed check.
 */
async function edgeOutOfTicket(h: H): Promise<void> {
  await mainIdle(h); // main's pane has answered the trust dialog for the scratch root
  const thread = await newTaskThread(h, "Add slugify", "slugify", `${WS_TASK} ${NOT_IN_TICKET_LINE} ${DECIDE}`);
  const got = await answeringWaits(
    h,
    [thread],
    (all) => {
      const o = outOfTicketOutcome(all, thread);
      return o?.outcome ? o : undefined;
    },
    h.left() - 60_000,
    "the api slugify ticket reviewed or blocked",
  );
  h.note(`the slugify ticket ${got.ticket} ended ${got.outcome}${got.detail ? `: ${got.detail}` : ""}`);
  const all = await h.events();
  const tickets = all.filter((e): e is EventOf<"ticket.created"> => e.type === "ticket.created" && e.thread === thread).map((e) => e.payload);
  const listing = tickets.filter((t) => t.files?.includes("CHANGELOG.md")).map((t) => t.ticket);
  if (listing.length) h.note(`inconclusive (premise not met): ticket ${listing.join(",")} lists CHANGELOG.md, so committing it is in-ticket work`);
  const { task, worktrees } = await wsTask(h.root, thread);
  for (const repo of REPOS) {
    const commits = (await branchExists(join(h.root, repo), `wip/${task}`)) ? await commitsIn(join(h.root, repo), `main..wip/${task}`) : [];
    const touching = commits.filter((c) => c.files.includes("CHANGELOG.md"));
    if (!listing.length) h.check(`${repo}: no commit on wip/${task} touches CHANGELOG.md`, touching.length === 0, touching.map((c) => c.sha).join(",") || `${commits.length} commits`);
    else {
      // Without the premise, a CHANGELOG.md commit must at least stay inside its ticket.
      const stray = commitsOutsideTickets(repo, touching, tickets);
      h.check(`${repo}: commits on wip/${task} touching CHANGELOG.md stay inside a ticket`, stray.length === 0, stray.join("; ") || `${touching.length} commits`);
    }
  }
  const api = worktrees.api;
  if (api && existsSync(join(api, "CHANGELOG.md"))) h.note(`api worktree has an uncommitted CHANGELOG.md: ${(await git(api, "status", "--porcelain", "--", "CHANGELOG.md")).trim() || "unchanged"}`);
}

/** The coordinator returns the first ticket once; it is reviewed again (same live worker, or a new one) and accepted. */
async function edgeReturn(h: H): Promise<void> {
  await mainIdle(h); // main's pane has answered the trust dialog for the scratch root
  const thread = await newTaskThread(h, "Add slugify", "slugify", `${WS_TASK} ${RETURN_LINE} ${DECIDE}`);
  await reviewAnsweringWaits(h, thread);
  const all = await h.events();
  const returned = all.find((e): e is EventOf<"ticket.returned"> => e.type === "ticket.returned" && e.thread === thread);
  const first = all.find((e): e is EventOf<"ticket.created"> => e.type === "ticket.created" && e.thread === thread)?.payload.ticket;
  h.check("a ticket was returned", !!returned, returned ? `${returned.payload.ticket}: ${returned.payload.note}` : "no ticket.returned");
  if (returned) {
    const ticket = returned.payload.ticket;
    if (ticket !== first) h.note(`the returned ticket is ${ticket}; the first one created was ${first}`);
    const problems = returnProblems(all, thread, ticket);
    h.check(`${ticket}: returned, reviewed again (by its live worker or a new one), then accepted`, problems.length === 0, problems.join("; ") || "ok");
  }
  await closeThread(h, thread);
}

/**
 * No model calls: the scenario drives the CLI and git as the coordinator would (the agent marker in its env, so the
 * hooks apply the coordinator's rules). The squash commit waits for stage 8; the e2e4 stack lock for the user's approval.
 */
async function edgeStageGates(h: H): Promise<void> {
  const task = "gates-1";
  // A proposed tier that waits an hour: no tab, no coordinator.
  const thread = threadIdOf(await h.agtOk(["thread", "new", "Stage gates", "--type", "feature", "--goal", "stage gates row", "--task", task, "--tier", "low", "--reason", "stage gates row: no coordinator"]));
  await h.agtOk(["worktree", "add", thread, "api"]);
  const wt = await waitWorktree(h, thread, "api", 120_000);
  const all = await h.events();
  const s8 = latestStage(all, thread, 8);
  h.check("stage 8 is open (a browser URL is configured)", !s8, JSON.stringify(s8 ?? null));
  const coordinator = { AGT_ROLE: "coordinator", AGT_THREAD: thread, AGT_TASK: task, AGT_ROOT: h.root, AGT_AGENT_PROCESS: "1" };

  // The squash branch, made as the user; the commit is the coordinator's.
  const feat = `feat/${task}`;
  const message = "feat: add the gate note";
  await git(wt, "switch", "-q", "-c", feat);
  writeFileSync(join(wt, "gate.txt"), "stage gate\n");
  await git(wt, "add", "gate.txt");
  const commit = () => spawnAsync("git", ["-C", wt, "commit", "-q", "-m", message], cleanEnv(coordinator), 30_000);
  const refused = await commit();
  h.check(`a coordinator commit on ${feat} is refused before stage 8`, refused.exitCode !== 0 && /stage 8/.test(refused.stderr), refused.stderr.trim() || `exit ${refused.exitCode}`);
  await h.agtOk(["stage", thread, "8", "na", "--reason", "test"], coordinator);
  // The hook reads the stage8 file the daemon renders after the event.
  const created = all.find((e): e is EventOf<"thread.created"> => e.type === "thread.created" && e.thread === thread)!;
  const gate = join(paths(h.root).threadDir({ id: thread, slug: created.payload.slug }), "stage8");
  const gateText = await fileFrom(gate, 20_000);
  h.check("agt wrote the stage8 file", gateText.trim() === "na", `${gate}: ${gateText.trim() || "missing"}`);
  const passed = await commit();
  h.check(`the coordinator commit on ${feat} passes after agt stage 8 na`, passed.exitCode === 0, passed.stderr.trim() || "committed");
  const subject = (await git(wt, "log", "-1", "--format=%s", feat).catch(() => "")).trim();
  h.check(`${feat} has the commit`, subject === message, subject || "none");

  const e2e4 = () => h.agt(["stack", "acquire", thread, "--for", "e2e4"], coordinator);
  const early = await e2e4();
  h.check("stack acquire --for e2e4 is rejected before the stage 7 approval", early.exitCode !== 0 && /approval/.test(early.stderr), early.stderr.trim() || early.stdout.trim());
  h.check("no stack.acquired before the approval", !(await h.events()).some((e) => e.type === "stack.acquired" && e.thread === thread));
  await h.agtOk(["stage", thread, "7", "approve", "--by", "user"]);
  const late = await e2e4();
  h.check("stack acquire --for e2e4 succeeds after agt stage 7 approve --by user", late.exitCode === 0, late.stderr.trim() || late.stdout.trim());
  const acquired = await h.waitFor("stack.acquired", (e) => e.thread === thread && e.payload.purpose === "e2e4", 30_000, "stack.acquired for e2e4").catch(() => undefined);
  h.check("stack.acquired with purpose e2e4", !!acquired, acquired ? `seq ${acquired.seq}` : "none");
  await h.agtOk(["stack", "release", thread], coordinator);
  const sessions = (await h.events()).filter((e) => e.type === "session.created" && e.thread === thread);
  h.check("no session started (no model calls)", sessions.length === 0, `${sessions.length}`);
}

/** Two threads whose coordinators each restart the stack: the lock serializes them. */
async function stackLock(h: H): Promise<void> {
  await mainIdle(h); // main's pane has answered the trust dialog for the scratch root
  const tasks = ["slugify", "capitalize"];
  const a = await newTaskThread(h, "Add slugify", tasks[0]!, `${WS_TASK} ${RESTART_LINE} ${DECIDE}`);
  const b = await newTaskThread(h, "Add capitalize", tasks[1]!, `${WS_TASK_B} ${RESTART_LINE} ${DECIDE}`);
  const log = join(h.root, ".stack.log");
  const read = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  const holders = (all: StoredEvent[]) => new Set(all.filter((e): e is EventOf<"stack.acquired"> => e.type === "stack.acquired").map((e) => e.payload.thread));
  const restarted = (t: string) => new RegExp(`^${t} \\d+$`, "m").test(read());
  await answeringWaits(h, [a, b], (all) => (holders(all).has(a) && holders(all).has(b) && tasks.every(restarted)) || undefined, h.left() - 60_000, "both threads acquire the stack and restart it").catch(
    (e) => h.note(String(e)), // the checks below say what is missing
  );
  await Bun.sleep((RESTART_SECONDS + 1) * 1_000); // the last restart's sleep
  const all = await h.events();
  for (const t of [a, b]) h.check(`stack.acquired for thread ${t}`, holders(all).has(t));
  const max = maxHolders(all);
  h.check("never two stack holders at once", max <= 1, `${max}`);
  const text = read();
  h.note(`.stack.log: ${text.trim().replace(/\n/g, " | ") || "(empty)"}`);
  const problems = stackLogProblems(text, tasks);
  h.check(".stack.log: a restart per thread, not overlapping in time", problems.length === 0, problems.join("; ") || "ok");
}

/** After the happy flow, the user marks the thread done and cleans it up: worktrees and wip/<task> go, feat/<task> stays. */
async function wsCleanup(h: H): Promise<void> {
  await mainIdle(h);
  const thread = await askForThread(h, WS_ASK_MAIN);
  await reviewAnsweringWaits(h, thread);
  const { task, worktrees } = await wsTask(h.root, thread);
  const feat = `feat/${task}`;
  for (const repo of REPOS) h.check(`${repo}: ${feat} exists before the cleanup`, await branchExists(join(h.root, repo), feat));
  await closeThread(h, thread); // agt thread status <id> done, as the user
  await h.agtOk(["thread", "cleanup", thread]);
  const end = await h.waitFor(["thread.cleaned", "thread.cleanup_failed"], (e) => e.thread === thread, 180_000, "the cleanup finished");
  h.check("thread.cleaned", end.type === "thread.cleaned" && REPOS.every((r) => end.type === "thread.cleaned" && end.payload.repos.includes(r)), JSON.stringify(end.payload));
  for (const repo of REPOS) {
    const path = worktrees[repo];
    h.check(`${repo}: the worktree is gone`, !!path && !existsSync(path), path ?? "no worktree.added");
    h.check(`${repo}: wip/${task} deleted`, !(await branchExists(join(h.root, repo), `wip/${task}`)));
    h.check(`${repo}: ${feat} kept`, await branchExists(join(h.root, repo), feat));
  }
}

/** Processes whose cwd is `dir` or below it, with their AGT_ variables only (no other variable is kept or shown). */
async function processesUnder(dir: string): Promise<{ pid: number; command: string; vars: Record<string, string> }[]> {
  const dirs = [dir, ...(existsSync(dir) ? [realpathSync(dir)] : [])];
  const lsof = await spawnAsync("lsof", ["-a", "-d", "cwd", "-Fpn", "-u", String(process.getuid?.() ?? "")], cleanEnv(), 20_000);
  const pids = new Set<number>();
  let pid = 0;
  for (const line of lsof.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid && dirs.some((d) => line.slice(1) === d || line.slice(1).startsWith(`${d}/`))) pids.add(pid);
  }
  const out: { pid: number; command: string; vars: Record<string, string> }[] = [];
  for (const p of pids) {
    const command = (await spawnAsync("ps", ["-o", "command=", "-p", String(p)], cleanEnv(), 5_000)).stdout.trim();
    let vars: Record<string, string> = {};
    if (process.platform === "linux") {
      try {
        vars = agtVarsFromEnv(readFileSync(`/proc/${p}/environ`, "utf8"));
      } catch {}
    } else vars = agtVarsFromPs((await spawnAsync("ps", ["-E", "-ww", "-o", "command=", "-p", String(p)], cleanEnv(), 5_000)).stdout);
    if (command) out.push({ pid: p, command: command.slice(0, 100), vars });
  }
  return out;
}

/**
 * A user's shell split in the thread's tab inherits the tab's AGT_ROLE but not the agent marker, so the hooks let the
 * user commit on wip/<task>; the coordinator's own agent process has the marker. No model calls beyond main and the
 * coordinator.
 */
async function tabShell(h: H): Promise<void> {
  await mainIdle(h); // main's pane has answered the trust dialog for the scratch root
  const task = "tabshell";
  const thread = await newTaskThread(h, "Tab shell", task, TAB_SHELL_GOAL);
  await h.agtOk(["worktree", "add", thread, "api"]);
  const wt = await waitWorktree(h, thread, "api", 120_000);
  const attached = await h.waitFor("session.attached", (e, all) => sessionsOf(all, thread, "coordinator").some((c) => c.payload.session === e.payload.session), 240_000, "the coordinator attached");
  const created = (await h.events()).find((e): e is EventOf<"thread.created"> => e.type === "thread.created" && e.thread === thread)!;
  const dir = created.payload.dir ?? join(h.root, ".worktrees", task);

  // The first coordinator's agent process (its cwd is the thread directory) carries AGT_AGENT_PROCESS=1.
  const marked = (p: { vars: Record<string, string> }) => p.vars.AGT_ROLE === "coordinator" && p.vars.AGT_THREAD === thread && p.vars.AGT_AGENT_PROCESS === "1";
  let procs = await processesUnder(dir);
  for (const until = runClock.now() + 60_000; !procs.some(marked) && runClock.now() < until; procs = await processesUnder(dir)) await Bun.sleep(3_000);
  const vars = (v: Record<string, string>) => Object.entries(v).filter(([k]) => k !== "AGT_ROOT").map(([k, x]) => `${k}=${x}`).join(" ") || "no AGT_ vars";
  for (const p of procs) h.note(`process ${p.pid} in ${dir}: ${p.command} [${vars(p.vars)}]`);
  h.check("the first coordinator's agent process has AGT_AGENT_PROCESS=1", procs.some(marked), procs.filter(marked).map((p) => `${p.pid}`).join(",") || `${procs.length} processes, none marked`);

  // The user splits a pane in the thread's tab, as from the keyboard.
  const split = await h.herdr.ok(["pane", "split", attached.payload.pane, "--direction", "down", "--cwd", wt, "--no-focus"]);
  const pane: string | undefined = split?.pane?.pane_id;
  if (!pane) throw new Error(`herdr pane split gave no pane: ${JSON.stringify(split)}`);
  await Bun.sleep(1_500); // the shell's prompt
  // Every typed line starts with a space and the shell's history goes to /dev/null: nothing lands in the user's history.
  const type = (line: string) => h.herdr.ok(["pane", "run", pane, ` ${line}`]);
  await type("HISTFILE=/dev/null");
  const envFile = join(h.root, ".e2e-tabshell.env");
  const q = shellQuote;
  await type(`env | grep '^AGT_' > ${q(`${envFile}.tmp`)}; mv ${q(`${envFile}.tmp`)} ${q(envFile)}`);
  const envText = await fileFrom(envFile, 30_000);
  const shellVars = agtVarsFromEnv(envText);
  h.note(`the user's split pane ${pane}: ${existsSync(envFile) ? vars(shellVars) : "env file never written"}`);
  if (shellVars.AGT_ROLE && shellVars.AGT_THREAD) h.note(`the split shell inherited the tab env (AGT_ROLE=${shellVars.AGT_ROLE} AGT_THREAD=${shellVars.AGT_THREAD})`);
  else h.note("FLAG: marker logic not exercised — split shell did not inherit tab env");
  h.check("the user's split pane shell has no AGT_AGENT_PROCESS", existsSync(envFile) && !("AGT_AGENT_PROCESS" in shellVars), vars(shellVars));

  // The user's commit on wip/<task> from that pane passes the hooks.
  const status = join(h.root, ".e2e-tabshell.commit");
  const message = "docs: add a note from the user";
  await type(`cd ${q(wt)} && printf 'user note\\n' > USER-NOTE.md && git add USER-NOTE.md && git commit -q -m ${q(message)}; echo $? > ${q(`${status}.tmp`)}; mv ${q(`${status}.tmp`)} ${q(status)}`);
  const code = (await fileFrom(status, 30_000)).trim();
  const subject = (await git(join(h.root, "api"), "log", "-1", "--format=%s", `wip/${task}`).catch(() => "")).trim();
  h.check(`the user's commit on wip/${task} from the split pane succeeds`, code === "0" && subject === message, `exit ${code || "?"}, head: ${subject || "none"}`);
}

const happy = (id: string, agents: RoleAgents): Scenario => ({ id, agents, workspace: true, config: { agents: tiers(agents) }, run: wsHappy });

/**
 * Workspace rows (Plan 13): a no-model smoke of task worktrees, then the happy feature flow with Claude Code
 * everywhere and with each other agent as worker (coordinator on Claude Code), minus duplicates; then the edges, the
 * stack lock, the cleanup and a user's shell in a thread tab, all on Claude Code. The rows that run a whole thread need
 * `--timeout 40m` (docs/release-e2e.md).
 */
export function workspaceScenarios(): Scenario[] {
  const cc: RoleAgents = { main: "claude-code", coordinator: "claude-code", worker: "claude-code" };
  const rows = new Map<string, Scenario>();
  rows.set("ws-smoke-worktrees", { id: "ws-smoke-worktrees", agents: cc, workspace: true, manager: false, config: { agents: tiers(cc, "1h") }, run: smokeWorktrees });
  rows.set("ws-stack-runner", { id: "ws-stack-runner", agents: cc, workspace: true, manager: false, config: { agents: tiers(cc, "1h") }, run: stackRunner });
  const key = (a: RoleAgents) => `${a.main}/${a.coordinator}/${a.worker}`;
  const add = (id: string, agents: RoleAgents) => {
    if (![...rows.values()].filter((s) => s.id.startsWith("ws-happy-")).some((s) => key(s.agents) === key(agents))) rows.set(id, happy(id, agents));
  };
  add("ws-happy-claude-code", cc);
  for (const w of AGENT_KINDS as readonly AgentKind[]) add(`ws-happy-worker-${w}`, { ...cc, worker: w });
  // The user creates these threads, so the task text reaches the coordinator as written. Main still runs: its pane
  // answers Claude Code's trust dialog for the scratch root (thread dirs and worktrees under it inherit the trust), so
  // each run waits for main to go idle first. Only the rows without agents pass `manager: false`.
  const asUser = (id: string, run: (h: H) => Promise<void>, extra: Partial<Scenario> = {}, agents: RoleAgents = cc): Scenario => ({ id, agents, workspace: true, config: { agents: tiers(agents) }, run, ...extra });
  const ocWorker: RoleAgents = { ...cc, worker: "opencode" };
  for (const s of [
    asUser("ws-edge-out-of-ticket", edgeOutOfTicket, { wsHints: { api: [OUT_OF_TICKET_HINT] } }),
    asUser("ws-edge-return", edgeReturn),
    // The same flows with an OpenCode worker (needs AGT_E2E_MODEL_OPENCODE); listed only when --agents has opencode.
    asUser("ws-edge-out-of-ticket-worker-opencode", edgeOutOfTicket, { wsHints: { api: [OUT_OF_TICKET_HINT] } }, ocWorker),
    asUser("ws-edge-return-worker-opencode", edgeReturn, {}, ocWorker),
    // A browser URL, so stage 8 is not na by agt and its gate can be exercised; the tier waits an hour (no coordinator).
    asUser("ws-edge-stage-gates", edgeStageGates, { manager: false, config: { agents: tiers(cc, "1h"), workflow: { browser: { urls: ["http://localhost:5173"] } } } }),
    asUser("ws-stack-lock", stackLock),
    { id: "ws-cleanup", agents: cc, workspace: true, config: { agents: tiers(cc) }, run: wsCleanup } satisfies Scenario,
    asUser("ws-tab-shell", tabShell),
  ])
    rows.set(s.id, s);
  return [...rows.values()];
}
