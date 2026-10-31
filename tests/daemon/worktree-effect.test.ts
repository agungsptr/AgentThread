import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, type Config } from "../../src/config/config.ts";
import { createEffectRunner } from "../../src/daemon/effects.ts";
import { addWorktreeFromAsync } from "../../src/project/git.ts";
import type { Thread } from "../../src/state/projection.ts";
import { isolatedConfigHome } from "../helpers.ts";

const savedXdg = process.env.XDG_CONFIG_HOME;
beforeAll(() => {
  process.env.XDG_CONFIG_HOME = isolatedConfigHome();
});
afterAll(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
});

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim() };
};

function repo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

type Report = { cmd: "worktree.report"; thread: string; repo: string; ok: boolean; error?: string };

function setup(config: Config, setupTimeoutMs?: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agt-ws-")));
  const api = repo(join(root, "api"));
  const dir = join(root, ".worktrees", "kyc-1");
  mkdirSync(dir, { recursive: true });
  const thread = { id: "001", title: "KYC", slug: "kyc", task: "kyc-1", dir, worktrees: {}, legacy: false } as unknown as Thread;
  const logs: string[] = [];
  let reported: (r: Report) => void = () => {};
  const runner = createEffectRunner({
    root,
    config,
    layout: () => undefined,
    thread: (id) => (id === "001" ? thread : undefined),
    log: (m) => logs.push(m),
    report: (r) => reported(r),
    ...(setupTimeoutMs !== undefined ? { setupTimeoutMs } : {}),
  });
  /** Runs the effect: it returns at once with no events; the background job's report is what this resolves to. */
  const run = async (e: Parameters<typeof runner>[0]): Promise<Report> => {
    const report = new Promise<Report>((r) => (reported = r));
    expect(await runner(e)).toEqual([]);
    return report;
  };
  const path = join(dir, "api");
  const effect = { kind: "git.worktree.add", thread: "001", repo: "api", repoPath: api, path, branch: "wip/kyc-1", source: "main" } as const;
  const nothingLeft = () => {
    expect(existsSync(path)).toBe(false);
    expect(git(api, "rev-parse", "--verify", "--quiet", "refs/heads/wip/kyc-1").ok).toBe(false);
    expect(git(api, "worktree", "list").out).not.toContain("kyc-1");
  };
  return { root, api, path, run, effect, logs, nothingLeft };
}

const withSetup = (cmd: string) => ConfigSchema.parse({ agents: { skill: false }, workspace: { worktree_setup: cmd } });

