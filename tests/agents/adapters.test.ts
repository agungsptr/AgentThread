import { expect, test } from "bun:test";
import { adapterFor } from "../../src/agents/adapters.ts";
import { hookSettings } from "../../src/agents/claude.ts";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";

test("adapterFor claude-code", () => {
  const a = adapterFor("claude-code");
  expect(a.agent).toBe("claude-code");
  expect(a.herdrKind).toBe("claude");
  expect(a.capabilities).toEqual({ hooks: true, contextSize: true, preCompact: true });
});

test("adapterFor an unknown agent throws", () => {
  expect(() => adapterFor("nope" as never)).toThrow("no adapter for agent nope");
});

test("claude startArgs: exact list per role, no session or prompt flags", () => {
  const a = adapterFor("claude-code");
  const settings = JSON.stringify(hookSettings());
  expect(a.startArgs({ role: "worker", config: DEFAULT_CONFIG, root: "/repo" })).toEqual([
    "--permission-mode", "acceptEdits",
    "--allowed-tools", "Bash(agt *),Bash(git status*),Bash(git diff*),Bash(git log*),Read(//repo/.agentthread/**)",
    "--settings", settings,
  ]);
  expect(a.startArgs({ role: "main", config: DEFAULT_CONFIG, root: "/repo" }).slice(2, 4)).toEqual(["--allowed-tools", "Bash(agt *)"]);
  const coord = a.startArgs({ role: "coordinator", config: DEFAULT_CONFIG, root: "/repo" });
  expect(coord[3]).toContain("Bash(git commit *)");
  for (const role of ["main", "coordinator", "worker"] as const) {
    const args = a.startArgs({ role, config: DEFAULT_CONFIG, root: "/repo" });
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--append-system-prompt");
  }
  const withModel = { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents, claude: { ...DEFAULT_CONFIG.agents.claude, model: "opus" } } };
  expect(a.startArgs({ role: "main", config: withModel, root: "/repo" }).slice(-2)).toEqual(["--model", "opus"]);
});
