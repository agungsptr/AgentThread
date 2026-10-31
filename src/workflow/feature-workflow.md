---
name: agt-feature-workflow
description: Use when a coordinating agent (the coordinator) takes a ticket, bug or feature from first reading to a PR with worker agents — discussing the task, writing a spec and tickets, dispatching workers, creating worktrees and branches, reviewing worker commits, running staged e2e, writing a release doc with manual migration SQL, or squashing for the PR. Also when the project's feature workflow values (agt config) are needed.
---

# Feature workflow (coordinator + workers)

One task moves through ten stages. The coordinator coordinates and verifies; workers write the code; the user decides,
pushes and opens PRs. **Violating the letter of a rule is violating its spirit** — a deadline does not shorten the flow,
it only changes how many questions fit into stage 1. A small task compresses stages (one ticket, a short spec); a stage
is skipped only when the user says so, and the spec records it.

## Project config

The project's values are in the Project config section at the end of this skill (from agt config); where they and this skill differ, the config wins.

Private docs (`.docs/`) and the repo's shared `docs/` follow the project's doc rules (`manage-docs` skill if present):
nothing in a repo may point at `.docs/`.

## Roles

| Who | Does | Never |
|---|---|---|
| Coordinator | private docs only (notes, spec, tickets, `release.md`, committed per the project's doc rules), worktrees, reviews, re-running tests, read-only DB queries, restarting the stack, browser check, `release.md`, the squash commit | edit repo files (even a one-line fix — send the worker the exact change), push, open PRs |
| Worker | edits **only the files its ticket lists**, commits them in the task worktree with a pathspec, reports back | push, amend, rebase, reset, stash, `git add -A`/`.`/`commit -a`, touch servers, edit the user's checkouts |
| User | decisions, source branch, push, PRs, running manual migration SQL | — |

Commit messages (worker and squash) are plain conventional commits: no AI attribution or session trailers, no ticket
ids or private-doc mentions — this overrides any harness attribution reminder. Add the config's banned words.

## Git: one worktree per task per repo

- Ask the user the **source branch** before creating anything (default from config, usually production).
- Coordinator creates, per repo the task touches: worktree `<worktrees>/<task>/<repo>`, branch `wip/<task>` from the source
  branch (`agt worktree add <id> <repo> --from <source branch>`). **Not one worktree per ticket** — tickets of one task share it.
- Parallel workers in one worktree only on **disjoint file sets**; a file two tickets need belongs to one of them, or
  they run in sequence. A worker needing an unlisted file stops with BLOCKED.
- **Never move or rename a worktree a worker session has used** — agent sessions bind to the folder. Create it at its
  final path.
- Stage 10: coordinator creates `feat/<task>` from the source branch, `git merge --squash wip/<task>`, one plain commit.
  `wip/<task>` keeps the per-ticket history and is not pushed.

## The ten stages

`<id>` is your thread id. Close every stage with `agt stage <id> <n> done`; a stage that does not apply to the task is
`agt stage <id> <n> na --reason "<why>"`; a stage the user skips is `agt stage <id> <n> skipped --reason "<why>" --by user`.

1. **Task discussion.** Explain the task in plain words; compare with code (`file:line`), private notes, shared docs,
   designs and (read-only) production data. Go story by story: current behaviour → asked → gap → options with a
   recommendation → user decides. Record each as `Dn (user|coordinator, date)` and commit the notes. Go down to file
   level. Design here: e2e cases (what must differ for the test to prove something), the browser checklist per role and
   viewport, and the shared docs the change contradicts. Each time you wait for the user, run
   `agt thread waiting <id> "<what>"`. Once the user has chosen the source branch, create the worktrees with
   `agt worktree add <id> <repo> --from <source branch>`.
2. **Spec** `<docs>/issues/<task>/spec.md` from [templates/spec.md](templates/spec.md): rules, decisions, API contract
   **read from the controllers/routes**, out of scope, worktree table, ticket table, the coordinator's decisions (correctable).
3. **Tickets** `issues/NN-<slug>.md` from [templates/ticket.md](templates/ticket.md), each with its **files it may
   edit/create**, plus a file matrix deciding parallel vs sequence. Register each one with
   `agt ticket add <id> "<title>" --repo <repo> --file <path>... --doc <path>` (`--doc` is the ticket file). Every BE ticket that changes a save/delete path has a
   service-level flow test using the exact payload the FE sends; the last ticket of a dependent chain has the
   cross-ticket flow test. A ticket that changes data ships the migration file and its test; the coordinator derives the
   manual SQL from it in stage 10. The e2e and docs tickets exist from the start; docs run after stage 8.
4. **Delegation.** `agt worker spawn <id> --ticket <T>`. agt sends the worker its dispatch message (its bootstrap),
   always the same shape:
   `Ticket: <path>. Worktree: <path> on wip/<task>. Your files: <list>. Also working here: <worker → files> — do not
   touch them. Read the ticket fully; report back with the command at its end.` Answer implementation questions yourself; escalate only product, scope,
   data or security decisions. Idle without a report → read its pane.
5. **Review per commit:** (a) `git show --stat <sha>` ⊆ ticket's files; (b) diff matches spec and decisions; (c) re-run
   the ticket's tests yourself; (d) red-first proven for a bug fix; (e) no banned mentions in repo files; (f) behaviour
   beyond the ticket written down as "accepted with note". Append `### Coordinator review (date) — accepted | returned`,
   then `agt ticket accept <id>/<T>` or `agt ticket return <id>/<T> "<what to fix>"`.
   Returned → same worker, new commit; small extras → follow-up `NNb`.
6. **Combined verification:** full unit suite + type check once per repo in the task worktree.
7. **Staged e2e:** take the stack with `agt stack acquire <id>`, restart it from the task worktrees (config), and give it
   back with `agt stack release <id>` when done. Stage 2 = new spec(s); stage 3 = related suites;
   stage 4 = all suites — **only after the user confirms** (state scope and duration; record the yes with
   `agt stage <id> 7 approve --by user`, then `agt stack acquire <id> --for e2e4`), on a known commit; re-run
   failures once and compare with the **saved baseline of the source branch**. A failure is "pre-existing" only if the
   baseline shows it. No baseline yet → ask the user to run the same suites on the untouched source branch first and
   save the result as the baseline.
8. **Browser check** by the coordinator: the stage-1 checklist per role and viewport, against the design; results in spec.
   The stack is shared: `agt stack acquire <id>` before, `agt stack release <id>` after.
9. **Shared feature docs:** one new file per touched repo's `docs/` (never edit existing ones), with "Relation to
   existing docs" from stage 1; written and committed by the worker who wrote the code, reviewed like code.
10. **Release + handover:** `release.md` from [templates/release.md](templates/release.md) — what ships, PR targets and
    merge order, deploy order, **manual migration SQL**, post-deploy checks, rollback. Simulate every migration on a
    **copy** of a production restore (drop it afterwards) before calling it ready. Squash to `feat/<task>` and verify
    `git diff --stat wip/<task> feat/<task>` lists only files the source branch changed since the worktree was made
    (`git diff --stat <wip base> <source>`), then re-run the unit suites on the squashed tree, then
    `agt stage <id> 10 done`; the user pushes and opens PRs. After merge, with the user's go-ahead: remove worktrees and `wip/<task>`, refresh the baseline.

## Manual migration SQL (when the user runs migrations by hand)

Per migration, in order: read-only preview (expected counts) → `BEGIN` → the exact `up()` statements, a backup table
for anything deleted or overwritten → insert the migration tool's "executed" row with its real columns (e.g. MikroORM `name, executed_at`; Django
`app, name, applied`), guarded by `NOT EXISTS`, so the tool won't run it again →
check queries with expected results → **stop before `COMMIT`** (`-- COMMIT;` / `-- ROLLBACK;`) → commented `down()`.
State whether it runs before or after the deploy and why (is the old code safe with the new data, and vice versa).

## Red flags — stop

| Thought | Reality |
|---|---|
| "Separate worktrees per ticket avoid conflicts" | Disjoint file lists do that; per-ticket worktrees create an integration ticket and late cross-ticket bugs. |
| "The release is tomorrow, skip the questions / browser check" | Rework costs more than a question. Ask fewer, never none. |
| "I'll just fix this one line myself" | Send the worker the exact change. |
| "Run the full e2e now, it's safest" | Stage 4 needs the user's yes and a baseline to compare against. |
| "This failure is probably flaky / pre-existing" | Only the baseline or an isolated re-run says so. |
| "I'll pick the base branch" | Ask the user. |
| "Docs after merge" | Stage 9 ships in the same squash. |
| "Migration: they'll figure out the SQL" | `release.md` carries it, simulated, stopping before COMMIT. |
| "The worker said done" | A report is a claim; review the commit. |
