# AgentThread Feature Workflow (Plan 12) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every task thread run the user's ten-stage feature workflow the same way in every project. That means:
- the workflow's content and templates ship inside agt;
- the project's values come from agt config, asked by `agt setup`;
- the role rules carry every §13 rule;
- commit messages are guarded;
- stages follow config;
- the coordinator can tell main it waits for the user;
- a finished thread's worktrees can be cleaned up.

**Architecture:**
- A snapshot of the `feature-workflow` skill, its templates and the generic `manage-docs` skill lives in `src/workflow/`, imported as text.
- The project's values live in a new `workflow` config block plus per-repo fields in `workspace.repos`. A renderer turns them into a "Project config" section, which is appended to the generated workflow skill.
- Skills are generated into the thread directory and each repo worktree with the Plan 9 mechanism (marker line, never overwriting a project-owned skill). They go to both `.claude/skills/` and `.agents/skills/`, because Codex reads the latter.
- A commit-msg hook stub reads banned words that the daemon renders to `.agentthread/banned-words`.

**Tech Stack:** TypeScript on Bun ≥ 1.1.34, `bun:test`, zod, yaml, git.

**Spec:** `docs/specs/2026-10-09-agentthread-design.md` §13, especially §13.1, §13.4, §13.5, §13.7 and §13.9. Plan 3 of 4 for §13; it requires Plan 11 (tickets, stages, stack lock) merged.

## Global Constraints

- **Runtime and checks.**
  - Bun ≥ 1.1.34, TypeScript `strict: true`.
  - Tests: `env -u HERDR_ENV -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID -u HERDR_PANE_ID -u AGT_HERDR_IT bun test`. Run the full suite under `timeout 600`, plus `bun run typecheck`, before each commit.
- **Forbidden.**
  - Never run real herdr or agents, `agt start`, or tests/release/.
  - Leave no `agt daemon run` or `agt __spawn` processes behind.
  - No `Bun.spawnSync` on daemon paths.
  - Never read or print credentials, or the contents of the Claude/omp config.
- **Legacy threads** (`t.legacy`) keep every old behavior.
- **Source files.** The workflow snapshot's source is the user's files, which may be read and copied:
  - the user's personal skills plugin (`feature-workflow/`) (`SKILL.md`, `templates/spec.md`, `templates/ticket.md`, `templates/release.md`);
  - the user's personal skills plugin (`multi-repo-doc/templates/manage-docs-SKILL.md`).

  `templates/project-config.md` is **not** copied: config replaces it.
- **Generated skill names:**
  - `agt-feature-workflow`, at `.claude/skills/agt-feature-workflow/` with `SKILL.md` and `templates/`;
  - `manage-docs`, at `.claude/skills/manage-docs/SKILL.md`.

  The same tree is written under `.agents/skills/`. The existing `agt` skill is also written to `.agents/skills/agt/SKILL.md`.
- **New config**, exactly. Every field is optional, and the defaults are noted:
  ```yaml
  workspace:
    repos:
      <name>:
        path, source_branch            # existing
        prod_branch: <b>
        staging_branch: <b>
        pr_order: <int>
        unit: <command>                # run in the repo worktree
        typecheck: <command>
  workflow:
    chat_language: <text>              # default "English"
    file_language: <text>              # default "English"
    stack: { restart: <cmd with {task}>, status: <cmd> }
    e2e: { stage2: <cmd>, stage3: <cmd>, stage4: <cmd>, baseline: <path> }
    migration: { tool: <text>, table: <text>, prod_migrates_on_start: <bool> }
    prod_read: <cmd>
    browser: { urls: [<url>...], login_note: <path> }
    banned_words: [<word>...]
    never_commit: [<path or glob>...]
    read_first: [<path>...]
    report_words: { done: <word>, blocked: <word> }   # defaults "done", "blocked"
  ```
