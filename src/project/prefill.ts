import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Prefill = { unit?: string; typecheck?: string; e2e?: string; makeTargets: string[] };

const read = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** Targets of a Makefile: `name:` at line start, not `.PHONY`/dot-targets and not a `:=` assignment. */
function makeTargets(dir: string): string[] {
  const text = read(join(dir, "Makefile"));
  if (text === null) return [];
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^([a-zA-Z0-9_.-]+):(?!=)/.exec(line);
    if (m && !m[1]!.startsWith(".") && !out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

function packageManager(dir: string): string {
  const has = (f: string) => existsSync(join(dir, f));
  if (has("bun.lockb") || has("bun.lock")) return "bun";
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  return "npm";
}

/**
 * Suggested workflow commands for a repo, read from its Makefile, package.json scripts and Gradle files. Only reads
 * files: nothing is run and no shell is started.
 */
export function prefill(repoPath: string): Prefill {
  const r: Prefill = { makeTargets: makeTargets(repoPath) };
  const pkg = read(join(repoPath, "package.json"));
  if (pkg !== null) {
    let scripts: Record<string, unknown> = {};
    try {
      const s = (JSON.parse(pkg) as { scripts?: unknown }).scripts;
      if (typeof s === "object" && s !== null && !Array.isArray(s)) scripts = s as Record<string, unknown>;
    } catch {
      // an unreadable package.json suggests nothing
    }
    const pm = packageManager(repoPath);
    if ("test" in scripts) r.unit = `${pm} run test`;
    if ("typecheck" in scripts) r.typecheck = `${pm} run typecheck`;
    else if ("tsc" in scripts) r.typecheck = `${pm} run tsc`;
    if ("e2e" in scripts) r.e2e = `${pm} run e2e`;
    else if ("test:e2e" in scripts) r.e2e = `${pm} run test:e2e`;
  }
  if (r.unit === undefined && ["build.gradle", "build.gradle.kts"].some((f) => existsSync(join(repoPath, f)))) r.unit = "./gradlew test";
  return r;
}

/** Workspace-level suggestions from the root Makefile's targets. */
export function stackPrefill(targets: string[]): { restart?: string; status?: string } {
  const restart = ["restart", "stack-restart", "up"].find((t) => targets.includes(t));
  const status = ["status", "ps"].find((t) => targets.includes(t));
  return { ...(restart ? { restart: `make ${restart} TASK={task}` } : {}), ...(status ? { status: `make ${status}` } : {}) };
}

/** The install command for a repo from its lockfile; null when it has no package.json. `install` overrides it ("" disables). */
export function installCommand(repoPath: string, install?: string): string | null {
  if (install !== undefined) return install === "" ? null : install;
  if (!existsSync(join(repoPath, "package.json"))) return null;
  const pm = packageManager(repoPath);
  return pm === "bun" ? "bun install" : pm === "npm" ? "npm ci" : `${pm} install --frozen-lockfile`;
}
