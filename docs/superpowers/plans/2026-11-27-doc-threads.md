# Doc Threads (`review`, `report`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two thread types, `review` and `report`, that run a four-stage doc workflow (no branches, no squash,
no repo commits) and end in one shareable Markdown report that agt checks for private mentions.

**Architecture:** The thread type maps to a workflow kind (`code` | `doc`). Every place that today assumes the ten
code stages, a squash branch or worker commits asks the kind first. Doc threads get a detached worktree, a guard that
refuses every repo commit, file-less tickets, a registered report path with a share check that gates the last stage,
doc-specific prompts and a generated `agt-doc-workflow` skill, and a cleanup without branch checks.

**Tech Stack:** Bun + TypeScript, zod, `bun test`, `tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-11-26-doc-threads-design.md`

## Global Constraints

- Thread types: `feature, bug, chore, review, report`. Kind: `review`, `report` → `doc`; everything else, and `undefined`, → `code`.
- Doc stage names, in order: `scope`, `investigation`, `draft`, `approval`.
- Code threads (and old events) behave exactly as today; every existing test stays green unchanged.
- Report paths: `review` → `.docs/<repo|shared>/reviews/YYYY-MM-DD-<slug>.md`; `report` → `.docs/<repo|shared>/reports/YYYY-MM-DD-<slug>.md`.
- Share check targets: `.docs`, `.agentthread`, `.worktrees`, the workspace root's absolute path, `thread <id>`, `<id>/T<n>`, `ticket T<n>`, every `workflow.banned_words` entry; case-insensitive.
- Guard message: `AgentThread: a review/report thread never commits in a repo.`
- A detached worktree is recorded with branch `(detached)`.
- Run before every commit: `bun test` and `bun run typecheck`, both clean.
- Commit messages: plain conventional commits, ending with the session's attribution line.

## Review Focus

1. **Report path outside `.docs` or with `..`** (`agt thread report 001 ../x.md`, `/abs/x.md`, `.docs/../x.md`): rejected, never read. Test in Task 3.
2. **Report file missing or empty at stage 4**: stage 4 done is rejected with "report <path> is missing" / "is empty", never a crash. Test in Task 4.
3. **A code thread given doc-only commands** (`agt thread report` on a feature thread, stage 11): rejected with a message naming the type. Tests in Tasks 3 and 4.
4. **Banned word inside a longer word** (banned `ai`, report says "maintain"): not a hit — banned words match as whole words, like the commit-msg hook (`grep -w`). Test in Task 2.
5. **Doc thread with no worktree at cleanup** (a report needing no checkout): `agt thread cleanup` succeeds with nothing to remove instead of "has no worktrees to clean up". Test in Task 8.

---

### Task 1: Thread types and workflow kinds

**Files:**
- Modify: `src/domain/types.ts:12-13,34-37`
- Modify: `src/domain/branches.ts`
- Test: `tests/domain/kinds.test.ts` (create)

**Interfaces:**
- Produces (in `src/domain/types.ts`):
  - `THREAD_TYPES = ["feature", "bug", "chore", "review", "report"] as const`; `ThreadType`
  - `CODE_THREAD_TYPES = ["feature", "bug", "chore"] as const`; `CodeThreadType`
  - `DOC_THREAD_TYPES = ["review", "report"] as const`
  - `type WorkflowKind = "code" | "doc"`; `workflowKind(type: ThreadType | undefined): WorkflowKind`
  - `isDocType(type: ThreadType | undefined): boolean`
  - `STAGE_NAMES` unchanged (code); `DOC_STAGE_NAMES = ["scope", "investigation", "draft", "approval"] as const`
  - `stageNames(type: ThreadType | undefined): readonly string[]`
- Produces (in `src/domain/branches.ts`): `DEFAULT_BRANCH_PREFIX: Record<CodeThreadType, string>`, `BranchPrefixes = Partial<Record<CodeThreadType, string>>`, `squashBranch(type: CodeThreadType | undefined, task, overrides?)` — callers holding a `ThreadType` must narrow first (TypeScript will flag each one; Tasks 6 and 8 remove the doc paths).