- **New CLI**, exactly:
  - `agt thread waiting <id> "<what>"` (coordinator)
  - `agt thread cleanup <id>` (main and user)
- **New events**, exactly:
  - `thread.waiting` `{what}`
  - `thread.cleanup_requested` `{}`
  - `thread.cleaned` `{repos: string[]}`
  - `thread.cleanup_failed` `{repo, reason}`
- **Texts**, exactly:
  - notice to main: `Thread <id> (<title>) waits for you in its tab: <what>`
  - main notice after cleanup: `Thread <id> is cleaned up: removed the worktrees and wip/<task> of <repos>.`
  - main notice when cleanup fails: `Cleanup of thread <id> stopped at <repo>: <reason>`
  - commit-msg refusal: `AgentThread: the commit message mentions <what>; write a plain conventional commit (no AI attribution, ticket ids, .docs paths or banned words).`
  - automatic stage reasons:
    - `no e2e commands configured` (stage 7)
    - `no browser URL or stack restart configured` (stage 8)
  - brief line when no migration tool is configured: `Migration SQL: not needed (no migration tool configured).`

## Review Focus

1. **A project-owned skill named `manage-docs`** (the reference project has one) **is never overwritten or hidden.** agt logs that it kept it. Test in Task 3.
2. **A commit message carrying `Co-Authored-By:`, `Generated with`, a `.docs/` path, a ticket id like `T3`, or a configured banned word is refused for agents.** The user is never refused, even in a shell opened in a thread's tab, whose env carries `AGT_ROLE=coordinator`. Test in Task 5.
3. **`agt thread cleanup` never deletes uncommitted work.** A worktree with modified or untracked (not ignored) files stops the cleanup before anything is removed. Test in Task 7.
4. **Re-running `agt setup` keeps every value already configured.** Each one is offered as the default, and blank keeps it. Test in Task 2.
5. **A worker's permission to write in `.docs` covers only its own ticket file**, both in Claude's allow rules and in the prompt. Test in Task 4.

---

### Task 1: Workflow config and its "Project config" section

**Files:**
- Modify: `src/config/config.ts` (the schema above, strict)
- Create: `src/workflow/project-config.ts`
- Test: `tests/config/config.test.ts`, `tests/workflow/project-config.test.ts`

**Interfaces:**
- **Produces:** `projectConfigSection(config: Config, repos: {name: string, path: string}[]): string`. This is Markdown headed `## Project config (from .agentthread/config.yaml)`, with these parts:
  - **Languages.**
  - **Repos table:** repo, production, staging, default source, PR order, unit, typecheck.
  - **Commands:** stack restart and status, e2e stages 2/3/4, baseline, read-only prod query.
  - **Migrations.**
  - **Browser:** URLs and login note.
  - **Rules:** banned words, never-commit, read-first files.
  - **Report words.**

  A missing value renders as `not configured`. When a stage is `na` because of a missing value, the section says so with the exact stage reason.
- **Produces:** `stageNa(config): {stage: 7 | 8, reason: string}[]`, using the exact reasons, and `migrationConfigured(config): boolean`.

- [ ] **Step 1: Write the failing tests.**
  - The full example config parses, and an unknown key under `workflow` is rejected.
  - The defaults are `chat_language` and `file_language` "English", and `report_words` done/blocked.
  - The section for the full config shows every value, and the section for an empty config shows `not configured`.
  - `stageNa` returns stage 7 when no `e2e.stage2|3|4` is set, and stage 8 when there are no browser URLs or no `stack.restart`. It returns nothing when all are set.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `feat: workflow config with a rendered project config section`.

### Task 2: `agt setup` asks for the workflow values, prefilled from the repos

**Files:**
- Modify: `src/project/setup.ts`
- Create: `src/project/prefill.ts`
- Test: `tests/project/prefill.test.ts`, `tests/project/setup.test.ts`

