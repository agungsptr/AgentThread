import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { loadConfig } from "../../src/config/config.ts";
import { paths } from "../../src/project/paths.ts";
import { isWorkspaceProject } from "../../src/project/workspace.ts";
import { events, git, removeScratch, scratchWorkspace, wsTask } from "../release/harness.ts";

const roots: string[] = [];
afterAll(() => roots.forEach((r) => removeScratch(r)));

const built = (async () => {
  const root = await scratchWorkspace({ api: ["api hint one"], web: ["web hint one", "web hint two"] });
  roots.push(root);
  return root;
})();

test("api and web are repos on main with one commit each; .docs is a git repo", async () => {
  const root = await built;
  for (const repo of ["api", "web"]) {
    expect((await git(join(root, repo), "rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe("main");
    expect((await git(join(root, repo), "rev-list", "--count", "HEAD")).trim()).toBe("1");
    expect((await git(join(root, repo), "status", "--porcelain")).trim()).toBe("");
    expect(existsSync(join(root, repo, "tests"))).toBe(true);
    expect(existsSync(join(root, repo, "src", "index.ts"))).toBe(true);
  }
  expect(existsSync(join(root, "Makefile"))).toBe(true);
  expect((await git(join(root, ".docs"), "rev-parse", "--is-inside-work-tree")).trim()).toBe("true");
});

test("the config parses and lists both repos with their checks and the stack commands", async () => {
  const root = await built;
  const raw = parse(readFileSync(join(root, ".agentthread", "config.yaml"), "utf8"));
  expect(raw.workspace.repos).toEqual({
    api: { path: "api", source_branch: "main", unit: "bun test", typecheck: "bun run typecheck" },
    web: { path: "web", source_branch: "main", unit: "bun test", typecheck: "bun run typecheck" },
  });
  expect(raw.workflow.stack).toEqual({ restart: "make restart TASK={task}", status: "make status" });
  const config = loadConfig(root);
  expect(Object.keys(config.workspace.repos ?? {}).sort()).toEqual(["api", "web"]);
});

test("the root is a workspace project, and agt agrees", async () => {
  const root = await built;
  expect(isWorkspaceProject(root)).toBe(true);
  // `agt init` ran against this root: its event log starts with project.initialized, and the repos were found.
  expect((await events(root)).map((e) => e.type)).toContain("project.initialized");
  expect(existsSync(paths(root).db)).toBe(true);
});

test("hints are appended to each repo's AGENTS.md", async () => {
  const root = await built;
  const api = readFileSync(join(root, "api", "AGENTS.md"), "utf8");
  const web = readFileSync(join(root, "web", "AGENTS.md"), "utf8");
  expect(api).toContain("- api hint one");
  expect(api).not.toContain("web hint");
  expect(web).toContain("- web hint one");
  expect(web).toContain("- web hint two");
});

test("a root outside the scratch base throws before any git runs", async () => {
  const outside = realpathSync(mkdtempSync(join(process.env.HOME ?? "/", "agt-ws-outside-")));
  try {
    expect(tmpdir().startsWith(outside)).toBe(false);
    await expect(scratchWorkspace({}, outside)).rejects.toThrow(/scratch base/);
    expect(existsSync(join(outside, "api"))).toBe(false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("wsTask reads the task id and worktrees from the event log", async () => {
  const root = await built;
  expect(wsTask).toBeFunction();
  await expect(wsTask(root, "nope")).rejects.toThrow();
});
