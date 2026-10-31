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
import { applyEvent, project, type State } from "../../src/state/projection.ts";
import { EventStore } from "../../src/store/event-store.ts";
import { INIT, USER, isolatedConfigHome, stateOf, taskThreadCreated, threadCreated } from "../helpers.ts";

const COORD: Actor = { role: "coordinator", thread: "001", session: "c1" };

const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};

/** A workspace folder holding the repos `api` and `web`, each with one commit on main. */
function workspace(configYaml?: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agt-ws-")));
  for (const name of ["api", "web"]) {
    const dir = join(root, name);
    mkdirSync(dir);
    sh(dir, "init", "-q", "-b", "main");
    sh(dir, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
  }
  initProject(root, "demo");
  if (configYaml) writeFileSync(join(root, ".agentthread", "config.yaml"), configYaml);
  return root;
}

describe("worktree.add in the handler", () => {
  const config = ConfigSchema.parse({ workspace: { repos: { api: { path: "api" }, web: { path: "web", source_branch: "develop" } } } });
  const run = (state: State, cmd: unknown, actor: Actor = USER): HandleResult => handle(state, CommandSchema.parse(cmd), actor, { root: "/repo", config });
  const errorOf = (r: HandleResult) => (r.ok ? "accepted" : r.error);
  const base = () => stateOf(INIT, taskThreadCreated("001", "kyc-1"), threadCreated("002"));

  const REQ = { repo: "api", path: "/repo/.worktrees/kyc-1/api", branch: "wip/kyc-1", source: "main" };
  /** Runs a command and applies its events, like the daemon does. */
  const exec = (state: State, cmd: unknown, actor: Actor = USER): HandleResult => {
    const r = run(state, cmd, actor);
    if (r.ok) for (const body of r.events) applyEvent(state, { ...body, seq: state.lastSeq + 1, ts: "2026-10-09T11:00:00.000Z", actor } as StoredEvent);
    return r;
  };
  const withCoordinator = () =>
    stateOf(
      INIT,
      taskThreadCreated("001", "kyc-1"),
      { type: "session.created", thread: "001", payload: { session: "c1", role: "coordinator", agent: "claude-code", name: "coord" } },
      { type: "session.attached", thread: "001", payload: { session: "c1", pane: "p1" } },
    );

  test("records the request (a command-decided event) and asks for a background git.worktree.add", () => {
    const r = run(base(), { cmd: "worktree.add", thread: "001", repo: "api", from: "main" }, COORD);
    if (!r.ok) throw new Error(r.error);
    expect(r.events).toEqual([{ type: "worktree.requested", thread: "001", payload: REQ }]);
    expect(r.actor).toMatchObject({ via: "command" });
    expect(r.result).toEqual({ ...REQ, requested: true });
    expect(r.effects).toEqual([{ kind: "git.worktree.add", thread: "001", repoPath: "/repo/api", ...REQ }]);
  });

  test("a second add while one is pending is rejected", () => {
    const s = base();
    expect(errorOf(exec(s, { cmd: "worktree.add", thread: "001", repo: "api", from: "main" }))).toBe("accepted");
    expect(s.threads.get("001")!.worktreeRequests).toEqual({ api: { path: REQ.path, branch: REQ.branch, source: REQ.source } });
    expect(errorOf(run(s, { cmd: "worktree.add", thread: "001", repo: "api", from: "main" }))).toBe("a worktree for api is already being created");
  });

  test("rejects a --from that starts with -", () => {
    expect(errorOf(run(base(), { cmd: "worktree.add", thread: "001", repo: "api", from: "--upload-pack=x" }))).toBe("invalid source branch --upload-pack=x");
  });

  test("a successful report adds the worktree and tells the coordinator", () => {
    const s = withCoordinator();
    exec(s, { cmd: "worktree.add", thread: "001", repo: "api", from: "main" }, COORD);
    const r = exec(s, { cmd: "worktree.report", thread: "001", repo: "api", ok: true });
    if (!r.ok) throw new Error(r.error);
    expect(r.events).toEqual([
      { type: "worktree.added", thread: "001", payload: REQ },
      { type: "notice.queued", thread: "001", payload: { session: "c1", text: "Worktree for api is ready at /repo/.worktrees/kyc-1/api on wip/kyc-1." } },
    ]);
    expect(s.threads.get("001")!.worktrees).toEqual({ api: { path: REQ.path, branch: REQ.branch, source: REQ.source } });
    expect(s.threads.get("001")!.worktreeRequests).toEqual({});
    // a repeated report changes nothing
    expect(exec(s, { cmd: "worktree.report", thread: "001", repo: "api", ok: true })).toMatchObject({ ok: true, events: [] });
  });

  test("a failed report clears the request and tells the coordinator why", () => {
    const s = withCoordinator();
    exec(s, { cmd: "worktree.add", thread: "001", repo: "api", from: "main" }, COORD);
    const r = exec(s, { cmd: "worktree.report", thread: "001", repo: "api", ok: false, error: "git worktree add failed: bad ref." });
    if (!r.ok) throw new Error(r.error);
    expect(r.events).toEqual([
      { type: "worktree.failed", thread: "001", payload: { repo: "api", reason: "git worktree add failed: bad ref" } },
      { type: "notice.queued", thread: "001", payload: { session: "c1", text: "Worktree for api failed: git worktree add failed: bad ref." } },
    ]);
    expect(s.threads.get("001")!.worktreeRequests).toEqual({});
    expect(s.threads.get("001")!.worktrees).toEqual({});
    // the repo can be requested again
    expect(errorOf(run(s, { cmd: "worktree.add", thread: "001", repo: "api", from: "main" }, COORD))).toBe("accepted");
  });

  test("only the daemon (the user actor) reports", () => {
    expect(errorOf(run(base(), { cmd: "worktree.report", thread: "001", repo: "api", ok: true }, COORD))).toBe("role coordinator may not run worktree.report");
  });

  test("the repo's source_branch is the default source", () => {
    const r = run(base(), { cmd: "worktree.add", thread: "001", repo: "web" });
    if (!r.ok) throw new Error(r.error);
    expect(r.effects[0]).toMatchObject({ source: "develop", branch: "wip/kyc-1", path: "/repo/.worktrees/kyc-1/web" });
  });

  test("rejects an unknown repo", () => {
    expect(errorOf(run(base(), { cmd: "worktree.add", thread: "001", repo: "nope", from: "main" }))).toBe("unknown repo nope; workspace repos: api, web");
  });

  test("rejects a legacy thread", () => {
    expect(errorOf(run(base(), { cmd: "worktree.add", thread: "002", repo: "api", from: "main" }))).toBe("thread 002 uses the single-repo layout");
  });

  test("rejects a repo already added", () => {
    const s = base();
    const added = { type: "worktree.added", thread: "001", payload: { repo: "api", path: "/repo/.worktrees/kyc-1/api", branch: "wip/kyc-1", source: "main" } } as const;
    const st = project([...[INIT, taskThreadCreated("001", "kyc-1"), added].map((b, i) => ({ ...b, seq: i + 1, ts: "2026-10-09T10:00:00.000Z", actor: USER }) as StoredEvent)]);
    expect(st.threads.get("001")!.worktrees).toEqual({ api: { path: "/repo/.worktrees/kyc-1/api", branch: "wip/kyc-1", source: "main" } });
    expect(errorOf(run(st, { cmd: "worktree.add", thread: "001", repo: "api", from: "main" }))).toBe("thread 001 already has a worktree for api");
    expect(errorOf(run(s, { cmd: "worktree.add", thread: "001", repo: "api", from: "main" }))).toBe("accepted");
  });

  test("rejects a repo with neither --from nor a source_branch", () => {
    expect(errorOf(run(base(), { cmd: "worktree.add", thread: "001", repo: "api" }))).toBe("no source branch for api; pass --from <branch>");
  });

  test("workers, main and another thread's coordinator may not run it", () => {
    const cmd = { cmd: "worktree.add", thread: "001", repo: "api", from: "main" };
    expect(errorOf(run(base(), cmd, { role: "worker", thread: "001", session: "w1" }))).toBe("role worker may not run worktree.add");
    expect(errorOf(run(base(), cmd, { role: "main" }))).toBe("role main may not run worktree.add");
    expect(errorOf(run(base(), cmd, { role: "coordinator", thread: "002", session: "c2" }))).toBe("coordinator is bound to thread 002");
  });
});

describe("agt worktree add through the daemon", () => {
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
    /** Waits for the background job's outcome: a worktree.added or worktree.failed event. */
    const outcome = async (timeoutMs = 10_000) => {
      for (const until = Date.now() + timeoutMs; Date.now() < until; await Bun.sleep(50)) {
        const done = (await events()).find((e) => e.type === "worktree.added" || e.type === "worktree.failed");
        if (done) return done;
      }
      throw new Error("no worktree outcome");
    };
    if (!project(await events()).threads.has("001")) {
      expect(await cmd({ cmd: "thread.new", title: "KYC", type: "feature", task: "kyc-1" })).toMatchObject({ ok: true });
    }
    return { cmd, events, outcome };
  }

  const nothingLeft = (root: string) => {
    expect(existsSync(join(root, ".worktrees", "kyc-1", "api"))).toBe(false);
    expect(sh(join(root, "api"), "rev-parse", "--verify", "--quiet", "refs/heads/wip/kyc-1").ok).toBe(false);
    expect(sh(join(root, "api"), "worktree", "list").out).not.toContain("kyc-1");
  };

  test("creates .worktrees/<task>/<repo> on wip/<task> from the source; the events and the projection list it", async () => {
    const root = workspace();
    const { cmd, events, outcome } = await start(root);
    const r = await cmd({ cmd: "worktree.add", thread: "001", repo: "api", from: "main" }, COORD);
    const path = join(root, ".worktrees", "kyc-1", "api");
    const payload = { repo: "api", path, branch: "wip/kyc-1", source: "main" };
    expect(r).toEqual({ ok: true, result: { ...payload, requested: true } });
    expect(await outcome()).toMatchObject({ type: "worktree.added", thread: "001", payload });
    expect(sh(path, "rev-parse", "--abbrev-ref", "HEAD").out).toBe("wip/kyc-1");
    expect(sh(path, "rev-parse", "HEAD").out).toBe(sh(join(root, "api"), "rev-parse", "main").out);
    const all = await events();
    expect(all.filter((e) => e.type === "worktree.requested").map((e) => e.payload)).toEqual([payload]);
    expect(project(all).threads.get("001")!.worktrees).toEqual({ api: { path, branch: "wip/kyc-1", source: "main" } });
    expect(existsSync(join(path, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(path, "CLAUDE.md"))).toBe(true);
    expect(sh(path, "status", "--porcelain").out).toBe("");
    // the guard is installed in the new worktree, with the repo's own excludes file
    expect(sh(path, "config", "--worktree", "--get", "core.hooksPath").out).toBe(join(root, ".agentthread", "hooks"));
    expect(sh(path, "config", "--worktree", "--get", "core.excludesFile").out).toBe(join(root, ".agentthread", "worktree-excludes", "api"));
    // a second add of the same repo is refused
    expect(await cmd({ cmd: "worktree.add", thread: "001", repo: "api", from: "main" }, COORD)).toEqual({ ok: false, error: "thread 001 already has a worktree for api" });
  });

  test("while a slow setup command runs, other commands complete; a duplicate request is rejected", async () => {
    const root = workspace(["workspace:", "  worktree_setup: sleep 2 && git -C {root}/{repo} worktree add -q -b wip/{task} {path} {src}", ""].join("\n"));
    const { cmd, outcome } = await start(root);
    const t0 = Date.now();
    expect(await cmd({ cmd: "worktree.add", thread: "001", repo: "api", from: "main" }, COORD)).toMatchObject({ ok: true });
    expect(await cmd({ cmd: "log", thread: "001", message: "still responsive" }, COORD)).toMatchObject({ ok: true });
    expect(await cmd({ cmd: "worktree.add", thread: "001", repo: "api", from: "main" }, COORD)).toEqual({ ok: false, error: "a worktree for api is already being created" });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(await outcome()).toMatchObject({ type: "worktree.added", payload: { repo: "api" } });
  });

  test("a nonexistent source branch: worktree.failed, no folder and no branch", async () => {
    const root = workspace();
    const { cmd, events, outcome } = await start(root);
    expect(await cmd({ cmd: "worktree.add", thread: "001", repo: "api", from: "nope" }, COORD)).toMatchObject({ ok: true });
    expect(await outcome()).toMatchObject({ type: "worktree.failed", payload: { repo: "api" } });
    expect((await events()).some((e) => e.type === "worktree.added")).toBe(false);
    expect(project(await events()).threads.get("001")!.worktreeRequests).toEqual({});
    nothingLeft(root);
  });

  test("a setup command that exits 1: worktree.failed, no folder and no branch", async () => {
    const root = workspace(["workspace:", "  worktree_setup: git -C {root}/{repo} worktree add -b wip/{task} {path} {src} && exit 1", ""].join("\n"));
    const { cmd, events, outcome } = await start(root);
    expect(await cmd({ cmd: "worktree.add", thread: "001", repo: "api", from: "main" }, COORD)).toMatchObject({ ok: true });
    expect(await outcome()).toMatchObject({ type: "worktree.failed", payload: { repo: "api", reason: expect.stringContaining("worktree setup for api failed (exit 1") } });
    expect((await events()).some((e) => e.type === "worktree.added")).toBe(false);
    nothingLeft(root);
  });

  test("a request still pending when the daemon starts is marked failed, so it can be requested again", async () => {
    const root = workspace();
    const store = new EventStore(paths(root).db);
    const path = join(root, ".worktrees", "kyc-1", "api");
    store.append([taskThreadCreated("001", "kyc-1", { dir: join(root, ".worktrees", "kyc-1") })], USER);
    store.append([{ type: "worktree.requested", thread: "001", payload: { repo: "api", path, branch: "wip/kyc-1", source: "main" } }], { ...COORD, via: "command" });
    store.close();
    const { cmd, events } = await start(root);
    const failed = (await events()).filter((e) => e.type === "worktree.failed");
    expect(failed.map((e) => e.payload)).toEqual([{ repo: "api", reason: expect.stringContaining("the daemon restarted before the worktree was ready") }]);
    expect(project(await events()).threads.get("001")!.worktreeRequests).toEqual({});
    expect(await cmd({ cmd: "worktree.add", thread: "001", repo: "api", from: "main" }, COORD)).toMatchObject({ ok: true });
    for (let i = 0; i < 200 && !(await events()).some((e) => e.type === "worktree.added"); i++) await Bun.sleep(50);
    expect(project(await events()).threads.get("001")!.worktrees.api?.path).toBe(path);
  });
});

test("the coordinator of a thread-directory thread is told to create worktrees; a legacy coordinator is not", () => {
  const rule = "- Ask the user which source branch to start from, then create a worktree for each repo the task touches: agt worktree add <thread> <repo> --from <branch>. Never move or rename a worktree.";
  const s = stateOf(INIT, taskThreadCreated("001", "kyc-1"), threadCreated("002"));
  expect(systemPrompt({ root: "/repo", role: "coordinator", thread: s.threads.get("001")! }).split("\n")).toContain(rule);
  expect(systemPrompt({ root: "/repo", role: "coordinator", thread: s.threads.get("002")! })).not.toContain("agt worktree add");
});
