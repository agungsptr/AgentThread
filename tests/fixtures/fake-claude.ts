#!/usr/bin/env bun
// Test double for the claude CLI: records argv, cwd and AGT_* env as one JSON line in $FAKE_CLAUDE_LOG.
import { appendFileSync } from "node:fs";

const log = process.env.FAKE_CLAUDE_LOG;
if (log) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("AGT_")));
  appendFileSync(log, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env })}\n`);
}
process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? "0"));
