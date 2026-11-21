import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle, type HandleResult } from "../../src/commands/handler.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import { ConfigSchema } from "../../src/config/config.ts";
import { request } from "../../src/daemon/client.ts";
import { startDaemon, type Daemon } from "../../src/daemon/server.ts";
import type { Actor, StoredEvent } from "../../src/domain/types.ts";
import { systemPrompt } from "../../src/agents/prompts.ts";
import { initProject } from "../../src/project/init.ts";
import { paths } from "../../src/project/paths.ts";
import { project, type State } from "../../src/state/projection.ts";
import { EventStore } from "../../src/store/event-store.ts";
import { INIT, USER, isolatedConfigHome, stateOf, taskThreadCreated, threadCreated } from "../helpers.ts";

const COORD: Actor = { role: "coordinator", thread: "001", session: "c1" };
const MAIN_SESSION = "00000000-0000-4000-8000-000000000001";
const MAIN: Actor = { role: "main", session: MAIN_SESSION };

const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};
const branchExists = (repo: string, branch: string) => sh(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).ok;

/** A workspace folder holding the repos `api` and `web`, each with one commit on main and a feat/kyc-1 branch. */
function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agt-ws-")));
  for (const name of ["api", "web"]) {
    const dir = join(root, name);
    mkdirSync(dir);
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
    sh(dir, "branch", "feat/kyc-1");
  }
  initProject(root, "demo");
  writeFileSync(join(root, ".agentthread", "config.yaml"), ["workspace:", "  repos:", "    api: { path: api }", "    web: { path: web }", ""].join("\n"));
  return root;
}