- [ ] **Step 1: Write the failing test** `tests/domain/kinds.test.ts`

```ts
test("review and report are doc threads; the rest and undefined are code", () => {
  expect(THREAD_TYPES).toEqual(["feature", "bug", "chore", "review", "report"]);
  expect(["review", "report"].map((t) => workflowKind(t as ThreadType))).toEqual(["doc", "doc"]);
  expect(["feature", "bug", "chore", undefined].map((t) => workflowKind(t as ThreadType | undefined))).toEqual(["code", "code", "code", "code"]);
});
test("stageNames follows the kind", () => {
  expect(stageNames("report")).toEqual(["scope", "investigation", "draft", "approval"]);
  expect(stageNames("bug")).toHaveLength(10);
  expect(stageNames(undefined)[9]).toBe("release and squash");
});
```

- [ ] **Step 2: Run** `bun test tests/domain/kinds.test.ts` — FAIL (no export `workflowKind`).
- [ ] **Step 3: Implement** the exports above. `squashBranch` keeps its body.
- [ ] **Step 4: Run** `bun test tests/domain && bun run typecheck` — tests PASS; fix every type error by narrowing at call sites with `isDocType` guards that keep today's behaviour for code threads (doc paths come in later tasks; until then a doc thread may fall back to `"feature"` where unavoidable — note each such spot with `// doc: Task N`).
- [ ] **Step 5: Commit** `feat: review and report thread types with a doc workflow kind`

---

### Task 2: Share check

**Files:**
- Create: `src/domain/share-check.ts`
- Test: `tests/domain/share-check.test.ts`

**Interfaces:**
- Produces: `shareCheckHits(text: string, o: { root: string; thread: string; banned: string[] }): { line: number; match: string }[]` — 1-based line numbers, hits in line order, one entry per match.
- Produces: `formatHits(path: string, hits: { line: number; match: string }[]): string` → `report <path> mentions private things: line 3 ".docs", line 9 "thread 004"`.

- [ ] **Step 1: Write the failing tests**

```ts
const o = { root: "/work/acme", thread: "004", banned: ["claude", "ai"] };
test("clean text has no hits", () => expect(shareCheckHits("# Review\nAll good in src/a.ts:12.\n", o)).toEqual([]));
test("each private mention is a hit with its line", () => {
  const text = ["See .docs/shared/notes.md", "path /work/acme/.worktrees/x", "as thread 004 found", "in 004/T2 and ticket T3", "made by Claude"].join("\n");
  expect(shareCheckHits(text, o).map((h) => `${h.line}:${h.match.toLowerCase()}`)).toEqual([
    "1:.docs", "2:/work/acme", "2:.worktrees", "3:thread 004", "4:004/t2", "4:ticket t3", "5:claude",
  ]);
});
test("banned words match whole words only", () => expect(shareCheckHits("We maintain it.", o)).toEqual([]));
test(".agentthread is a hit", () => expect(shareCheckHits("cfg in .agentthread/config.yaml", o)[0]!.match).toBe(".agentthread"));
```

- [ ] **Step 2: Run** `bun test tests/domain/share-check.test.ts` — FAIL.
- [ ] **Step 3: Implement** with one case-insensitive regex per target (escape `root` and banned words; banned words wrapped in `\b`), scanning line by line.
- [ ] **Step 4: Run** the test — PASS.
- [ ] **Step 5: Commit** `feat: share check for review and report documents`

---

### Task 3: `agt thread report` — register and check the report path

**Files:**
- Modify: `src/commands/schema.ts` (new command), `src/commands/handler.ts` (ALLOWED + case), `src/domain/types.ts` (event), `src/state/projection.ts` (`Thread.report?: string`, event case), `src/render/markdown.ts` + `src/render/brief.ts` (show `Report: <path>`), `src/cli/main.ts` + `src/cli/usage.ts` (`thread report`)
- Test: `tests/commands/report.test.ts` (create), `tests/cli/cli.test.ts` (one parse test)

