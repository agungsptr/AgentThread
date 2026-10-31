import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { FEATURE_WORKFLOW, MANAGE_DOCS, TEMPLATES } from "../../src/workflow/index.ts";

const frontmatter = (text: string) => parse(text.split("\n---\n")[0]!.replace(/^---\n/, "")) as { name: string; description: string };
const SRC = join(import.meta.dir, "..", "..", "src", "workflow");

describe("feature-workflow content", () => {
  test("frontmatter names the generated skill", () => {
    expect(frontmatter(FEATURE_WORKFLOW).name).toBe("agt-feature-workflow");
  });

  test("has stages 1-10 and no manager", () => {
    for (let n = 1; n <= 10; n++) expect(FEATURE_WORKFLOW).toMatch(new RegExp(`^${n}\\. \\*\\*`, "m"));
    expect(FEATURE_WORKFLOW).not.toMatch(/manager/i);
    expect(FEATURE_WORKFLOW).toContain("Coordinator");
  });

  test("names every agt command", () => {
    for (const cmd of [
      "agt thread waiting <id>",
      "agt worktree add <id> <repo> --from",
      "agt ticket add <id>",
      "--repo <repo>",
      "--file <path>",
      "--doc <path>",
      "agt worker spawn <id> --ticket",
      "agt ticket accept <id>/",
      "agt ticket return <id>/",
      "agt stack acquire <id>",
      "agt stack acquire <id> --for e2e4",
      "agt stack release <id>",
      "agt stage <id> 7 approve --by user",
      "agt stage <id> <n> done",
      "agt stage <id> <n> skipped",
      "agt stage <id> <n> na",
      "agt stage <id> 10 done",
    ]) expect(FEATURE_WORKFLOW).toContain(cmd);
  });

  test("the config pointer replaces the project config section", () => {
    expect(FEATURE_WORKFLOW).toContain(
      "The project's values are in the Project config section at the end of this skill (from agt config); where they and this skill differ, the config wins.",
    );
    expect(FEATURE_WORKFLOW).not.toContain("templates/project-config.md");
  });

  test("keeps every red flag and the dispatch shape", () => {
    for (const flag of [
      "Separate worktrees per ticket avoid conflicts",
      "The release is tomorrow, skip the questions / browser check",
      "I'll just fix this one line myself",
      "Run the full e2e now, it's safest",
      "This failure is probably flaky / pre-existing",
      "I'll pick the base branch",
      "Docs after merge",
      "Migration: they'll figure out the SQL",
      "The worker said done",
    ]) expect(FEATURE_WORKFLOW).toContain(flag);
    expect(FEATURE_WORKFLOW).toContain("Ticket: <path>. Worktree: <path> on wip/<task>. Your files: <list>.");
    expect(FEATURE_WORKFLOW).toContain("## Manual migration SQL");
  });
});

describe("manage-docs and templates", () => {
  test("manage-docs is named manage-docs", () => {
    expect(frontmatter(MANAGE_DOCS).name).toBe("manage-docs");
  });

  test("no shipped file says manager", () => {
    for (const text of [FEATURE_WORKFLOW, MANAGE_DOCS, ...Object.values(TEMPLATES)]) expect(text).not.toMatch(/manager/i);
    expect(TEMPLATES.spec).toContain("## Coordinator decisions (correctable)");
    expect(TEMPLATES.release).toContain("## 2. Squash (coordinator)");
  });

  test("the text imports match the files", () => {
    expect(MANAGE_DOCS).toBe(readFileSync(join(SRC, "manage-docs.md"), "utf8"));
    for (const name of ["spec", "ticket", "release"] as const) {
      expect(TEMPLATES[name]).toBe(readFileSync(join(SRC, "templates", `${name}.md`), "utf8"));
      expect(TEMPLATES[name].length).toBeGreaterThan(100);
    }
  });
});
