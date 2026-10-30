import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StoredEvent } from "../../../src/domain/types.ts";
import type { RunResult } from "../../../src/herdr/bridge.ts";
import { paths } from "../../../src/project/paths.ts";
import { git, isSymlinkTo, runFor, type EventOf, type Herdr, type HerdrServer, type RoleAgents } from "../harness.ts";

/** What a scenario's run() gets. Assertions go through check(); a thrown error fails the row too. */
export interface H {
  id: string;
  root: string;
  agents: RoleAgents;
  herdr: Herdr;
  server: HerdrServer;
  workspace: string;
  /** The pane `agt start` runs in: main's pane when the scenario has a manager. */
  mainPane: string;
  deadline: number;
  agt(args: string[], env?: Record<string, string>): Promise<RunResult>;
  /** agt that must exit 0; returns stdout. */
  agtOk(args: string[], env?: Record<string, string>): Promise<string>;
  events(): Promise<StoredEvent[]>;
  waitFor<T extends StoredEvent["type"]>(type: T | readonly T[], pred?: (e: EventOf<T>, all: StoredEvent[]) => boolean, timeoutMs?: number, what?: string): Promise<EventOf<T>>;
  /** Types into main's pane as the user. */
  say(text: string): Promise<void>;
  /** Stops the isolated Herdr server and starts it again under the same session (panes and agents are gone). */
  restartHerdr(): Promise<void>;
  /** Runs `agt start` (again) in the main pane, e.g. after a Herdr restart; resolves when the command was sent. */
  startAgt(args?: string[], env?: Record<string, string>): Promise<void>;
  check(name: string, ok: boolean, detail?: string): void;
  note(m: string): void;
  /** Milliseconds left before the scenario's timeout. */
  left(): number;
}

export interface Scenario {
  id: string;
  agents: RoleAgents;
  /** Run main (default) or `agt start --no-manager`. */
  manager?: boolean;
  /** A fixed scratch root instead of a new temp dir (only MIXED_MAIN_ROOT, which the user trusts once for Claude Code). */
  scratchAt?: string;
  /** Lines appended to the scratch repo's AGENTS.md. */
  hints?: string[];
  /** Merged into .agentthread/config.yaml. */
  config?: Record<string, any>;
  /** Env for `agt start` in the pane; the daemon it starts inherits it. */
  startEnv?: Record<string, string>;
  run(h: H): Promise<void>;
}

export const TASK_TITLE = "Add slugify";
export const TASK =
  "Add a slugify(s) function to this project: it lowercases the text, replaces every run of characters that are not a-z or 0-9 with a single '-', and trims '-' from both ends. " +
  "Add unit tests for it, and add a line for it to the README's Functions list. Follow the conventions in AGENTS.md.";
export const GOAL = "slugify(s) exists in src/slugify.ts, is exported from src/index.ts, has unit tests in tests/slugify.test.ts, and is listed in README.md";

/** The request to main: the task, with the confirmation given up front so main can create the thread right away. */
export const ASK_MAIN = `${TASK} You have my confirmation already: draft the title, goal and acceptance criteria and create the thread right away without asking me again.`;

/** Two complexity tiers on the coordinator's agent, so whichever main picks, the row's coordinator is unchanged. */
export function tiers(agents: RoleAgents, timeout = "5s") {
  const low = lowEffort(agents.coordinator);
  return { complexity: { timeout, tiers: { low: { ...runFor(agents.coordinator), ...(low ? { effort: low } : {}) }, high: runFor(agents.coordinator) } } };
}

/** An effort every agent accepts for "low" (OpenCode variants are provider-defined, so none is set). */
function lowEffort(agent: RoleAgents["coordinator"]): string | undefined {
  return agent === "opencode" ? undefined : "low";
}

export const sessionsOf = (all: StoredEvent[], thread: string, role: "coordinator" | "worker") =>
  all.filter((e): e is EventOf<"session.created"> => e.type === "session.created" && e.thread === thread && e.payload.role === role);

export const mainSession = (all: StoredEvent[]) =>
  all.filter((e): e is EventOf<"session.created"> => e.type === "session.created" && e.payload.role === "main").at(-1)?.payload.session;

