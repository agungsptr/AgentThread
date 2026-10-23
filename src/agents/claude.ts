import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config/config.ts";
import type { SessionRole, SessionSignal } from "../domain/types.ts";
import { shellQuote } from "../herdr/bridge.ts";

export const AGT_BIN = fileURLToPath(new URL("../../bin/agt", import.meta.url));

export function hookCommand(signal: SessionSignal): string {
  return `${shellQuote(process.execPath)} ${shellQuote(AGT_BIN)} event ${signal}`;
}

export function hookSettings() {
  const on = (signal: SessionSignal) => [{ hooks: [{ type: "command" as const, command: hookCommand(signal) }] }];
  return {
    hooks: {
      SessionStart: on("started"),
      UserPromptSubmit: on("active"),
      Stop: on("idle"),
      PreCompact: on("compacting"),
      SessionEnd: on("ended"),
    },
  };
}

export function claudeConfigDir(config: Config, env: Record<string, string | undefined> = process.env): string {
  return config.agents.claude.config_dir ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

const READ_TOOLS = ["Bash(agt *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)"];

/** The thread files live under <root>/.agentthread, outside the agent's worktree cwd; `//abs/path` is Claude's absolute-path rule form. */
export function allowedTools(role: SessionRole, config: Config, root?: string): string[] {
  const base = role === "main" ? ["Bash(agt *)"] : role === "coordinator" ? [...READ_TOOLS, "Bash(git add *)", "Bash(git commit *)"] : READ_TOOLS;
  const stateFiles = root && role !== "main" ? [`Read(/${root}/.agentthread/**)`] : [];
  return [...base, ...stateFiles, ...config.agents.claude.extra_allowed_tools];
}

export function agentEnv(o: { root: string; role: SessionRole; session: string; thread?: string; ticket?: string; configDir?: string }): Record<string, string> {
  return {
    AGT_ROOT: o.root,
    AGT_ROLE: o.role,
    AGT_SESSION: o.session,
    AGT_AGENT: "claude-code",
    ...(o.thread ? { AGT_THREAD: o.thread } : {}),
    ...(o.ticket ? { AGT_TICKET: o.ticket } : {}),
    ...(o.configDir ? { CLAUDE_CONFIG_DIR: o.configDir } : {}),
    PATH: `${dirname(AGT_BIN)}:${process.env.PATH ?? ""}`,
  };
}
