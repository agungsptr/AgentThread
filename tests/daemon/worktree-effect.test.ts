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

function setup(config: Config) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agt-ws-")));
  const api = repo(join(root, "api"));
  const dir = join(root, ".worktrees", "kyc-1");
  mkdirSync(dir, { recursive: true });
  const thread = { id: "001", title: "KYC", slug: "kyc", task: "kyc-1", dir, worktrees: {}, legacy: false } as unknown as Thread;
  const logs: string[] = [];
  const run = createEffectRunner({ root, config, layout: () => undefined, thread: (id) => (id === "001" ? thread : undefined), log: (m) => logs.push(m) });
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
    expect(await s.run(s.effect)).toEqual([{ type: "worktree.added", thread: "001", payload: { repo: "api", path: s.path, branch: "wip/kyc-1", source: "main" } }]);
    expect(git(s.path, "rev-parse", "--abbrev-ref", "HEAD").out).toBe("wip/kyc-1");
    expect(readFileSync(join(s.path, "AGENTS.md"), "utf8")).toContain(`thread 001 ("KYC")`);
    expect(git(s.path, "status", "--porcelain").out).toBe("");
  });

  test("a setup command is used instead of git, with the placeholders filled in", async () => {
    const s = setup(withSetup("echo {root}/{task}/{repo}/{src}/{path} > {root}/setup.log && git -C {root}/{repo} worktree add -q -b wip/{task} {path} {src}"));
    expect(await s.run(s.effect)).toEqual([{ type: "worktree.added", thread: "001", payload: { repo: "api", path: s.path, branch: "wip/kyc-1", source: "main" } }]);
    expect(readFileSync(join(s.root, "setup.log"), "utf8")).toBe(`${s.root}/kyc-1/api/main/${s.path}\n`);
    expect(git(s.path, "rev-parse", "--abbrev-ref", "HEAD").out).toBe("wip/kyc-1");
    expect(existsSync(join(s.path, "AGENTS.md"))).toBe(true);
  });

  test("the setup command runs in <root> and its placeholders are shell-quoted", async () => {
    const s = setup(withSetup("pwd > out.log; printf '%s\\n' {src} >> out.log; git -C {repo} worktree add -q -b wip/{task} {path} main"));
    expect(await s.run({ ...s.effect, source: "a b;echo x" })).toHaveLength(1);
    expect(readFileSync(join(s.root, "out.log"), "utf8")).toBe(`${s.root}\na b;echo x\n`);
  });

  test("a setup command that exits 1 after creating the worktree leaves nothing behind", async () => {
    const s = setup(withSetup("git -C {root}/{repo} worktree add -q -b wip/{task} {path} {src} && exit 1"));
    await expect(s.run(s.effect)).rejects.toThrow("worktree setup for api failed");
    s.nothingLeft();
  });

  test("a setup command that does not produce the worktree fails with the verification message", async () => {
    const s = setup(withSetup("true"));
    await expect(s.run(s.effect)).rejects.toThrow(`worktree setup for api did not produce ${s.path} on wip/kyc-1`);
    s.nothingLeft();
  });

  test("a setup command that leaves the worktree on another branch is undone", async () => {
    const s = setup(withSetup("git -C {root}/{repo} worktree add -q -b other {path} {src}"));
    await expect(s.run(s.effect)).rejects.toThrow(`worktree setup for api did not produce ${s.path} on wip/kyc-1`);
    s.nothingLeft();
  });

  test("a nonexistent source branch throws and leaves nothing behind", async () => {
    const s = setup(ConfigSchema.parse({}));
    await expect(s.run({ ...s.effect, source: "nope" })).rejects.toThrow("git worktree add failed");
    s.nothingLeft();
  });

  test("an existing wip/<task> branch is kept when the add fails", async () => {
    const s = setup(ConfigSchema.parse({}));
    git(s.api, "branch", "wip/kyc-1");
    await expect(s.run(s.effect)).rejects.toThrow("git worktree add failed");
    expect(git(s.api, "rev-parse", "--verify", "--quiet", "refs/heads/wip/kyc-1").ok).toBe(true);
    expect(existsSync(s.path)).toBe(false);
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
