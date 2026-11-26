# Doc threads: `review` and `report` thread types — design

## Intent

Today every thread type (`feature`, `bug`, `chore`) runs the same code workflow: ten stages, worker commits on
`wip/<task>`, a squash onto `<prefix>/<task>`, a merge check, cleanup. The user also does work that changes no code:

- **`review`** — review a finding, or another programmer's PR / branch, and produce one report.
- **`report`** — explain logic in the project (how something works, worked examples) as one document.

Both end in **one Markdown file the user shares as a file** with colleagues. It is kept in the private `.docs/`, but
its content must be shareable: it never mentions anything private (no `.docs` paths, no thread or ticket ids, no
private specs or notes). This is the same rule that already holds for commits and the repos' `docs/`.

## Goals

- Two new thread types, `review` and `report`, created like any thread (`agt thread new … --type review|report`).
- A **doc workflow** with its own short stage list, chosen by the thread type; the code types keep their ten stages.
- The coordinator does the work itself. It **may** spawn workers when it needs verification: run tests, reproduce a
  finding, check behaviour.
- No branch is ever created or committed in a repo by a doc thread.
- agt **checks the report mechanically** for private mentions before the thread can finish.

## Non-goals

- No change to `feature`, `bug`, `chore` behaviour.
- No posting of the report anywhere (PR comment, chat). The user shares the file by hand.
- No new output format: the report is Markdown.

## Anti-goals (a failure even if it works)

- A shared report that leaks a `.docs` path, a thread/ticket id or a banned word.
- A doc thread that leaves a branch (`wip/<task>` or a squash branch) in a repo.
- Doc threads shown with the ten code stages, most of them `na` — status must read honestly.

## Approaches considered

1. **Thread type picks a workflow kind (code | doc), each with its own stage list.** *(chosen)*
   Stage engine reads the stage list from the thread's kind instead of a hard-coded 1–10; doc threads get their own
   prompts, skill, detached worktrees, a guard that refuses all repo commits, and a cleanup without branch checks.
   Honest status, room for more doc types later; touches the most code (`projection.ts`, `handler.ts`, `prompts.ts`).
2. **Keep ten stages, mark the code-only ones `na` at creation** (like `stageNa` does from the config). Least engine
   change, but stage names lie ("release and squash" for a report) and status lists ten stages of which three are used.
3. **A separate entity outside threads** (`agt review new`). Rejected: would duplicate sessions, tabs, handoffs and
   recovery that threads already have.

The user picked 1.

## Design

### Types and kinds

- `THREAD_TYPES` becomes `feature, bug, chore, review, report`.
- A new `workflowKind(type)`: `review`, `report` → `doc`; everything else (and `undefined`, for old threads) → `code`.
- `DEFAULT_BRANCH_PREFIX` and `workflow.branch_prefix` stay code-only (`Record<CodeType, string>`); `squashBranch` is
  only called for code threads. The "Squash branch" section of the generated skill lists only the code types.

### Doc stages

| # | Name | Done when |
|---|---|---|
| 1 | scope | coordinator and user agreed what is reviewed/explained, for whom, and from which branch/PR; worktrees created |
| 2 | investigation | code/diff read; any verification tickets accepted |
| 3 | draft | report written at its path and shown to the user |
| 4 | approval | user approved the report; agt's share check passed |

