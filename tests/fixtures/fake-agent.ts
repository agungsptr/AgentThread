#!/usr/bin/env bun
// Test double for the opencode, codex and omp CLIs: records argv, cwd, AGT_* env and OPENCODE_CONFIG_CONTENT as one
// JSON line in $FAKE_AGENT_LOG.
import { appendFileSync } from "node:fs";

const log = process.env.FAKE_AGENT_LOG;
if (log) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("AGT_") || k === "OPENCODE_CONFIG_CONTENT"));
  appendFileSync(log, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env })}\n`);
}
process.exit(Number(process.env.FAKE_AGENT_EXIT ?? "0"));
