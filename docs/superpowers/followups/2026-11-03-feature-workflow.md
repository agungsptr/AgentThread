# Feature workflow (Plan 12): rulings and follow-ups

Source: the SDD ledger for docs/superpowers/plans/2026-11-03-feature-workflow.md (branch feat/feature-workflow, 8df60d9..cfba829). Plan 13 (workspace release e2e) finishes §13.

## Rulings
- **Doc paths.** Ticket `--doc` paths are relative to the workspace root. On task threads they must be normalised paths under `.docs/`, with no `..`, backslash or glob characters, because the worker's Claude Edit/Write/Read rules are built from them.
- **Auto-`na`.** Stages are marked `na` automatically only on task threads.
- **Generated manage-docs.** It fills its placeholders (repos, file language, report words, commit policy) from config. The shipped templates say "Coordinator" instead of "Manager".
- **Claude rules for the coordinator and worker.**
  - The coordinator's `.docs` git rules are limited to `git -C <root>/.docs add|commit|status|diff|log`, so no push and no re-targeting.
  - Read rules: the worker may read its doc, and the coordinator may read `.docs/**`.
- **Commit message guard.** The ticket-id check is case-sensitive (`T<n>`); the other checks ignore case.
- **Agent marker.** Hooks apply role rules only when `AGT_AGENT_PROCESS=1`.
  - Every agent launch sets the marker: adapter `processEnv`, split-pane env, a root-pane export, and main.
  - The tab env never has it, so a user shell in a thread tab is never refused.
- **Cleanup and unsquashed work.** `wip/<task>` is deleted only if `feat/<task>` exists or wip has no commits outside other local branches. Otherwise cleanup stops before removing anything, with a hint to delete the branch by hand if it was merged another way.
- **Cleanup method.** Cleanup runs plain `git worktree remove`, without `--force`, after a porcelain check of every worktree. It unregisters only its own stale worktree entry. Status changes, cancel and `worktree add` are rejected while a cleanup runs.
- **Waiting.** A thread stays `waiting` until the coordinator goes idle and then gets a turn from the user. A notice agt delivers does not count as that turn.
- **Project-owned skills.** A skill owned at the workspace root (for example Zentro's `manage-docs`) also counts as owned in thread dirs and repo worktrees. agt removes its own marked copy there and logs `kept the project's own skill …`.
- **Status after the squash.** The coordinator no longer sets `review` itself: `agt stage <id> 10 done` does it after the squash.
- **Hook stubs on upgrade.** The daemon refreshes the shared hook stub at start. The README says to restart the daemon and running agents after an upgrade.

## Carried into Plan 13 (real Herdr)
- The first coordinator, whose marker is exported in the root pane before `agent start`, is refused on `git push` and on out-of-rule commits.
- A pane split from the root pane, or a user shell in a thread tab, does not carry `AGT_AGENT_PROCESS`.
- The marker outlives the agent in its own pane's leftover shell (the root pane after the coordinator exits). Document it, or find a way to scope it.

## Deferred
- **Before a release that ships a compiled binary:** verify that the `with { type: "text" }` markdown imports are inlined.
- **Setup.**
  - Its per-repo workflow questions follow `discoverRepos`, not `workspace.repos`.
  - The test script helper is lenient (it answers blank when it runs out of answers).
  - A single-repo config key is pinned to the folder name.
  - Prefill does not handle the regex edge `CC::=`.
- **Project config section:** repo-row tests are weak, backticks in values are not escaped, and `repos.path` is unused.
- **Codex** cannot scope doc writes, so a Codex worker gets no doc grant and a Codex coordinator is asked for `.docs` work.
- **OpenCode:** the coordinator rule `git commit *` does not match `git -C .docs commit`.
- **Claude rules:** a root path containing spaces does not match the `git -C` rules. `git -C .docs diff --output` can write a file.
- **Commit guard.**
  - Banned words are skipped when `AGT_ROOT` is missing.
  - An agent can drop the marker with `env -i`; that was already possible with AGT_ROLE.
  - GNU `grep -w` with multi-word banned words is untested.
  - No test covers the banned-words rewrite after setup.
- **Waiting:** a thread stays waiting across coordinator rotation, and a user answer typed while a notice is pending is ignored. Both fail safe.
- **Cleanup.**
  - The stale-startup notice to main is not asserted.
  - Another thread's wip branch counts as containing the wip commits.
  - When `feat/<task>` exists, wip is deleted without checking that feat contains it.