**Interfaces:**
- Consumes: `isDocType`, `shareCheckHits`, `formatHits`.
- Produces:
  - command `{ cmd: "thread.report", thread, path?: string, check?: boolean }` — ALLOWED `["user", "coordinator"]`.
  - event `{ type: "thread.report_set"; thread; payload: { path: string } }`; projection sets `t.report`.
  - exported `readReport(root: string, path: string): { ok: true; text: string } | { ok: false; error: string }` in `src/commands/handler.ts` (errors: `report <path> is missing`, `report <path> is empty`).
  - CLI: `agt thread report <id> <path>` sets; `agt thread report <id> --check` checks the recorded path; result printed as JSON like other commands: `{ path, ok: boolean, hits }`.

- [ ] **Step 1: Write the failing tests** (handler style of `tests/commands/stages.test.ts`, with `ctx.root` a temp dir containing `.docs/shared/reports/`)

```ts
test("a doc thread records its report path", () => {
  // taskThreadCreated("001", "r-1", { threadType: "report" })
  expect(exec(s, { cmd: "thread.report", thread: "001", path: ".docs/shared/reports/2026-11-27-auth.md" })).toMatchObject({ ok: true });
  expect(s.threads.get("001")!.report).toBe(".docs/shared/reports/2026-11-27-auth.md");
});
test("rejects a path outside .docs, with .., absolute, or not .md", () => {
  for (const p of ["docs/x.md", ".docs/../x.md", "/tmp/x.md", ".docs/x.txt"]) expect(errorOf(run(s, { cmd: "thread.report", thread: "001", path: p }))).toContain("report path must be a .md file under .docs/");
});
test("a code thread has no report", () =>
  expect(errorOf(run(codeState, { cmd: "thread.report", thread: "001", path: ".docs/a.md" }))).toBe("thread 001 is a feature thread; only review and report threads have a report"));
test("--check reads the recorded file and lists the hits", () => {
  // file contains "see .docs/x" on line 2
  expect(run(s, { cmd: "thread.report", thread: "001", check: true })).toMatchObject({ ok: true, result: { ok: false, hits: [{ line: 2, match: ".docs" }] } });
});
test("--check without a recorded path is rejected", () =>
  expect(errorOf(run(fresh, { cmd: "thread.report", thread: "001", check: true }))).toBe("no report recorded: agt thread report 001 <path>"));
test("the report path shows in main.thread.md and the brief", () => { /* renderMain(s) and renderBrief contain "Report: .docs/shared/reports/2026-11-27-auth.md" */ });
```

- [ ] **Step 2: Run** `bun test tests/commands/report.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Path rule: relative, normalised (`path.posix.normalize`) still starts with `.docs/`, no `..` segment, ends `.md`. Setting is rejected for a `done` thread. Neither `path` nor `check` → usage error from the schema refine.
- [ ] **Step 4: Run** `bun test tests/commands/report.test.ts tests/cli && bun run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat: agt thread report records and checks a doc thread's report`

---

### Task 4: Stage engine per kind

**Files:**
- Modify: `src/commands/schema.ts:70` (`max(10)` stays), `src/commands/handler.ts` (`stage` case ~382-398, `newThread` ~609-615, `thread.browser_check`, `stack.acquire` e2e4, `thread.status` coordinator-done message ~335), `src/state/projection.ts` (`currentStage`, `stageLine`, stage note ~582)
- Test: `tests/commands/doc-stages.test.ts` (create)

**Interfaces:**
- Consumes: `stageNames`, `isDocType`, `readReport`, `shareCheckHits`, `formatHits`, `Thread.report`.
- Produces: `currentStage(t)` / `stageLine(t)` read `stageNames(t.type)`; doc threads report `Stage: 1 scope` … `all done`.

- [ ] **Step 1: Write the failing tests**

