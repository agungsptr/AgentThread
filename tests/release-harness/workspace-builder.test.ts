import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { loadConfig } from "../../src/config/config.ts";
import { paths } from "../../src/project/paths.ts";
import { isWorkspaceProject } from "../../src/project/workspace.ts";
import { events, git, removeScratch, scratchWorkspace, writeWorkspaceConfig, wsTask } from "../release/harness.ts";

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

test("writeWorkspaceConfig keeps the workspace and stack, sets the row's agents and merges the row's config", async () => {
  const root = await scratchWorkspace();
  roots.push(root);
  writeWorkspaceConfig(root, { main: "claude-code", coordinator: "claude-code", worker: "opencode" }, { agents: { complexity: { timeout: "1h" } } });
  const raw = parse(readFileSync(join(root, ".agentthread", "config.yaml"), "utf8"));
  expect(Object.keys(raw.workspace.repos).sort()).toEqual(["api", "web"]);
  expect(raw.workflow.stack).toEqual({ restart: "make restart TASK={task}", status: "make status" });
  expect(raw.agents.roles.worker.agent).toBe("opencode");
  expect(raw.agents.roles.coordinator.agent).toBe("claude-code");
  expect(raw.agents.autonomous).toBe(true);
  expect(raw.agents.complexity.timeout).toBe("1h");
  expect(loadConfig(root).agents.roles.worker.agent).toBe("opencode");
});

test("the builder's agt init reads the given XDG_CONFIG_HOME, not the user's", async () => {
  // A user config whose banned word agt init renders into .agentthread/banned-words: it shows which config init read.
  const xdg = realpathSync(mkdtempSync(join(tmpdir(), "agt-e2e-repo-xdg-test-")));
  roots.push(xdg);
  mkdirSync(join(xdg, "agentthread"), { recursive: true });
  writeFileSync(join(xdg, "agentthread", "config.yaml"), "workflow:\n  banned_words: [xdg-probe-word]\n");
  const banned = (root: string) => (existsSync(join(root, ".agentthread", "banned-words")) ? readFileSync(join(root, ".agentthread", "banned-words"), "utf8") : "");
  const given = await scratchWorkspace({}, undefined, xdg);
  roots.push(given);
  expect(banned(given)).toContain("xdg-probe-word");
  // Without one, the builder's own config home leaves the agentthread config out, even the parent's XDG one.
  const before = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const own = await scratchWorkspace();
    roots.push(own);
    expect(existsSync(paths(own).db)).toBe(true);
    expect(banned(own)).not.toContain("xdg-probe-word");
  } finally {
    if (before === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = before;
  }
});
