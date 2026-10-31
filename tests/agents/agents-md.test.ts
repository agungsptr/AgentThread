import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { agentsMd, writeAgentsFiles, writeThreadDirFiles } from "../../src/agents/agents-md.ts";
import { SKILL_REL } from "../../src/agents/skill.ts";
import { type Runner, spawnRunner } from "../../src/herdr/bridge.ts";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { createEffectRunner } from "../../src/daemon/effects.ts";
import type { SpawnJob } from "../../src/agents/spawn-job.ts";
import { addWorktree } from "../../src/project/git.ts";
import type { Thread } from "../../src/state/projection.ts";
import { isolatedConfigHome, tempRepo } from "../helpers.ts";

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

const NO_SKILL = { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents, skill: false } };
const SECTION = "# AgentThread\n\nsection body\n";

// Never read the developer's global git config or excludes.
const HOME = isolatedConfigHome();
const envFor = (home: string) => ({ ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), GIT_CONFIG_GLOBAL: join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" });
const ENV = envFor(HOME);
const write = (o: { root: string; worktree: string; content: string }, env: Record<string, string | undefined> = ENV) =>
  writeAgentsFiles({ ...o, env, config: NO_SKILL });

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
    for (const x of ["agt ticket add 002", "agt worker spawn 002 --ticket <T>", "agt ticket reopen 002/<T>", "HANDOFF REQUEST", "git commit", "agt thread status 002 review", '- Plan before you spawn: split the work into the largest set of tickets that can run in parallel without touching the same files (usually 2–4). Use one ticket only when the work is genuinely a single change. Add each with: agt ticket add 002 "<title>" --scope <path> [--scope <path>].', "- Spawn a worker for every ticket that is ready, all at once, with agt worker spawn 002 --ticket <T>; the daemon queues any beyond max-workers.", "- Do not implement tickets yourself: every change to project files is made by a worker. You may read code and docs, run the tests and the stack, review and commit.", "Never run git update-index --no-skip-worktree and never commit AGENTS.md or CLAUDE.md. If merging or rebasing main is blocked by them, ask with agt question."]) {
      expect(coord).toContain(x);
    }
    const worker = s.slice(s.indexOf("## Worker"));
    for (const x of ["agt ticket claim 002/<T>", 'agt ticket done 002/<T> --summary "<one line>" is your last action: make no edits after it', "agt ticket block 002/<T>", "Do not commit", "$AGT_TICKET"]) {
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
    const excludes = readFileSync(join(root, ".agentthread", "worktree-excludes", basename(root)), "utf8").split("\n");
    expect(excludes).toContain("/AGENTS.md");
    expect(excludes).toContain("/CLAUDE.md");
    expect(git(wt, "config", "--worktree", "--get", "core.excludesFile").trim()).toBe(join(root, ".agentthread", "worktree-excludes", basename(root)));
    // the shared info/exclude stays untouched, so the main checkout is unaffected
    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8")).not.toContain("AGENTS.md");
  });

  test("the old shared excludes file moves to the repo's own file, with every worktree that used it", () => {
    const { root, wt } = repoWith({});
    const shared = join(root, ".agentthread", "worktree-excludes");
    // an earlier version: one shared file, and a second worktree pointing at it
    mkdirSync(join(root, ".agentthread"), { recursive: true });
    writeFileSync(shared, "/AGENTS.md\n/CLAUDE.md\n");
    const other = join(root, ".worktrees", "002-y");
    addWorktree(root, "thread/002-y", other);
    git(root, "config", "extensions.worktreeConfig", "true");
    git(other, "config", "--worktree", "core.excludesFile", shared);
    write({ root, worktree: wt, content: SECTION });
    const file = join(shared, basename(root));
    expect(lstatSync(shared).isDirectory()).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("/AGENTS.md");
    expect(git(wt, "config", "--worktree", "--get", "core.excludesFile").trim()).toBe(file);
    expect(git(other, "config", "--worktree", "--get", "core.excludesFile").trim()).toBe(file);
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
      const exclude = readFileSync(join(root, ".agentthread", "worktree-excludes", basename(root)), "utf8").split("\n");
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
    expect(readFileSync(join(root, ".agentthread", "worktree-excludes", basename(root)), "utf8")).toBe("*.log\n/AGENTS.md\n/CLAUDE.md\n");
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
    expect(readFileSync(join(root, ".agentthread", "worktree-excludes", basename(root)), "utf8")).toBe("*.log\n/AGENTS.md\n/CLAUDE.md\n");
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
    expect(readFileSync(join(root, ".agentthread", "worktree-excludes", basename(root)), "utf8")).toBe("*.tmp\n/AGENTS.md\n/CLAUDE.md\n");
  });

  test("without per-worktree config: falls back to the shared info/exclude and reverts extensions.worktreeConfig", () => {
    const { root, wt } = repoWith({});
    const failing: Runner = (bin, args, env, t) =>
      args.includes("--worktree") && !args.includes("--get")
        ? { exitCode: 129, stdout: "", stderr: "error: unknown option `worktree'" }
        : spawnRunner(bin, args, env, t);
    const logs: string[] = [];
    for (let i = 0; i < 2; i++) writeAgentsFiles({ root, worktree: wt, content: SECTION, env: ENV, config: NO_SKILL, runner: failing, log: (m) => logs.push(m) });
    const info = lines(readFileSync(join(root, ".git", "info", "exclude"), "utf8"));
    expect(info.filter((l) => l === "/AGENTS.md").length).toBe(1);
    expect(info.filter((l) => l === "/CLAUDE.md").length).toBe(1);
    expect(Bun.spawnSync(["git", "-C", root, "config", "--get", "extensions.worktreeConfig"]).exitCode).toBe(1);
    expect(logs.some((m) => m.includes("per-worktree excludes unavailable"))).toBe(true);
    expect(logs).toContain("worker commit guard unavailable: git without worktree config");
    expect(existsSync(join(root, ".agentthread", "hooks"))).toBe(false);
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

  test("a relative core.hooksPath with two worktrees: each runs its own project hook", () => {
    const root = tempRepo();
    git(root, "config", "core.hooksPath", ".githooks");
    const wts = ["001-a", "002-b"].map((n) => join(root, ".worktrees", n));
    mkdirSync(join(root, ".githooks"), { recursive: true });
    writeFileSync(join(root, ".githooks", "pre-commit"), "#!/bin/sh\necho hook-root >&2\nexit 1\n", { mode: 0o755 });
    git(root, "add", ".githooks");
    Bun.spawnSync(["git", "-C", root, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "hooks"], { env: ENV });
    wts.forEach((w, i) => {
      addWorktree(root, `thread/00${i}-x`, w);
      writeFileSync(join(w, ".githooks", "pre-commit"), `#!/bin/sh\necho hook-${i}\nexit 1\n`, { mode: 0o755 });
      write({ root, worktree: w, content: SECTION });
    });
    wts.forEach((w, i) => {
      const r = commit(w, { AGT_ROLE: "coordinator" });
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout.toString() + r.stderr.toString()).toContain(`hook-${i}`);
    });
  });

  test("a hook added after the files were written still runs, commit-msg gets its argument, a path with a space works", () => {
    const root = tempRepo();
    const wt = join(root, ".worktrees", "001 x");
    addWorktree(root, "thread/001-x", wt);
    write({ root, worktree: wt, content: SECTION });
    writeFileSync(join(root, ".git", "hooks", "commit-msg"), '#!/bin/sh\ncase "$1" in *COMMIT_EDITMSG) echo msg-arg-ok >&2;; esac\nexit 1\n', { mode: 0o755 });
    const r = commit(wt, { AGT_ROLE: "coordinator" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("msg-arg-ok");
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

describe("branch-aware commit guard and no-push hook", () => {
  const WIP = "AgentThread: workers commit only on wip/<task>.";
  const FEAT = "AgentThread: the coordinator commits only the squash on feat/<task>.";
  const PUSH = "AgentThread: agents never push; the user pushes.";
  function taskWt(branch: string) {
    const root = tempRepo();
    const wt = join(root, ".worktrees", "t1", "repo");
    addWorktree(root, branch, wt);
    write({ root, worktree: wt, content: SECTION });
    return { root, wt };
  }
  const err = (r: ReturnType<typeof commit>) => r.stderr.toString();

  test("a worker commits on wip/<task> and is refused elsewhere", () => {
    expect(commit(taskWt("wip/t1").wt, { AGT_ROLE: "worker", AGT_TASK: "t1" }).exitCode).toBe(0);
    const r = commit(taskWt("feat/t1").wt, { AGT_ROLE: "worker", AGT_TASK: "t1" });
    expect(r.exitCode).not.toBe(0);
    expect(err(r)).toContain(WIP);
    const other = commit(taskWt("wip/t2").wt, { AGT_ROLE: "worker", AGT_TASK: "t1" });
    expect(other.exitCode).not.toBe(0);
    expect(err(other)).toContain(WIP);
  });

  test("the coordinator commits on feat/<task> and is refused on wip/<task>", () => {
    expect(commit(taskWt("feat/t1").wt, { AGT_ROLE: "coordinator", AGT_TASK: "t1" }).exitCode).toBe(0);
    const r = commit(taskWt("wip/t1").wt, { AGT_ROLE: "coordinator", AGT_TASK: "t1" });
    expect(r.exitCode).not.toBe(0);
    expect(err(r)).toContain(FEAT);
  });

  test("with no AGT_ROLE, or main, any branch commits", () => {
    expect(commit(taskWt("wip/t1").wt, {}).exitCode).toBe(0);
    expect(commit(taskWt("feat/t1").wt, { AGT_ROLE: "main" }).exitCode).toBe(0);
    expect(commit(taskWt("other/x").wt, {}).exitCode).toBe(0);
  });

  test("legacy thread/* branches: the worker is refused with the old message, the coordinator commits", () => {
    const { wt } = taskWt("thread/x");
    const r = commit(wt, { AGT_ROLE: "worker", AGT_TASK: "t1" });
    expect(r.exitCode).not.toBe(0);
    expect(err(r)).toContain("AgentThread: workers do not commit; the coordinator commits.");
    expect(commit(wt, { AGT_ROLE: "coordinator" }).exitCode).toBe(0);
  });

  test("any agent role is refused a push; no role pushes; the project's pre-commit still runs after an allowed commit", () => {
    const { root, wt } = taskWt("wip/t1");
    const bare = mkdtempSync(join(tmpdir(), "agt-bare-"));
    git(bare, "init", "-q", "--bare");
    git(root, "remote", "add", "origin", bare);
    const push = (env: Record<string, string>) =>
      Bun.spawnSync(["git", "-C", wt, "push", "-q", "origin", "HEAD:refs/heads/wip/t1"], { env: { ...ENV, ...env }, stdout: "pipe", stderr: "pipe" });
    for (const role of ["worker", "coordinator", "main"]) {
      const r = push({ AGT_ROLE: role });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr.toString()).toContain(PUSH);
    }
    expect(push({}).exitCode).toBe(0);
    writeFileSync(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho project-hook-ran >&2\nexit 1\n", { mode: 0o755 });
    const c = commit(wt, { AGT_ROLE: "worker", AGT_TASK: "t1" });
    expect(c.exitCode).not.toBe(0);
    expect(err(c)).toContain("project-hook-ran");
    rmSync(bare, { recursive: true, force: true });
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

test("a core.hooksPath of ~/x is expanded, so the project's own hook still runs", () => {
  const { root, wt } = repoWith({});
  git(root, "config", "core.hooksPath", "~/x");
  mkdirSync(join(HOME, "x"), { recursive: true });
  writeFileSync(join(HOME, "x", "pre-commit"), "#!/bin/sh\necho home-hook-ran >&2\nexit 1\n", { mode: 0o755 });
  write({ root, worktree: wt, content: SECTION });
  expect(git(wt, "config", "--worktree", "--get", "agentthread.hooksPath").trim()).toBe(join(HOME, "x"));
  const r = commit(wt, { AGT_ROLE: "coordinator" });
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toContain("home-hook-ran");
});

describe("thread directory", () => {
  const LAYOUT = { workspace: "w", mainTab: "t", managerPane: "p0", loggerPane: "p1", herdrBin: "/nonexistent/herdr" };
  const workspace = () => realpathSync(mkdtempSync(join(tmpdir(), "agt-ws-")));

  test("writeThreadDirFiles writes AGENTS.md, the CLAUDE.md symlink and the skill plainly into a non-git dir", () => {
    const root = workspace();
    const dir = join(root, ".worktrees", "kyc-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CLAUDE.md"), "stale");
    writeThreadDirFiles({ root, dir, content: SECTION, config: DEFAULT_CONFIG });
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(SECTION);
    expectSymlink(dir);
    expect(readFileSync(join(dir, SKILL_REL), "utf8")).toContain("name: agt");
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(existsSync(join(root, ".agentthread", "worktree-excludes"))).toBe(false);
  });

  test("thread.dir.ensure makes the directory and writes the files; agent.spawn rewrites them there", async () => {
    const root = workspace();
    const dir = join(root, ".worktrees", "kyc-1");
    const thread = { id: "001", title: "Fix login", slug: "fix-login", task: "kyc-1", dir, worktrees: {}, legacy: false } as unknown as Thread;
    const launched: string[] = [];
    const jobs: SpawnJob[] = [];
    const logs: string[] = [];
    const run = createEffectRunner({
      root,
      config: NO_SKILL,
      layout: () => LAYOUT,
      thread: (id) => (id === "001" ? thread : undefined),
      launch: (job) => {
        launched.push(job.session);
        jobs.push(job);
      },
      log: (m) => logs.push(m),
    });
    expect(await run({ kind: "thread.dir.ensure", thread: { id: "001", title: "Fix login", slug: "fix-login", task: "kyc-1", dir } })).toEqual([]);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain(`thread 001 ("Fix login")`);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain(dir);
    expectSymlink(dir);

    rmSync(join(dir, "AGENTS.md"));
    const spawn = { kind: "agent.spawn", session: "s-1", role: "coordinator", run: { agent: "claude-code" }, name: "coord", thread: "001", cwd: dir, pane: "p2" } as const;
    expect(await run(spawn)).toEqual([]);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(agentsMd({ root, thread, config: NO_SKILL }));
    expect(launched).toEqual(["s-1"]);
    expect(logs).toEqual([]);
    // a worker split from the coordinator: its pane env stops git at .worktrees
    const { pane: _p, ...split } = spawn;
    expect(await run({ ...split, session: "s-2", role: "worker", ticket: "T1", splitFrom: "p2", direction: "down" })).toEqual([]);
    expect(jobs.at(-1)?.split?.env).toMatchObject({ GIT_CEILING_DIRECTORIES: join(root, ".worktrees"), AGT_ROLE: "worker" });
  });
});
