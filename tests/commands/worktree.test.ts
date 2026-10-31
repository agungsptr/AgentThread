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

  test("asks for a git.worktree.add effect on wip/<task> and writes no event itself", () => {
    const r = run(base(), { cmd: "worktree.add", thread: "001", repo: "api", from: "main" }, COORD);
    if (!r.ok) throw new Error(r.error);
    expect(r.events).toEqual([]);
    expect(r.effects).toEqual([
      { kind: "git.worktree.add", thread: "001", repo: "api", repoPath: "/repo/api", path: "/repo/.worktrees/kyc-1/api", branch: "wip/kyc-1", source: "main" },
    ]);
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
    expect(await cmd({ cmd: "thread.new", title: "KYC", type: "feature", task: "kyc-1" })).toMatchObject({ ok: true });
    return { cmd, events };
  }

  test("creates .worktrees/<task>/<repo> on wip/<task> from the source; the event and the projection list it", async () => {
    const root = workspace();
    const { cmd, events } = await start(root);
    const r = await cmd({ cmd: "worktree.add", thread: "001", repo: "api", from: "main" }, COORD);
    const path = join(root, ".worktrees", "kyc-1", "api");
    expect(r).toEqual({ ok: true, result: { repo: "api", path, branch: "wip/kyc-1", source: "main" } });
    expect(sh(path, "rev-parse", "--abbrev-ref", "HEAD").out).toBe("wip/kyc-1");
    expect(sh(path, "rev-parse", "HEAD").out).toBe(sh(join(root, "api"), "rev-parse", "main").out);
    const all = await events();
    const added = all.filter((e) => e.type === "worktree.added");
    expect(added.map((e) => ({ thread: e.thread, payload: e.payload }))).toEqual([{ thread: "001", payload: { repo: "api", path, branch: "wip/kyc-1", source: "main" } }]);
    expect(project(all).threads.get("001")!.worktrees).toEqual({ api: { path, branch: "wip/kyc-1", source: "main" } });
    expect(existsSync(join(path, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(path, "CLAUDE.md"))).toBe(true);
    expect(sh(path, "status", "--porcelain").out).toBe("");
    // the guard is installed in the new worktree
    expect(sh(path, "config", "--worktree", "--get", "core.hooksPath").out).toBe(join(root, ".agentthread", "hooks"));
    // a second add of the same repo is refused
    expect(await cmd({ cmd: "worktree.add", thread: "001", repo: "api", from: "main" }, COORD)).toEqual({ ok: false, error: "thread 001 already has a worktree for api" });
  });

  test("a nonexistent source branch leaves no event, no folder and no branch", async () => {
    const root = workspace();
    const { cmd, events } = await start(root);
    const before = (await events()).length;
    const r = await cmd({ cmd: "worktree.add", thread: "001", repo: "api", from: "nope" }, COORD);
    expect(r.ok).toBe(false);
    expect((await events()).length).toBe(before);
    expect(existsSync(join(root, ".worktrees", "kyc-1", "api"))).toBe(false);
    expect(sh(join(root, "api"), "rev-parse", "--verify", "--quiet", "refs/heads/wip/kyc-1").ok).toBe(false);
  });

  test("a setup command that exits 1 leaves no event, no folder and no branch", async () => {
    const root = workspace(
      ["workspace:", "  worktree_setup: git -C {root}/{repo} worktree add -b wip/{task} {path} {src} && exit 1", ""].join("\n"),
    );
    const { cmd, events } = await start(root);
    const before = (await events()).length;
    const r = await cmd({ cmd: "worktree.add", thread: "001", repo: "api", from: "main" }, COORD);
    expect(r.ok).toBe(false);
    expect((await events()).length).toBe(before);
    expect(existsSync(join(root, ".worktrees", "kyc-1", "api"))).toBe(false);
    expect(sh(join(root, "api"), "rev-parse", "--verify", "--quiet", "refs/heads/wip/kyc-1").ok).toBe(false);
    expect(sh(join(root, "api"), "worktree", "list").out).not.toContain("kyc-1");
  });
});

test("the coordinator of a thread-directory thread is told to create worktrees; a legacy coordinator is not", () => {
  const rule = "- Ask the user which source branch to start from, then create a worktree for each repo the task touches: agt worktree add <thread> <repo> --from <branch>. Never move or rename a worktree.";
  const s = stateOf(INIT, taskThreadCreated("001", "kyc-1"), threadCreated("002"));
  expect(systemPrompt({ root: "/repo", role: "coordinator", thread: s.threads.get("001")! }).split("\n")).toContain(rule);
  expect(systemPrompt({ root: "/repo", role: "coordinator", thread: s.threads.get("002")! })).not.toContain("agt worktree add");
});
