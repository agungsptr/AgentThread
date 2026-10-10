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

/** Claude Code stores each session's transcript under projects/<cwd with every non-alphanumeric character as "-">. */
export function claudeSessionFile(o: { configDir: string; cwd: string; session: string }): string {
  return join(o.configDir, "projects", o.cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${o.session}.jsonl`);
}

const READ_TOOLS = ["Bash(agt *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)"];

/** The thread files live under <root>/.agentthread, outside the agent's worktree cwd; `//abs/path` is Claude's absolute-path rule form. */
export function allowedTools(role: SessionRole, config: Config, root?: string): string[] {
  const base = role === "main" ? ["Bash(agt *)"] : role === "coordinator" ? [...READ_TOOLS, "Bash(git add *)", "Bash(git commit *)"] : READ_TOOLS;
  const stateFiles = root && role !== "main" ? [`Read(/${root}/.agentthread/**)`] : [];
  return [...base, ...stateFiles, ...config.agents.claude.extra_allowed_tools];
}

export function claudeArgs(o: { session: string; role: SessionRole; systemPrompt: string; config: Config; root: string; resume?: boolean }): string[] {
  const claude = o.config.agents.claude;
  return [
    ...(o.resume ? ["--resume", o.session] : ["--session-id", o.session]),
    "--permission-mode", claude.permission_mode,
    "--allowed-tools", allowedTools(o.role, o.config, o.root).join(","),
    "--settings", JSON.stringify(hookSettings()),
    ...(claude.model ? ["--model", claude.model] : []),
    "--append-system-prompt", o.systemPrompt,
  ];
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
