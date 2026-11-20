import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, ConfigSchema, type Config } from "../../src/config/config.ts";
import { applyConfig } from "../../src/project/config-apply.ts";
import { initProject } from "../../src/project/init.ts";
import { MAKEFILE_MARKER, renderMakefile, renderMakefileMd, writeStackMakefiles } from "../../src/stack/makefile.ts";
import { isolatedConfigHome, twoRepoFolder } from "../helpers.ts";

const config = (services: Record<string, unknown>): Config =>
  ConfigSchema.parse({ ...DEFAULT_CONFIG, workspace: { repos: { a: { path: "a" }, b: { path: "b" } }, services } });
const WEB = { web: { repo: "a", dir: "app", start: "bun run dev", port: 3000, migrate: "bun migrate", after: ["db"] }, db: { repo: "b", start: "run-db", port: 5432, enabled: false } };

test("absent files are written; a marker file is rewritten from the config", () => {
  const root = twoRepoFolder();
  expect(writeStackMakefiles(root, config(WEB))).toEqual([".agentthread/agt.mk", "Makefile", "MAKEFILE.md"]);
  expect(readFileSync(join(root, "Makefile"), "utf8")).toBe(renderMakefile());
  expect(readFileSync(join(root, "Makefile"), "utf8").startsWith(MAKEFILE_MARKER)).toBe(true);
  const md = readFileSync(join(root, "MAKEFILE.md"), "utf8");
  expect(md).toContain("| web | a | app | `bun run dev` | 3000 | tcp:3000 | `bun migrate` | db | yes |");
  expect(md).toContain("| db | b | . | `run-db` | 5432 | tcp:5432 | - | - | no |");
  expect(md).toContain(".local-run/");
  writeStackMakefiles(root, config({ api: { repo: "a", start: "x" } }));
  const md2 = readFileSync(join(root, "MAKEFILE.md"), "utf8");
  expect(md2).toContain("| api |");
  expect(md2).not.toContain("| web |");
});

test("a user's own Makefile and MAKEFILE.md are untouched; agt.mk is still written", () => {
  const root = twoRepoFolder();
  writeFileSync(join(root, "Makefile"), "all:\n\techo mine\n");
  writeFileSync(join(root, "MAKEFILE.md"), "my notes\n");
  expect(writeStackMakefiles(root, config(WEB))).toEqual([".agentthread/agt.mk"]);
  expect(readFileSync(join(root, "Makefile"), "utf8")).toBe("all:\n\techo mine\n");
  expect(readFileSync(join(root, "MAKEFILE.md"), "utf8")).toBe("my notes\n");
  expect(readFileSync(join(root, ".agentthread", "agt.mk"), "utf8")).toContain("wt-new:");
});

test("no services: nothing is written", () => {
  const root = twoRepoFolder();
  expect(writeStackMakefiles(root, DEFAULT_CONFIG)).toEqual([]);
  expect(existsSync(join(root, "Makefile"))).toBe(false);
});

test("config apply regenerates the files", () => {
  const root = twoRepoFolder();
  const env = { XDG_CONFIG_HOME: isolatedConfigHome() };
  initProject(root, "demo", env);
  const res = applyConfig({ root, env, text: "workspace:\n  repos:\n    a: { path: a }\n  services:\n    web: { repo: a, start: x, port: 4000 }\n" });
  expect(res.ok && res.refreshError).toBeFalsy();
  expect(readFileSync(join(root, "MAKEFILE.md"), "utf8")).toContain("| web |");
  expect(existsSync(join(root, ".agentthread", "agt.mk"))).toBe(true);
});

/** A stand-in agt that records each invocation's argv, one word per line. */
function fakeAgt(dir: string, knownTask: string): string {
  const bin = join(dir, "fake-agt");
  writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = thread ]; then [ "$4" = ${knownTask} ] && echo 007 && exit 0; echo "no thread has task $4; create it first: agt thread new" >&2; exit 1; fi\nprintf 'CALL' >> "${dir}/calls"\nfor a in "$@"; do printf '\\n%s' "$a" >> "${dir}/calls"; done\nprintf '\\n' >> "${dir}/calls"\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}
const make = (root: string, args: string[]) => Bun.spawnSync(["make", "-s", "-f", join(root, "Makefile"), ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });

test("targets pass TASK, ONLY, SVC, REPOS and SRC as single argv words", () => {
  const root = twoRepoFolder();
  writeStackMakefiles(root, config(WEB));
  const agt = fakeAgt(root, "kyc");
  const calls = () => readFileSync(join(root, "calls"), "utf8");
  expect(make(root, [`AGT=${agt}`, "start", "TASK=kyc", "ONLY=web,db"]).exitCode).toBe(0);
  expect(make(root, [`AGT=${agt}`, "restart"]).exitCode).toBe(0);
  expect(make(root, [`AGT=${agt}`, "stop", "ONLY=web"]).exitCode).toBe(0);
  expect(make(root, [`AGT=${agt}`, "status"]).exitCode).toBe(0);
  expect(calls()).toBe("CALL\nstack\nstart\n--task\nkyc\n--only\nweb,db\nCALL\nstack\nrestart\nCALL\nstack\nstop\n--only\nweb\nCALL\nstack\nstatus\n");
  const evil = "x'; touch pwned; echo '`id`";
  expect(make(root, [`AGT=${agt}`, "logs", `SVC=${evil}`]).exitCode).toBe(0);
  expect(calls().endsWith(`CALL\nstack\nlogs\n${evil}\n`)).toBe(true);
  expect(existsSync(join(root, "pwned"))).toBe(false);
  expect(make(root, [`AGT=${agt}`, "logs"]).exitCode).not.toBe(0);
  expect(make(root, ["help"]).stdout.toString()).toContain("wt-new");
});

test("wt-new adds a worktree per repo for the task's thread, or says how to create the thread", () => {
  const root = twoRepoFolder();
  writeStackMakefiles(root, config(WEB));
  const agt = fakeAgt(root, "kyc");
  const calls = () => readFileSync(join(root, "calls"), "utf8");
  const ok = make(root, [`AGT=${agt}`, "wt-new", "TASK=kyc", "REPOS=a,b", "SRC=release/1; touch pwned"]);
  expect(ok.exitCode).toBe(0);
  expect(calls()).toBe("CALL\nworktree\nadd\n007\na\n--from\nrelease/1; touch pwned\nCALL\nworktree\nadd\n007\nb\n--from\nrelease/1; touch pwned\n");
  expect(existsSync(join(root, "pwned"))).toBe(false);
  const none = make(root, [`AGT=${agt}`, "wt-new", "TASK=other", "REPOS=a"]);
  expect(none.exitCode).not.toBe(0);
  expect(none.stderr.toString()).toContain("no thread has task other");
  expect(readFileSync(join(root, "calls"), "utf8")).not.toContain("other");
  expect(make(root, [`AGT=${agt}`, "wt-new", "TASK=kyc"]).exitCode).not.toBe(0);
});

test("a project Makefile can include agt.mk", () => {
  const root = twoRepoFolder();
  writeFileSync(join(root, "Makefile"), "include .agentthread/agt.mk\nmine:\n\t@echo mine\n");
  writeStackMakefiles(root, config(WEB));
  expect(make(root, ["mine"]).stdout.toString()).toBe("mine\n");
  expect(make(root, ["help"]).exitCode).toBe(0);
});

test("MAKEFILE.md for no services names none", () => {
  expect(renderMakefileMd(DEFAULT_CONFIG)).toContain("No services are configured");
});
