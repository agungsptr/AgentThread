import { expect, test } from "bun:test";
import { EFFORTS, configWarnings, roleAgent, tierAgent } from "../../src/agents/roles.ts";
import { ConfigSchema, DEFAULT_CONFIG } from "../../src/config/config.ts";

const cfg = (agents: unknown) => ConfigSchema.parse({ agents });

test("defaults fill every role with claude-code", () => {
  expect(roleAgent(DEFAULT_CONFIG, "worker")).toEqual({ agent: "claude-code" });
  expect(roleAgent(DEFAULT_CONFIG, "main")).toEqual({ agent: "claude-code" });
});

test("tierAgent falls back to roles.coordinator for an unknown tier", () => {
  const c = cfg({ roles: { coordinator: { agent: "codex", effort: "high" } }, complexity: { tiers: { big: { agent: "omp", model: "m" } } } });
  expect(tierAgent(c, "big")).toEqual({ agent: "omp", model: "m" });
  expect(tierAgent(c, "nope")).toEqual({ agent: "codex", effort: "high" });
  expect(tierAgent(c, undefined)).toEqual({ agent: "codex", effort: "high" });
});

test("configWarnings names the ignored claude permission keys only when autonomous and set", () => {
  const msg = "agents.claude.permission_mode/extra_allowed_tools are ignored while agents.autonomous is true";
  expect(configWarnings(DEFAULT_CONFIG)).toEqual([]);
  expect(configWarnings(cfg({ claude: { extra_allowed_tools: ["Bash(x)"] } }))).toEqual([msg]);
  expect(configWarnings(cfg({ claude: { permission_mode: "plan" } }))).toEqual([msg]);
  expect(configWarnings(cfg({ autonomous: false, claude: { permission_mode: "plan" } }))).toEqual([]);
});

test("EFFORTS follows the facts table", () => {
  expect(EFFORTS.opencode).toEqual([]);
  expect(EFFORTS.codex).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
});
