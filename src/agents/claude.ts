import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config/config.ts";
import type { AgentKind, SessionRole, SessionSignal } from "../domain/types.ts";
import { shellQuote } from "../herdr/bridge.ts";
import { ticketDocPath } from "./prompts.ts";
import { claudeProfiles, profileDir } from "./profiles.ts";

export const AGT_BIN = fileURLToPath(new URL("../../bin/agt", import.meta.url));

export function hookCommand(signal: SessionSignal): string {
  return `${shellQuote(process.execPath)} ${shellQuote(AGT_BIN)} event ${signal}`;
}

/** How often Claude Code reruns agt's statusLine on its own, so an idle pane still reports its usage. */
export const STATUSLINE_REFRESH_SECONDS = 60;

export const statuslineCommand = (profile: string, root: string): string =>
  `${shellQuote(process.execPath)} ${shellQuote(AGT_BIN)} statusline --profile ${shellQuote(profile)} --root ${shellQuote(root)}`;

/**
 * The hooks of a Claude Code launch. With `profile` (2 or more profiles): agt's statusLine, which records the profile's
 * usage, and a StopFailure hook for `rate_limit`, which marks the profile exhausted.
 */
export function hookSettings(o?: { profile: string; root: string }) {
  const on = (signal: SessionSignal) => [{ hooks: [{ type: "command" as const, command: hookCommand(signal) }] }];
  return {
    ...(o ? { statusLine: { type: "command" as const, command: statuslineCommand(o.profile, o.root), refreshInterval: STATUSLINE_REFRESH_SECONDS } } : {}),
    hooks: {
      SessionStart: on("started"),
      UserPromptSubmit: on("active"),
      Stop: on("idle"),
      ...(o
        ? { StopFailure: [{ matcher: "rate_limit", hooks: [{ type: "command" as const, command: `${shellQuote(process.execPath)} ${shellQuote(AGT_BIN)} event rate-limited --profile ${shellQuote(o.profile)}` }] }] }
        : {}),
      PreCompact: on("compacting"),
      SessionEnd: on("ended"),
    },
  };
}

export function claudeConfigDir(config: Config, env: Record<string, string | undefined> = process.env): string {
  // A single profile is the same as agents.env.CLAUDE_CONFIG_DIR; with 2 or more, each launch picks its own (see AgentSession.profile).
  const only = claudeProfiles(config).length === 1 ? profileDir(config, claudeProfiles(config)[0]!.name, env) : undefined;
  return config.agents.claude.config_dir ?? only ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

const READ_TOOLS = ["Bash(agt *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)"];

const COMMIT_TOOLS = ["Bash(git add *)", "Bash(git commit *)"];

/**
 * The thread files live under <root>/.agentthread, outside the agent's worktree cwd; `//abs/path` is Claude's
 * absolute-path rule form. A worker commits only in a task thread (`legacy: false`); a legacy thread's worker never does.
 * In a task thread (§13) the worker may also write its own ticket doc (`doc`, workspace-root-relative) and nothing
 * else outside its worktree, and the coordinator may edit and commit <root>/.docs and squash. Push stays denied
 * by the launch settings.
 */
export function allowedTools(role: SessionRole, config: Config, root?: string, o: { legacy?: boolean; doc?: string } = {}): string[] {
  const task = o.legacy === false;
  const base = role === "main" ? ["Bash(agt *)"] : role === "coordinator" || task ? [...READ_TOOLS, ...COMMIT_TOOLS] : READ_TOOLS;
  const workflow =
    !task || !root
      ? []
      : role === "coordinator"
        ? [
            `Read(/${root}/.docs/**)`, `Edit(/${root}/.docs/**)`, `Write(/${root}/.docs/**)`,
            // Only these subcommands: a catch-all `git -C .docs *` would also approve push, a second -C or -c config.
            ...["add *", "commit *", "status*", "diff*", "log*"].map((c) => `Bash(git -C ${join(root, ".docs")} ${c})`),
            "Bash(git switch *)", "Bash(git merge --squash *)",
          ]
        : role === "worker" && o.doc !== undefined
          ? [`Read(/${ticketDocPath(root, o.doc)})`, `Edit(/${ticketDocPath(root, o.doc)})`, `Write(/${ticketDocPath(root, o.doc)})`]
          : [];
  const stateFiles = root && role !== "main" ? [`Read(/${root}/.agentthread/**)`] : [];
  return [...base, ...workflow, ...stateFiles, ...config.agents.claude.extra_allowed_tools];
}

/** The AGT_* env of an agent session; CLAUDE_CONFIG_DIR is set only for claude-code. Without `session` it is a tab's env. */
export function agentEnv(o: {
  root: string;
  role: SessionRole;
  agent: AgentKind;
  session?: string;
  thread?: string;
  ticket?: string;
  task?: string;
  configDir?: string;
}): Record<string, string> {
  return {
    AGT_ROOT: o.root,
    ...(o.thread ? { AGT_THREAD: o.thread } : {}),
    AGT_ROLE: o.role,
    ...(o.session ? { AGT_SESSION: o.session } : {}),
    AGT_AGENT: o.agent,
    ...(o.ticket ? { AGT_TICKET: o.ticket } : {}),
    ...(o.task && o.role !== "main" ? { AGT_TASK: o.task } : {}),
    ...(o.configDir && o.agent === "claude-code" ? { CLAUDE_CONFIG_DIR: o.configDir } : {}),
    PATH: `${dirname(AGT_BIN)}:${process.env.PATH ?? ""}`,
  };
}
