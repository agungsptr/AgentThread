import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, DEFAULT_CONFIG, configHash, configPaths, deepMerge, loadConfig } from "../../src/config/config.ts";
import { isolatedConfigHome } from "../helpers.ts";

function setup(files: { user?: string; project?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agt-cfg-")));
  const env = { XDG_CONFIG_HOME: isolatedConfigHome(), HOME: "/nonexistent" };
  const p = configPaths(root, env);
  if (files.user !== undefined) {
    mkdirSync(join(p.user, ".."), { recursive: true });
    writeFileSync(p.user, files.user);
  }
  if (files.project !== undefined) {
    mkdirSync(join(p.project, ".."), { recursive: true });
    writeFileSync(p.project, files.project);
  }
  return { root, env, p };
}

test("an empty HOME still gives an absolute user path", () => {
  expect(configPaths("/repo", { HOME: "" }).user.startsWith("/")).toBe(true);
});

test("defaults match the spec", () => {
  expect(DEFAULT_CONFIG).toEqual({
    language: "en",
    agents: {
      main_manager: "claude-code",
      default_coordinator: "claude-code",
      default_worker: "claude-code",
      roles: { main: { agent: "claude-code" }, coordinator: { agent: "claude-code" }, worker: { agent: "claude-code" } },
      complexity: { timeout: "10s", tiers: {} },
      autonomous: true,
      claude: { permission_mode: "acceptEdits", extra_allowed_tools: [] },
    },
    workers: { max_workers: 3 },
    session: {
      rotation: { on_precompact: true, context_threshold: 0.7, idle_timeout: "24h", context_window: 200000, max_turns: 150, max_age: "8h" },
      handoff: { timeout: "5m", fallback_generate: true },
    },
    checkpoint: { reminder_turns: 8, reminder_after: "30m" },
    herdr: { main_tab_label: "main", close_tab_on_done: true, close_worker_pane_on_end: true, poll_interval: "2s" },
  });
});

test("no files gives the defaults", () => {
  const { root, env } = setup();
  expect(loadConfig(root, env)).toEqual(DEFAULT_CONFIG);
});

test("config paths honor XDG_CONFIG_HOME and fall back to HOME", () => {
  expect(configPaths("/repo", { XDG_CONFIG_HOME: "/x" })).toEqual({
    user: "/x/agentthread/config.yaml",
    project: "/repo/.agentthread/config.yaml",
  });
  expect(configPaths("/repo", { HOME: "/home/me" }).user).toBe("/home/me/.config/agentthread/config.yaml");
});

test("project overrides user, nested keys merge", () => {
  const { root, env } = setup({
    user: "workers:\n  max_workers: 5\nherdr:\n  close_tab_on_done: false\n",
    project: "workers:\n  max_workers: 2\nherdr:\n  main_tab_label: home\n",
  });
  const cfg = loadConfig(root, env);
  expect(cfg.workers.max_workers).toBe(2);
  expect(cfg.herdr).toEqual({ main_tab_label: "home", close_tab_on_done: false, close_worker_pane_on_end: true, poll_interval: "2s" });
});

test("empty files are allowed", () => {
  const { root, env } = setup({ user: "", project: "# nothing\n" });
  expect(loadConfig(root, env)).toEqual(DEFAULT_CONFIG);
});

test("unknown keys are rejected with their path", () => {
  const { root, env } = setup({ project: "workers:\n  max_worker: 2\n" });
  expect(() => loadConfig(root, env)).toThrow(/workers: Unrecognized key\(s\) in object: 'max_worker'/);
});

test("wrong types and ranges are rejected with their path", () => {
  const { root, env } = setup({ project: "session:\n  rotation:\n    context_threshold: 7\n" });
  expect(() => loadConfig(root, env)).toThrow(/session\.rotation\.context_threshold/);
  const bad = setup({ user: "session:\n  handoff:\n    timeout: soon\n" });
  expect(() => loadConfig(bad.root, bad.env)).toThrow(/session\.handoff\.timeout: duration must look like 500ms, 30s, 5m, 24h or 2d/);
});

test("herdr.poll_interval must be at least 100ms", () => {
  const fast = setup({ project: "herdr:\n  poll_interval: 50ms\n" });
  expect(() => loadConfig(fast.root, fast.env)).toThrow(/herdr\.poll_interval: must be at least 100ms/);
  const soon = setup({ project: "herdr:\n  poll_interval: soon\n" });
  expect(() => loadConfig(soon.root, soon.env)).toThrow(/herdr\.poll_interval: duration must look like 500ms/);
  const ok = setup({ project: "herdr:\n  poll_interval: 100ms\n" });
  expect(loadConfig(ok.root, ok.env).herdr.poll_interval).toBe("100ms");
});

test("non-mapping and unparseable files are rejected", () => {
  const list = setup({ project: "- a\n- b\n" });
  expect(() => loadConfig(list.root, list.env)).toThrow("must contain a YAML mapping");
  const broken = setup({ user: "workers: [\n" });
  expect(() => loadConfig(broken.root, broken.env)).toThrow(/cannot parse .*config\.yaml/);
});

test("deepMerge replaces arrays and scalars, merges objects", () => {
  expect(deepMerge({ a: { b: 1, c: [1] }, d: 1 }, { a: { c: [2] }, d: 2 })).toEqual({ a: { b: 1, c: [2] }, d: 2 });
});

test("claude section: permission mode, extra tools, model", () => {
  const { root, env } = setup({
    project: "agents:\n  claude:\n    permission_mode: bypassPermissions\n    extra_allowed_tools: ['Bash(bun test*)']\n    model: opus\n",
  });
  expect(loadConfig(root, env).agents.claude).toEqual({
    permission_mode: "bypassPermissions",
    extra_allowed_tools: ["Bash(bun test*)"],
    model: "opus",
  });
  const bad = setup({ project: "agents:\n  claude:\n    permission_mode: yolo\n" });
  expect(() => loadConfig(bad.root, bad.env)).toThrow(/agents\.claude\.permission_mode/);
});

test("durationMs", async () => {
  const { durationMs } = await import("../../src/config/config.ts");
  expect([durationMs("30s"), durationMs("5m"), durationMs("24h"), durationMs("2d")]).toEqual([30_000, 300_000, 86_400_000, 172_800_000]);
  expect(() => durationMs("soon")).toThrow("invalid duration soon");
});

test("legacy keys fill roles", () => {
  const { root, env } = setup({ project: "agents:\n  default_worker: opencode\n  claude:\n    model: claude-opus-5-5\n" });
  const a = loadConfig(root, env).agents;
  expect(a.roles.worker).toEqual({ agent: "opencode" });
  expect(a.roles.main).toEqual({ agent: "claude-code", model: "claude-opus-5-5" });
  expect(a.default_worker).toBe("opencode");
});

test("legacy: default_worker alone leaves worker without a model", () => {
  const { root, env } = setup({ project: "agents:\n  default_worker: opencode\n" });
  expect(loadConfig(root, env).agents.roles.worker).toEqual({ agent: "opencode" });
});

test("roles win over legacy keys", () => {
  const { root, env } = setup({ project: "agents:\n  default_worker: opencode\n  claude:\n    model: x\n  roles:\n    worker: { agent: codex, effort: low }\n" });
  const a = loadConfig(root, env).agents;
  expect(a.roles.worker).toEqual({ agent: "codex", effort: "low" });
  expect(a.default_worker).toBe("codex");
});

test("tiers parse; the timeout defaults to 10s; a timeout under 1s is rejected", () => {
  const { root, env } = setup({ project: "agents:\n  complexity:\n    tiers:\n      hard: { agent: claude-code, model: opus, effort: max }\n" });
  const c = loadConfig(root, env).agents.complexity;
  expect(c.timeout).toBe("10s");
  expect(c.tiers.hard).toEqual({ agent: "claude-code", model: "opus", effort: "max" });
  const bad = setup({ project: "agents:\n  complexity:\n    timeout: 500ms\n" });
  expect(() => loadConfig(bad.root, bad.env)).toThrow(/agents\.complexity\.timeout/);
});

test("effort outside the agent's list is rejected", () => {
  const { root, env } = setup({ project: "agents:\n  roles:\n    worker: { agent: omp, effort: ultra }\n" });
  expect(() => loadConfig(root, env)).toThrow("agents.roles.worker.effort: omp accepts off, minimal, low, medium, high, xhigh, max, auto");
  const ok = setup({ project: "agents:\n  roles:\n    worker: { agent: opencode, effort: anything }\n" });
  expect(loadConfig(ok.root, ok.env).agents.roles.worker.effort).toBe("anything");
});

test("a bad tier name is rejected", () => {
  const { root, env } = setup({ project: "agents:\n  complexity:\n    tiers:\n      Bad Name: { agent: omp }\n" });
  expect(() => loadConfig(root, env)).toThrow(/agents\.complexity\.tiers/);
});

test("effort outside the agent's list is rejected on a tier path", () => {
  const { root, env } = setup({ project: "agents:\n  complexity:\n    tiers:\n      big: { agent: codex, effort: max }\n" });
  expect(() => loadConfig(root, env)).toThrow("agents.complexity.tiers.big.effort: codex accepts minimal, low, medium, high, xhigh");
});

test("tier names must match the regex", () => {
  for (const name of ["High", "1x"]) {
    const { root, env } = setup({ project: `agents:\n  complexity:\n    tiers:\n      ${name}: { agent: omp }\n` });
    expect(() => loadConfig(root, env)).toThrow(/agents\.complexity\.tiers/);
  }
});

test("configHash: sha256 of the canonical JSON, independent of key order", () => {
  const a = ConfigSchema.parse({ workers: { max_workers: 4 }, language: "en" });
  const b = ConfigSchema.parse({ language: "en", workers: { max_workers: 4 } });
  expect(configHash(a)).toBe(configHash(b));
  expect(configHash(a)).not.toBe(configHash(DEFAULT_CONFIG));
  expect(configHash(DEFAULT_CONFIG)).toMatch(/^[0-9a-f]{64}$/);
});