describe("git.worktree.add (repo form)", () => {
  test("without a setup command: git worktree add -b wip/<task> from the source, then AGENTS.md", async () => {
    const s = setup(ConfigSchema.parse({}));
    expect(await s.run(s.effect)).toEqual({ cmd: "worktree.report", thread: "001", repo: "api", ok: true });
    expect(git(s.path, "rev-parse", "--abbrev-ref", "HEAD").out).toBe("wip/kyc-1");
    expect(readFileSync(join(s.path, "AGENTS.md"), "utf8")).toContain(`thread 001 ("KYC")`);
    expect(git(s.path, "status", "--porcelain").out).toBe("");
  });

  test("a setup command is used instead of git, with the placeholders filled in", async () => {
    const s = setup(withSetup("echo {root}/{task}/{repo}/{src}/{path} > {root}/setup.log && git -C {root}/{repo} worktree add -q -b wip/{task} {path} {src}"));
    expect(await s.run(s.effect)).toEqual({ cmd: "worktree.report", thread: "001", repo: "api", ok: true });
    expect(readFileSync(join(s.root, "setup.log"), "utf8")).toBe(`${s.root}/kyc-1/api/main/${s.path}\n`);
    expect(git(s.path, "rev-parse", "--abbrev-ref", "HEAD").out).toBe("wip/kyc-1");
    expect(existsSync(join(s.path, "AGENTS.md"))).toBe(true);
  });

  test("the setup command runs in <root> and its placeholders are shell-quoted", async () => {
    const s = setup(withSetup("pwd > out.log; printf '%s\\n' {src} >> out.log; git -C {repo} worktree add -q -b wip/{task} {path} main"));
    expect(await s.run({ ...s.effect, source: "a b;echo x" })).toEqual({ cmd: "worktree.report", thread: "001", repo: "api", ok: true });
    expect(readFileSync(join(s.root, "out.log"), "utf8")).toBe(`${s.root}\na b;echo x\n`);
  });

  test("a setup command that exits 1 after creating the worktree leaves nothing behind", async () => {
    const s = setup(withSetup("git -C {root}/{repo} worktree add -q -b wip/{task} {path} {src} && exit 1"));
    expect((await s.run(s.effect)).error).toContain("worktree setup for api failed");
    s.nothingLeft();
  });

  test("a setup command that does not produce the worktree fails with the verification message", async () => {
    const s = setup(withSetup("true"));
    expect((await s.run(s.effect)).error).toContain(`worktree setup for api did not produce ${s.path} on wip/kyc-1`);
    s.nothingLeft();
  });

  test("a setup command that leaves the worktree on another branch is undone", async () => {
    const s = setup(withSetup("git -C {root}/{repo} worktree add -q -b other {path} {src}"));
    expect((await s.run(s.effect)).error).toContain(`worktree setup for api did not produce ${s.path} on wip/kyc-1`);
    s.nothingLeft();
  });

  test("a nonexistent source branch throws and leaves nothing behind", async () => {
    const s = setup(ConfigSchema.parse({}));
    expect((await s.run({ ...s.effect, source: "nope" })).error).toContain("git worktree add failed");
    s.nothingLeft();
  });

  test("an existing wip/<task> branch is kept when the add fails", async () => {
    const s = setup(ConfigSchema.parse({}));
    git(s.api, "branch", "wip/kyc-1");
    expect((await s.run(s.effect)).error).toContain("git worktree add failed");
    expect(git(s.api, "rev-parse", "--verify", "--quiet", "refs/heads/wip/kyc-1").ok).toBe(true);
    expect(existsSync(s.path)).toBe(false);
  });
});

describe("the setup command's process group", () => {
  test("a timeout kills the whole group: a child cannot create anything after the cleanup", async () => {
    const s = setup(withSetup("(sleep 1; touch {root}/marker; mkdir -p {path}) & sleep 5"), 300);
    const r = await s.run(s.effect);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("worktree setup for api failed (timed out");
    await Bun.sleep(1500);
    expect(existsSync(join(s.root, "marker"))).toBe(false);
    s.nothingLeft();
  });
});

