import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config/config.ts";
import { SETUP_HINT, detectAgents, needsSetup, initCommand, runSetup, setupIfNeeded } from "../../src/project/setup.ts";
import { isolatedConfigHome, tempRepo, twoRepoFolder } from "../helpers.ts";
import { repoName } from "../helpers.ts";

const script = (answers: string[]) => {
  const asked: string[] = [];
  const ask = async (q: string, def?: string) => {
    asked.push(q);
    // Past the scripted answers the user presses enter (the workflow questions come last).
    const a = answers.shift() ?? "";
    return a === "" && def !== undefined ? def : a;
  };
  return { ask, asked };
};
const cfg = (root: string) => join(root, ".agentthread", "config.yaml");
const env = () => ({ XDG_CONFIG_HOME: isolatedConfigHome(), HOME: "/nonexistent" });

test("written YAML round-trips through loadConfig", async () => {
  const root = tempRepo();
  const { ask } = script([
    "claude-code", "opus", "high",
    "codex", "", "",
    "claude-code", "sonnet", "low",
    "deep", "claude-code", "opus", "max",
    "",
    "30s",
  ]);
  await runSetup({ root, ask, detected: ["claude-code", "codex"] });
  const c = loadConfig(root, env());
  expect(c.agents.roles.main).toEqual({ agent: "claude-code", model: "opus", effort: "high" });
  expect(c.agents.roles.coordinator).toEqual({ agent: "codex" });
  expect(c.agents.roles.worker).toEqual({ agent: "claude-code", model: "sonnet", effort: "low" });
  expect(c.agents.complexity.tiers.deep).toEqual({ agent: "claude-code", model: "opus", effort: "max" });
  expect(c.agents.complexity.timeout).toBe("30s");
  expect(c.agents.autonomous).toBe(true);
  expect(needsSetup(root)).toBe(false);
});

test("keeps other keys and comments", async () => {
  const root = tempRepo();
  mkdirSync(join(root, ".agentthread"), { recursive: true });
  writeFileSync(cfg(root), "workers:\n  max_workers: 5 # keep me\n");
  const { ask } = script(["", "", "", "", "", "", "", "", "", "", ""]);
  await runSetup({ root, ask, detected: ["claude-code"] });
  const text = readFileSync(cfg(root), "utf8");
  expect(text).toContain("max_workers: 5 # keep me");
  expect(loadConfig(root, env()).workers.max_workers).toBe(5);
});

test("an undetected agent is refused and re-asked", async () => {
  const root = tempRepo();
  const { ask } = script(["opencode", "claude-code", "", "", "", "", "", "", "", "", "", ""]);
  const errs: string[] = [];
  const orig = console.error;
  console.error = (m: string) => void errs.push(String(m));
  try {
    await runSetup({ root, ask, detected: ["claude-code"] });
  } finally {
    console.error = orig;
  }
  expect(errs).toContain("opencode is not installed (looked for opencode on PATH)");
  expect(loadConfig(root, env()).agents.roles.main.agent).toBe("claude-code");
});

test("a bad effort re-asks", async () => {
  const root = tempRepo();
  const { ask, asked } = script(["claude-code", "", "bogus", "turbo", "high", "", "", "", "", "", "", "", ""]);
  const orig = console.error;
  console.error = () => {};
  try {
    await runSetup({ root, ask, detected: ["claude-code"] });
  } finally {
    console.error = orig;
  }
  expect(asked.filter((q) => q.includes("main") && q.toLowerCase().includes("effort")).length).toBe(3);
  expect(loadConfig(root, env()).agents.roles.main.effort).toBe("high");
});

test("needsSetup is true only without agents.roles", () => {
  const root = tempRepo();
  const e = env();
  expect(needsSetup(root, e)).toBe(true);
  mkdirSync(join(root, ".agentthread"), { recursive: true });
  writeFileSync(cfg(root), "workers:\n  max_workers: 2\n");
  expect(needsSetup(root, e)).toBe(true);
  writeFileSync(cfg(root), "agents:\n  roles:\n    main: { agent: codex }\n");
  expect(needsSetup(root, e)).toBe(false);
});

test("detectAgents uses bin and AGT_<AGENT>_BIN overrides", () => {
  const seen: string[] = [];
  const which = (b: string) => (seen.push(b), b === "codex" || b === "/x/claude" ? `/bin/${b}` : null);
  expect(detectAgents(which, { AGT_CLAUDE_BIN: "/x/claude" })).toEqual(["claude-code", "codex"]);
});

