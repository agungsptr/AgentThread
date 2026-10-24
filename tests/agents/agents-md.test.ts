import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentsMd, writeAgentsFiles } from "../../src/agents/agents-md.ts";
import { type Runner, spawnRunner } from "../../src/herdr/bridge.ts";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { createEffectRunner } from "../../src/daemon/effects.ts";
import { addWorktree } from "../../src/project/git.ts";
import type { Thread } from "../../src/state/projection.ts";
import { isolatedConfigHome, tempRepo } from "../helpers.ts";

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

const SECTION = "# AgentThread\n\nsection body\n";

// Never read the developer's global git config or excludes.
const HOME = isolatedConfigHome();
const envFor = (home: string) => ({ ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), GIT_CONFIG_GLOBAL: join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" });
const ENV = envFor(HOME);
const write = (o: { root: string; worktree: string; content: string }, env: Record<string, string | undefined> = ENV) =>
  writeAgentsFiles({ ...o, env });

function repoWith(files: Record<string, string>, links: Record<string, string> = {}): { root: string; wt: string } {
  const root = tempRepo();
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  for (const [name, target] of Object.entries(links)) symlinkSync(target, join(root, name));
  const all = [...Object.keys(files), ...Object.keys(links)];
  if (all.length) {
    git(root, "add", ...all);
    git(root, "commit", "-q", "-m", "project files");
  }
  const wt = join(root, ".worktrees", "001-x");
  addWorktree(root, "thread/001-x", wt);
  return { root, wt };
}

function expectSymlink(wt: string) {
  const claude = join(wt, "CLAUDE.md");
  expect(lstatSync(claude).isSymbolicLink()).toBe(true);
  expect(readlinkSync(claude)).toBe("AGENTS.md");
  expect(readFileSync(claude, "utf8")).toBe(readFileSync(join(wt, "AGENTS.md"), "utf8"));
}

const lines = (t: string) => t.split("\n").map((l) => l.replace(/\r$/, ""));

const status = (wt: string) => git(wt, "status", "--porcelain");

describe("agentsMd", () => {
  const T = { id: "002", title: "Fix race", slug: "fix-race", worktree: "/repo/.worktrees/002-fix-race" };
  const DIR = "/repo/.agentthread/threads/002-fix-race";

  test("has the common, working-memory, coordinator and worker sections", () => {
    const s = agentsMd({ root: "/repo", thread: T });
    expect(s.startsWith("# AgentThread\n")).toBe(true);
    for (const h of ["## Working memory (required)", "## Coordinator", "## Worker"]) expect(s).toContain(`\n${h}\n`);
    expect(s.indexOf("## Working memory")).toBeLessThan(s.indexOf("## Coordinator"));
    expect(s.indexOf("## Coordinator")).toBeLessThan(s.indexOf("## Worker"));
    for (const x of [`thread 002 ("Fix race")`, "/repo", `${DIR}/brief.md`, `${DIR}/sub.thread.md`, `${DIR}/board.md`, "$AGT_ROLE"]) {
      expect(s).toContain(x);
    }
    const memory = s.slice(s.indexOf("## Working memory"), s.indexOf("## Coordinator"));
    for (const x of ["agt note 002", "agt progress 002", "agt question 002", "--summary", "Before ending a turn"]) expect(memory).toContain(x);
    const coord = s.slice(s.indexOf("## Coordinator"), s.indexOf("## Worker"));
    for (const x of ["agt ticket add 002", "agt worker spawn 002 --ticket <T>", "agt ticket reopen 002/<T>", "HANDOFF REQUEST", "git commit", "agt thread status 002 review", "Never run git update-index --no-skip-worktree and never commit AGENTS.md or CLAUDE.md. If merging or rebasing main is blocked by them, ask with agt question."]) {
      expect(coord).toContain(x);
    }
    const worker = s.slice(s.indexOf("## Worker"));
    for (const x of ["agt ticket claim 002/<T>", "agt ticket done 002/<T> --summary", "agt ticket block 002/<T>", "Do not commit", "$AGT_TICKET"]) {
      expect(worker).toContain(x);
    }
  });
});

describe("writeAgentsFiles", () => {
  test("project without AGENTS.md/CLAUDE.md: both written, symlinked, excluded", () => {
    const { root, wt } = repoWith({});
    write({ root, worktree: wt, content: SECTION });
    expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toBe(SECTION);
    expectSymlink(wt);
    expect(status(wt)).toBe("");
    const excludes = readFileSync(join(root, ".agentthread", "worktree-excludes"), "utf8").split("\n");
    expect(excludes).toContain("/AGENTS.md");
    expect(excludes).toContain("/CLAUDE.md");
    expect(git(wt, "config", "--worktree", "--get", "core.excludesFile").trim()).toBe(join(root, ".agentthread", "worktree-excludes"));
    // the shared info/exclude stays untouched, so the main checkout is unaffected
    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8")).not.toContain("AGENTS.md");
  });

  test("project tracking AGENTS.md: project content first, then the section; skip-worktree", () => {
    const { root, wt } = repoWith({ "AGENTS.md": "# Project rules\n\nBe nice.\n" });
    write({ root, worktree: wt, content: SECTION });
    expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toBe(`# Project rules\n\nBe nice.\n\n\n${SECTION}`);
    expectSymlink(wt);
    expect(status(wt)).toBe("");
    // the main checkout's own file is untouched
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("# Project rules\n\nBe nice.\n");
  });

  test("project tracking only CLAUDE.md: it seeds AGENTS.md and becomes the symlink", () => {
    const { root, wt } = repoWith({ "CLAUDE.md": "Claude rules\n" });
    write({ root, worktree: wt, content: SECTION });
    expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toBe(`Claude rules\n\n\n${SECTION}`);
    expectSymlink(wt);
    expect(status(wt)).toBe("");
    expect(lstatSync(join(root, "CLAUDE.md")).isSymbolicLink()).toBe(false);
  });

  test("project tracking both with different content: AGENTS.md, then CLAUDE.md under a heading; both skip-worktree", () => {
    const { root, wt } = repoWith({ "AGENTS.md": "A\n", "CLAUDE.md": "C\n" });
    write({ root, worktree: wt, content: SECTION });
    expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toBe(`A\n\n\n# From the project's CLAUDE.md\n\nC\n\n\n${SECTION}`);
    expectSymlink(wt);
    expect(status(wt)).toBe("");
    // running again reads HEAD, not the rewritten file: nothing doubles up
    write({ root, worktree: wt, content: SECTION });
    expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toBe(`A\n\n\n# From the project's CLAUDE.md\n\nC\n\n\n${SECTION}`);
  });

  test("project tracking both with the same content: it is included once", () => {
    const { root, wt } = repoWith({ "AGENTS.md": "Same\n", "CLAUDE.md": "Same\n" });
    write({ root, worktree: wt, content: SECTION });
    expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toBe(`Same\n\n\n${SECTION}`);
  });

  test("project tracking AGENTS.md and a CLAUDE.md symlink to it: included once", () => {
    const { root, wt } = repoWith({ "AGENTS.md": "A\n" }, { "CLAUDE.md": "AGENTS.md" });
    write({ root, worktree: wt, content: SECTION });
    expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toBe(`A\n\n\n${SECTION}`);
    expectSymlink(wt);
    expect(status(wt)).toBe("");
  });

  test("running twice is idempotent: same content, no duplicate exclude lines", () => {
    for (const files of [{}, { "AGENTS.md": "P\n" }, { "CLAUDE.md": "C\n" }] as Record<string, string>[]) {
      const { root, wt } = repoWith(files);
      write({ root, worktree: wt, content: SECTION });
      const first = readFileSync(join(wt, "AGENTS.md"), "utf8");
      write({ root, worktree: wt, content: SECTION });
      expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toBe(first);
      expectSymlink(wt);
      expect(status(wt)).toBe("");
      const exclude = readFileSync(join(root, ".agentthread", "worktree-excludes"), "utf8").split("\n");
      expect(exclude.filter((l) => l === "/AGENTS.md").length).toBe(1);
      expect(exclude.filter((l) => l === "/CLAUDE.md").length).toBe(1);
    }
  });

  test("updated content replaces the old section", () => {
    const { root, wt } = repoWith({ "AGENTS.md": "P\n" });
    write({ root, worktree: wt, content: SECTION });
    write({ root, worktree: wt, content: "# AgentThread\n\nv2\n" });
    expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toBe("P\n\n\n# AgentThread\n\nv2\n");
  });

  test("git add -A && git commit never includes either file", () => {
    for (const files of [{}, { "AGENTS.md": "P\n" }, { "CLAUDE.md": "C\n" }] as Record<string, string>[]) {
      const { root, wt } = repoWith(files);
      write({ root, worktree: wt, content: SECTION });
      writeFileSync(join(wt, "work.txt"), "work\n");
      git(wt, "add", "-A");
      git(wt, "commit", "-q", "-m", "work");
      const changed = git(wt, "show", "--name-only", "--format=", "HEAD").trim().split("\n");
      expect(changed).toEqual(["work.txt"]);
      // the committed tree keeps the project's own versions
      for (const [name, content] of Object.entries(files)) expect(git(wt, "show", `HEAD:${name}`)).toBe(content);
      expect(status(wt)).toBe("");
    }
  });
});

describe("writeAgentsFiles: symlinks, excludes, git operations", () => {
  test("tracked AGENTS.md -> CLAUDE.md: no write-through, no ELOOP, clean status, nothing committed", () => {
    const { root, wt } = repoWith({ "CLAUDE.md": "C\n" }, { "AGENTS.md": "CLAUDE.md" });
    for (let i = 0; i < 2; i++) {
      write({ root, worktree: wt, content: SECTION });
      expect(lstatSync(join(wt, "AGENTS.md")).isFile()).toBe(true);
      expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toBe(`C\n\n\n${SECTION}`);
      expectSymlink(wt);
      expect(status(wt)).toBe("");
    }
    writeFileSync(join(wt, "work.txt"), "w\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "work");
    expect(git(wt, "show", "--name-only", "--format=", "HEAD").trim()).toBe("work.txt");
    expect(git(wt, "show", "HEAD:CLAUDE.md")).toBe("C\n");
  });

  test("tracked AGENTS.md -> docs/AGENTS.md: the target is never overwritten or committed", () => {
    const { root, wt } = repoWith({ "docs/AGENTS.md": "Docs rules\n" }, { "AGENTS.md": "docs/AGENTS.md" });
    write({ root, worktree: wt, content: SECTION });
    write({ root, worktree: wt, content: SECTION });
    expect(lstatSync(join(wt, "AGENTS.md")).isFile()).toBe(true);
    expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toBe(`Docs rules\n\n\n${SECTION}`);
    expect(readFileSync(join(wt, "docs", "AGENTS.md"), "utf8")).toBe("Docs rules\n");
    expectSymlink(wt);
    expect(status(wt)).toBe("");
    writeFileSync(join(wt, "work.txt"), "w\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "work");
    expect(git(wt, "show", "--name-only", "--format=", "HEAD").trim()).toBe("work.txt");
  });

  test("a symlink pointing outside the worktree contributes no project content", () => {
    const { root, wt } = repoWith({}, { "AGENTS.md": "../outside.md" });
    write({ root, worktree: wt, content: SECTION });
    expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toBe(SECTION);
    expect(existsSync(join(root, ".worktrees", "outside.md"))).toBe(false);
    expect(status(wt)).toBe("");
  });

  test("the main checkout can still add its own AGENTS.md and CLAUDE.md", () => {
    const { root, wt } = repoWith({});
    write({ root, worktree: wt, content: SECTION });
    writeFileSync(join(root, "AGENTS.md"), "mine\n");
    writeFileSync(join(root, "CLAUDE.md"), "mine\n");
    expect(git(root, "status", "--porcelain", "--", "AGENTS.md", "CLAUDE.md")).toBe("?? AGENTS.md\n?? CLAUDE.md\n");
    git(root, "add", "AGENTS.md", "CLAUDE.md");
    expect(git(root, "diff", "--cached", "--name-only")).toBe("AGENTS.md\nCLAUDE.md\n");
    expect(status(wt)).toBe("");
  });

  test("removes lines earlier versions put in the shared info/exclude (CRLF-safe)", () => {
    const { root, wt } = repoWith({});
    const info = join(root, ".git", "info", "exclude");
    writeFileSync(info, "# keep\r\n/AGENTS.md\r\n*.tmp\n/CLAUDE.md\n");
    write({ root, worktree: wt, content: SECTION });
    expect(readFileSync(info, "utf8")).toBe("# keep\r\n*.tmp\n");
    expect(status(wt)).toBe("");
  });

  test("the user's global excludes keep applying in the worktree, deduplicated", () => {
    const home = isolatedConfigHome();
    const ignore = join(home, "global-ignore");
    writeFileSync(ignore, "*.log\r\n/AGENTS.md\r\n");
    writeFileSync(join(home, "gitconfig"), `[core]\n\texcludesFile = ${ignore}\n`);
    const env = envFor(home);
    const { root, wt } = repoWith({});
    write({ root, worktree: wt, content: SECTION }, env);
    write({ root, worktree: wt, content: SECTION }, env);
    expect(readFileSync(join(root, ".agentthread", "worktree-excludes"), "utf8")).toBe("*.log\n/AGENTS.md\n/CLAUDE.md\n");
    writeFileSync(join(wt, "debug.log"), "x\n");
    expect(status(wt)).toBe("");
  });

  test("a core.excludesFile from an [include]d global file (with ~) keeps applying in the worktree", () => {
    const home = isolatedConfigHome();
    writeFileSync(join(home, "global-ignore"), "*.log\n");
    writeFileSync(join(home, "extra.gitconfig"), "[core]\n\texcludesFile = ~/global-ignore\n");
    writeFileSync(join(home, "gitconfig"), `[include]\n\tpath = ${join(home, "extra.gitconfig")}\n`);
    // the XDG default holds something else and must not be used
    mkdirSync(join(home, "xdg", "git"), { recursive: true });
    writeFileSync(join(home, "xdg", "git", "ignore"), "*.wrong\n");
    const { root, wt } = repoWith({});
    write({ root, worktree: wt, content: SECTION }, envFor(home));
    expect(readFileSync(join(root, ".agentthread", "worktree-excludes"), "utf8")).toBe("*.log\n/AGENTS.md\n/CLAUDE.md\n");
    writeFileSync(join(wt, "debug.log"), "x\n");
    expect(status(wt)).toBe("");
  });

  test("a repo-local core.excludesFile keeps applying in the worktree", () => {
    const { root, wt } = repoWith({});
    const local = join(isolatedConfigHome(), "repo-ignore");
    writeFileSync(local, "*.tmp\r\n");
    git(root, "config", "core.excludesFile", local);
    write({ root, worktree: wt, content: SECTION });
    writeFileSync(join(wt, "x.tmp"), "x\n");
    expect(status(wt)).toBe("");
    // running again never reads back our own per-worktree value
    write({ root, worktree: wt, content: SECTION });
    expect(readFileSync(join(root, ".agentthread", "worktree-excludes"), "utf8")).toBe("*.tmp\n/AGENTS.md\n/CLAUDE.md\n");
  });

  test("without per-worktree config: falls back to the shared info/exclude and reverts extensions.worktreeConfig", () => {
    const { root, wt } = repoWith({});
    const failing: Runner = (bin, args, env, t) =>
      args.includes("--worktree") && !args.includes("--get")
        ? { exitCode: 129, stdout: "", stderr: "error: unknown option `worktree'" }
        : spawnRunner(bin, args, env, t);
    const logs: string[] = [];
    for (let i = 0; i < 2; i++) writeAgentsFiles({ root, worktree: wt, content: SECTION, env: ENV, runner: failing, log: (m) => logs.push(m) });
    const info = lines(readFileSync(join(root, ".git", "info", "exclude"), "utf8"));
    expect(info.filter((l) => l === "/AGENTS.md").length).toBe(1);
    expect(info.filter((l) => l === "/CLAUDE.md").length).toBe(1);
    expect(Bun.spawnSync(["git", "-C", root, "config", "--get", "extensions.worktreeConfig"]).exitCode).toBe(1);
    expect(logs.some((m) => m.includes("per-worktree excludes unavailable"))).toBe(true);
    expectSymlink(wt);
    expect(status(wt)).toBe("");
  });

  test("skip-worktree survives git stash -u / pop and git reset --hard", () => {
    const { root, wt } = repoWith({ "AGENTS.md": "P\n", "CLAUDE.md": "C\n" });
    write({ root, worktree: wt, content: SECTION });
    writeFileSync(join(wt, "scratch.txt"), "s\n");
    git(wt, "stash", "-u");
    expect(existsSync(join(wt, "scratch.txt"))).toBe(false);
    expect(status(wt)).toBe("");
    git(wt, "stash", "pop");
    expect(status(wt)).toBe("?? scratch.txt\n");
    rmSync(join(wt, "scratch.txt"));
    git(wt, "reset", "-q", "--hard");
    expect(status(wt)).toBe("");
    expect(git(wt, "ls-files", "-v", "AGENTS.md", "CLAUDE.md")).toBe("S AGENTS.md\nS CLAUDE.md\n");
    expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toBe(`P\n\n\n# From the project's CLAUDE.md\n\nC\n\n\n${SECTION}`);
    expectSymlink(wt);
  });
});

function commit(dir: string, env: Record<string, string>) {
  writeFileSync(join(dir, "f.txt"), String(Math.random()));
  git(dir, "add", "f.txt");
  return Bun.spawnSync(["git", "-C", dir, "commit", "-q", "-m", "x"], { env: { ...ENV, ...env }, stdout: "pipe", stderr: "pipe" });
}

describe("worker commit guard", () => {
  test("a worker cannot commit in a thread worktree", () => {
    const { root, wt } = repoWith({});
    write({ root, worktree: wt, content: SECTION });
    const r = commit(wt, { AGT_ROLE: "worker" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("AgentThread: workers do not commit; the coordinator commits.");
  });

  test("the coordinator can commit", () => {
    const { root, wt } = repoWith({});
    write({ root, worktree: wt, content: SECTION });
    expect(commit(wt, { AGT_ROLE: "coordinator" }).exitCode).toBe(0);
  });

  test("the project's own pre-commit hook still runs", () => {
    const { root, wt } = repoWith({});
    const hook = join(root, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho project-hook-ran >&2\nexit 1\n", { mode: 0o755 });
    write({ root, worktree: wt, content: SECTION });
    const r = commit(wt, { AGT_ROLE: "coordinator" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("project-hook-ran");
  });

  test("the main checkout is not affected", () => {
    const { root, wt } = repoWith({});
    write({ root, worktree: wt, content: SECTION });
    expect(Bun.spawnSync(["git", "-C", root, "config", "--get", "core.hooksPath"], { env: ENV }).exitCode).not.toBe(0);
    expect(commit(root, { AGT_ROLE: "worker" }).exitCode).toBe(0);
  });

  test("rerunning is idempotent", () => {
    const { root, wt } = repoWith({});
    write({ root, worktree: wt, content: SECTION });
    const hook = join(root, ".agentthread", "hooks", "pre-commit");
    const before = readFileSync(hook, "utf8");
    write({ root, worktree: wt, content: SECTION });
    expect(readFileSync(hook, "utf8")).toBe(before);
    expect(git(wt, "config", "--worktree", "--get-all", "core.hooksPath")).toBe(`${join(root, ".agentthread", "hooks")}\n`);
  });
});

describe("effect runner", () => {
  const LAYOUT = { workspace: "w", mainTab: "t", managerPane: "p0", loggerPane: "p1", herdrBin: "/nonexistent/herdr" };

  test("writes AGENTS.md after git.worktree.add and again before every agent.spawn", async () => {
    const root = tempRepo();
    const wt = join(root, ".worktrees", "001-fix-race");
    const thread = { id: "001", title: "Fix race", slug: "fix-race", worktree: wt } as Thread;
    const launched: string[] = [];
    const logs: string[] = [];
    const run = createEffectRunner({
      root,
      config: DEFAULT_CONFIG,
      layout: () => LAYOUT,
      thread: (id) => (id === "001" ? thread : undefined),
      launch: (job) => launched.push(job.session),
      log: (m) => logs.push(m),
    });
    await run({ kind: "git.worktree.add", branch: "thread/001-fix-race", path: wt, thread: { id: "001", title: "Fix race", slug: "fix-race" } });
    expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toContain(`thread 001 ("Fix race")`);
    expectSymlink(wt);
    expect(status(wt)).toBe("");

    rmSync(join(wt, "AGENTS.md"));
    const spawn = { kind: "agent.spawn", session: "s-1", role: "coordinator", run: { agent: "claude-code" }, name: "coord", thread: "001", cwd: wt, pane: "p2" } as const;
    expect(await run(spawn)).toEqual([]);
    expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toBe(agentsMd({ root, thread }));
    expect(launched).toEqual(["s-1"]);

    // a failed write is logged and does not block the spawn
    rmSync(wt, { recursive: true, force: true });
    expect(await run({ ...spawn, session: "s-2" })).toEqual([]);
    expect(launched).toEqual(["s-1", "s-2"]);
    expect(existsSync(join(wt, "AGENTS.md"))).toBe(false);
    expect(logs.some((m) => m.includes("writing AGENTS.md for thread 001 failed"))).toBe(true);
  });
});
