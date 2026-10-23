import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentsMd, writeAgentsFiles } from "../../src/agents/agents-md.ts";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { createEffectRunner } from "../../src/daemon/effects.ts";
import { addWorktree } from "../../src/project/git.ts";
import type { Thread } from "../../src/state/projection.ts";
import { tempRepo } from "../helpers.ts";

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

const SECTION = "# AgentThread\n\nsection body\n";

function repoWith(files: Record<string, string>): { root: string; wt: string } {
  const root = tempRepo();
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  if (Object.keys(files).length) {
    git(root, "add", ...Object.keys(files));
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
    for (const x of ["agt ticket add 002", "agt worker spawn 002 --ticket <T>", "agt ticket reopen 002/<T>", "HANDOFF REQUEST", "git commit", "agt thread status 002 review"]) {
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
    writeAgentsFiles({ root, worktree: wt, content: SECTION });
    expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toBe(SECTION);
    expectSymlink(wt);
    expect(status(wt)).toBe("");
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf8").split("\n");
    expect(exclude).toContain("/AGENTS.md");
    expect(exclude).toContain("/CLAUDE.md");
  });

  test("project tracking AGENTS.md: project content first, then the section; skip-worktree", () => {
    const { root, wt } = repoWith({ "AGENTS.md": "# Project rules\n\nBe nice.\n" });
    writeAgentsFiles({ root, worktree: wt, content: SECTION });
    expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toBe(`# Project rules\n\nBe nice.\n\n\n${SECTION}`);
    expectSymlink(wt);
    expect(status(wt)).toBe("");
    // the main checkout's own file is untouched
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("# Project rules\n\nBe nice.\n");
  });

  test("project tracking only CLAUDE.md: it seeds AGENTS.md and becomes the symlink", () => {
    const { root, wt } = repoWith({ "CLAUDE.md": "Claude rules\n" });
    writeAgentsFiles({ root, worktree: wt, content: SECTION });
    expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toBe(`Claude rules\n\n\n${SECTION}`);
    expectSymlink(wt);
    expect(status(wt)).toBe("");
    expect(lstatSync(join(root, "CLAUDE.md")).isSymbolicLink()).toBe(false);
  });

  test("project tracking both: AGENTS.md content wins, both skip-worktree", () => {
    const { root, wt } = repoWith({ "AGENTS.md": "A\n", "CLAUDE.md": "C\n" });
    writeAgentsFiles({ root, worktree: wt, content: SECTION });
    expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toBe(`A\n\n\n${SECTION}`);
    expectSymlink(wt);
    expect(status(wt)).toBe("");
  });

  test("running twice is idempotent: same content, no duplicate exclude lines", () => {
    for (const files of [{}, { "AGENTS.md": "P\n" }, { "CLAUDE.md": "C\n" }] as Record<string, string>[]) {
      const { root, wt } = repoWith(files);
      writeAgentsFiles({ root, worktree: wt, content: SECTION });
      const first = readFileSync(join(wt, "AGENTS.md"), "utf8");
      writeAgentsFiles({ root, worktree: wt, content: SECTION });
      expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toBe(first);
      expectSymlink(wt);
      expect(status(wt)).toBe("");
      const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf8").split("\n");
      expect(exclude.filter((l) => l === "/AGENTS.md").length).toBeLessThanOrEqual(1);
      expect(exclude.filter((l) => l === "/CLAUDE.md").length).toBeLessThanOrEqual(1);
    }
  });

  test("updated content replaces the old section", () => {
    const { root, wt } = repoWith({ "AGENTS.md": "P\n" });
    writeAgentsFiles({ root, worktree: wt, content: SECTION });
    writeAgentsFiles({ root, worktree: wt, content: "# AgentThread\n\nv2\n" });
    expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toBe("P\n\n\n# AgentThread\n\nv2\n");
  });

  test("git add -A && git commit never includes either file", () => {
    for (const files of [{}, { "AGENTS.md": "P\n" }, { "CLAUDE.md": "C\n" }] as Record<string, string>[]) {
      const { root, wt } = repoWith(files);
      writeAgentsFiles({ root, worktree: wt, content: SECTION });
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

describe("effect runner", () => {
  const LAYOUT = { workspace: "w", mainTab: "t", managerPane: "p0", loggerPane: "p1", herdrBin: "/nonexistent/herdr" };

  test("writes AGENTS.md after git.worktree.add and again before every agent.spawn", () => {
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
    run({ kind: "git.worktree.add", branch: "thread/001-fix-race", path: wt, thread: { id: "001", title: "Fix race", slug: "fix-race" } });
    expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toContain(`thread 001 ("Fix race")`);
    expectSymlink(wt);
    expect(status(wt)).toBe("");

    rmSync(join(wt, "AGENTS.md"));
    const spawn = { kind: "agent.spawn", session: "s-1", role: "coordinator", name: "coord", thread: "001", cwd: wt, pane: "p2" } as const;
    expect(run(spawn)).toEqual([]);
    expect(readFileSync(join(wt, "AGENTS.md"), "utf8")).toBe(agentsMd({ root, thread }));
    expect(launched).toEqual(["s-1"]);

    // a failed write is logged and does not block the spawn
    rmSync(wt, { recursive: true, force: true });
    expect(run({ ...spawn, session: "s-2" })).toEqual([]);
    expect(launched).toEqual(["s-1", "s-2"]);
    expect(existsSync(join(wt, "AGENTS.md"))).toBe(false);
    expect(logs.some((m) => m.includes("writing AGENTS.md for thread 001 failed"))).toBe(true);
  });
});
