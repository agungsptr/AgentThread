# Tickets, stages and stack lock (Plan 11): rulings and follow-ups

Source: the SDD ledger for docs/superpowers/plans/2026-11-02-tickets-stages-stack.md (branch feat/tickets-stages-stack, e8ce7e2..e9871d7). Plans 12 (feature workflow) and 13 (workspace release e2e) continue §13.

## Rulings
- **Overlap per repo.** On task threads, file-overlap checks (claim and scheduling) compare only tickets of the same repo.
  - Why: a ticket is bound to one repo, so the same path in another repo is a different file.
  - Cost if wrong: needless serialisation, or none.
- **Missing-worktree text.** The spawn rejection reads `ticket <T> needs a worktree for <r>; create it with agt worktree add <thread> <r>`.
  - Ticket add accepts a known repo that has no worktree yet; the check happens at spawn time, before the queue branches.
- **Coordinator prompt.** On task threads it says `--repo/--file`, not `--scope`.
- **What blocks a ticket.** A ticket that only waits in the queue does not block others. One with a live worker that has not yet claimed it does.
- **Returns always reach a worker.** A returned ticket whose worker is lost or ends gets a fresh worker automatically, carrying the return note.
  - After two fresh workers have exited, it is released to the coordinator with a notice.
  - A worker's `session.failed` releases the ticket to the coordinator instead of respawning.
  - Cost if wrong: an unwanted respawn, or one manual respawn.
- **Stage recording rules:**
  - `approve` applies only to stage 7 and needs `--by user`.
  - `skipped` needs `--by user`.
  - `skipped` and `na` need `--reason`.
  - Recording a stage again replaces the earlier record.
  - The coordinator and the user may record stages; workers and main may not.
  - Legacy threads reject `agt stage`.
  - Cost if wrong: some flag friction for the coordinator.
- **Stage 8 skip opens the gate.** A stage 8 `skipped --by user` opens the squash gate.
  - Why: the user may skip any stage for a task, and a gate that never opens would block the squash.
- **Stack lock roles.** The coordinator and the user may acquire and release the lock; any role may see its status.
  - There is no legacy gate on the lock. The e2e4 approval gate is skipped for legacy threads, which have no stages.
  - Acquiring again while queued keeps the position. A queued thread that releases leaves the queue (reason `left the queue`).
  - The sweep also drops queued threads that have no live coordinator.
  - The e2e4 check runs before the holder and queue shortcuts.
- **One fix wave after the final review.** It fixed the refill on `ticket.released`, the respawn brake for returned tickets, the e2e4 gate bypass, claim-from-review, the `--file` validation (no directories, no quote, backslash, tab or newline), FILE_HOLDING in claim, and the early missing-worktree rejection.

## Deferred
- **Done threads.** A thread that is `done` can still record stages or take the lock. The sweep frees the lock within one pass.
- **Task 1:**
  - legacy `ticket add` silently ignores `--repo/--file/--doc` (consider rejecting);
  - no CLI test for `agt ticket files`.
- **Task 2:** a long inline `also` set in `fillWorkers`; a test that hides a spawn in `&&`.
- **Task 3:**
  - CRLF or trailing whitespace in a `.files` list would refuse everything (the daemon writes it, so this is fine);
  - paths containing newlines are unsupported (now rejected at add);
  - the fail-closed git-diff branch is untested.
- **Task 4:**
  - `fillWorkers` subtracts ended workers on legacy threads too (the slot frees one pass earlier);
  - a return while the thread has no root pane starts only on the next refill trigger;
  - usage alignment;
  - no test of the guide output;
  - the review notice may fire early for a just-started hook worker;
  - the `worker spawn failed` branch is untested.
- **Task 5:**
  - the hook prints a literal `<thread>` when AGT_THREAD is unset;
  - `--reason` is accepted on `done`;
  - the legacy not-gated test is tautological;
  - `by` is recorded as coordinator when the user runs `done` without `--by`;
  - `--by user` is trust-based (the plan's call);
  - every coordinator commit on `feat/<task>` is gated, not only the squash.
- **Task 6:**
  - no test of the `stackGiven` guard;
  - the wording "Stack: free" versus "Held by";
  - the lock may pass to a queued thread whose coordinator died but has not yet been swept (the next sweep fixes it).
- **Carried into Plan 12:** a user shell in a thread tab inherits `AGT_ROLE=coordinator` and the first coordinator has no `AGT_SESSION`. Plan 12 Task 5 adds the `AGT_AGENT_PROCESS=1` agent marker for all hook stubs.