/** Waits until main has finished its current turn (its first one is the role prompt). */
export async function mainIdle(h: H, timeoutMs = 300_000): Promise<void> {
  const all = await h.events();
  const m = mainSession(all);
  if (!m) throw new Error("no main session");
  const after = all.at(-1)?.seq ?? 0;
  const already = all.filter((e) => "session" in (e.payload as object) && (e.payload as { session?: string }).session === m).at(-1);
  if (already?.type === "agent.idle") return;
  await h.waitFor("agent.idle", (e) => e.payload.session === m && e.seq > Math.min(after, already?.seq ?? after), timeoutMs, "main idle");
}

/**
 * Asks main for the slugify thread and waits for thread.created; if main ends its turn without creating it (it asked
 * for a confirmation after all), confirms up to twice. Returns the thread id.
 */
export async function askForThread(h: H, ask = ASK_MAIN): Promise<string> {
  const before = (await h.events()).at(-1)?.seq ?? 0;
  await h.say(ask);
  for (let nudge = 0; ; nudge++) {
    try {
      const created = await h.waitFor("thread.created", (e) => e.seq > before, 240_000, "main creates the thread");
      return created.thread;
    } catch (e) {
      if (nudge >= 2) throw e;
      h.note(`main had not created the thread; confirmation #${nudge + 1} sent`);
      await mainIdle(h, 120_000);
      await h.say("Yes, I confirm. Please create the thread now.");
    }
  }
}

/** Waits for the thread to reach review, then runs the artifact checks of a finished slugify thread. */
export async function finishAndVerify(h: H, thread: string, o: { coordinator: string; worker: string; reviewTimeoutMs?: number }): Promise<void> {
  await h.waitFor("thread.status_changed", (e) => e.thread === thread && e.payload.to === "review", o.reviewTimeoutMs ?? h.left() - 60_000, `thread ${thread} in review`);
  await verifyThread(h, thread, o);
}

export async function verifyThread(h: H, thread: string, o: { coordinator: string; worker: string }): Promise<void> {
  const all = await h.events();
  const created = all.find((e): e is EventOf<"thread.created"> => e.type === "thread.created" && e.thread === thread)!;
  const { branch, worktree, slug } = created.payload;

  const coords = sessionsOf(all, thread, "coordinator");
  h.check("coordinator runs the row's agent", coords.length > 0 && coords.every((c) => c.payload.agent === o.coordinator), coords.map((c) => c.payload.agent).join(","));
  const workers = sessionsOf(all, thread, "worker");
  h.check("workers run the row's agent", workers.length > 0 && workers.every((w) => w.payload.agent === o.worker), workers.map((w) => w.payload.agent).join(",") || "no workers");

  const tickets = all.filter((e): e is EventOf<"ticket.created"> => e.type === "ticket.created" && e.thread === thread).map((e) => e.payload.ticket);
  const done = new Set(all.filter((e): e is EventOf<"ticket.completed"> => e.type === "ticket.completed" && e.thread === thread).map((e) => e.payload.ticket));
  h.check("tickets were created", tickets.length > 0, `${tickets.length}`);
  if (tickets.length < 2 || tickets.length > 3) h.note(`thread ${thread}: ${tickets.length} tickets (the fixture usually splits into 2-3)`);
  h.check("every ticket is done", tickets.every((t) => done.has(t)), tickets.filter((t) => !done.has(t)).join(",") || "all done");

  const brief = join(paths(h.root).threadDir({ id: thread, slug }), "brief.md");
  h.check("brief.md exists", existsSync(brief) && statSync(brief).size > 0, brief);

  h.check("AGENTS.md in the worktree", existsSync(join(worktree, "AGENTS.md")) && readFileSync(join(worktree, "AGENTS.md"), "utf8").includes("# AgentThread"));
  h.check("CLAUDE.md links to AGENTS.md", isSymlinkTo(join(worktree, "CLAUDE.md"), "AGENTS.md"));
  const status = await git(worktree, "status", "--porcelain");
  h.check("AGENTS.md/CLAUDE.md absent from git status", !/AGENTS\.md|CLAUDE\.md/.test(status), status.trim() || "clean");

  const commits = Number((await git(h.root, "rev-list", "--count", `main..${branch}`)).trim());
  h.check("commits on the thread branch", commits > 0, `${commits}`);
  const changed = (await git(h.root, "diff", "--name-only", `main...${branch}`)).split("\n").filter(Boolean);
  h.check("the branch adds slugify and its README line", changed.includes("README.md") && changed.some((f) => /slugify/.test(f)), changed.join(","));
  h.check("AGENTS.md/CLAUDE.md never committed", !changed.includes("CLAUDE.md") && !(await git(h.root, "diff", `main...${branch}`, "--", "AGENTS.md")).trim());

  const stalls = all.filter((e) => e.type === "session.stalled" && e.thread === thread);
  h.check("no session reported stalled in a healthy run", stalls.length === 0, stalls.map((e) => JSON.stringify(e.payload)).join(",") || "none");

  // Worker panes are closed once their ticket is done.
  const panes = await h.herdr.panes();
  const workerPanes = all
    .filter((e): e is EventOf<"session.attached"> => e.type === "session.attached" && workers.some((w) => w.payload.session === e.payload.session))
    .map((e) => e.payload.pane);
  h.check("worker panes opened", workerPanes.length > 0, workerPanes.join(","));
  h.check("worker panes closed", workerPanes.every((p) => !panes.includes(p)), workerPanes.filter((p) => panes.includes(p)).join(",") || "all closed");
}

