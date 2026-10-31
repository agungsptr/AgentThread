# AgentThread Tickets, Stages and Stack Lock (Plan 11) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give task threads the machinery of the user's feature workflow:
- tickets bound to one repo and a list of files, with the worker started in that repo's worktree;
- parallel work only on disjoint files;
- a pre-commit check that staged files are the ticket's own;
- a review/accept/return cycle with the same worker session;
- ten tracked stages with two gates;
- a workspace stack lock.

**Architecture:**
- Ticket machine fields live in agt events. The daemon renders each ticket's file list to `.agentthread/threads/<id>-<slug>/tickets/<T>.files`, so the git hook can check commits without the daemon.
- `ticket.done` on a task thread moves the ticket to `review`. The worker stays alive until the coordinator runs `accept` (which ends it) or `return` (which sends the note to the same session, or to a fresh worker when that session is gone).
- Stages are events. The squash gate is checked by the pre-commit hook on `feat/<task>`. The stage-4 gate is checked when the stack lock is taken for e2e stage 4.

**Tech Stack:** TypeScript on Bun ≥ 1.1.34, `bun:test`, git.

**Spec:** `docs/specs/2026-10-09-agentthread-design.md` §13 (§13.1, §13.3, §13.4, §13.9). Plan 2 of 4 for §13. Plan 10 (workspaces) is merged; Plan 12 brings the workflow content and config, and Plan 13 the release e2e.

## Global Constraints

- **Runtime and checks.**
  - Bun ≥ 1.1.34, TypeScript `strict: true`.
  - Tests: `env -u HERDR_ENV -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID -u HERDR_PANE_ID -u AGT_HERDR_IT bun test`. Run the full suite under `timeout 300`, plus `bun run typecheck`, before each commit.
- **Forbidden.**
  - Never run real herdr or agents, `agt start`, or tests/release/.
  - Leave no `agt daemon run` or `agt __spawn` processes behind.
  - No `Bun.spawnSync` on daemon paths.
- **Legacy threads** (`t.legacy`) keep every old behavior: scope tickets, `done` without review, and coordinator commits.
- **New CLI**, exactly:
  - `agt ticket add <thread> "<title>" --repo <r> --file <path>... [--doc <path>]` (task threads; `--scope` stays for legacy)
  - `agt ticket accept <thread>/<T>`
  - `agt ticket return <thread>/<T> "<what to fix>"`
  - `agt ticket files <thread>/<T>`
  - `agt stage <thread> <1-10> done|skipped|na|approve [--reason "<why>"] [--by user]`
  - `agt stack acquire <thread> [--for e2e4]`
  - `agt stack release <thread>`
  - `agt stack status`
- **New events**, exactly:
  - `ticket.reviewed`, payload `{ticket, summary}`: worker done, now in review
  - `ticket.accepted`, payload `{ticket}`
  - `ticket.returned`, payload `{ticket, note}`
  - `stage.recorded`, payload `{stage, state, by, reason?}`
  - `stack.acquired`, payload `{thread, purpose?}`
  - `stack.queued`, payload `{thread, purpose?}`
  - `stack.released`, payload `{thread, reason}`
- **New ticket status:** `review`.
- **Notice texts**, exactly:
  - to the coordinator, when a worker's turn ends after `ticket done`: `Ticket <T> is ready for review: <summary>. Review its commits, then agt ticket accept <thread>/<T> or agt ticket return <thread>/<T> "<what to fix>".`
  - to the worker, on return: `Ticket <T> was returned: <note> Fix it in a new commit, then run agt ticket done <thread>/<T> --summary "<one line>" again.`
  - to the coordinator, when the stack lock is acquired from the queue: `The stack lock is yours for thread <id>.`
- **Hook refusal messages**, exactly:
  - worker staging files outside its ticket: `AgentThread: these files are not in ticket <T>: <list>.`
  - squash before stage 8: `AgentThread: stage 8 (browser check) is not done; record it with agt stage <thread> 8 done|na first.`
- **Rejection message:** stage 4 e2e without approval: `stage 4 e2e needs the user's approval: agt stage <thread> 7 approve --by user`.

## Review Focus

