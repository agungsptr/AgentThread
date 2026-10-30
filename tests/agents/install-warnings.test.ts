import { expect, test } from "bun:test";
import { installWarnings } from "../../src/agents/roles.ts";
import { loadConfig } from "../../src/config/config.ts";
import { isolatedConfigHome, tempRepo } from "../helpers.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("installWarnings checks each role's default binary, but main's override", () => {
  const root = tempRepo();
  mkdirSync(join(root, ".agentthread"), { recursive: true });
  writeFileSync(
    join(root, ".agentthread", "config.yaml"),
    "agents:\n  roles:\n    main: { agent: claude-code }\n    coordinator: { agent: claude-code }\n    worker: { agent: opencode }\n  complexity:\n    tiers:\n      t: { agent: codex }\n",
  );
  const config = loadConfig(root, { XDG_CONFIG_HOME: isolatedConfigHome(), HOME: "/nonexistent" });
  const env = { AGT_OPENCODE_BIN: "/x/opencode", AGT_CLAUDE_BIN: "/x/claude" };
  const which = (bin: string) => (bin === "/x/claude" || bin === "codex" ? `/bin/${bin}` : null);
  expect(installWarnings(config, which, env)).toEqual([
    "agents.roles.coordinator: claude-code is not installed",
    "agents.roles.worker: opencode is not installed",
  ]);
});
