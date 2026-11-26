---
name: agt-doc-workflow
description: Use when a coordinator runs a review or report thread — reviewing a PR, a branch or a finding, or explaining project logic — and produces one shareable Markdown report.
---

# Doc workflow (review and report threads)

A `review` or `report` thread changes no code. It ends in **one Markdown report** that the user shares as a file with
people outside the workspace. The report is kept in the private `.docs/`, but nothing in it may point at anything
private.

## Roles

| Who | Does | Never |
|---|---|---|
| Coordinator | discusses the scope, reads the code or the diff, writes the report, runs the share check | edit or commit a repo file, push |
| Worker | only when the coordinator needs a check: runs tests, reproduces a finding, checks behaviour; reports what it ran and saw | commit, push |
| User | decides the scope and the branch, approves the report, shares it | — |

## Git: a detached checkout, never a branch

`agt worktree add <id> <repo> --from <branch>` makes a **detached** checkout at `<worktrees>/<task>/<repo>`: the PR's
branch for a review, the source branch for a report. agt creates no branch and refuses every agent commit in it.
Workers may leave throwaway files there (a reproduction test, a script); `agt thread cleanup` removes them.

## The four stages

Close each with `agt stage <id> <n> done`. Only the user skips a stage (`--by user --reason "<why>"`); stage 4 is never
skipped.

1. **scope** — what is reviewed or explained, for whom, from which branch or PR; the worktrees are created.
2. **investigation** — the code or the diff read; any verification tickets
   (`agt ticket add <id> "<title>" --repo <r> [--doc <path>]`, no `--file`) accepted.
3. **draft** — the report written at its path and shown to the user.
4. **approval** — the user approved it and agt's share check passed. Done moves the thread to review.

## The report

| Thread | Path |
|---|---|
| review | `.docs/<repo or shared>/reviews/YYYY-MM-DD-<slug>.md` |
| report | `.docs/<repo or shared>/reports/YYYY-MM-DD-<slug>.md` |

Record it with `agt thread report <id> <path>` (workspace-root-relative). Keep working notes elsewhere in `.docs/`:
only the report is shared. Commit `.docs/` changes as the doc rules say.

## The share rule

The report never mentions: `.docs`, `.agentthread`, `.worktrees`, local paths, thread or ticket ids, private specs,
notes or decisions, or the project's banned words. Point at code by repo path and line (`src/auth.ts:42`) or by PR.

`agt thread report <id> --check` lists every hit with its line; fix them all before asking for approval.
`agt stage <id> 4 done` runs the same check and refuses while a hit, a missing file or an empty file remains.

## Finishing

After stage 4: `agt tell main "<id>: report approved: <path>"`. Main closes the thread and runs `agt thread cleanup`;
the coordinator never does.
