# NN — <REPO>: <what this ticket delivers>

Status: open
Assignee: <worker>
Repo: `<repo>`; worktree `<worktree path>`, branch `wip/<task>` (do not create branches or worktrees)
Spec: `<spec path>`
Method: <TDD / red-first for a bug fix>. Read first: <project rule files>.

## Files you may edit / create

- edit: `<path>`
- create: `<path>`

Others working in this worktree now: <worker → files>. Any file not listed here is off-limits — stop with BLOCKED.

## Task

1. <step, with `file:line` anchors and the decision ids it implements>
2. Service-level flow test with the exact payload the FE sends (for save/delete paths).
3. Run `<ticket's test command>` and `<type check>`; paste the output.
4. Commit only your files: `git add <new files> && git commit -m "<conventional message>" -- <your files>`.
   A new commit for each review fix.

## Acceptance

- <observable result + the evidence to paste>
- `git show --stat HEAD` lists only the files above.

## Do not

- push, amend, rebase, reset, stash, `git add -A` / `.` / `commit -a`, delete `index.lock` (wait and retry).
- restart or stop servers (including build-tool daemons), edit the user's own checkouts.
- mention private docs, ticket ids, AI attribution or <banned words> in any repo file, test name or commit message.

## Report back

<!-- Use the config's report command and words (e.g. DONE/BLOCKED or the project's own). -->

Append evidence under `## Comments`, then **run it with your shell tool — printing it is not reporting**:

```bash
<report-done command with "[<worker>] DONE NN: <summary>. Report: <ticket path>">
```

Blocked:

```bash
<report-blocked command with "[<worker>] BLOCKED NN: <what blocks you>. Report: <ticket path>">
```

## Comments
