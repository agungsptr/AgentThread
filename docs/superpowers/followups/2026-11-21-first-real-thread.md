# First real thread on Project B (Plan 16): evaluation, fixes and follow-ups

Source: an evaluation of thread `001-feature-x` in the user's Project B workspace:
- event log, daemon.log and thread files;
- main and coordinator transcripts.

Setup: main and coordinator on Claude Code, workers on Antigravity.

## Results
- **Time:** stage 10 was reached in 60 minutes. Agents spent about 13 of those minutes waiting on the user.
- **Tickets and workers:** 12 tickets (7 planned, 4 companions, 1 extra) and 13 worker sessions.
- **E2E:** 99/100 passed. The one failure also fails on dev.
- **Coordinator rotations:** three, all for context.
- **Tokens:**
  - main: about 15k output;
  - the four coordinators together: about 132k output and 30.7M cache-read.
- **Biggest waste:** `ticket add --file a b c` recorded only `a`. The workaround was four companion tickets.
  - Fixed in 1366a7d: `ticket files --add/--remove`, and file paths in a ticket title are rejected.

## Fixed in Plan 16
- **Help.** `agt --help`, `-h`, `agt help` and `agt help <cmd>` work, and so does `agt <cmd> --help` (exit 0; it never runs the command). Arguments after `--` never trigger help.
- **Logger.**
  - `agt logs` prints readable lines; heartbeat events are hidden unless `--all` is given.
  - `logs -f` survives daemon restarts.
  - `agt start` repairs the logger pane, using `logger.pid` verified by its command line.
- **Squash branch follows the thread type.** feature → `feat/`, bug → `fix/`, chore → `chore/`; `workflow.branch_prefix` overrides this, and `wip` and `thread` are refused.
  - The guard reads the thread file `squash-branch`, which is written once.
  - Older threads may still use `feat/<task>`, in both the guard and cleanup.
- **Language.** The `chat_language` rule comes first in the prompts for main, the task coordinator and task workers, and in the rotated-coordinator bootstrap.
- **Post-merge flow.**
  - The coordinator verifies the merge (ancestor check, else `git cherry`, else it reports "unverified"), releases the stack lock and tells main.
  - Main then:
    1. sets the thread to done;
    2. moves the stack back to main when it was on that task;
    3. runs cleanup;
    4. reports to the user.
  - A coordinator cannot set a task thread to done.
- **Main drafting.** At most 3 criteria and at most one question; the user's words map to `--type`.
- **Notices.**
  - A handoff request jumps the queue.
  - Delivery is acknowledged by notice text, so a notice inserted during an in-flight delivery is never dropped. Older events replay by count.
  - The fallback window runs from delivery, with a hard cap of 2× the timeout.
  - The "waiting" notice to main is neutral (a question or a permission), is not duplicated by `thread waiting`, and names the thread tab.
  - `thread status` to the same status is a no-op.
- **Project B config.** The e2e commands set `E2E_BASE_URL=http://localhost:9002`, because `e2e/.env.e2e` says 9901.

## Deferred
- **Rotation threshold.** The 140k threshold of an assumed 200k window is reached quickly, because the first turn alone is about 48k. Tune it, or shrink the coordinator's start-up context.
- **Stage timestamps** can be recorded after the fact (stages 1–4 within one second).
- **Shared databases.** The stage-8 browser check and the migrations ran against a shared dev database; the workflow has no notion of a disposable database.
- **E2E baseline.** A "pre-existing failure" was judged before any baseline existed.
- **`pane get` error code.** Herdr's code for a missing pane is assumed to be `pane_not_found` / `not_found`; it is not yet verified against real Herdr.
- **Logger pid cleanup** has no test.