```ts
test("a doc thread starts at 1 scope with no stage recorded by agt", () => {
  // run thread.new --type review on stateOf(INIT): no stage.recorded events in r.events (no stageNa, no stage-8 skip)
  // renderBrief contains "Stage: 1 scope"
});
test("stage numbers beyond 4 are rejected on a doc thread", () =>
  expect(errorOf(run(doc, stage(5, "done")))).toBe("a review thread has stages 1-4"));
test("approve is a code-thread state", () =>
  expect(errorOf(run(doc, stage(4, "approve", { by: "user" }), USER))).toBe("only stage 7 (e2e) of a code thread is approved"));
test("stage 4 cannot be skipped or na", () => {
  expect(errorOf(run(doc, stage(4, "skipped", { by: "user", reason: "x" }), USER))).toBe("stage 4 (approval) cannot be skipped or na: it runs the share check");
  expect(errorOf(run(doc, stage(4, "na", { reason: "x" })))).toBe("stage 4 (approval) cannot be skipped or na: it runs the share check");
});
test("stage 4 done needs a recorded, clean report", () => {
  expect(errorOf(run(noReport, stage(4, "done")))).toBe("no report recorded: agt thread report 001 <path>");
  expect(errorOf(run(missingFile, stage(4, "done")))).toBe("report .docs/shared/reviews/r.md is missing");
  expect(errorOf(run(emptyFile, stage(4, "done")))).toBe("report .docs/shared/reviews/r.md is empty");
  expect(errorOf(run(dirty, stage(4, "done")))).toBe('report .docs/shared/reviews/r.md mentions private things: line 1 ".docs"');
});
test("stage 4 done on a clean report moves an in-progress doc thread to review", () => { /* events: stage.recorded then thread status review */ });
test("browser-check and e2e4 are code-thread only", () => {
  expect(errorOf(run(doc, { cmd: "thread.browser_check", thread: "001" }))).toBe("the browser check applies to code threads");
  expect(errorOf(run(doc, { cmd: "stack.acquire", thread: "001", for: "e2e4" }))).toBe("e2e stage 4 applies to code threads");
});
test("a doc coordinator closing its thread is pointed at main with the report wording", () =>
  expect(errorOf(run(doc, { cmd: "thread.status", thread: "001", status: "done" }, COORD))).toBe('only main or the user close a thread: agt tell main "001: report approved: <report path>"'));
```

- [ ] **Step 2: Run** `bun test tests/commands/doc-stages.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Stage 4 done on a doc thread: run the share check with `{ root: ctx.root, thread: t.id, banned: config.workflow.banned_words ?? [] }`; on pass record and transition exactly as stage 10 does today (`threadStatus(..., "review", "stage 4 done", ctx)`). Code threads take today's path untouched.
- [ ] **Step 4: Run** `bun test && bun run typecheck` — PASS (existing stage tests unchanged).
- [ ] **Step 5: Commit** `feat: doc threads run four stages ending in a share-checked approval`

---

### Task 5: Detached worktrees for doc threads

**Files:**
- Modify: `src/project/git.ts` (extract the remote fetch of `addWorktreeFromAsync` into `fetchSourceIfRemote(repoDir, source)`; add `addDetachedWorktreeAsync`), `src/commands/handler.ts` (`addWorktree` ~631-649, effect type ~21), `src/daemon/effects.ts` (`addRepoWorktree` ~440-547)
- Test: `tests/commands/worktree.test.ts`, `tests/daemon/worktree-effect.test.ts`

**Interfaces:**
- Produces: effect `{ kind: "git.worktree.add"; thread; repo; repoPath; path; branch; source; task: string; detach?: true }` (`task` added for every task-thread worktree; the setup's `{task}` placeholder reads it); for doc threads `branch: "(detached)"`, `detach: true`.
- Produces: `addDetachedWorktreeAsync(repoDir: string, path: string, source: string): Promise<void>` — `git worktree add --detach <path> <source>` after `fetchSourceIfRemote`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/commands/worktree.test.ts
test("a doc thread's worktree is requested detached", () => {
  // run worktree.add on a review thread: effect has { branch: "(detached)", detach: true, source: "origin/pr-12" }, event payload branch "(detached)"
});
// tests/daemon/worktree-effect.test.ts
test("detach without a setup command: a detached HEAD at the source, no wip branch", async () => {
  // after the effect: git -C <path> rev-parse --abbrev-ref HEAD === "HEAD"; HEAD == source commit; refs/heads/wip/<task> absent; AGENTS.md present
});
test("detach with a setup command: the setup runs, then HEAD is detached and its fresh wip/<task> is deleted", async () => { /* setup does git worktree add -b wip/{task} {path} {src} */ });
test("detach with a setup command keeps a wip/<task> that has its own commits", async () => { /* branch existed before with a commit: still there */ });
```

