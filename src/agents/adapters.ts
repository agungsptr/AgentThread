import type { Config } from "../config/config.ts";
import type { AgentKind, SessionRole } from "../domain/types.ts";
import { allowedTools, hookSettings } from "./claude.ts";

export interface AgentAdapter {
  agent: AgentKind;
  /** The `--kind` Herdr is given, e.g. "claude". */
  herdrKind: string;
  startArgs(o: { role: SessionRole; config: Config; root: string }): string[];
  capabilities: { hooks: boolean; contextSize: boolean; preCompact: boolean };
}

const claudeAdapter: AgentAdapter = {
  agent: "claude-code",
  herdrKind: "claude",
  startArgs({ role, config, root }) {
    const claude = config.agents.claude;
    return [
      "--permission-mode", claude.permission_mode,
      "--allowed-tools", allowedTools(role, config, root).join(","),
      "--settings", JSON.stringify(hookSettings()),
      ...(claude.model ? ["--model", claude.model] : []),
    ];
  },
  capabilities: { hooks: true, contextSize: true, preCompact: true },
};

const ADAPTERS: Partial<Record<AgentKind, AgentAdapter>> = { "claude-code": claudeAdapter };

export function adapterFor(agent: AgentKind): AgentAdapter {
  const a = ADAPTERS[agent];
  if (!a) throw new Error(`no adapter for agent ${agent}`);
  return a;
}
