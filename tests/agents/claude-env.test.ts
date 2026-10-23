import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnv, claudeConfigDir } from "../../src/agents/claude.ts";
import { contextTokensFromTranscript } from "../../src/agents/transcript.ts";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";

test("config dir precedence", () => {
  const withDir = { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents, claude: { ...DEFAULT_CONFIG.agents.claude, config_dir: "/cfg" } } };
  expect(claudeConfigDir(withDir, { CLAUDE_CONFIG_DIR: "/env" })).toBe("/cfg");
  expect(claudeConfigDir(DEFAULT_CONFIG, { CLAUDE_CONFIG_DIR: "/env" })).toBe("/env");
  expect(claudeConfigDir(DEFAULT_CONFIG, {})).toBe(join(homedir(), ".claude"));
});

test("CLAUDE_CONFIG_DIR env", () => {
  expect(agentEnv({ root: "/repo", role: "worker", session: "s", configDir: "/c" }).CLAUDE_CONFIG_DIR).toBe("/c");
  expect(agentEnv({ root: "/repo", role: "worker", session: "s" })).not.toHaveProperty("CLAUDE_CONFIG_DIR");
});

test("context tokens from the last assistant usage; robust to junk", () => {
  const dir = mkdtempSync(join(tmpdir(), "agt-tr-"));
  const file = join(dir, "t.jsonl");
  const lines = [
    { type: "user", message: { content: "hi" } },
    { type: "assistant", message: { usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 } } },
    { type: "assistant", message: { usage: { input_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 1 } } },
    { type: "user", message: { content: "x" } },
  ];
  writeFileSync(file, `garbage line\n${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  expect(contextTokensFromTranscript(file)).toBe(1020);
  expect(contextTokensFromTranscript(join(dir, "missing.jsonl"))).toBeUndefined();
  writeFileSync(file, "x".repeat(300_000));
  expect(contextTokensFromTranscript(file)).toBeUndefined();
});

test("malformed usage, sidechain and zero-total entries are skipped; non-files are ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "agt-tr-"));
  const file = join(dir, "t.jsonl");
  const good = { type: "assistant", message: { usage: { input_tokens: 3, cache_read_input_tokens: 4 } } };
  const bad = (usage: object, extra: object = {}) => ({ type: "assistant", ...extra, message: { usage } });
  const run = (entry: object) => {
    writeFileSync(file, `${JSON.stringify(good)}\n${JSON.stringify(entry)}\n`);
    return contextTokensFromTranscript(file);
  };
  expect(run(bad({ input_tokens: 1, cache_read_input_tokens: "x" }))).toBe(7);
  expect(run(bad({ input_tokens: -1 }))).toBe(7);
  expect(run(bad({ input_tokens: 1.5 }))).toBe(7);
  expect(run(bad({ input_tokens: 1, cache_creation_input_tokens: -2 }))).toBe(7);
  writeFileSync(file, `${JSON.stringify(good)}\n{"type":"assistant","message":{"usage":{"input_tokens":1e400}}}\n`);
  expect(contextTokensFromTranscript(file)).toBe(7);
  expect(run(bad({ input_tokens: 99 }, { isSidechain: true }))).toBe(7);
  expect(run(bad({ input_tokens: 0 }))).toBe(7);
  writeFileSync(file, `${JSON.stringify(bad({ input_tokens: 1, cache_read_input_tokens: "x" }))}\n`);
  expect(contextTokensFromTranscript(file)).toBeUndefined();
  expect(contextTokensFromTranscript(dir)).toBeUndefined();
});