describe("thread.cleanup in the handler", () => {
  const config = ConfigSchema.parse({ workspace: { repos: { api: { path: "api" }, web: { path: "web" } } } });
  const run = (state: State, cmd: unknown, actor: Actor = USER): HandleResult => handle(state, CommandSchema.parse(cmd), actor, { root: "/repo", config });
  const errorOf = (r: HandleResult) => (r.ok ? "accepted" : r.error);
  const added = (repo: string) => ({ type: "worktree.added", thread: "001", payload: { repo, path: `/repo/.worktrees/kyc-1/${repo}`, branch: "wip/kyc-1", source: "main" } }) as const;

  test("a done task thread: cleanup is requested with every worktree and its repo", () => {
    const s = stateOf(INIT, taskThreadCreated("001", "kyc-1", { status: "done" }), added("api"), added("web"));
    const r = run(s, { cmd: "thread.cleanup", thread: "001" }, { role: "main" });
    if (!r.ok) throw new Error(r.error);
    expect(r.events).toEqual([{ type: "thread.cleanup_requested", thread: "001", payload: {} }]);
    expect(r.effects).toEqual([
      {
        kind: "git.thread.cleanup",
        thread: "001",
        task: "kyc-1",
        squashBranch: "feat/kyc-1",
        dir: "/repo/.worktrees/kyc-1",
        repos: [
          { repo: "api", repoPath: "/repo/api", path: "/repo/.worktrees/kyc-1/api" },
          { repo: "web", repoPath: "/repo/web", path: "/repo/.worktrees/kyc-1/web" },
        ],
      },
    ]);
  });

  test("a thread that is not done is rejected", () => {
    const s = stateOf(INIT, taskThreadCreated("001", "kyc-1"), added("api"));
    expect(errorOf(run(s, { cmd: "thread.cleanup", thread: "001" }))).toBe("cleanup needs thread 001 to be done; the user says when it is merged");
  });

  test("a legacy thread is rejected", () => {
    const s = stateOf(INIT, threadCreated("002", { status: "done" }));
    expect(errorOf(run(s, { cmd: "thread.cleanup", thread: "002" }))).toBe("legacy threads keep their worktree; remove it by hand");
  });

  test("a worker or a coordinator cannot run it", () => {
    const s = stateOf(INIT, taskThreadCreated("001", "kyc-1", { status: "done" }), added("api"));
    expect(errorOf(run(s, { cmd: "thread.cleanup", thread: "001" }, { role: "worker", thread: "001", session: "w1", ticket: "T1" }))).toBe("role worker may not run thread.cleanup");
    expect(errorOf(run(s, { cmd: "thread.cleanup", thread: "001" }, COORD))).toBe("role coordinator may not run thread.cleanup");
  });

  test("a second cleanup while one runs is rejected; only the daemon reports", () => {
    const s = stateOf(INIT, taskThreadCreated("001", "kyc-1", { status: "done" }), added("api"), { type: "thread.cleanup_requested", thread: "001", payload: {} });
    expect(errorOf(run(s, { cmd: "thread.cleanup", thread: "001" }))).toBe("cleanup of thread 001 is already running");
    expect(errorOf(run(s, { cmd: "thread.cleanup_report", thread: "001", ok: true, repos: ["api"] }, { role: "main" }))).toBe("role main may not run thread.cleanup_report");
  });

  test("while a cleanup runs, thread status changes and worktree adds are rejected", () => {
    const s = stateOf(INIT, taskThreadCreated("001", "kyc-1", { status: "done" }), added("api"), { type: "thread.cleanup_requested", thread: "001", payload: {} });
    expect(errorOf(run(s, { cmd: "thread.status", thread: "001", status: "in_progress" }))).toBe("cleanup of thread 001 is running");
    expect(errorOf(run(s, { cmd: "thread.cancel", thread: "001" }))).toBe("cleanup of thread 001 is running");
    expect(errorOf(run(s, { cmd: "worktree.add", thread: "001", repo: "web", from: "main" }, COORD))).toBe("cleanup of thread 001 is running");
  });

  test("a failure after some repos were removed drops those repos from the thread's worktrees", () => {
    const s = stateOf(INIT, taskThreadCreated("001", "kyc-1", { status: "done" }), added("api"), added("web"), { type: "thread.cleanup_requested", thread: "001", payload: {} });
    const r = run(s, { cmd: "thread.cleanup_report", thread: "001", ok: false, repo: "web", error: "git branch -D wip/kyc-1 failed: x (already removed: api)", removed: ["api"] });
    if (!r.ok) throw new Error(r.error);
    expect(r.events[0]).toEqual({ type: "thread.cleanup_failed", thread: "001", payload: { repo: "web", reason: "git branch -D wip/kyc-1 failed: x (already removed: api)", removed: ["api"] } });
    const after = stateOf(INIT, taskThreadCreated("001", "kyc-1", { status: "done" }), added("api"), added("web"), { type: "thread.cleanup_requested", thread: "001", payload: {} }, r.events[0]!);
    expect(Object.keys(after.threads.get("001")!.worktrees)).toEqual(["web"]);
    expect(after.threads.get("001")!.cleanupRequested).toBeUndefined();
  });

  test("the outcome without a pending request is ignored", () => {
    const s = stateOf(INIT, taskThreadCreated("001", "kyc-1", { status: "done" }), added("api"));
    expect(run(s, { cmd: "thread.cleanup_report", thread: "001", ok: true, repos: ["api"] })).toMatchObject({ ok: true, events: [] });
  });
});

