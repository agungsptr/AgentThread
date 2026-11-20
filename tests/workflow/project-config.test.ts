import { expect, test } from "bun:test";
import { ConfigSchema } from "../../src/config/config.ts";
import { migrationConfigured, projectConfigSection, stageNa } from "../../src/workflow/project-config.ts";

const full = ConfigSchema.parse({
  workspace: {
    repos: {
      api: { path: "api", prod_branch: "main", staging_branch: "staging", source_branch: "dev", pr_order: 1, unit: "bun test", typecheck: "bun run tc" },
    },
  },
  workflow: {
    chat_language: "Indonesian",
    stack: { restart: "make restart TASK={task}", status: "make status" },
    e2e: { stage2: "make e2e2", stage3: "make e2e3", stage4: "make e2e4", baseline: "docs/baseline.md" },
    migration: { tool: "goose", table: "goose_db_version", prod_migrates_on_start: true },
    prod_read: "psql -c",
    browser: { urls: ["http://localhost:3000", "http://localhost:4000"], login_note: "docs/login.md" },
    banned_words: ["foo", "bar"],
    never_commit: [".env"],
    read_first: ["README.md"],
    report_words: { done: "selesai", blocked: "terhenti" },
  },
});
const repos = [{ name: "api", path: "/ws/api" }];

test("the section for a full config shows every value", () => {
  const s = projectConfigSection(full, repos);
  expect(s.startsWith("## Project config (from .agentthread/config.yaml)")).toBe(true);
  for (const v of [
    "Indonesian", "English", "api", "main", "staging", "dev", "bun test", "bun run tc", "make restart TASK={task}", "make status",
    "make e2e2", "make e2e3", "make e2e4", "docs/baseline.md", "goose", "goose_db_version", "psql -c",
    "http://localhost:3000", "http://localhost:4000", "docs/login.md", "foo", "bar", ".env", "README.md", "selesai", "terhenti",
  ])
    expect(s).toContain(v);
  expect(s).not.toContain("not configured");
  expect(stageNa(full)).toEqual([]);
  expect(migrationConfigured(full)).toBe(true);
});

test("the section for an empty config says not configured and the stage reasons", () => {
  const c = ConfigSchema.parse({});
  const s = projectConfigSection(c, []);
  expect(s).toContain("not configured");
  expect(s).toContain("no e2e commands configured");
  expect(s).toContain("no browser URL or stack restart configured");
  expect(s).toContain("done");
  expect(migrationConfigured(c)).toBe(false);
});

test("a repo from the config without config entry still gets a row", () => {
  const s = projectConfigSection(ConfigSchema.parse({}), [{ name: "web", path: "/ws/web" }]);
  expect(s).toContain("web");
});

test("stageNa: stage 7 without e2e stages, stage 8 without browser urls or restart", () => {
  const na = (w: object) => stageNa(ConfigSchema.parse({ workflow: w }));
  expect(na({})).toEqual([
    { stage: 7, reason: "no e2e commands configured" },
    { stage: 8, reason: "no browser URL or stack restart configured" },
  ]);
  expect(na({ e2e: { stage3: "x" }, browser: { urls: ["u"] }, stack: { restart: "r" } })).toEqual([]);
  expect(na({ e2e: { stage2: "x" }, browser: { urls: ["u"] } })).toEqual([{ stage: 8, reason: "no browser URL or stack restart configured" }]);
  expect(na({ e2e: { baseline: "b" }, browser: { urls: [] }, stack: { restart: "r" } }).map((x) => x.stage)).toEqual([7, 8]);
});

test("projectConfigSection: a command with {task} says what to put there", () => {
  const s = projectConfigSection(full, repos);
  expect(s).toContain("replace `{task}` with the thread's task name");
  expect(s).toContain("never run it with the placeholder or an empty value");
  const noPlaceholder = ConfigSchema.parse({ workflow: { stack: { restart: "make restart" } } });
  expect(projectConfigSection(noPlaceholder, repos)).not.toContain("replace `{task}`");
});

test("services are listed and stack commands default to agt stack", () => {
  const c = ConfigSchema.parse({
    workspace: { repos: { api: { path: "api" } }, services: { web: { repo: "api", start: "x", port: 3000, after: [] }, db: { repo: "api", start: "y", enabled: false } } },
    workflow: { browser: { urls: ["http://localhost:3000"] } },
  });
  const md = projectConfigSection(c, repos, "t1");
  expect(md).toContain("### Services");
  expect(md).toContain("| web | api | `.` | 3000 | `tcp:3000` | - | yes |");
  expect(md).toContain("| db | api | `.` | not configured | not configured | - | no |");
  expect(md).toContain("- Stack restart: `agt stack restart --task t1`");
  expect(md).toContain("- Stack status: `agt stack status`");
  expect(stageNa(c).some((n) => n.stage === 8)).toBe(false);
});