describe("I2 and the cheap fixes", () => {
  test("a path already registered on wip/<task> is adopted: no setup run, AGENTS.md and the guard written", async () => {
    const s = setup(withSetup("touch {root}/ran; exit 1"));
    expect(git(s.api, "worktree", "add", "-q", "-b", "wip/kyc-1", s.path, "main").ok).toBe(true);
    expect(await s.run(s.effect)).toEqual({ cmd: "worktree.report", thread: "001", repo: "api", ok: true });
    expect(existsSync(join(s.root, "ran"))).toBe(false);
    expect(existsSync(join(s.path, "AGENTS.md"))).toBe(true);
    expect(git(s.path, "config", "--worktree", "--get", "core.hooksPath").out).toBe(join(s.root, ".agentthread", "hooks"));
    expect(git(s.path, "rev-parse", "--abbrev-ref", "HEAD").out).toBe("wip/kyc-1");
  });

  test("a registered path on another branch is not adopted", async () => {
    const s = setup(ConfigSchema.parse({}));
    expect(git(s.api, "worktree", "add", "-q", "-b", "other", s.path, "main").ok).toBe(true);
    expect((await s.run(s.effect)).ok).toBe(false);
    expect(git(s.path, "rev-parse", "--abbrev-ref", "HEAD").out).toBe("other");
  });

  test("verification needs a registered worktree: a separate repo at the path on wip/<task> fails and is removed", async () => {
    const s = setup(withSetup("git init -q -b wip/{task} {path} && git -C {path} -c user.name=T -c user.email=t@example.com commit -q --allow-empty -m x"));
    expect((await s.run(s.effect)).error).toContain(`worktree setup for api did not produce ${s.path} on wip/kyc-1`);
    s.nothingLeft();
  });

  test("a setup that exits 0 but fails verification has its group killed", async () => {
    const s = setup(withSetup("(sleep 1; touch {root}/marker) & exit 0"));
    expect((await s.run(s.effect)).error).toContain("did not produce");
    await Bun.sleep(1500);
    expect(existsSync(join(s.root, "marker"))).toBe(false);
  });

  test("stop() kills a running setup group and waits for the job; later jobs do not run their setup", async () => {
    const s = setup(withSetup("(sleep 1; touch {root}/marker) & sleep 5"));
    const reports: Report[] = [];
    const runner = createEffectRunner({ root: s.root, config: withSetup("(sleep 1; touch {root}/marker) & sleep 5"), layout: () => undefined, thread: () => undefined, log: () => {}, report: (r) => void reports.push(r) });
    expect(await runner(s.effect)).toEqual([]);
    await Bun.sleep(300);
    const t0 = Date.now();
    await runner.stop();
    expect(Date.now() - t0).toBeLessThan(5500);
    await Bun.sleep(1500);
    expect(existsSync(join(s.root, "marker"))).toBe(false);
    s.nothingLeft();
  });

  test("setup runs are serialized per workspace, even for different repos", async () => {
    const s = setup(ConfigSchema.parse({}));
    repo(join(s.root, "web"));
    const cmd = "echo start {repo} >> {root}/order.log; sleep 0.4; echo end {repo} >> {root}/order.log; git -C {root}/{repo} worktree add -q -b wip/{task} {path} {src}";
    const reports: Report[] = [];
    const runner = createEffectRunner({ root: s.root, config: withSetup(cmd), layout: () => undefined, thread: () => undefined, log: () => {}, report: (r) => void reports.push(r) });
    await runner(s.effect);
    await runner({ ...s.effect, repo: "web", repoPath: join(s.root, "web"), path: join(s.root, ".worktrees", "kyc-1", "web") });
    for (let i = 0; i < 100 && reports.length < 2; i++) await Bun.sleep(50);
    expect(reports.map((r) => r.ok)).toEqual([true, true]);
    // never interleaved (either may go first: each job asks git a few things before it queues its setup)
    const lines = readFileSync(join(s.root, "order.log"), "utf8").trim().split("\n");
    expect([["start api", "end api", "start web", "end web"], ["start web", "end web", "start api", "end api"]]).toContainEqual(lines);
  });

  test("jobs for the same repo run one after another", async () => {
    const s = setup(ConfigSchema.parse({}));
    const reports: Report[] = [];
    const runner = createEffectRunner({ root: s.root, config: ConfigSchema.parse({}), layout: () => undefined, thread: () => undefined, log: () => {}, report: (r) => void reports.push(r) });
    // the same request twice at once: the second sees the first's finished worktree and adopts it
    await runner(s.effect);
    await runner(s.effect);
    for (let i = 0; i < 100 && reports.length < 2; i++) await Bun.sleep(50);
    expect(reports.map((r) => r.ok)).toEqual([true, true]);
    expect(git(s.path, "rev-parse", "--abbrev-ref", "HEAD").out).toBe("wip/kyc-1");
  });
});

describe("addWorktreeFromAsync", () => {
  test("fetches a remote branch that is not present locally", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "agt-remote-")));
    const upstream = repo(join(base, "upstream"));
    const local = join(base, "local");
    expect(Bun.spawnSync(["git", "clone", "-q", upstream, local]).exitCode).toBe(0);
    git(upstream, "-c", "user.name=T", "-c", "user.email=t@example.com", "checkout", "-q", "-b", "release");
    git(upstream, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "release");
    expect(git(local, "rev-parse", "--verify", "--quiet", "origin/release^{commit}").ok).toBe(false);
    const path = join(base, "wt");
    await addWorktreeFromAsync(local, "wip/x", path, "origin/release");
    expect(git(path, "rev-parse", "HEAD").out).toBe(git(upstream, "rev-parse", "release").out);
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD").out).toBe("wip/x");
  });
});