**Interfaces:**
- **Produces:** `prefill(repoPath: string): {unit?: string, typecheck?: string, e2e?: string, makeTargets: string[]}`. It reads the repo's `Makefile`, `package.json` and Gradle files. It never runs them, and never runs a shell.
  - `package.json` scripts:
    - `unit` = `<pm> run test` when `test` exists, where `<pm>` is `bun` if `bun.lockb` or `bun.lock` exists, `pnpm` if `pnpm-lock.yaml`, `yarn` if `yarn.lock`, else `npm`;
    - `typecheck` = `<pm> run typecheck` when the script exists, else `<pm> run tsc` when a `tsc` script exists;
    - `e2e` = `<pm> run e2e` or `test:e2e`.
  - Gradle (`build.gradle*`): `./gradlew test`.
  - Makefile: targets matching `^[a-zA-Z0-9_.-]+:` (not `.PHONY`).
- **Workspace-level prefill.** The workspace root Makefile's targets suggest:
  - `stack.restart`: the first of `restart`, `stack-restart`, `up`, then `make <t> TASK={task}`;
  - `stack.status`: `status`, `ps`.
- **Setup wizard.**
  - After the existing role and repo questions, the wizard asks each workflow field once, with the current value, or else the prefill, as the default. Blank keeps the default.
  - It asks per repo: prod_branch, staging_branch, pr_order, unit, typecheck.
  - It asks at workspace level: languages, stack restart/status, e2e stage2/3/4 and baseline, migration tool/table/prod_migrates_on_start, prod_read, browser URLs (comma-separated), login note, banned words, never-commit, read-first (comma-separated), report words.
  - It writes only `.agentthread/config.yaml`, merging as `agt setup` already does for repos. It does not read `.docs/shared/notes/feature-workflow.md`.

- [ ] **Step 1: Write the failing tests.**
  - `prefill` on fixture repos:
    - bun with test and typecheck scripts gives `bun run test` and `bun run typecheck`;
    - npm with only `test`;
    - Gradle;
    - a Makefile with `wt-new:`, `restart:` and `.PHONY:`.
  - The wizard, with scripted answers: blank everywhere on a fresh workspace writes the prefilled values.
  - A second run with blank answers keeps every earlier value (Review Focus 4).
  - A typed value replaces the old one.
  - The comma lists are trimmed.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `feat: agt setup asks for the workflow values, prefilled from Makefiles and scripts`.

### Task 3: Workflow content shipped in agt, generated as skills

**Files:**
- Create `src/workflow/`:
  - `feature-workflow.md`
  - `templates/spec.md`, `templates/ticket.md`, `templates/release.md`
  - `manage-docs.md`
  - `index.ts` (text imports, `with { type: "text" }`)
- Modify:
  - `src/agents/skill.ts`: generalise to a list of generated skills and to both skill roots
  - `src/project/init.ts`, `setup.ts`, the thread-dir writer, and the worktree add path: wherever `writeSkill` runs today
- Test: `tests/agents/skill.test.ts`, `tests/workflow/content.test.ts`

**Content rules for `feature-workflow.md`:**
- Copy it from the user's `SKILL.md`, then adapt it to agt:
  - "manager" becomes "coordinator";
  - the "Project config first" section is replaced by "The project's values are in the Project config section at the end of this skill (from agt config); where they and this skill differ, the config wins.";
  - each stage names its agt command:
    - stage 1: `agt thread waiting` when waiting for the user, and `agt worktree add` after the source branch is chosen;
    - stage 3: `agt ticket add … --repo --file --doc`;
    - stage 4: `agt worker spawn`;
    - stage 5: `agt ticket accept|return`;
    - stages 7 and 8: `agt stack acquire|release`, plus `agt stage <id> 7 approve --by user` for stage 4 e2e;
    - every stage: `agt stage <id> <n> done|skipped|na`;
    - stage 10: the squash, then `agt stage <id> 10 done`;
  - the worker dispatch-message shape is kept, but it is now agt's bootstrap. Note that agt sends it.