- [ ] **Step 2: Run** `bun test tests/commands/worktree.test.ts tests/daemon/worktree-effect.test.ts` — FAIL.
- [ ] **Step 3: Implement.** In `addRepoWorktree`, when `e.detach`: the built-in path calls `addDetachedWorktreeAsync`; the setup path runs the setup with `{task}` from the thread's task (pass `task` on the effect instead of deriving it from `e.branch`), then `git -C <path> switch --detach`, then deletes `wip/<task>` only if it did not exist before the run (`hadBranch` false). "On branch" checks (adoption and post-setup) become "HEAD is detached" for detach effects. Failure cleanup unchanged.
- [ ] **Step 4: Run** the two test files, then `bun test && bun run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat: doc threads check out repos detached, without a wip branch`

---

### Task 6: Commit guard and thread files for doc threads

**Files:**
- Modify: `src/render/write.ts:38-48`, `src/agents/agents-md.ts` (hook `pre-commit` block ~340-372)
- Test: `tests/render/write.test.ts` (or the file that covers `writeAll` squash-branch; find with `grep -rn squash-branch tests`), `tests/agents/agents-md.test.ts`

**Interfaces:**
- Produces: thread dir file `doc-thread` (content `review\n` or `report\n`) for doc threads; no `squash-branch` and no `stage8` file for them.
- Produces: pre-commit refusal `AgentThread: a review/report thread never commits in a repo.` for `worker` and `coordinator` when `agt_thread_file doc-thread` is non-empty, checked before the branch cases.

- [ ] **Step 1: Write the failing tests**

```ts
test("writeAll gives a doc thread a doc-thread file and no squash-branch or stage8", () => { /* existsSync checks */ });
test("the guard refuses a worker commit in a doc thread worktree", () => { /* reuse the existing hook harness in agents-md.test.ts: AGT_AGENT_PROCESS=1, AGT_ROLE=worker, thread dir has doc-thread; git commit fails with the message */ });
test("the guard refuses a coordinator commit in a doc thread worktree", () => { /* same, AGT_ROLE=coordinator */ });
```

- [ ] **Step 2: Run** the two test files — FAIL.
- [ ] **Step 3: Implement** both changes.
- [ ] **Step 4: Run** `bun test && bun run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat: the commit guard refuses every repo commit in a review or report thread`

---

### Task 7: File-less tickets in doc threads

**Files:**
- Modify: `src/commands/handler.ts` (`ticket.add` ~363-380, `ticket.files` ~417)
- Test: `tests/commands/doc-tickets.test.ts` (create)

**Interfaces:**
- Produces: on a doc thread `ticket.add` needs `--repo` (a workspace repo), accepts `--doc`, rejects `--file`; the ticket has `scope: []`, no `files`. `ticket.files` with `--add/--remove` is rejected on a doc thread.

- [ ] **Step 1: Write the failing tests**

```ts
test("a doc ticket needs --repo and no --file", () => {
  expect(errorOf(run(doc, { cmd: "ticket.add", thread: "001", title: "Run auth tests" }))).toBe("a review thread's ticket needs --repo <repo>");
  expect(errorOf(run(doc, { cmd: "ticket.add", thread: "001", title: "X", repo: "api", files: ["a.ts"] }))).toBe("a review thread's ticket takes no --file: its worker never commits");
  expect(exec(doc, { cmd: "ticket.add", thread: "001", title: "Run auth tests", repo: "api" })).toMatchObject({ ok: true, result: { ticket: "T1" } });
});
test("two doc tickets in one repo never block each other", () => { /* both spawn; conflictingTicket is undefined */ });
test("ticket files cannot be changed on a doc thread", () => { /* message: "a review thread's tickets have no files" */ });
```

