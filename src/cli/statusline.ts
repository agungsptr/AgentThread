import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { loadConfig } from "../config/config.ts";
import { claudeProfiles, expandHome, statuslineText, usageFromStatusline, writeUsage } from "../agents/profiles.ts";

type Env = Record<string, string | undefined>;

/** The longest agt waits for the user's own statusLine command. */
export const USER_STATUSLINE_TIMEOUT_MS = 3_000;

/** Runs the user's own statusLine command with the same stdin; its stdout, or "" on any failure. */
export function runUserStatusline(command: string, stdin: string, env: Env, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      const child = spawn("sh", ["-c", expandHome(command, env.HOME || homedir())], { cwd, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve("");
      }, USER_STATUSLINE_TIMEOUT_MS);
      child.stdout.on("data", (b: Buffer) => (out += b.toString()));
      child.on("error", () => {
        clearTimeout(timer);
        resolve("");
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve(out.trimEnd());
      });
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    } catch {
      resolve("");
    }
  });
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** A token count in a few characters: 950, 68k, 1M, 1.5M. */
export function tokens(n: number): string {
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${Math.round(n / 100_000) / 10}M`;
}

/**
 * The session's own parts of the line, from Claude Code's statusLine stdin: the model's display name, the effort
 * (thinking) level, and the context window as used/size and percent. A field missing or of the wrong type is left out.
 */
export function sessionParts(stdin: string): string[] {
  let j: unknown;
  try {
    j = JSON.parse(stdin);
  } catch {
    return [];
  }
  const o = obj(j);
  const parts: string[] = [];
  const model = obj(o.model).display_name;
  if (typeof model === "string" && model) parts.push(model);
  const effort = typeof o.effort === "string" ? o.effort : obj(o.effort).level;
  if (typeof effort === "string" && effort) parts.push(effort);
  const ctx = obj(o.context_window);
  const used = num(ctx.total_input_tokens);
  const size = num(ctx.context_window_size);
  const pct = num(ctx.used_percentage) ?? (used !== undefined && size ? (used / size) * 100 : undefined);
  if (used !== undefined && size) parts.push(`ctx ${tokens(used)}/${tokens(size)} ${Math.round(pct!)}%`);
  else if (pct !== undefined) parts.push(`ctx ${Math.round(pct)}%`);
  return parts;
}

/**
 * `agt statusline --profile <name> --root <root>`: Claude Code's statusLine command. Records the profile's usage
 * (.agentthread/usage/<profile>.json, atomically) and returns the text to print: agt's one short line (the profile, the
 * session's model, effort and context window, then the profile's usage windows), then the user's
 * own statusLine output (agents.claude.statusline) on a second line. Never throws and never talks to the daemon.
 */
export async function statuslineLine(o: { profile: string; root: string; stdin: string; env: Env; cwd?: string; now?: Date }): Promise<string> {
  const now = o.now ?? new Date();
  // The name is a file name: only a profile the config lists is recorded (anything else prints nothing and writes nothing).
  let config;
  try {
    config = loadConfig(o.root, o.env);
  } catch {
    return "";
  }
  if (!claudeProfiles(config).some((p) => p.name === o.profile)) return "";
  const usage = usageFromStatusline(o.stdin, now);
  try {
    // Garbage, or a session before its first response: nothing new to record; the previous data stays.
    if (usage.five_hour || usage.seven_day) writeUsage(o.root, o.profile, usage);
  } catch {
    // the usage file is telemetry: a failed write must not break the status line
  }
  let line = statuslineText(o.profile, usage, sessionParts(o.stdin));
  const own = config.agents.claude.statusline;
  if (own) {
    const extra = await runUserStatusline(own, o.stdin, o.env, o.cwd ?? o.root);
    if (extra) line += `\n${extra}`;
  }
  return line;
}