- Keep every rule and red flag.
- Templates are copied verbatim.
- `manage-docs.md` is the generic template, copied verbatim, with its frontmatter name `manage-docs`.
- Generated files get the Plan 9 marker line after the frontmatter. Template files get it as an HTML comment on line 1.

**Generation behavior:**
- **What is written where.** For each generated skill and each root (`.claude/skills`, `.agents/skills`), `writeSkills(dir, config)` writes the files when they are ours to write: not tracked, and absent or carrying the marker.
  - `agt-feature-workflow/SKILL.md` = the content + `\n\n` + `projectConfigSection(...)`.
  - `agt` gets the existing content.
- **Project-owned skills.** A project-owned file with the same name is left alone. The daemon log gets `kept the project's own skill <name> at <path>`.
- **Git exclude.** The generated paths are added to the git exclude (per-repo excludes for worktrees, as in Plan 10).
- **Where skills go.** They are written in the project root, each thread dir and each repo worktree. `agents.skill: false` turns all of them off.
- **Where to edit the workflow.** README gains one line: the workflow is edited in agt's `src/workflow/`, never in the generated copies. My call: README only, because only the user edits it, so it is not a role rule.

- [ ] **Step 1: Write the failing tests.**
  - The content has stages 1–10, names every agt command listed above, and contains no "manager".
  - Generation writes all 4 skill files plus 3 templates under both roots.
  - The project config section reflects the config.
  - A hand-written `.claude/skills/manage-docs/SKILL.md` is untouched and logged, while the other skills are written (Review Focus 1).
  - A tracked file is untouched.
  - Regeneration with changed config rewrites the file, and unchanged config does not touch its mtime.
  - The exclude lines are present.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `feat: the feature workflow and manage-docs ship in agt as generated skills`.

### Task 4: Role rules and permissions carry every §13 rule

**Files:**
- Modify:
  - `src/agents/prompts.ts`, `guide.ts`
  - `src/agents/claude.ts` (`allowedTools`)
  - `src/agents/adapters.ts` (OpenCode, Codex and omp in non-autonomous mode)
- Test: `tests/agents/prompts.test.ts`, `tests/agents/claude.test.ts`, `tests/agents/adapters.test.ts`

**Behavior (task threads only; legacy unchanged):**
- **Coordinator rules gain, one line each:**
  - Never edit a repo file, even one line; send the worker the exact change.
  - Ask the user the source branch before `agt worktree add`.
  - Record every stage with `agt stage`.
  - Use the stack lock.
  - Run `agt thread waiting <id> "<what>"` whenever you stop to wait for the user.
  - Commit your own `.docs` changes, one commit per logical change, never pushing.
  - Commit messages are plain conventional commits: no AI attribution or session trailers, no ticket ids, no `.docs` mentions, none of these words: `<banned_words>`. This overrides any harness attribution reminder.
  - Read these files first: `<read_first>`.
  - Talk to the user in `<chat_language>`; write files in `<file_language>`.

  Also remove the old "review and commit" bullet that contradicts the squash rule (Plan 10 deferred).
- **Worker rules gain:**
  - Your ticket file is `<doc>`. You may append evidence under `## Comments` there; it is the only file outside your worktree you may write.
  - Validate your own work first.
  - End your summary with `<report_words.done>` or `<report_words.blocked>`.
  - The same commit-message rule as the coordinator.
- **Claude allow rules.**
  - Worker: adds `Edit(/<abs doc path>)` and `Write(/<abs doc path>)` for its ticket's doc only. A ticket without a doc gets none.
  - Coordinator: adds `Edit(/<root>/.docs/**)`, `Write(/<root>/.docs/**)`, `Bash(git -C <root>/.docs *)`, `Bash(git switch *)` and `Bash(git merge --squash *)`.
  - `git push` stays denied.