/** Marks the thread done as the user and checks that its tab and coordinator pane close. */
export async function closeThread(h: H, thread: string): Promise<void> {
  const all = await h.events();
  const tab = all.filter((e): e is EventOf<"thread.tab_opened"> => e.type === "thread.tab_opened" && e.thread === thread).at(-1)?.payload.tab;
  await h.agtOk(["thread", "status", thread, "done"]);
  await h.waitFor("thread.tab_closed", (e) => e.thread === thread, 60_000, "tab closed on done");
  if (tab) h.check("thread tab closed in Herdr", (await h.herdr.run(["tab", "get", tab])).error?.code === "tab_not_found", tab);
  const live = new Set((await h.herdr.agents()).map((a) => a.pane_id));
  const threadPanes = (await h.events())
    .filter((e): e is EventOf<"session.attached"> => e.type === "session.attached" && e.thread === thread)
    .map((e) => e.payload.pane);
  h.check("no agent left in the thread's panes", threadPanes.every((p) => !live.has(p)), threadPanes.filter((p) => live.has(p)).join(",") || "none");
}

/** The happy flow: main is asked, proposes a tier that auto-accepts, the thread finishes and is closed. */
export async function happyFlow(h: H): Promise<void> {
  await mainIdle(h);
  const thread = await askForThread(h);
  const proposed = await h.waitFor("thread.tier_proposed", (e) => e.thread === thread, 120_000, "tier proposed");
  const chosen = await h.waitFor("thread.tier_chosen", (e) => e.thread === thread, 120_000, "tier chosen");
  h.check("the proposed tier auto-accepts", chosen.payload.auto && chosen.payload.tier === proposed.payload.tier, JSON.stringify(chosen.payload));
  await h.waitFor("notice.queued", (e, all) => e.payload.session === mainSession(all) && e.payload.text.startsWith(`Thread ${thread} started with tier `), 60_000, "main told of the auto-accept");
  await finishAndVerify(h, thread, { coordinator: h.agents.coordinator, worker: h.agents.worker });
  await closeThread(h, thread);
}

/** Creates the slugify thread directly as the user (scenarios that do not exercise main). */
export async function newThread(h: H, extra: string[] = []): Promise<string> {
  const out = await h.agtOk(["thread", "new", TASK_TITLE, "--type", "feature", "--goal", `${TASK} ${GOAL}`, "--criteria", "bun test passes", ...extra]);
  const id = /"thread":"(\d+)"/.exec(out)?.[1];
  if (!id) throw new Error(`cannot read the thread id from: ${out}`);
  return id;
}

/** The coordinator session currently acting for `thread` (latest attached, not ended/lost/rotated/failed). */
export function actingCoordinator(all: StoredEvent[], thread: string): { session: string; pane?: string } | undefined {
  const gone = new Set(
    all
      .filter((e) => ["session.ended", "session.lost", "session.rotated", "session.failed"].includes(e.type))
      .map((e) => (e.payload as { session: string }).session),
  );
  const c = sessionsOf(all, thread, "coordinator").filter((s) => !gone.has(s.payload.session)).at(-1);
  if (!c) return undefined;
  const pane = all.filter((e): e is EventOf<"session.attached"> => e.type === "session.attached" && e.payload.session === c.payload.session).at(-1)?.payload.pane;
  return { session: c.payload.session, ...(pane ? { pane } : {}) };
}