describe("agt thread cleanup through the daemon (real git)", () => {
  let daemon: Daemon | undefined;
  const savedXdg = process.env.XDG_CONFIG_HOME;
  beforeAll(() => {
    process.env.XDG_CONFIG_HOME = isolatedConfigHome();
  });
  afterAll(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
  });

  async function start(root: string) {
    daemon = await startDaemon(root, { log: () => {} });
    const cmd = (command: object, actor: Actor = USER) => request(paths(root).socket, { op: "command", command, actor });
    const events = async () => {
      const r = await request(paths(root).socket, { op: "events.since", seq: 0 });
      return r.ok ? (r.result as StoredEvent[]) : [];
    };
    const waitFor = async (pred: (e: StoredEvent[]) => boolean, timeoutMs = 10_000) => {
      for (const until = Date.now() + timeoutMs; Date.now() < until; await Bun.sleep(50)) if (pred(await events())) return;
      throw new Error("timed out");
    };
    return { cmd, events, waitFor };
  }

  /** A done task thread kyc-1 with worktrees for api and web made by agt (generated files, excludes, guard), and a main session. */
  async function doneThread(root: string, type: "feature" | "bug" | "chore" = "feature") {
    const d = await start(root);
    expect(await d.cmd({ cmd: "session.open_main", session: MAIN_SESSION, pane: "p-main" })).toMatchObject({ ok: true });
    expect(await d.cmd({ cmd: "thread.new", title: "KYC", type, task: "kyc-1" })).toMatchObject({ ok: true });
    for (const repo of ["api", "web"]) expect(await d.cmd({ cmd: "worktree.add", thread: "001", repo, from: "main" }, COORD)).toMatchObject({ ok: true });
    await d.waitFor((e) => e.filter((x) => x.type === "worktree.added").length === 2);
    for (const status of ["in_progress", "review", "done"]) expect(await d.cmd({ cmd: "thread.status", thread: "001", status })).toMatchObject({ ok: true });
    const dir = join(root, ".worktrees", "kyc-1");
    expect(existsSync(join(dir, "api", "AGENTS.md"))).toBe(true);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
    return { ...d, dir };
  }
  const outcome = (e: StoredEvent[]) => e.some((x) => x.type === "thread.cleaned" || x.type === "thread.cleanup_failed");
  const mainNotices = (e: StoredEvent[]) => e.filter((x) => x.type === "notice.queued" && (x.payload as { session: string }).session === MAIN_SESSION).map((x) => (x.payload as { text: string }).text);

  test("two clean worktrees: both removed, wip/<task> deleted, feat/<task> kept, the thread dir removed, main told", async () => {
    const root = workspace();
    const { cmd, events, waitFor, dir } = await doneThread(root);
    expect(await cmd({ cmd: "thread.cleanup", thread: "001" }, MAIN)).toEqual({ ok: true, result: { requested: true, repos: ["api", "web"] } });
    await waitFor(outcome);
    const all = await events();
    expect(all.filter((x) => x.type === "thread.cleanup_requested").map((x) => x.payload)).toEqual([{}]);
    expect(all.filter((x) => x.type === "thread.cleaned").map((x) => x.payload)).toEqual([{ repos: ["api", "web"] }]);
    expect(mainNotices(all)).toContain("Thread 001 is cleaned up: removed the worktrees and wip/kyc-1 of api, web.");
    for (const repo of ["api", "web"]) {
      expect(existsSync(join(dir, repo))).toBe(false);
      expect(sh(join(root, repo), "worktree", "list").out).not.toContain("kyc-1");
      expect(branchExists(join(root, repo), "wip/kyc-1")).toBe(false);
      expect(branchExists(join(root, repo), "feat/kyc-1")).toBe(true);
    }
    expect(existsSync(dir)).toBe(false);
    expect(project(all).threads.get("001")!.worktrees).toEqual({});
  });

  test("an untracked file in one worktree: nothing is removed, and cleanup_failed names the repo", async () => {
    const root = workspace();
    const { cmd, events, waitFor, dir } = await doneThread(root);
    writeFileSync(join(dir, "web", "notes.txt"), "keep me\n");
    expect(await cmd({ cmd: "thread.cleanup", thread: "001" }, MAIN)).toMatchObject({ ok: true });
    await waitFor(outcome);
    const all = await events();
    expect(all.some((x) => x.type === "thread.cleaned")).toBe(false);
    expect(all.filter((x) => x.type === "thread.cleanup_failed").map((x) => x.payload)).toEqual([{ repo: "web", reason: "uncommitted changes" }]);
    expect(mainNotices(all)).toContain("Cleanup of thread 001 stopped at web: uncommitted changes");
    for (const repo of ["api", "web"]) {
      expect(existsSync(join(dir, repo, ".git"))).toBe(true);
      expect(branchExists(join(root, repo), "wip/kyc-1")).toBe(true);
    }
    expect(existsSync(join(dir, "web", "notes.txt"))).toBe(true);
    expect(project(all).threads.get("001")!.worktrees).toMatchObject({ api: {}, web: {} });
    // once the file is committed elsewhere (here: removed), a second cleanup goes through
    Bun.spawnSync(["rm", join(dir, "web", "notes.txt")]);
    expect(await cmd({ cmd: "thread.cleanup", thread: "001" })).toMatchObject({ ok: true });
    await waitFor((e) => e.some((x) => x.type === "thread.cleaned"));
    expect(existsSync(dir)).toBe(false);
  });

  test("a file of the user's own in the thread dir keeps the dir", async () => {
    const root = workspace();
    const { cmd, waitFor, dir } = await doneThread(root);
    writeFileSync(join(dir, "scratch.md"), "mine\n");
    expect(await cmd({ cmd: "thread.cleanup", thread: "001" }, MAIN)).toMatchObject({ ok: true });
    await waitFor((e) => e.some((x) => x.type === "thread.cleaned"));
    expect(existsSync(join(dir, "api"))).toBe(false);
    expect(existsSync(join(dir, "scratch.md"))).toBe(true);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
  });

  test("a failure mid-way names the repo, and the repos already removed stay listed in the reason", async () => {
    const root = workspace();
    const { cmd, events, waitFor, dir } = await doneThread(root);
    // web's wip/kyc-1 is checked out in its main checkout too, so git branch -D refuses it there
    sh(join(root, "web"), "worktree", "add", "-q", "-f", join(root, "web-other"), "wip/kyc-1");
    expect(await cmd({ cmd: "thread.cleanup", thread: "001" }, MAIN)).toMatchObject({ ok: true });
    await waitFor(outcome);
    const failed = (await events()).filter((x) => x.type === "thread.cleanup_failed").map((x) => x.payload as { repo: string; reason: string });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.repo).toBe("web");
    expect(failed[0]!.reason).toContain("already removed: api");
    expect(project(await events()).threads.get("001")!.worktrees).toEqual({ web: expect.anything() });
    expect(existsSync(join(dir, "api"))).toBe(false);
    expect(branchExists(join(root, "api"), "wip/kyc-1")).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  /** A commit on wip/kyc-1 that no other branch has (same tree, so the worktree stays clean), made without hooks. */
  const extraCommit = (repo: string) => {
    const c = sh(repo, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit-tree", "wip/kyc-1^{tree}", "-p", "wip/kyc-1", "-m", "extra").out;
    expect(sh(repo, "update-ref", "refs/heads/wip/kyc-1", c).ok).toBe(true);
  };

  test("no feat/<task> and wip/<task> has its own commits: nothing is removed", async () => {
    const root = workspace();
    const { cmd, events, waitFor, dir } = await doneThread(root);
    sh(join(root, "web"), "branch", "-D", "feat/kyc-1");
    extraCommit(join(root, "web"));
    expect(await cmd({ cmd: "thread.cleanup", thread: "001" }, MAIN)).toMatchObject({ ok: true });
    await waitFor(outcome);
    const all = await events();
    expect(all.filter((x) => x.type === "thread.cleanup_failed").map((x) => x.payload)).toEqual([{ repo: "web", reason: "wip/kyc-1 has commits that were never squashed; if it was merged another way, delete it with git branch -D wip/kyc-1 and run cleanup again" }]);
    for (const repo of ["api", "web"]) {
      expect(existsSync(join(dir, repo, ".git"))).toBe(true);
      expect(branchExists(join(root, repo), "wip/kyc-1")).toBe(true);
    }
  });

  test("no feat/<task> but wip/<task> has no commits of its own: cleaned", async () => {
    const root = workspace();
    const { cmd, waitFor, dir } = await doneThread(root);
    for (const repo of ["api", "web"]) sh(join(root, repo), "branch", "-D", "feat/kyc-1");
    expect(await cmd({ cmd: "thread.cleanup", thread: "001" }, MAIN)).toMatchObject({ ok: true });
    await waitFor((e) => e.some((x) => x.type === "thread.cleaned"));
    for (const repo of ["api", "web"]) expect(branchExists(join(root, repo), "wip/kyc-1")).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  test("a feat/<task> branch: cleaned even when wip/<task> has commits of its own", async () => {
    const root = workspace();
    const { cmd, waitFor } = await doneThread(root);
    extraCommit(join(root, "web"));
    expect(await cmd({ cmd: "thread.cleanup", thread: "001" }, MAIN)).toMatchObject({ ok: true });
    await waitFor((e) => e.some((x) => x.type === "thread.cleaned"));
    expect(branchExists(join(root, "web"), "wip/kyc-1")).toBe(false);
    expect(branchExists(join(root, "web"), "feat/kyc-1")).toBe(true);
  });

  test("a bug thread's squash branch is fix/<task>: cleaned even when wip/<task> has commits of its own", async () => {
    const root = workspace();
    const { cmd, waitFor } = await doneThread(root, "bug");
    for (const repo of ["api", "web"]) sh(join(root, repo), "branch", "-m", "feat/kyc-1", "fix/kyc-1");
    extraCommit(join(root, "web"));
    expect(await cmd({ cmd: "thread.cleanup", thread: "001" }, MAIN)).toMatchObject({ ok: true });
    await waitFor((e) => e.some((x) => x.type === "thread.cleaned"));
    expect(branchExists(join(root, "web"), "wip/kyc-1")).toBe(false);
    expect(branchExists(join(root, "web"), "fix/kyc-1")).toBe(true);
  });

  test("a bug thread without fix/<task> and with unsquashed commits is refused (feat/<task> absent too)", async () => {
    const root = workspace();
    const { cmd, waitFor } = await doneThread(root, "bug");
    sh(join(root, "web"), "branch", "-D", "feat/kyc-1");
    extraCommit(join(root, "web"));
    expect(await cmd({ cmd: "thread.cleanup", thread: "001" }, MAIN)).toMatchObject({ ok: true });
    await waitFor((e) => e.some((x) => x.type === "thread.cleanup_failed"));
    expect(branchExists(join(root, "web"), "wip/kyc-1")).toBe(true);
  });

  test("the handler hands the job the config's branch prefix for the type", () => {
    const s = stateOf(INIT, taskThreadCreated("001", "kyc-1", { status: "done", threadType: "bug" }), { type: "worktree.added", thread: "001", payload: { repo: "api", path: "/repo/.worktrees/kyc-1/api", branch: "wip/kyc-1", source: "main" } });
    const config = ConfigSchema.parse({ workspace: { repos: { api: { path: "api" } } }, workflow: { branch_prefix: { bug: "hotfix" } } });
    const r = handle(s, CommandSchema.parse({ cmd: "thread.cleanup", thread: "001" }), { role: "main" }, { root: "/repo", config });
    expect(r.ok && r.effects[0]).toMatchObject({ kind: "git.thread.cleanup", squashBranch: "hotfix/kyc-1" });
  });

  test("a worktree folder deleted by hand: only its stale entry goes, unrelated stale entries stay", async () => {
    const root = workspace();
    const { cmd, waitFor, dir } = await doneThread(root);
    const api = join(root, "api");
    const other = join(root, "api-other");
    expect(sh(api, "worktree", "add", "-q", "-b", "other", other, "main").ok).toBe(true);
    Bun.spawnSync(["rm", "-rf", other, join(dir, "api")]);
    expect(await cmd({ cmd: "thread.cleanup", thread: "001" }, MAIN)).toMatchObject({ ok: true });
    await waitFor((e) => e.some((x) => x.type === "thread.cleaned"));
    const list = sh(api, "worktree", "list", "--porcelain").out;
    expect(list).not.toContain("kyc-1");
    expect(list).toContain(other);
    expect(branchExists(api, "wip/kyc-1")).toBe(false);
  });

  test("a cleanup still pending when the daemon starts is marked failed, so it can be run again", async () => {
    const root = workspace();
    const store = new EventStore(paths(root).db);
    store.append([taskThreadCreated("001", "kyc-1", { dir: join(root, ".worktrees", "kyc-1"), status: "done" })], USER);
    store.append([{ type: "thread.cleanup_requested", thread: "001", payload: {} }], { role: "main", via: "command" });
    store.close();
    const { events } = await start(root);
    const failed = (await events()).filter((x) => x.type === "thread.cleanup_failed").map((x) => x.payload);
    expect(failed).toEqual([{ repo: "(all)", reason: "the daemon restarted during the cleanup; run agt thread cleanup again" }]);
  });
});

test("main runs cleanup only when the user says the thread is merged", () => {
  expect(systemPrompt({ root: "/repo", role: "main" }).split("\n")).toContain("- Run agt thread cleanup <id> only when the user says so, after they told you the thread is merged.");
});
