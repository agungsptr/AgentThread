import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, unlinkSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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
  const dir = join(root, ".worktrees", "pay-1");
  mkdirSync(dir, { recursive: true });
  const thread = { id: "001", title: "PAY", slug: "pay", task: "pay-1", dir, worktrees: {}, legacy: false } as unknown as Thread;
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
  const effect = { kind: "git.worktree.add", thread: "001", repo: "api", repoPath: api, path, branch: "wip/pay-1", source: "main" } as const;
  const nothingLeft = () => {
    expect(existsSync(path)).toBe(false);
    expect(git(api, "rev-parse", "--verify", "--quiet", "refs/heads/wip/pay-1").ok).toBe(false);
    expect(git(api, "worktree", "list").out).not.toContain("pay-1");
  };
  return { root, api, path, run, effect, logs, nothingLeft };
}

const withSetup = (cmd: string) => ConfigSchema.parse({ agents: { skill: false }, workspace: { worktree_setup: cmd } });

describe("git.worktree.add (repo form)", () => {
  test("without a setup command: git worktree add -b wip/<task> from the source, then AGENTS.md", async () => {
    const s = setup(ConfigSchema.parse({}));
    expect(await s.run(s.effect)).toEqual({ cmd: "worktree.report", thread: "001", repo: "api", ok: true });
    expect(git(s.path, "rev-parse", "--abbrev-ref", "HEAD").out).toBe("wip/pay-1");
    expect(readFileSync(join(s.path, "AGENTS.md"), "utf8")).toContain(`thread 001 ("PAY")`);
    expect(git(s.path, "status", "--porcelain").out).toBe("");
  });

  test("a setup command is used instead of git, with the placeholders filled in", async () => {
    const s = setup(withSetup("echo {root}/{task}/{repo}/{src}/{path} > {root}/setup.log && git -C {root}/{repo} worktree add -q -b wip/{task} {path} {src}"));
    expect(await s.run(s.effect)).toEqual({ cmd: "worktree.report", thread: "001", repo: "api", ok: true });
    expect(readFileSync(join(s.root, "setup.log"), "utf8")).toBe(`${s.root}/pay-1/api/main/${s.path}\n`);
    expect(git(s.path, "rev-parse", "--abbrev-ref", "HEAD").out).toBe("wip/pay-1");
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
    expect((await s.run(s.effect)).error).toContain(`worktree setup for api did not produce ${s.path} on wip/pay-1`);
    s.nothingLeft();
  });

  test("a setup command that leaves the worktree on another branch is undone", async () => {
    const s = setup(withSetup("git -C {root}/{repo} worktree add -q -b other {path} {src}"));
    expect((await s.run(s.effect)).error).toContain(`worktree setup for api did not produce ${s.path} on wip/pay-1`);
    s.nothingLeft();
  });

  test("a nonexistent source branch throws and leaves nothing behind", async () => {
    const s = setup(ConfigSchema.parse({}));
    expect((await s.run({ ...s.effect, source: "nope" })).error).toContain("git worktree add failed");
    s.nothingLeft();
  });

  test("an existing wip/<task> branch is kept when the add fails", async () => {
    const s = setup(ConfigSchema.parse({}));
    git(s.api, "branch", "wip/pay-1");
    expect((await s.run(s.effect)).error).toContain("git worktree add failed");
    expect(git(s.api, "rev-parse", "--verify", "--quiet", "refs/heads/wip/pay-1").ok).toBe(true);
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
    expect(git(s.api, "worktree", "add", "-q", "-b", "wip/pay-1", s.path, "main").ok).toBe(true);
    expect(await s.run(s.effect)).toEqual({ cmd: "worktree.report", thread: "001", repo: "api", ok: true });
    expect(existsSync(join(s.root, "ran"))).toBe(false);
    expect(existsSync(join(s.path, "AGENTS.md"))).toBe(true);
    expect(git(s.path, "config", "--worktree", "--get", "core.hooksPath").out).toBe(join(s.root, ".agentthread", "hooks"));
    expect(git(s.path, "rev-parse", "--abbrev-ref", "HEAD").out).toBe("wip/pay-1");
  });

  test("a registered path on another branch is not adopted", async () => {
    const s = setup(ConfigSchema.parse({}));
    expect(git(s.api, "worktree", "add", "-q", "-b", "other", s.path, "main").ok).toBe(true);
    expect((await s.run(s.effect)).ok).toBe(false);
    expect(git(s.path, "rev-parse", "--abbrev-ref", "HEAD").out).toBe("other");
  });

  test("verification needs a registered worktree: a separate repo at the path on wip/<task> fails and is removed", async () => {
    const s = setup(withSetup("git init -q -b wip/{task} {path} && git -C {path} -c user.name=T -c user.email=t@example.com commit -q --allow-empty -m x"));
    expect((await s.run(s.effect)).error).toContain(`worktree setup for api did not produce ${s.path} on wip/pay-1`);
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
    await runner({ ...s.effect, repo: "web", repoPath: join(s.root, "web"), path: join(s.root, ".worktrees", "pay-1", "web") });
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
    expect(git(s.path, "rev-parse", "--abbrev-ref", "HEAD").out).toBe("wip/pay-1");
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

describe("the built-in copy and install step", () => {
  const cfg = (repo: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ConfigSchema.parse({ agents: { skill: false }, workspace: { repos: { api: { path: "api", ...repo } }, ...extra } });
  const commit = (api: string, ...files: string[]) => {
    git(api, "add", "-f", ...files);
    git(api, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "files");
  };

  test("copies present files with their mode, skips missing ones with a note, never overwrites", async () => {
    const s = setup(cfg({ copy: [".env", "e2e/.env.local", "missing.env", "tracked.txt"], install: "" }));
    writeFileSync(join(s.api, ".env"), "A=1\n");
    chmodSync(join(s.api, ".env"), 0o750);
    mkdirSync(join(s.api, "e2e"));
    writeFileSync(join(s.api, "e2e/.env.local"), "B=2\n");
    writeFileSync(join(s.api, "tracked.txt"), "main\n");
    commit(s.api, "tracked.txt");
    writeFileSync(join(s.api, "tracked.txt"), "dirty main\n");
    expect((await s.run(s.effect)).ok).toBe(true);
    expect(readFileSync(join(s.path, ".env"), "utf8")).toBe("A=1\n");
    expect(lstatSync(join(s.path, ".env")).mode & 0o777).toBe(0o750);
    expect(readFileSync(join(s.path, "e2e/.env.local"), "utf8")).toBe("B=2\n");
    expect(existsSync(join(s.path, "missing.env"))).toBe(false);
    // a tracked file with local edits is replaced by the local copy and hidden from git status (skip-worktree)
    expect(readFileSync(join(s.path, "tracked.txt"), "utf8")).toBe("dirty main\n");
    expect(git(s.path, "status", "--porcelain").out).toBe("");
    expect(s.logs.some((l) => l.includes("missing.env") && l.includes("skipped"))).toBe(true);
  });

  test("link: node_modules is symlinked and install skipped; a differing lockfile installs instead", async () => {
    const same = setup(cfg({ link: ["node_modules"], install: "echo run >> ../installs.log" }));
    mkdirSync(join(same.api, "node_modules/p"), { recursive: true });
    writeFileSync(join(same.api, ".gitignore"), "node_modules\n");
    expect((await same.run(same.effect)).ok).toBe(true);
    expect(lstatSync(join(same.path, "node_modules")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(same.root, ".worktrees/pay-1/installs.log"))).toBe(false);
    expect(git(same.path, "status", "--porcelain").out).toBe("");

    const diff = setup(cfg({ link: ["node_modules"], install: "echo run >> ../installs.log" }));
    mkdirSync(join(diff.api, "node_modules/p"), { recursive: true });
    writeFileSync(join(diff.api, "yarn.lock"), "main\n");
    commit(diff.api, "yarn.lock");
    // the worktree is made from a source whose lockfile differs from the main checkout's working copy
    writeFileSync(join(diff.api, "yarn.lock"), "edited\n");
    expect((await diff.run(diff.effect)).ok).toBe(true);
    expect(existsSync(join(diff.path, "node_modules"))).toBe(false);
    expect(readFileSync(join(diff.root, ".worktrees/pay-1/installs.log"), "utf8")).toBe("run\n");
    expect(diff.logs.some((l) => l.includes("link node_modules: not linked") && l.includes("yarn.lock"))).toBe(true);
  });

  test("a re-run after the lockfile changed unlinks node_modules and installs, leaving the main checkout's untouched", async () => {
    const s = setup(cfg({ link: ["node_modules"], install: "mkdir -p node_modules && echo i > node_modules/installed" }));
    mkdirSync(join(s.api, "node_modules/p"), { recursive: true });
    writeFileSync(join(s.api, ".gitignore"), "node_modules\n");
    expect((await s.run(s.effect)).ok).toBe(true);
    expect(lstatSync(join(s.path, "node_modules")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(s.api, "node_modules/installed"))).toBe(false);
    // the worktree is adopted again without the ready marker, with a lockfile that now differs
    unlinkSync(join(git(s.path, "rev-parse", "--absolute-git-dir").out, "agt-ready"));
    writeFileSync(join(s.path, "yarn.lock"), "new\n");
    expect((await s.run(s.effect)).ok).toBe(true);
    expect(lstatSync(join(s.path, "node_modules")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(s.path, "node_modules/installed"))).toBe(true);
    expect(readdirSync(join(s.api, "node_modules"))).toEqual(["p"]);
  });

  test("a symlink pointing outside the repo is refused", async () => {
    const s = setup(cfg({ copy: [".env", "link/x"], install: "" }));
    const outside = join(s.root, "secret.txt");
    writeFileSync(outside, "s\n");
    symlinkSync(outside, join(s.api, ".env"));
    mkdirSync(join(s.root, "elsewhere"));
    writeFileSync(join(s.root, "elsewhere/x"), "x\n");
    symlinkSync(join(s.root, "elsewhere"), join(s.api, "link"));
    expect((await s.run(s.effect)).ok).toBe(true);
    expect(existsSync(join(s.path, ".env"))).toBe(false);
    expect(existsSync(join(s.path, "link/x"))).toBe(false);
    expect(s.logs.filter((l) => l.includes("refused")).length).toBe(2);
  });

  test("a destination symlink leading out of the worktree is refused", async () => {
    const s = setup(cfg({ copy: ["d2/.env"], install: "" }));
    mkdirSync(join(s.root, "outside"));
    git(s.api, "checkout", "-q", "-b", "feat");
    symlinkSync(join(s.root, "outside"), join(s.api, "d2"));
    commit(s.api, "d2");
    git(s.api, "checkout", "-q", "main");
    mkdirSync(join(s.api, "d2"));
    writeFileSync(join(s.api, "d2/.env"), "y\n");
    expect((await s.run({ ...s.effect, source: "feat" })).ok).toBe(true);
    expect(existsSync(join(s.root, "outside/.env"))).toBe(false);
    expect(s.logs.some((l) => l.includes("refused"))).toBe(true);
  });

  const fakeNpm = (s: { root: string }) => {
    const bin = join(s.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "$PWD: npm $*" >> ${join(s.root, "install.log")}\n`);
    chmodSync(join(bin, "npm"), 0o755);
    return bin;
  };

  test("the install command is detected from the lockfile and runs in the worktree", async () => {
    const s = setup(cfg({}));
    writeFileSync(join(s.api, "package.json"), "{}");
    writeFileSync(join(s.api, "package-lock.json"), "{}");
    commit(s.api, "package.json", "package-lock.json");
    const saved = process.env.PATH;
    process.env.PATH = `${fakeNpm(s)}:${saved}`;
    try {
      expect((await s.run(s.effect)).ok).toBe(true);
    } finally {
      process.env.PATH = saved;
    }
    expect(readFileSync(join(s.root, "install.log"), "utf8")).toBe(`${s.path}: npm ci\n`);
  });

  test("an explicit install command overrides detection; an empty one disables it", async () => {
    const s = setup(cfg({ install: "echo custom > ../custom.log" }));
    writeFileSync(join(s.api, "package.json"), "{}");
    commit(s.api, "package.json");
    expect((await s.run(s.effect)).ok).toBe(true);
    expect(readFileSync(join(s.path, "../custom.log"), "utf8")).toBe("custom\n");
    const d = setup(cfg({ install: "" }));
    writeFileSync(join(d.api, "package.json"), "{}");
    commit(d.api, "package.json");
    expect((await d.run(d.effect)).ok).toBe(true);
  });

  test("a failing install fails the worktree with the last log lines and leaves nothing behind", async () => {
    const s = setup(cfg({ install: "echo one >&2; echo boom >&2; exit 3" }));
    const r = await s.run(s.effect);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("install for api failed");
    expect(r.error).toContain("exit 3");
    expect(r.error).toContain("boom");
    s.nothingLeft();
  });

  test("worktree_setup replaces the built-in step", async () => {
    const s = setup(cfg({ copy: [".env"], install: "echo installed > ../installed.log" }, { worktree_setup: "git -C {repo} worktree add -q -b wip/{task} {path} {src}" }));
    writeFileSync(join(s.api, ".env"), "A=1\n");
    expect((await s.run(s.effect)).ok).toBe(true);
    expect(existsSync(join(s.path, ".env"))).toBe(false);
    expect(existsSync(join(s.path, "../installed.log"))).toBe(false);
  });

  test("copied files are git-ignored in the worktree", async () => {
    const s = setup(cfg({ copy: [".env", "e2e/.env.local"], install: "" }));
    writeFileSync(join(s.api, ".env"), "A=1\n");
    mkdirSync(join(s.api, "e2e"));
    writeFileSync(join(s.api, "e2e/.env.local"), "B=2\n");
    expect((await s.run(s.effect)).ok).toBe(true);
    expect(existsSync(join(s.path, ".env"))).toBe(true);
    expect(git(s.path, "status", "--porcelain", "--", ".env", "e2e").out).toBe("");
  });

  test("an adopted worktree without the ready marker runs copy and install; with it, they are skipped", async () => {
    const s = setup(cfg({ copy: [".env"], install: "echo run >> ../adopt.log" }));
    writeFileSync(join(s.api, ".env"), "A=1\n");
    await addWorktreeFromAsync(s.api, "wip/pay-1", s.path, "main");
    expect((await s.run(s.effect)).ok).toBe(true);
    expect(readFileSync(join(s.path, ".env"), "utf8")).toBe("A=1\n");
    expect(readFileSync(join(s.path, "../adopt.log"), "utf8")).toBe("run\n");
    expect((await s.run(s.effect)).ok).toBe(true);
    expect(readFileSync(join(s.path, "../adopt.log"), "utf8")).toBe("run\n");
  });

  test("credentials are redacted from an install failure", async () => {
    const s = setup(cfg({ install: "echo 'GET https://bob:hunter2@reg.example/x' >&2; echo '_authToken=abc123' >&2; echo 'token=t0k password=pw1' >&2; exit 1" }));
    const r = await s.run(s.effect);
    expect(r.ok).toBe(false);
    for (const secret of ["hunter2", "abc123", "t0k", "pw1"]) expect(r.error).not.toContain(secret);
    expect(r.error).toContain("://***@reg.example");
  });
});
