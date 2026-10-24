import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config/config.ts";
import { SETUP_HINT, detectAgents, needsSetup, runSetup } from "../../src/project/setup.ts";
import { isolatedConfigHome, tempRepo } from "../helpers.ts";

const script = (answers: string[]) => {
  const asked: string[] = [];
  const ask = async (q: string, def?: string) => {
    asked.push(q);
    const a = answers.shift();
    if (a === undefined) throw new Error(`script exhausted at: ${q}`);
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
  const { ask } = script(["opencode", "", "high", "", "claude-code", "", "", "claude-code", "", "", "", "10s"]);
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