test("needsSetup reads the merged config: agents.roles in the user file is enough", () => {
  const root = tempRepo();
  const xdg = isolatedConfigHome();
  const env = { XDG_CONFIG_HOME: xdg, HOME: "/nonexistent" };
  expect(needsSetup(root, env)).toBe(true);
  mkdirSync(join(xdg, "agentthread"), { recursive: true });
  writeFileSync(join(xdg, "agentthread", "config.yaml"), "agents:\n  roles:\n    main: { agent: codex }\n");
  expect(needsSetup(root, env)).toBe(false);
});

test("SETUP_HINT does not claim claude-code for every role", () => {
  expect(SETUP_HINT).toBe("run agt setup (or edit .agentthread/config.yaml) to choose agents per role; using the configured defaults (claude-code unless set)");
});

test("the wizard asks again for an opencode effort without a model", async () => {
  const root = tempRepo();
  const { ask } = script(["opencode", "", "high", "", "", "claude-code", "", "", "claude-code", "", "", "", "10s"]);
  const errors: string[] = [];
  const orig = console.error;
  console.error = (m: string) => void errors.push(m);
  try {
    await runSetup({ root, ask, detected: ["claude-code", "opencode"] });
  } finally {
    console.error = orig;
  }
  expect(errors).toContain("opencode effort needs a model");
  expect(loadConfig(root, env()).agents.roles.main).toEqual({ agent: "opencode" });
});

test("a bare `agents:` (null) gets agents.roles, keeping other keys and comments", async () => {
  const root = tempRepo();
  mkdirSync(join(root, ".agentthread"), { recursive: true });
  writeFileSync(cfg(root), "# top\nagents:\nworkers:\n  max_workers: 5 # keep me\n");
  const { ask } = script(["", "", "", "", "", "", "", "", "", "", ""]);
  await runSetup({ root, ask, detected: ["claude-code"] });
  const text = readFileSync(cfg(root), "utf8");
  expect(text).toContain("# top");
  expect(text).toContain("max_workers: 5 # keep me");
  const c = loadConfig(root, env());
  expect(c.agents.roles.main).toEqual({ agent: "claude-code" });
  expect(c.workers.max_workers).toBe(5);
});

test("re-running setup replaces roles and complexity with no stale tier", async () => {
  const root = tempRepo();
  const first = script(["", "", "", "", "", "", "", "", "", "old", "", "", "", "", "20s"]);
  await runSetup({ root, ask: first.ask, detected: ["claude-code"] });
  expect(loadConfig(root, env()).agents.complexity.tiers.old).toBeDefined();
  const second = script(["", "", "", "", "", "", "", "", "", "", ""]);
  await runSetup({ root, ask: second.ask, detected: ["claude-code"] });
  const c = loadConfig(root, env());
  expect(c.agents.complexity.tiers).toEqual({});
  expect(c.agents.complexity.timeout).toBe("10s");
  expect(readFileSync(cfg(root), "utf8")).not.toContain("old");
});

test("an opencode effort with an empty model re-asks the model", async () => {
  const root = tempRepo();
  const { ask, asked } = script([
    "opencode", "", "high", "prov/model", "high",
    "", "", "", "", "", "", "", "", "",
  ]);
  const errs: string[] = [];
  const orig = console.error;
  console.error = (m: string) => void errs.push(String(m));
  try {
    await runSetup({ root, ask, detected: ["opencode"] });
  } finally {
    console.error = orig;
  }
  expect(errs).toContain("opencode effort needs a model");
  expect(asked.filter((q) => q.startsWith("main model")).length).toBe(2);
  expect(loadConfig(root, env()).agents.roles.main).toEqual({ agent: "opencode", model: "prov/model", effort: "high" });
});

const NO_BINS = { AGT_CLAUDE_BIN: "/nonexistent/a", AGT_OPENCODE_BIN: "/nonexistent/b", AGT_CODEX_BIN: "/nonexistent/c", AGT_OMP_BIN: "/nonexistent/d", AGT_AGY_BIN: "/nonexistent/agy" };
const HINT = "no supported agent found; install one (see README) and run agt setup";

test("initCommand on a TTY with no agent prints initialized, then the hint, and returns 0", async () => {
  const root = tempRepo();
  const lines: string[] = [];
  const [ol, oe] = [console.log, console.error];
  console.log = (m: string) => void lines.push(`out:${m}`);
  console.error = (m: string) => void lines.push(`err:${m}`);
  let code: number;
  try {
    code = await initCommand(root, { ...env(), ...NO_BINS }, "x", true);
  } finally {
    [console.log, console.error] = [ol, oe];
  }
  expect(code).toBe(0);
  expect(lines).toEqual(["out:initialized", `err:${HINT}`]);
});

