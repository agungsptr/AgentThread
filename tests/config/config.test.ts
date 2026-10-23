import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, configPaths, deepMerge, loadConfig } from "../../src/config/config.ts";
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