- [ ] **Step 2: Run** `bun test tests/commands/doc-tickets.test.ts` — FAIL.
- [ ] **Step 3: Implement** (workspace config in the test: one repo `api`, as other task-thread ticket tests set it up).
- [ ] **Step 4: Run** `bun test && bun run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat: review and report tickets carry no file list`

---

### Task 8: Cleanup for doc threads

**Files:**
- Modify: `src/commands/handler.ts` (`cleanupThread` ~677-697, effect type ~23), `src/daemon/cleanup-job.ts`
- Test: `tests/commands/cleanup.test.ts`, `tests/daemon/cleanup-job.test.ts` (create; temp repos like `worktree-effect.test.ts`)

**Interfaces:**
- Produces: effect `{ kind: "git.thread.cleanup"; …; squashBranch?: string; doc?: true }` — doc threads send `doc: true` and no `squashBranch`.
- Produces: doc cleanup with no worktrees → `{ ok: true, events: [], result: { requested: false, repos: [] } }`.

- [ ] **Step 1: Write the failing tests**

```ts
// handler
test("a done doc thread without worktrees cleans up to nothing", () => { /* result { requested: false, repos: [] }, no events, no effects */ });
test("a done doc thread's cleanup effect is doc, without a squash branch", () => { /* effect.doc === true, no squashBranch key */ });
// job
test("doc cleanup removes a worktree with uncommitted throwaway files", async () => { /* detached worktree + untracked repro.test.ts → ok, path gone */ });
test("doc cleanup deletes a wip/<task> without own commits and keeps one with commits, saying so", async () => {
  // no own commits → branch gone, ok:true; own commits → branch kept, ok:true, outcome.notes includes "kept wip/<task>: it has commits of its own"
});
```

- [ ] **Step 2: Run** both test files — FAIL.
- [ ] **Step 3: Implement.** In the job, `doc` skips the squash check and the `git status` stop, removes worktrees with `git worktree remove --force`, and handles `wip/<task>` as above; add `notes?: string[]` to the ok outcome and pass it into the existing cleanup notice to main.
- [ ] **Step 4: Run** `bun test && bun run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat: cleaning up a review or report thread needs no merge and keeps no throwaway files`

---

### Task 9: Prompts, AGENTS.md and the guide

**Files:**
- Modify: `src/agents/prompts.ts`, `src/agents/guide.ts`, `src/cli/main.ts` (guide: read the thread type), `README.md:166`
- Test: `tests/agents/prompts.test.ts`, `tests/agents/guide.test.ts`

**Interfaces:**
- Consumes: `isDocType`, `DOC_STAGE_NAMES`.
- Produces: `systemPrompt` doc variants for `coordinator` and `worker` when `isDocType(o.thread?.type)`; main's draft rule and command line list the five types; `MAIN_DOC_FINISH_RULE` exported; `threadTypeOf(root: string, id: string): ThreadType | undefined` in `guide.ts` (reads `type` from `sub.thread.md` frontmatter like `isLegacyThread`).

Required content (assert each with `toContain` on the rendered prompt):

