import { DEFAULT_BRANCH_PREFIX } from "../domain/branches.ts";
import { effectiveStack, type Config } from "../config/config.ts";

const NA_E2E = "no e2e commands configured";
const NA_BROWSER = "no browser URL or stack restart configured";
const NOT_CONFIGURED = "not configured";

/** Stages that cannot run because the config lacks what they need. */
export function stageNa(config: Config): { stage: 7 | 8; reason: string }[] {
  const w = config.workflow;
  const out: { stage: 7 | 8; reason: string }[] = [];
  if (!w.e2e?.stage2 && !w.e2e?.stage3 && !w.e2e?.stage4) out.push({ stage: 7, reason: NA_E2E });
  if (!w.browser?.urls?.length || !effectiveStack(config).restart) out.push({ stage: 8, reason: NA_BROWSER });
  return out;
}

/** True when a migration tool is configured; otherwise the release brief says no SQL is needed. */
export function migrationConfigured(config: Config): boolean {
  return !!config.workflow.migration?.tool;
}

const val = (v: string | number | undefined): string => (v === undefined || v === "" ? NOT_CONFIGURED : String(v));
const codeOf = (v: string | number | undefined): string => (v === undefined || v === "" ? NOT_CONFIGURED : `\`${v}\``);
const list = (v: string[] | undefined): string => (v?.length ? v.map((x) => `\`${x}\``).join(", ") : NOT_CONFIGURED);
const cell = (s: string): string => s.replace(/\|/g, "\\|");

/** The Markdown "Project config" section appended to the generated feature-workflow skill. */
export function projectConfigSection(config: Config, repos: { name: string; path: string }[], task?: string): string {
  const w = config.workflow;
  // a task thread's copy has `{task}` filled in (task names are shell-safe: ^[a-z0-9][a-z0-9._-]*$); the root copy keeps it
  const code = (v: string | number | undefined): string => codeOf(typeof v === "string" && task !== undefined ? v.replaceAll("{task}", task) : v);
  const stack = effectiveStack(config);
  const configured = config.workspace.repos ?? {};
  const lines: string[] = ["## Project config (from .agentthread/config.yaml)", ""];

  lines.push("### Languages", "", `- Chat language: ${val(w.chat_language)}`, `- File language: ${val(w.file_language)}`, "");
  lines.push(
    "### Squash branch",
    "",
    `- Feature: \`${w.branch_prefix?.feature ?? DEFAULT_BRANCH_PREFIX.feature}/<task>\``,
    `- Bug: \`${w.branch_prefix?.bug ?? DEFAULT_BRANCH_PREFIX.bug}/<task>\``,
    `- Chore: \`${w.branch_prefix?.chore ?? DEFAULT_BRANCH_PREFIX.chore}/<task>\``,
    "",
  );

  lines.push(
    "### Repos",
    "",
    "| Repo | Production | Staging | Default source | PR order | Unit | Typecheck |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  if (!repos.length) lines.push(`| ${NOT_CONFIGURED} | | | | | | |`);
  for (const r of repos) {
    const c = configured[r.name];
    lines.push(
      `| ${[r.name, val(c?.prod_branch), val(c?.staging_branch), val(c?.source_branch), val(c?.pr_order), code(c?.unit), code(c?.typecheck)].map((x) => cell(x)).join(" | ")} |`,
    );
  }
  lines.push("");

  lines.push(
    "### Commands",
    "",
    `- Stack restart: ${code(stack.restart)}`,
    `- Stack status: ${code(stack.status)}`,
    ...(task === undefined && stack.restart?.includes("{task}")
      ? ["- In the restart command, replace `{task}` with the thread's task name (the folder under `.worktrees/`) before running it; never run it with the placeholder or an empty value."]
      : []),
    `- E2E stage 2: ${code(w.e2e?.stage2)}`,
    `- E2E stage 3: ${code(w.e2e?.stage3)}`,
    `- E2E stage 4: ${code(w.e2e?.stage4)}`,
    `- E2E baseline: ${code(w.e2e?.baseline)}`,
    `- Read-only prod query: ${code(w.prod_read)}`,
    "",
  );

  const services = Object.entries(config.workspace.services ?? {});
  if (services.length) {
    lines.push("### Services", "", "| Service | Repo | Dir | Port | Health | After | Enabled |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const [name, s] of services) {
      const health = s.health ?? (s.port !== undefined ? `tcp:${s.port}` : undefined);
      lines.push(`| ${[name, s.repo, code(s.dir), val(s.port), code(health), s.after?.length ? s.after.join(", ") : "-", s.enabled ? "yes" : "no"].map((x) => cell(x)).join(" | ")} |`);
    }
    lines.push("");
  }

  const m = w.migration;
  lines.push(
    "### Migrations",
    "",
    `- Tool: ${val(m?.tool)}`,
    `- Table: ${val(m?.table)}`,
    `- Production migrates on start: ${m?.prod_migrates_on_start === undefined ? NOT_CONFIGURED : m.prod_migrates_on_start ? "yes" : "no"}`,
    "",
  );

  lines.push("### Browser", "", `- URLs: ${list(w.browser?.urls)}`, `- Login note: ${code(w.browser?.login_note)}`, "");

  lines.push(
    "### Rules",
    "",
    `- Banned words: ${list(w.banned_words)}`,
    `- Never commit: ${list(w.never_commit)}`,
    `- Read first: ${list(w.read_first)}`,
    "",
  );

  lines.push("### Report words", "", `- Done: ${val(w.report_words.done)}`, `- Blocked: ${val(w.report_words.blocked)}`, "");

  const na = stageNa(config);
  if (na.length) {
    lines.push("### Stages that are na", "");
    for (const n of na) lines.push(`- Stage ${n.stage}: na (${n.reason})`);
    lines.push("");
  }
  return lines.join("\n");
}