- The stage engine (`STAGE_NAMES`, `currentStage`, `stageLine`, the `stage` command's range check, the projection)
  takes the list from the thread's kind. Schema: `stage` accepts 1–10 and the handler rejects a number outside the
  thread's list.
- Code-only stage rules do not apply to doc threads: no `stageNa` from the config, no stage-8 auto-skip, no
  `approve` (stage 7), no stage-8 gate file.
- **Stage 4 done** runs the share check (below). On pass: the stage is recorded and the thread moves to `review` (the
  same transition stage 10 uses today). On fail: rejected, listing each hit with its line number.
- Skipping is as today: only the user (`--by user`, `--reason`). Stage 4 cannot be skipped or marked `na`: the
  check is the point of it.

### The report file

- Paths (added to `manage-docs.md`'s table):
  - `review` → `.docs/<repo|shared>/reviews/YYYY-MM-DD-<slug>.md`
  - `report` → `.docs/<repo|shared>/reports/YYYY-MM-DD-<slug>.md`
- The coordinator records the path with `agt thread report <id> <path>` (workspace-root-relative, must sit under
  `.docs/` and end in `.md`); it may run it again to change the path before stage 4. The path is shown in
  `agt thread status`, `sub.thread.md` and `main.thread.md`.
- The coordinator's own working notes stay separate from the report (anywhere else in `.docs`); only the report file is
  checked and shared. The coordinator commits `.docs` changes as today.

### Share check

Run by agt when stage 4 is recorded done; also available as `agt thread report <id> --check` so the coordinator can
run it at stage 3. Case-insensitive search of the report file for:

- `.docs`, `.agentthread`, `.worktrees`;
- the workspace root's absolute path;
- the thread's own id written as a reference (`thread <id>`, `<id>/T<n>`) and ticket refs `T<n>` in a ticket context
  (`ticket T<n>`, `<id>/T<n>`);
- every word in `workflow.banned_words`.

A missing or empty file fails the check. The check is a guard against slips, not a proof: the prompts still tell the
coordinator the rule.

### Worktrees

- `agt worktree add <id> <repo> --from <ref>` on a doc thread creates a **detached** worktree at `<dir>/<repo>`
  (`git worktree add --detach <path> <ref>`), fetching a `<remote>/<branch>` ref first as today. For `review` the ref
  is the PR's branch; for `report`, the source branch.
- The built-in copy/link/install step runs as for code threads, so workers can run tests.
- With `worktree_setup` configured: agt runs it as usual (it is the project's way to a runnable worktree), then
  switches the worktree to a detached HEAD and deletes a `wip/<task>` the run created if it has no commits of its own.
  *(builder's call how; see below)*
- No `squash-branch` file is written for a doc thread.

### Commit guard

- Doc thread worktrees are detached, so today's pre-commit already refuses worker commits (no branch matches) and the
  coordinator's (no squash branch). Make it explicit: when the thread directory has a `doc-thread` marker file, the
  guard refuses every agent commit in a repo worktree with "AgentThread: a review/report thread never commits in a
  repo." `.docs` is its own repo and is unaffected.

### Tickets and workers

- In a doc thread, `agt ticket add <id> "<title>" --repo <r> [--doc <path>]` — `--file` is not required and not
  accepted (no commit allowlist). `--repo` names the worktree the worker runs in.
- Worker prompt (doc variant): work only in the worktree; you may create throwaway files (a reproduction test, a
  script) but never commit; report what you ran and what you saw under `## Comments` in the ticket file and in the
  `agt ticket done --summary`. Review/accept/return work as today, minus the `git show --stat` check.
- File-overlap scheduling does not apply (no file lists); `max-workers` still does.

### Prompts and skill

- **Main:** the `--type` mapping becomes: bug/fix/hotfix → bug; feature/feat → feature; chore/refactor/docs → chore
  (a change to a repo's `docs/` is still a commit); review / "review PR" / "review branch" / reviewing a finding →
  review; explain / "report about" / "how does X work" → report. Main's post-finish rule gets a doc variant (below).
- **Coordinator (doc variant):** no squash, no ticket `--file`, no e2e/browser/stack lines unless it runs the stack
  for verification (it keeps `agt stack acquire/restart/wait/release`); the four stages; record the report path;
  the share rule in plain words; run the check before asking for approval; never edit a repo file.
- **Skill:** a new `doc-workflow.md` (generated beside `feature-workflow.md`, same mechanism), with the stages, the
  report paths, the share rule and the worker rules. `agt guide` shows the doc rules for a doc thread's roles.

### Finishing and cleanup

- Stage 4 done → thread `review`. The coordinator then runs `agt tell main "<id>: report approved: <report path>"`.
- Main, on that notice: `agt thread status <id> done --reason "report approved"`, then `agt thread cleanup <id>`,
  then tells the user the report path in one line. No merge check, no stack restart.
- Cleanup for a doc thread: no branch checks (there are none), and worktrees are removed with `--force`, since the
  only uncommitted files in them are workers' throwaway files and the report lives in `.docs`. A `wip/<task>` that
  exists anyway (see `worktree_setup`) is deleted only if it has no commits of its own.

## Constraints

- Old events and threads without a type, or with the three code types, behave exactly as today.
- The event payload `threadType` gains two values; no migration of stored events.
- Everything stays usable with the daemon restarted mid-thread (guard reads files, as today).

## Left to the builder

- Exact module layout for per-kind stage lists and prompt variants.
- How to detach after a custom `worktree_setup` (or whether to skip it for doc threads if that proves unsafe — raise
  it if so).
- Exact patterns of the share check, within the list above, and its message format.
- Tests: follow the existing handler/projection/CLI test style; cover the stage list per kind, the share check
  (pass and each kind of hit), detached worktree creation, the guard refusal, ticket add without `--file`, and doc
  cleanup with uncommitted throwaway files.

## Calls made without the user (correctable)

1. Doc worktrees are detached checkouts; workers never commit.
2. Four stages: scope, investigation, draft, approval.
3. Report paths `reviews/` and `reports/` under `.docs/<repo|shared>/`, dated.
4. The report path is registered with `agt thread report`; the share check runs at stage 4 and on demand.
5. Stage 4 cannot be skipped.
6. Main closes and cleans up a doc thread on the coordinator's "report approved" notice without asking the user.
7. Doc cleanup force-removes worktrees (throwaway files are lost by design).
8. "docs" stays `chore` (it changes a repo's `docs/`); only explain/report wording maps to `report`.
