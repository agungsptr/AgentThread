# Workspace release e2e (Plan 13): rulings, run results and follow-ups

Source: the SDD ledger for docs/superpowers/plans/2026-11-04-workspace-release-e2e.md (branch feat/workspace-release-e2e, 4825fac..HEAD). The real runs found several product bugs; Tasks 5–9 fixed them.

## Run results
- **Claude Code regression: all 8 workspace rows PASS** (`.agentthread/e2e-reports/2026-11-11T14-20-32-242Z.md`): `ws-smoke-worktrees`, `ws-edge-stage-gates`, `ws-tab-shell`, `ws-edge-return`, `ws-edge-out-of-ticket`, `ws-happy-claude-code`, `ws-stack-lock`, `ws-cleanup`.
- **ws-tab-shell findings (real Herdr):**
  - The first coordinator's process carries `AGT_AGENT_PROCESS=1`.
  - A pane the user splits in a thread tab does not inherit the tab env, so it has no `AGT_*` variables.
  - The user's commit on `wip/<task>` from that pane passes.
- **Pending: the OpenCode worker rows** (`ws-happy-worker-opencode` and edge rows with OpenCode workers). They need `AGT_E2E_MODEL_OPENCODE`; the user is to confirm the model (proposed `myrouter/worker`). The user's direction is that e2e focuses on OpenCode workers while agt stays agent-agnostic. There is no omp worker row: in Zentro, omp spent about 2.3× the prompt tokens of OpenCode (`.docs/shared/notes/2026-11-06-worker-harness-omp-vs-opencode.md`).

## Product bugs found by the runs, and their fixes
- **Trust dialog (Task 5).** Claude Code asks to trust each folder agt creates (`.worktrees/<task>/`, repo worktrees): trust of a non-git workspace root is not inherited.
  - Fix: agt answers the dialog only in folders under `<root>/.worktrees/` that it created. It never touches Claude's config. The root folder stays the user's one-time choice.
- **Workers ending before they claim their ticket (Task 6).**
  - A worker that ended before claiming left its ticket stranded silently. Fix: auto-replace up to twice, with a coordinator notice each time, then a final notice.
  - Failed rows now keep pane screens as evidence.
- **The trust answer picked "No, exit" (Task 7).**
  - `down` sent too early made `enter` land on "No, exit". Fix: confirm "Yes" is selected (two reads) before pressing `enter`.
  - The bootstrap was typed into the dialog. Fix: hold it until the dialog is gone.
  - The poller no longer ends `starting` sessions.
  - The selection check now judges only the dialog's own option lines, because the user's starship `❯` prompt sits above the dialog.
- **Narrow panes (Task 8).** In a narrow split the dialog's footer wraps, Herdr lists the agent idle, and the bootstrap's `enter` picked "No, exit".
  - Fix: every typing path reads the screen first. Wrapped and chopped dialogs are detected and typing is held.
- **Idle workers that never report (Task 9).** A worker idled "waiting for another ticket" without `done` or `block`, and the thread deadlocked.
  - Fix: the coordinator gets an idle notice from the sweep after about 20s of a continuous idle stretch. It is capped at 3, then one "keeps stopping" notice, and skipped while the worker has an open question.
  - The worker rule now says to block instead of waiting.
  - `agt tell <thread>/<T>` reaches a ticket's live worker.
- **Final review fixes.**
  - Held or failed notices are retried by the sweep.
  - A worker whose agent never started has its split closed before it is respawned.
  - The typing-safety check lives in one helper, keyed by the pane's agent kind.
  - New behaviours are documented in `docs/agents.md` and README.

## Rulings
- **ws-tab-shell** checks the marker on real processes (`ps -E`) instead of attempting a push.
- **Answering waits in the happy rows.** They answer `thread.waiting` with a canned "go with your recommendations" typed into the coordinator's pane.
- **ws-edge-stage-gates** configures a browser URL, so stage 8 is not automatically `na`.
- **Rows with agents run main**, so the root's trust dialog is answered.
- **Trust auto-answer** applies only in `<root>/.worktrees/`, never touches config, and is opted into per adapter (`trustPrompt`).
- **Early-exit replacement** is capped at 2. A returned ticket keeps Plan 11's `freshWorkers` path, so there are two notice wordings for similar cases.
- **Worker panes** close on end again in the workspace rows. Keeping dead panes narrowed every respawn split down to about 4 columns.
- **Idle notice.** It fires once per idle stretch, from the sweep after about 20s, with a cap of 3 per ticket.
- **`agt tell <thread>/<T>`** is for the thread's coordinator and the user only.

## Deferred
- **Held-notice retry has no backoff (fix soon).** For a stuck idle session it appends `notice.held` on every sweep, so the event log grows.
- **Pane layout.** Repeated splits make panes narrower. Consider a minimum width, reusing closed slots, or a new tab per extra worker.
- **Worker context size.** Watch it for agents that report it, as is done for coordinators. Set omp's compaction threshold at launch if omp supports it (user-agreed).
- **Unstarted worker.** Its `pane.close` ignores `close_worker_pane_on_end`.
- **Idle notice:**
  - its cap is not reset by `ticket return`;
  - a held notice silences it;
  - a worker that asks a question and then idles is skipped only while the question is open.
- **Bootstrap loss without agt's watch.** It can still be lost in user folders, or after the watch gives up, if delivery races Herdr; the sweep retry now covers most of this.
- **A test occasionally leaks an `agt daemon run`** in a temp `agt-repo-*` dir. It could not be reproduced, so the cause is likely a timed-out test.
- **Old-log replay.** After an upgrade, an open ticket whose last worker ended without claiming gets one respawn when the logs replay.
- **Fixture typecheck** is a bundle check, not a real type check.
- **Missing tests:**
  - the async start path's busy and not-ready cases are tested only through a sync fake;
  - there is no legacy respawn test and no test of the trigger for the run.ts screen dump.
- **Respawn mechanisms.** Merge `freshWorkers` and `earlyExits` later.
- **Edge-row checks are lenient:** `ws-edge-return` accepts any returned ticket, and `ws-stack-lock` does not assert who issued acquire.
