# Worker layout, worker context and OpenCode edge rows (Plan 14): runs, rulings and follow-ups

Source: the SDD ledger for docs/superpowers/plans/2026-11-11-workers-layout-context.md (branch feat/workers-layout-context, 6fd53e1..HEAD).

## E2E results (real Herdr, isolated sessions)
- Every Plan 14 row has passed:
  - `ws-happy-claude-code` and `ws-edge-return-worker-opencode` / `ws-edge-out-of-ticket-worker-opencode` (report 2026-11-11T18-40-47-377Z);
  - `ws-happy-worker-opencode` and `ws-cleanup` (2026-11-13T16-50-12-078Z);
  - `ws-stack-lock` (2026-11-13T18-06-47-593Z).
- The OpenCode worker model was `myrouter/worker`.
- The real Herdr `pane layout` shape is confirmed: the layout-driven rows passed live.

## Found by the runs and fixed
- **Long typed env line.** The first layout version typed a worker's env into a new workers tab as one `export` line of about 1872 bytes. Herdr refuses lines over 1024 bytes in canonical mode, so every worker failed.
  - Fix: the workers tab is created with the worker's env (`tab create --env`), and only `AGT_AGENT_PROCESS=1` is typed.
  - The minimum pane became 60×15; 80×20 had made normal panes unsplittable.
- **Mac sleep.** The machine slept during long runs, leaving event gaps of 16 and 24 minutes.
  - Fix: a stall-aware deadline clock in the harness.
  - Release runs now go under `caffeinate -i`.
- **`{task}` placeholder.** Coordinators ran `make restart TASK={task}` with the literal placeholder, or with the thread id.
  - Fix: thread-dir and worktree skills show stack commands with the task already filled in.
- **Stray daemon.** A surviving OpenCode worker obeyed "run `agt daemon start`" and started a daemon inside a worktree.
  - Fix: `agt daemon start` and `agt daemon run` refuse in agent panes, in thread-tab shells and under `.worktrees/`.
  - The agent-facing text says to tell the user, and the daemon's cwd is the project root.

## Rulings
- The minimum worker pane is 60×15 with a 1-cell divider: split right from 121 columns, down from 31 rows; otherwise use the `<id>-<slug>-workers` tab (`-workers-2`, …).
- A workers tab carries its first worker's env. The marker is typed, not put in the tab env, so a user shell there is never treated as an agent.
- The worker context notice fires once per ticket and resets on `ticket.returned`. Workers are never rotated automatically.
- omp compaction: `compaction.thresholdTokens` = floor(context_threshold × context_window), about 140K by default, set through a `--config` overlay. The key comes from omp's public docs/compaction.md, not from the user's config. `launch()` stays pure; a separate `prepare` step writes the overlay; the adapter owns its fallback (`degradedArgs`).
- Release runs use `caffeinate -i`.

## Deferred
- **A test occasionally leaks an `agt daemon run`** in a temp dir during the full suite. Fix soon.
- **User shells in a thread tab or workers tab** get the agent-style "tell the user" refusal text, because `inAgentContext` keys on `AGT_ROLE`/`AGT_THREAD` without the marker. The behaviour is safe; only the wording is wrong for a user.
- **The omp overlay** is written non-atomically (use temp file plus rename). No omp e2e row has verified the overlay live yet.
- **Leftover root-pane shell.** It keeps `AGT_ROLE=worker` and the marker when panes are kept.
- **Workers tab edge cases:**
  - a missed workers-tab close is not retried by reconcile;
  - a zoomed workers tab opens an extra tab;
  - mixed adapters in one workers tab inherit the first worker's adapter env keys.
- **Placement lock races.** Concurrent steals, pid reuse, and a leaked lock dir when the pid write fails are bounded by the 30s wait and the 120s backstop.
- **Harness clocks.** Four `harness.ts` helpers still default `now` to `Date.now`.
- **Missing test:** none for the `--agents` filter hiding the OpenCode rows.
- **Context size reporting.** Only claude-code reports it, so the worker context notice covers Claude workers only.
