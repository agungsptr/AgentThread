import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString() : "";
}

/**
 * The code state of a service dir: where it runs, git HEAD, and a hash of `git status --porcelain` for it
 * (the runtime dirs .local-run and .agentthread are left out, so a start does not change its own stamp).
 */
export function computeStamp(dir: string): string {
  const head = git(dir, "rev-parse", "HEAD").trim();
  const status = git(dir, "status", "--porcelain", "--", ".", ":(exclude,top).local-run", ":(exclude,top).agentthread");
  return `${dir}:${head}:${createHash("sha1").update(status).digest("hex").slice(0, 12)}`;
}

export function readStamp(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}

export function writeStamp(file: string, stamp: string): void {
  writeFileSync(file, `${stamp}\n`);
}