1. **A worker that commits a file outside its ticket is refused**, including a new file, a rename, and a delete. A worker whose ticket list includes a file can commit that file. Test in Task 3.
2. **Two tickets in one repo with overlapping files never run at the same time.** The second waits in the queue and starts when the first is accepted. Test in Task 2.
3. **A returned ticket always reaches a worker**: the same live session, or a fresh worker if the session ended. It is never stranded in `in_progress` with no worker. Test in Task 4.
4. **The stack lock is never held forever.** When the holder thread has no live coordinator, the lock is released on the next sweep, and the queue moves on. Test in Task 6.

---

### Task 1: Tickets carry a repo, files and a doc path; workers start in the repo worktree

**Files:**
- Modify:
  - `src/commands/schema.ts` and `src/commands/handler.ts` (`ticket.add`)
  - `src/domain/types.ts` (`ticket.created` payload)
  - `src/state/projection.ts`
  - `src/orchestration/sessions.ts` (`spawnWorker` cwd)
  - `src/render/write.ts` (the files list per ticket)
  - `src/render/markdown.ts` and `src/render/brief.ts` (the board shows repo and files)
  - `src/cli/main.ts`, `usage.ts`
- Test: `tests/commands/tickets.test.ts`, `tests/orchestration/sessions.test.ts`, `tests/render/write.test.ts`

**Interfaces:**
- **Event.** The `ticket.created` payload gains optional `repo: string`, `files: string[]` and `doc: string`.
- **Projection.** `Ticket` gains `repo?`, `files?` and `doc?`.
- **Command.** `ticket.add` takes `repo?`, `files?` and `doc?`.
  - For a task thread (`!t.legacy`), `repo` and at least one `file` are required. `scope` is set to `files` so the existing overlap code applies.
  - A repo not in `workspace.repos` is rejected: `unknown repo <r>`.
  - A known repo with no worktree in the thread is accepted. My call: tickets can be written before worktrees exist, so the worktree check happens at spawn time (below).
  - Paths are repo-relative, normalised, with no leading `/` and no `..` segments. Otherwise the error is `file paths are relative to the repo: <p>`.
- **Files list on disk.** `writeAll` writes `<threadDir>/tickets/<T>.files`, one path per line, for each task-thread ticket.
- **CLI.** `agt ticket files <thread>/<T>` prints the same list. It reads from the daemon.
- **Worker spawn.** `spawnWorker` on a task thread uses `t.worktrees[k.repo].path` as cwd. When that worktree is missing, `worker.spawn` is rejected with the message above.