- **Other adapters, in their non-autonomous ask modes:**
  - the worker may run `git add` and `git commit`;
  - the coordinator may run `git switch`, `git merge --squash` and `git commit`;
  - push stays denied.
  - The autonomous defaults are unchanged.
  - Read each adapter's permission format in `adapters.ts` and follow it.

- [ ] **Step 1: Write the failing tests.**
  - The coordinator prompt has each new line, with config values substituted, and no "review and commit" bullet.
  - The worker prompt names its doc path and the report words.
  - Worker `allowedTools` contains the exact `Edit(`/`Write(` for its doc and no `.docs/**` (Review Focus 5).
  - Coordinator `allowedTools` has the `.docs/**` rules and the git rules.
  - Each adapter's ask-mode config allows the git commands listed and still denies push.
  - Legacy prompts are byte-for-byte unchanged.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `feat: role rules and permissions carry the feature workflow rules`.

### Task 5: Commit messages are guarded

**Files:**
- Modify:
  - `src/agents/agents-md.ts`: add a `commit-msg` stub next to `pre-commit`, installed the same way
  - the agent launch path in `src/agents/adapters.ts` / `src/orchestration/sessions.ts`
  - `src/render/write.ts`: renders `.agentthread/banned-words`, one word per line
- Test: `tests/agents/agents-md.test.ts` (real git), `tests/agents/adapters.test.ts`

**Behavior:**
- **Agent marker.** `AGT_ROLE` alone does not mark an agent.
  - A thread tab's env carries `AGT_ROLE=coordinator` (`tabEnv`), so a user's shell split in that tab inherits it.
  - The first coordinator has no `AGT_SESSION` (it runs in the root pane).
  - So every agent process is started with `AGT_AGENT_PROCESS=1` in the agent's own command environment, never in a tab env (for example an `env AGT_AGENT_PROCESS=1` prefix on the launch command).
- **Who is checked.** All hook stubs (pre-commit, pre-push and the new commit-msg) apply role rules only when `AGT_AGENT_PROCESS=1`. Without it the committer is the user and is never refused.
  - My call: this also fixes the Plan 10 follow-up where a user shell in a thread tab got its commits refused on `wip/<task>`. Plan 13 verifies it with real Herdr.
  - Existing hook tests set the marker.
- **Message lines.** Comment lines (`#`) of the message are ignored.
- **What is refused,** case-insensitive, with `<what>` in the exact refusal:
  - any `Co-Authored-By:` line → `AI attribution`;
  - `Generated with` → `AI attribution`;
  - `.docs/` → `a .docs path`;
  - a ticket id matching `\bT[0-9]{1,4}\b` → `a ticket id`;
  - a word from `banned-words`, as a whole word with fixed-string match → `the banned word "<w>"`.
- POSIX sh, with globbing off where needed, as in the Plan 11 hook.

- [ ] **Step 1: Write the failing tests.** Real git:
  - a worker commit with each refused form is refused with its exact `<what>`;
  - a clean `feat: add slugify` passes;
  - a banned word from config (`Zentro`) is refused, while `Zentroy` passes;
  - the same messages pass for a user, including one with `AGT_ROLE=coordinator` but no `AGT_AGENT_PROCESS`, and so does that user's commit on `wip/<task>` in the pre-commit hook;
  - every agent launch command sets `AGT_AGENT_PROCESS=1`, and `tabEnv` does not;
  - a coordinator squash with a clean message passes.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `feat: agent commit messages carry no attribution, ticket ids, .docs paths or banned words`.

### Task 6: Stages follow config; waiting for the user; thread status after the squash

**Files:**
- Modify:
  - `src/commands/schema.ts`, `handler.ts` (`thread.waiting`; the auto stages at task-thread creation)
  - `src/domain/types.ts` (`stage.recorded` `by` gains `"agt"`)
  - `src/state/projection.ts` (`Thread.waiting?: {what, since, idleSeen}`)
  - `src/orchestration/reactor.ts` (the notice to main; stage 10 done → thread `review`)
  - `src/render/brief.ts`, `markdown.ts`
  - `src/cli/main.ts`, `usage.ts`
