import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString() : "";
}

const LOCKFILES = ["package.json", "bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml", "package-lock.json"];

/**
 * The code state a service runs from: where it runs, git HEAD of its repo, and a hash of `git status --porcelain` for
 * the whole repo dir (the runtime dirs .local-run and .agentthread are left out, so a start does not change its own
 * stamp). Outside a git repo it hashes the mtimes of package.json and the lockfiles instead, so it is not constant.
 */
export function computeStamp(repoDir: string, cwd: string = repoDir): string {
  const head = git(repoDir, "rev-parse", "HEAD").trim();
  let status = git(repoDir, "status", "--porcelain", "--", ".", ":(exclude,top).local-run", ":(exclude,top).agentthread");
  if (!head) {
    status = LOCKFILES.map((f) => {
      try {
        return `${f}:${statSync(join(repoDir, f)).mtimeMs}`;
      } catch {
        return `${f}:-`;
      }
    }).join("\n");
  }
  return `${cwd}:${head || "no-git"}:${createHash("sha1").update(status).digest("hex").slice(0, 12)}`;
}

export function readStamp(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}

export function writeStamp(file: string, stamp: string): void {
  writeFileSync(file, `${stamp}\n`);
}