- [ ] **Step 1: Write the failing tests.**
  - `ticket add` with repo, two files and a doc creates a ticket with those fields, and the `.files` list has both paths.
  - The unknown-repo and bad-path rejections give their exact messages; a known repo without a worktree is accepted.
  - `worker spawn` for a ticket whose repo has a worktree starts the worker with cwd at that worktree. Without a worktree it is rejected with the exact message.
  - The board and the brief show `[repo] files…`.
  - A legacy thread's `ticket add --scope` is unchanged.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `feat: task tickets name their repo and files; workers start in that repo's worktree`.

### Task 2: Parallel only on disjoint files

**Files:** Modify `src/commands/handler.ts` (`worker.spawn`, `ticket.claim`) and `src/orchestration/reactor.ts` (`fillWorkers`). Test `tests/orchestration/scheduling.test.ts`.

**Behavior:**
- On a task thread, a ticket **conflicts** with another ticket that:
  - is in the same repo;
  - has status `in_progress`, `review`, or is queued with a live worker;
  - has at least one file in common.
- `worker.spawn` of a conflicting ticket queues it (`worker.queued`) and does not spawn. The result says `{queued: true, waitingFor: "<T>"}`.
- `fillWorkers` skips queued tickets that still conflict. It starts them once the conflicting ticket is `done` (accepted), `blocked`, or `open` again.
- `ticket.claim` keeps its overlap rejection as a second line of defence.

- [ ] **Step 1: Write the failing tests.**
  - T1 and T2 in `api` share `src/a.ts`. Spawning both starts T1 and queues T2. Accepting T1 starts T2.
  - T1 in `api` and T3 in `fe` with the same relative path both start, because the repos differ.
  - Disjoint files in one repo both start.
  - `max_workers` is still respected.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `feat: tickets that share files in a repo run one after the other`.

### Task 3: The pre-commit hook checks a worker's staged files

**Files:** Modify `src/agents/agents-md.ts` (the `hookStub` worker branch). Test `tests/agents/agents-md.test.ts`.

**Behavior:**
- For `AGT_ROLE=worker` on `wip/$AGT_TASK`, the stub reads `$AGT_ROOT/.agentthread/threads/*/tickets/$AGT_TICKET.files`, choosing the thread directory whose name starts with `$AGT_THREAD-`.
- Staged paths come from `git diff --cached --name-only --no-renames --diff-filter=ACDMRT`.
- Any staged path that is not in the list refuses the commit with the exact message (paths space-separated).
- A missing list file refuses the commit with `AgentThread: no file list for ticket <T>; ask the coordinator.`
- Coordinator and user behavior is unchanged.

- [ ] **Step 1: Write the failing tests** (real git):
  - a worker commit of its own two files passes;
  - adding a third file is refused, naming it;
  - deleting a listed file passes, and deleting an unlisted file is refused;
  - a rename from a listed path to an unlisted path is refused;
  - a missing list is refused with the exact message;
  - paths with spaces are handled.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.** The stub stays POSIX sh.
- [ ] **Step 4: Run the full suite and typecheck.** Commit `feat: a worker can commit only the files of its ticket`.

### Task 4: Review, accept and return

**Files:**
- Modify:
  - `src/commands/schema.ts`, `handler.ts`
  - `src/domain/types.ts` (`TicketStatus` gains `review`; new events)
  - `src/state/projection.ts`
  - `src/orchestration/reactor.ts`: the done notice, finished-worker teardown, `doneWorkerEnded`, `endFinishedWorker`
  - `src/orchestration/sweep.ts`: finished-worker grace now applies after `accepted`
  - `src/orchestration/sessions.ts`: a fresh worker for a return
  - `src/cli/main.ts`, `usage.ts`, `src/agents/prompts.ts`
- Test: `tests/orchestration/review.test.ts`

**Behavior (task threads):**
- **`ticket.done`.** It emits `ticket.reviewed`, and the ticket status becomes `review`. Teardown on the worker's idle no longer happens for a ticket in `review`.
  - The coordinator is notified with the exact ready-for-review text when the worker's turn ends: the next `agent.idle` of that worker, or at once if it is already idle. This is the same deferral as today.
- **`ticket accept`** (coordinator only):
  - Requires status `review`.
  - Emits `ticket.accepted`, and the status becomes `done`.
  - The reactor ends the worker with the existing finished-worker teardown, then runs `fillWorkers`.
  - No second notice is sent.
- **`ticket return`** (coordinator only):
  - Requires status `review`.
  - Emits `ticket.returned`, and the status becomes `in_progress`.
  - If the assignee session is live, it gets the exact return notice.
  - Otherwise a fresh worker is spawned for the ticket. Its bootstrap is the normal worker bootstrap followed by the return notice text.
- **Sweep.** The finished-worker grace sweep (Plan 8) applies only to tickets in `done` (accepted) whose worker is still live.
- **Legacy threads** keep `ticket.completed` and the old flow.
- **Prompts.**
  - Worker (task threads): `When the ticket is done, run agt ticket done … --summary and wait: the coordinator reviews your commits and may return the ticket with what to fix.`
  - Coordinator (task threads): `Review each ticket's commits (git show --stat must list only its files), then agt ticket accept or agt ticket return with what to fix.`

- [ ] **Step 1: Write the failing tests.**
  - done → `review`, with the notice after the worker's idle, and the worker is still live.
  - accept → `done`: the worker is ended, its pane closed, and the next queued ticket starts.
  - return with a live worker → the worker gets the exact notice; status is `in_progress`.
  - return after the worker ended → a fresh worker spawns with the note in its bootstrap.
  - accept or return on a non-`review` ticket is rejected.
  - A worker cannot accept.
  - A legacy thread is unchanged.
  - The grace sweep ignores tickets in `review` and closes an accepted ticket's lingering worker.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `feat: tickets go to review; the coordinator accepts or returns them to the same worker`.

### Task 5: Stages and the squash gate

**Files:**
- Modify:
  - `src/commands/schema.ts`, `handler.ts` (`stage`)
  - `src/domain/types.ts`, `src/state/projection.ts` (`Thread.stages: Record<1..10, {state, by, reason?, ts}>`, plus `stage7Approved`)
  - `src/render/brief.ts`, `markdown.ts` (current stage)
  - `src/render/write.ts`: writes `<threadDir>/stage8` containing `done` or `na` once stage 8 is recorded as either, so the hook can check it without the daemon
  - `src/agents/agents-md.ts`: the stub's coordinator branch on `feat/$AGT_TASK` refuses unless that file exists
  - `src/cli/main.ts`, `usage.ts`
- Test: `tests/commands/stages.test.ts`, `tests/agents/agents-md.test.ts`

**Behavior:**
- **Who may record.** `agt stage` is available to the coordinator and the user. `--by user` is allowed only for `approve` and `skipped`, and it records `by: "user"`. My call: the flag is trust-based, like the other user-only flags.
- **Current stage.** The lowest stage that is not `done`, `skipped` or `na`. brief.md and sub.thread.md show `Stage: <n> <name>`, and main.thread.md shows the same in each thread's row. Stage names, 1–10:
  1. discussion
  2. spec
  3. tickets
  4. delegation
  5. review
  6. unit and type check
  7. e2e
  8. browser check
  9. shared docs
  10. release and squash
- **Approval.** `approve` is valid only for stage 7, and sets `stage7Approved`.
- **Squash gate.** It is the hook check above, with the exact message. Nothing else is refused.

- [ ] **Step 1: Write the failing tests.**
  - Recording stages 1–3 as done makes the current stage `4 delegation` in the brief and on main.
  - `na` and `skipped` with a reason count as passed.
  - `approve` on any stage other than 7 is rejected.
  - Real git: a coordinator commit on `feat/<task>` is refused with the exact message before stage 8, and allowed after `agt stage <id> 8 done`.
  - A legacy thread has no stage gate.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `feat: threads record their ten stages; the squash waits for the browser check`.

### Task 6: Workspace stack lock

**Files:**
- Modify:
  - `src/commands/schema.ts`, `handler.ts` (`stack.acquire`, `stack.release`, `stack.status`)
  - `src/domain/types.ts`
  - `src/state/projection.ts` (`state.stack: {holder?: {thread, purpose?, since}, queue: {thread, purpose?}[]}`)
  - `src/orchestration/reactor.ts`: on release, the next in the queue acquires it, with a notice
  - `src/orchestration/sweep.ts`: auto-release
  - `src/render/markdown.ts`: main.thread.md shows the holder and the queue
  - `src/cli/main.ts`, `usage.ts`, `src/agents/prompts.ts`
- Test: `tests/commands/stack.test.ts`

**Behavior:**
- **Acquire.**
  - When free, `acquire` emits `stack.acquired` and returns `{acquired: true}`.
  - When the holder is this same thread, it is a no-op success.
  - When held by another thread, it emits `stack.queued` and returns `{acquired: false, position: n}`.
- **Stage-4 gate.** `--for e2e4` without `stage7Approved` is rejected with the exact message.
- **Release.** `release` by the holder emits `stack.released` (reason `released`). The reactor then gives the lock to the first in the queue (`stack.acquired`) and notifies that thread's coordinator with the exact text.
- **Auto-release.** The sweep releases the lock (reason `holder thread has no live coordinator`) when the holder thread has no live coordinator, or is done, and moves the queue on. Releasing from a thread that is not the holder removes it from the queue.
- **Coordinator rule:** `- Before restarting the stack, running e2e or the browser check, run agt stack acquire <thread> (add --for e2e4 for the full e2e); wait for the notice if it is queued; agt stack release <thread> when done.`

- [ ] **Step 1: Write the failing tests.**
  - Thread A acquires, B queues at position 1, A releases, and B gets it with the notice.
  - A double acquire by A is a no-op.
  - e4 without approval is rejected, and with approval it is acquired.
  - When A's coordinator is lost, the next sweep releases the lock to B.
  - main.thread.md shows the holder and the queue.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `feat: one stack lock per workspace with a queue shown to main`.