- Test: `tests/commands/workflow-stages.test.ts`

**Behavior:**
- **Auto `na` stages.** When a task thread is created, `stage.recorded` events with `by: "agt"`, `state: "na"` and the exact reasons are appended for each `stageNa(config)` entry.
- **Migration line.** brief.md carries the exact migration line when `migrationConfigured` is false.
- **Waiting.**
  - `thread.waiting` sets `waiting`. Main gets the exact notice. main.thread.md shows `waiting: <what>` in the thread's row.
  - The coordinator's next `agent.idle` sets `idleSeen`, and the next turn start of that coordinator after that clears `waiting`. That is the user answering: use the event the reactor already treats as a turn start.
  - Only the coordinator may run it.
- **Thread status.** `agt stage <id> 10 done` moves an `in_progress` thread to `review`, through the existing transition and its event.

- [ ] **Step 1: Write the failing tests.**
  - Thread creation with empty workflow config records 7 and 8 as `na` with the exact reasons, and the brief shows the current stage skipping them correctly.
  - With full config nothing is recorded.
  - Waiting: notice text exact, row shows it, cleared after idle then turn start, not cleared by the idle alone.
  - A worker running `thread waiting` is rejected.
  - Stage 10 done → thread status `review`.
  - The migration line is present or absent per config.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `feat: stages follow config; coordinators say when they wait for the user`.

### Task 7: `agt thread cleanup`

**Files:**
- Modify:
  - `src/commands/schema.ts`, `handler.ts`
  - `src/domain/types.ts`
  - `src/orchestration/reactor.ts`
  - a background job module next to the worktree-add job (follow its pattern: outside the queue, its result re-enters as an event)
  - `src/cli/main.ts`, `usage.ts`, `src/agents/prompts.ts` (main)
- Test: `tests/commands/cleanup.test.ts` (real git)

**Behavior:**
- **Who and when.** Only main or the user, and only for a task thread whose status is `done`. Otherwise it is rejected:
  - `cleanup needs thread <id> to be done; the user says when it is merged`
  - `legacy threads keep their worktree; remove it by hand`
- **Check.** The job checks every worktree first with `git status --porcelain`, honouring ignores. Any output stops the job with `thread.cleanup_failed` (reason `uncommitted changes`) before anything is removed (Review Focus 3).
- **Unsquashed work.** Without `feat/<task>`, a `wip/<task>` holding commits no other branch has stops the job before anything is removed, with reason `wip/<task> has commits that were never squashed; if it was merged another way, delete it with git branch -D wip/<task> and run cleanup again`; main gets `Cleanup of thread <id> stopped at <repo>: <reason>`.
- **Removal.** Then, per repo:
  - `git worktree remove <path>`;
  - `git branch -D wip/<task>` in the repo.

  `feat/<task>` is never touched.
- **Thread dir.** The thread dir is removed only when it holds nothing but agt-generated files (the instruction files and generated skills). Otherwise it is kept.
- **Result.** `thread.cleaned` lists the repos, and main gets the exact notice. A failure mid-way names the repo, and the repos already removed stay listed in the failure reason.
- **Main rule:** `- Run agt thread cleanup <id> only when the user says so, after they told you the thread is merged.`

- [ ] **Step 1: Write the failing tests.**
  - A done thread with two clean worktrees: both are removed, both `wip/<task>` deleted, `feat/<task>` kept, the thread dir removed, the notice exact.
  - An untracked file in one worktree: nothing is removed, and `cleanup_failed` names the repo.
  - A not-done thread and a legacy thread are rejected with the exact messages.
  - A worker cannot run it.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `feat: agt thread cleanup removes a merged task's worktrees and wip branches`.
