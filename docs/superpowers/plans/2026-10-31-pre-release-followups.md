# AgentThread Pre-Release Follow-ups (Plan 8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four small follow-ups that Plan 7 left before release:
- the done notice is lost when a worker's spawn report is lost;
- a hung worker that has finished its ticket stalls its thread;
- a coordinator replacement fails when the thread's root pane is gone;
- main uses `--now` when the user did not name a tier.

**Architecture:** Each task is a small change to an existing seam: the reactor's `session.failed` case, the sweep, the reactor's coordinator replacement, and the main prompt. One agent-free release check verifies how real Herdr behaves when a tab's last pane is closed.

**Tech Stack:** TypeScript on Bun ≥ 1.1.34, `bun:test`, Herdr 0.9.3.

**Spec:** `docs/specs/2026-10-09-agentthread-design.md` §11–§12. Input: `docs/superpowers/followups/2026-10-30-release-hardening.md`.

## Global Constraints

- Bun ≥ 1.1.34 and TypeScript `strict: true`.
- Run tests as `env -u HERDR_ENV -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID -u HERDR_PANE_ID -u AGT_HERDR_IT bun test`. Run the full suite under `timeout 300`, and `bun run typecheck`, before every commit.
- Never run the real `herdr`, `claude`, `opencode`, `codex` or `omp` binaries, or `agt start`, outside `tests/release/`. Task 3 may run only the agent-free `smoke-layout` row.
- Leave no `agt daemon run`, `agt __spawn` or `agt-e2e-*` processes behind.
- No `Bun.spawnSync` on daemon paths.
- Old event logs and configs keep loading.
- New config key `session.finished_worker_grace: duration`, with default `"5m"` and minimum `"30s"`.
- New notice texts, verbatim:
  - to the coordinator, when a hung finished worker is closed: `The worker for ticket <T> finished its ticket but did not stop within <grace>; closed it.`
  - to main, when a coordinator's tab is recreated: `Thread <id> lost its tab pane; reopening its tab with a fresh coordinator.`

## Review Focus

1. **The done notice reaches the coordinator exactly once, on every path a finished worker can take:**
   - idle teardown;
   - the worker exits on its own;
   - the worker is lost;
   - the worker fails (lost spawn);
   - the sweep closes a hung worker;
   - the worker is already idle when `ticket.completed` arrives.

   Tests are in Tasks 1 and 2.
2. **A recreated tab never results in two coordinators**, and it respects the 3-replacements-in-10-minutes brake. Tests are in Task 3.

---

### Task 1: A finished worker's done notice survives a lost spawn, and is not stuck on an already-idle worker

**Files:** Modify `src/orchestration/reactor.ts`. Test `tests/orchestration/rotation.test.ts` (lost-spawn tests) and `tests/orchestration/questions.test.ts` (done-notice tests).

**Interfaces:** Consumes `doneWorkerEnded(s, t)` in reactor.ts (~line 137).

- [ ] **Step 1: Write the failing tests:**
  - A worker that ran `ticket done` and is then failed by the sweep (`spawn report lost after 3m`) sends the coordinator exactly one `Ticket <T> is done: <summary>.` notice, plus the existing lost-spawn notice. Its done ticket is not released.
  - A worker whose status is already `idle` when `ticket.completed` is applied is ended at once. The ending goes through the same teardown as the finished-worker `agent.idle` path. The coordinator gets exactly one done notice.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - In the `session.failed` worker branch, call `doneWorkerEnded(s, t)`.
  - In `ticket.completed`, when the assignee is a live worker with `status === "idle"`, end it exactly as the finished-worker idle path does.
- [ ] **Step 4: Run the full suite and typecheck.** Expected: PASS. Then commit `fix: the done notice survives a lost spawn and an already-idle worker`.

### Task 2: The sweep closes a finished worker that never stops

**Files:** Modify `src/orchestration/sweep.ts`, `src/state/projection.ts` and `src/config/config.ts`. Test `tests/orchestration/sweep.test.ts`.

**Interfaces:**
- Produces `Ticket.completedAt?: string`, set from the `ticket.completed` event's ts and cleared on reopen.
- Produces config `session.finished_worker_grace`.

- [ ] **Step 1: Write the failing tests.** For a live worker whose ticket is `done`, assigned to it, and whose `completedAt` is older than the grace:
  - the sweep ends the worker, using the same end path as teardown (`session.ended` plus pane close);
  - the coordinator gets the exact hung-worker notice from Global Constraints;
  - the coordinator then gets exactly one done notice;
  - nothing happens at grace minus 1s;
  - nothing happens for a worker on a ticket that is not done.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `fix: the sweep closes a finished worker that does not stop`.

### Task 3: A coordinator replacement recovers from a missing root pane

**Files:**
- Modify `src/orchestration/reactor.ts`.
- Modify `tests/release/scenarios/smoke.ts` (an agent-free Herdr check).
- Test `tests/orchestration/recovery.test.ts`.

**Behavior:** a coordinator's `session.failed` has a reason matching `/pane_not_found|pane .* not found/i`, and the thread is not done, has no live coordinator, and is under the brake. Then:
1. The reactor emits `herdr.tab.close` for the old tab, if `t.tab` is set.
2. It emits `herdr.tab.ensure` without a tab id, so a fresh tab is opened.
3. It notifies main with the exact tab-recreated text.

The existing `thread.tab_opened` reaction then spawns the coordinator from the new root pane.

- [ ] **Step 1: Write the failing tests:**
  - **Recovery:** a failed replacement with reason `pane_not_found` yields the close and ensure effects and the main notice. After the `tab_opened` that follows, there is exactly one coordinator.
  - **Brake:** at 3 replacements in 10 minutes, nothing is reopened, and main gets the existing brake notice.
  - **Other reasons:** a failure with any other reason keeps today's behaviour.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Add the real-Herdr check** to `smoke-layout`, in the isolated `agt-e2e-*` session:
  1. Create a tab with one pane and run `herdr pane close` on that pane.
  2. Record whether the pane and the tab are gone, as a check named `herdr closes a tab's last pane`.
  3. If Herdr refuses, the check fails, and the row's detail says so.

  Run `bun tests/release/run.ts --only smoke-layout` once.
- [ ] **Step 4: Run the full suite and typecheck.** Commit `fix: a coordinator whose root pane is gone gets a fresh tab`.

### Task 4: Main uses `--now` only when the user named a tier

**Files:**
- Modify `src/agents/prompts.ts`.
- Modify `tests/release/scenarios/common.ts` (`ASK_MAIN`).
- Test `tests/agents/claude.test.ts`.

- [ ] **Step 1: Write the failing test.** The main prompt contains this line verbatim, in place of the old `If the user named a tier themselves, add --now.` sentence: `Add --now only when the user's message names one of these tiers (<tier names>) by name. "Start now", "don't ask me again" or a confirmation is not a tier choice: still propose, tell the user, and end your turn.` The `<tier names>` part is rendered from config.
- [ ] **Step 2: Implement.** Also change `ASK_MAIN`'s confirmation clause to `create the thread without asking me to confirm it`.
- [ ] **Step 3: Run the full suite and typecheck.** Commit `fix: main proposes a tier unless the user named one`.