test("setupIfNeeded (agt start) on a TTY with no agent prints the hint and continues instead of prompting", async () => {
  const root = tempRepo();
  const errs: string[] = [];
  const orig = console.error;
  console.error = (m: string) => void errs.push(String(m));
  try {
    await setupIfNeeded(root, { ...env(), ...NO_BINS }, true);
  } finally {
    console.error = orig;
  }
  expect(errs).toEqual([HINT]);
});

test("a comment-only config.yaml keeps its comment after setup", async () => {
  const root = tempRepo();
  mkdirSync(join(root, ".agentthread"), { recursive: true });
  writeFileSync(cfg(root), "# my notes\n");
  const { ask } = script(["", "", "", "", "", "", "", "", "", "", ""]);
  await runSetup({ root, ask, detected: ["claude-code"] });
  expect(readFileSync(cfg(root), "utf8")).toContain("# my notes");
  expect(loadConfig(root, env()).agents.roles.main).toEqual({ agent: "claude-code" });
});

test("the wizard records a workspace's repos and source branches", async () => {
  const root = twoRepoFolder();
  const { ask } = script(["claude-code", "", "", "claude-code", "", "", "claude-code", "", "", "", "", "develop", ""]);
  await runSetup({ root, ask, detected: ["claude-code"] });
  expect(loadConfig(root, env()).workspace.repos).toEqual({ a: { path: "a", source_branch: "develop" }, b: { path: "b" } });
});

test("I4: a re-run with blank answers keeps a hand-added repo and an existing source_branch", async () => {
  const root = twoRepoFolder();
  mkdirSync(join(root, ".agentthread"), { recursive: true });
  writeFileSync(
    cfg(root),
    ["workspace:", "  repos:", "    a:", "      path: a", "      source_branch: develop", "    extra:", "      path: vendor/extra", "      source_branch: release", ""].join("\n"),
  );
  const { ask, asked } = script(["claude-code", "", "", "claude-code", "", "", "claude-code", "", "", "", "", "", ""]);
  const defaults: Record<string, string | undefined> = {};
  await runSetup({
    root,
    ask: (q, def) => {
      defaults[q] = def;
      return ask(q, def);
    },
    detected: ["claude-code"],
  });
  expect(defaults["a source branch (blank to ask per task)"]).toBe("develop");
  expect(defaults["b source branch (blank to ask per task)"]).toBeUndefined();
  expect(asked.filter((q) => q.includes("source branch"))).toEqual(["a source branch (blank to ask per task)", "b source branch (blank to ask per task)"]);
  expect(loadConfig(root, env()).workspace.repos).toEqual({
    a: { path: "a", source_branch: "develop" },
    extra: { path: "vendor/extra", source_branch: "release" },
    b: { path: "b" },
  });
});

// Answers by question text; every other question gets enter (its default).
const byLabel = (answers: Record<string, string>) => {
  const asked: Record<string, string | undefined> = {};
  const ask = async (q: string, def?: string) => {
    asked[q] = def;
    const a = answers[q];
    return a === undefined || a === "" ? (def ?? "") : a;
  };
  return { ask, asked };
};
const run = (root: string, answers: Record<string, string>) => {
  const s = byLabel(answers);
  return runSetup({ root, ask: s.ask, detected: ["claude-code"] }).then(() => s);
};

test("workflow: blank everywhere on a fresh workspace writes the prefilled values", async () => {
  const root = twoRepoFolder();
  writeFileSync(join(root, "a", "package.json"), JSON.stringify({ scripts: { test: "t", typecheck: "c" } }));
  writeFileSync(join(root, "a", "bun.lock"), "");
  writeFileSync(join(root, "Makefile"), ".PHONY: restart\nrestart:\n\techo\nstatus:\n\techo\n");
  const s = await run(root, {});
  expect(s.asked["a unit command"]).toBe("bun run test");
  const c = loadConfig(root, env());
  expect(c.workspace.repos).toEqual({ a: { path: "a", unit: "bun run test", typecheck: "bun run typecheck" }, b: { path: "b" } });
  expect(c.workflow.stack).toEqual({ restart: "make restart TASK={task}", status: "make status" });
  expect(c.workflow.chat_language).toBe("English");
});

