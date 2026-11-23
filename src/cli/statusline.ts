import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { loadConfig } from "../config/config.ts";
import { expandHome, statuslineText, usageFromStatusline, writeUsage } from "../agents/profiles.ts";

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

/**
 * `agt statusline --profile <name> --root <root>`: Claude Code's statusLine command. Records the profile's usage
 * (.agentthread/usage/<profile>.json, atomically) and returns the text to print: agt's one short line, then the user's
 * own statusLine output (agents.claude.statusline) on a second line. Never throws and never talks to the daemon.
 */
export async function statuslineLine(o: { profile: string; root: string; stdin: string; env: Env; cwd?: string; now?: Date }): Promise<string> {
  const now = o.now ?? new Date();
  let usage = usageFromStatusline(o.stdin, now);
  try {
    // Garbage, or a session before its first response: nothing new to record; the previous data stays.
    if (usage.five_hour || usage.seven_day) writeUsage(o.root, o.profile, usage);
  } catch {
    // the usage file is telemetry: a failed write must not break the status line
  }
  let line = statuslineText(o.profile, usage);
  try {
    const own = loadConfig(o.root, o.env).agents.claude.statusline;
    if (own) {
      const extra = await runUserStatusline(own, o.stdin, o.env, o.cwd ?? o.root);
      if (extra) line += `\n${extra}`;
    }
  } catch {
    // a broken config leaves just agt's line
  }
  return line;
}
