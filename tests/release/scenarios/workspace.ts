import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AGENT_KINDS, type AgentKind, type StoredEvent } from "../../../src/domain/types.ts";
import { spawnAsync } from "../../../src/herdr/bridge.ts";
import { paths } from "../../../src/project/paths.ts";
import { assertInScratchBase, cleanEnv, git, isSymlinkTo, say, type EventOf, type RoleAgents } from "../harness.ts";
import { actingCoordinator, askForThread, closeThread, mainIdle, sessionsOf, tiers, type H, type Scenario } from "./common.ts";

/** The shared workspace task (plan Global Constraints, verbatim). */
export const WS_TASK =
  "Add a `slugify(s)` function to api (`src/slugify.ts`, unit tests) and use it in web to display a slug of the title (`src/title.ts`, unit tests). Use the source branch `main`; do not ask me about it.";

/** The request to main: the task, with the confirmation given up front and the details left to the agents. */
export const WS_ASK_MAIN =
  `${WS_TASK} You have my confirmation already: create the thread without asking me to confirm it. ` +
  "Decide details yourself with your recommendations; only stop for me if something is truly blocked.";

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

const latestStage = (all: StoredEvent[], thread: string, stage: number) =>
  all.filter((e): e is EventOf<"stage.recorded"> => e.type === "stage.recorded" && e.thread === thread && e.payload.stage === stage).at(-1)?.payload;

/** Reads brief.md until it has `want`, or a timeout; returns the last text read ("" when it never existed). */
async function briefWith(file: string, want: RegExp[], timeoutMs: number): Promise<string> {
  let text = "";
  for (const until = Date.now() + timeoutMs; ; ) {
    text = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (want.every((w) => w.test(text)) || Date.now() >= until) return text;
    await Bun.sleep(500);
  }
}

/** No model calls: the user does what the coordinator would (thread with a task name, a worktree per repo). */
async function smokeWorktrees(h: H): Promise<void> {
  const task = "kyc-1";
  // A proposed tier that waits an hour: the thread gets no tab and no coordinator, so nothing calls a model.
  const out = await h.agtOk(["thread", "new", "KYC smoke", "--type", "feature", "--goal", "workspace worktrees smoke", "--task", task, "--tier", "low", "--reason", "smoke row: no coordinator"]);
  const thread = /"thread":"(\d+)"/.exec(out)?.[1];
  if (!thread) throw new Error(`cannot read the thread id from: ${out}`);
  for (const repo of REPOS) await h.agtOk(["worktree", "add", thread, repo]);
  for (const repo of REPOS) await h.waitFor("worktree.added", (e) => e.thread === thread && e.payload.repo === repo, 120_000, `worktree for ${repo}`);

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

/** Main is asked for the workspace task; the thread runs to review, then the event log and git are checked. */
async function wsHappy(h: H): Promise<void> {
  await mainIdle(h);
  const thread = await askForThread(h, WS_ASK_MAIN);
  await reviewAnsweringWaits(h, thread);
  await verifyWsThread(h, thread);
  await closeThread(h, thread);
}

/**
 * Waits for the thread to reach review, keeping AFTER_REVIEW_MS for the checks. Each thread.waiting on the way is
 * answered as the user would: typed into the acting coordinator's pane (the coordinator talks to the user there).
 */
async function reviewAnsweringWaits(h: H, thread: string): Promise<void> {
  let after = 0;
  for (;;) {
    const e = await h.waitFor(
      ["thread.waiting", "thread.status_changed"],
      (e) => e.thread === thread && e.seq > after && (e.type === "thread.waiting" || e.payload.to === "review"),
      h.left() - AFTER_REVIEW_MS,
      `thread ${thread} in review`,
    );
    after = e.seq;
    if (e.type === "thread.status_changed") return;
    const all = await h.events();
    // Already past it: a wait that was followed by review needs no answer.
    if (all.some((x) => x.type === "thread.status_changed" && x.thread === thread && x.seq > e.seq && x.payload.to === "review")) continue;
    const c = actingCoordinator(all, thread);
    if (!c?.pane) {
      h.note(`thread ${thread} waits (${e.payload.what}) but has no coordinator pane to answer in`);
      continue;
    }
    await say(h.herdr, c.pane, WAITING_ANSWER);
    h.note(`thread ${thread} waited for the user (${e.payload.what}); answered in coordinator pane ${c.pane}`);
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

  const s7 = latestStage(all, thread, 7);
  h.check("stage 7 na by agt (no e2e commands in config)", s7?.state === "na" && s7.by === "agt", JSON.stringify(s7 ?? null));
  const s8 = latestStage(all, thread, 8);
  h.check("stage 8 na by agt (no browser in config)", s8?.state === "na" && s8.by === "agt", JSON.stringify(s8 ?? null));
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

const happy = (id: string, agents: RoleAgents): Scenario => ({ id, agents, workspace: true, config: { agents: tiers(agents) }, run: wsHappy });

/**
 * Workspace rows (Plan 13): a no-model smoke of task worktrees, then the happy feature flow with Claude Code
 * everywhere and with each other agent as worker (coordinator on Claude Code), minus duplicates. The happy rows need
 * `--timeout 40m` (docs/release-e2e.md).
 */
export function workspaceScenarios(): Scenario[] {
  const cc: RoleAgents = { main: "claude-code", coordinator: "claude-code", worker: "claude-code" };
  const rows = new Map<string, Scenario>();
  rows.set("ws-smoke-worktrees", { id: "ws-smoke-worktrees", agents: cc, workspace: true, manager: false, config: { agents: tiers(cc, "1h") }, run: smokeWorktrees });
  const key = (a: RoleAgents) => `${a.main}/${a.coordinator}/${a.worker}`;
  const add = (id: string, agents: RoleAgents) => {
    if (![...rows.values()].filter((s) => s.id.startsWith("ws-happy-")).some((s) => key(s.agents) === key(agents))) rows.set(id, happy(id, agents));
  };
  add("ws-happy-claude-code", cc);
  for (const w of AGENT_KINDS as readonly AgentKind[]) add(`ws-happy-worker-${w}`, { ...cc, worker: w });
  return [...rows.values()];
}