test("workflow: a single-repo project reads its own root and records the repo", async () => {
  const root = tempRepo();
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "t" } }));
  await run(root, {});
  expect(loadConfig(root, env()).workspace.repos).toEqual({ [repoName(root)]: { path: ".", unit: "npm run test" } });
});

test("workflow: a second run with blank answers keeps every earlier value", async () => {
  const root = twoRepoFolder();
  await run(root, {
    "a prod branch": "main",
    "a staging branch": "staging",
    "a PR order": "2",
    "a unit command": "make unit",
    "a typecheck command": "make tc",
    "chat language": "Indonesian",
    "file language": "English",
    "stack restart command ({task} = the task name)": "make up TASK={task}",
    "stack status command": "make ps",
    "e2e stage 2 command": "make e2e2",
    "e2e stage 3 command": "make e2e3",
    "e2e stage 4 command": "make e2e4",
    "e2e baseline path": ".docs/baseline.md",
    "migration tool": "flyway",
    "migration table": "schema_history",
    "production migrates on start (yes/no)": "yes",
    "production read command": "make prod-read",
    "browser URLs (comma-separated)": " http://a.test , ,http://b.test ",
    "browser login note path": ".docs/login.md",
    "banned words (comma-separated)": "claude, ai ,",
    "never-commit paths (comma-separated)": ".docs, *.env",
    "read-first paths (comma-separated)": "README.md",
    "report word for done": "selesai",
    "report word for blocked": "macet",
  });
  const first = loadConfig(root, env());
  expect(first.workspace.repos?.a).toEqual({ path: "a", prod_branch: "main", staging_branch: "staging", pr_order: 2, unit: "make unit", typecheck: "make tc" });
  expect(first.workflow.browser).toEqual({ urls: ["http://a.test", "http://b.test"], login_note: ".docs/login.md" });
  expect(first.workflow.banned_words).toEqual(["claude", "ai"]);
  expect(first.workflow.never_commit).toEqual([".docs", "*.env"]);
  expect(first.workflow.migration).toEqual({ tool: "flyway", table: "schema_history", prod_migrates_on_start: true });
  expect(first.workflow.report_words).toEqual({ done: "selesai", blocked: "macet" });
  const s = await run(root, {});
  expect(s.asked["a unit command"]).toBe("make unit");
  expect(s.asked["browser URLs (comma-separated)"]).toBe("http://a.test, http://b.test");
  expect(s.asked["production migrates on start (yes/no)"]).toBe("yes");
  expect(loadConfig(root, env())).toEqual(first);
});

test("workflow: a typed value replaces the old one; prod_migrates_on_start takes no/false; bad answers re-ask", async () => {
  const root = twoRepoFolder();
  await run(root, { "a unit command": "old", "production migrates on start (yes/no)": "yes", "a PR order": "1" });
  const errs: string[] = [];
  const orig = console.error;
  console.error = (m: string) => void errs.push(String(m));
  try {
    const answers: Record<string, string[]> = { "a PR order": ["x", "3"], "production migrates on start (yes/no)": ["maybe", "no"], "a unit command": ["new"] };
    await runSetup({
      root,
      ask: async (q, def) => {
        const a = answers[q]?.shift();
        return a === undefined || a === "" ? (def ?? "") : a;
      },
      detected: ["claude-code"],
    });
  } finally {
    console.error = orig;
  }
  expect(errs.length).toBe(2);
  const c = loadConfig(root, env());
  expect(c.workspace.repos?.a).toEqual({ path: "a", unit: "new", pr_order: 3 });
  expect(c.workflow.migration).toEqual({ prod_migrates_on_start: false });
});

test("workflow: a hand-added repo and its new fields survive a re-run", async () => {
  const root = twoRepoFolder();
  mkdirSync(join(root, ".agentthread"), { recursive: true });
  writeFileSync(cfg(root), ["workspace:", "  repos:", "    extra:", "      path: vendor/extra", "      unit: make x", "      pr_order: 4", ""].join("\n"));
  await run(root, {});
  expect(loadConfig(root, env()).workspace.repos?.extra).toEqual({ path: "vendor/extra", unit: "make x", pr_order: 4 });
});

test("detectAgents finds agy by its bin and AGT_AGY_BIN", () => {
  expect(detectAgents((b) => (b === "agy" ? "/x/agy" : null), {})).toEqual(["agy"]);
  expect(detectAgents((b) => (b === "/y/antigravity" ? b : null), { AGT_AGY_BIN: "/y/antigravity" })).toEqual(["agy"]);
});