- Main: `agt thread new "<title>" --type feature|bug|chore|review|report`; mapping line `- Map the user's words to --type: bug, fix or hotfix is bug; feature or feat is feature; chore, refactor or docs is chore; reviewing a PR, a branch or a finding is review; explaining how something in the project works is report.`; `MAIN_DOC_FINISH_RULE` = `- When a coordinator tells you a review or report thread's report is approved, run agt thread status <id> done --reason "report approved", then agt thread cleanup <id>, then tell the user the report path in one line.`
- Doc coordinator: the four stages with `agt stage <id> <n> done`; `agt worktree add <id> <repo> --from <branch>` makes a detached checkout (the PR's branch for a review, the source branch for a report); write the report at the paths from Global Constraints and run `agt thread report <id> <path>`; the share rule in one line (`The report is shared as a file: never mention .docs, .agentthread, .worktrees, local paths, thread or ticket ids, or private notes in it.`); run `agt thread report <id> --check` before asking for approval; after the user approves run `agt stage <id> 4 done`, then `agt tell main "<id>: report approved: <path>"`; tickets `agt ticket add <id> "<title>" --repo <r> [--doc <path>]` only for verification; never edit or commit a repo file; keeps the stack lines (acquire/restart/wait/release) when services exist; keeps language, `.docs` commit, decide/progress/question/handoff lines. No squash, `wip/`, `--file`, stage 7/8/10 or merge-check lines.
- Doc worker: work only in the worktree; may create throwaway files; never commit (`Never commit: this thread changes no code.`); report what was run and seen under `## Comments` in the ticket file and in `agt ticket done --summary`.
- Guide: `agt guide coordinator|worker` inside a doc thread (`AGT_THREAD` set, `threadTypeOf` → doc) renders the doc variants; `NEVER_TASK` lines become `- Never push; never commit in a repo; never bypass the commit guard.` for doc threads.

- [ ] **Step 1: Write the failing tests** — one `test` per bullet above, asserting the quoted lines and, for doc variants, `not.toContain("wip/")`, `not.toContain("squash")`, `not.toContain("--file")`.
- [ ] **Step 2: Run** `bun test tests/agents/prompts.test.ts tests/agents/guide.test.ts` — FAIL.
- [ ] **Step 3: Implement**; update `README.md` line 166 to list the five types with one sentence on doc threads.
- [ ] **Step 4: Run** `bun test && bun run typecheck` — PASS (existing code-thread prompt tests unchanged).
- [ ] **Step 5: Commit** `feat: coordinator, worker and main prompts for review and report threads`

---

### Task 10: Generated `agt-doc-workflow` skill and doc paths

**Files:**
- Create: `src/workflow/doc-workflow.md`
- Modify: `src/workflow/index.ts`, `src/agents/skill.ts` (`SKILLS`), `src/workflow/manage-docs.md` (§1 table)
- Test: `tests/agents/skill.test.ts`, `tests/workflow/project-config.test.ts` (squash section still lists only Feature, Bug, Chore)

**Interfaces:**
- Produces: skill `agt-doc-workflow` (one `SKILL.md`: the shipped text with the marker, then `projectConfigSection` like `featureWorkflowText`); `DOC_WORKFLOW` export.

`doc-workflow.md` content: frontmatter `name: agt-doc-workflow`, description "Use when a coordinator runs a review or report thread — reviewing a PR, a branch or a finding, or explaining project logic — and produces one shareable Markdown report." Sections: Roles (coordinator writes, workers only verify and never commit, user approves); Git (detached checkout, never a branch or commit); The four stages (what "done" means for each, from the spec's table); The report (paths, `agt thread report`, `--check`); The share rule (the targets list, plus "no private specs, notes or decisions"); Finishing (stage 4 → tell main). Under 80 lines.

`manage-docs.md` rows to add: `| Review report (shareable) | .docs/<repo or shared>/reviews/YYYY-MM-DD-<slug>.md |` and `| Logic report (shareable) | .docs/<repo or shared>/reports/YYYY-MM-DD-<slug>.md |`, plus one sentence under the table: a shareable report never points at anything in `.docs/`.

- [ ] **Step 1: Write the failing tests** — `writeSkills` writes `.claude/skills/agt-doc-workflow/SKILL.md` and `.agents/skills/agt-doc-workflow/SKILL.md` with the marker; `manageDocsText` contains `/reviews/YYYY-MM-DD-<slug>.md` and `/reports/YYYY-MM-DD-<slug>.md`; `GENERATED_RELS` includes the new files.
- [ ] **Step 2: Run** `bun test tests/agents/skill.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test && bun run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat: generated doc-workflow skill and report paths in the doc rules`
