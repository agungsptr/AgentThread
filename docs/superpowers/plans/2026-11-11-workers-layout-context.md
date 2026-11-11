# AgentThread Worker Layout, Worker Context and OpenCode Edge Rows (Plan 14) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three items from the Plan 13 follow-ups:
- the e2e proves worker behaviour with OpenCode workers too;
- worker panes never shrink into unusable slivers;
- a worker whose context grows large is noticed, and omp is told to compact earlier.

**Architecture:**
- Two new release rows reuse the existing edge scenarios with an OpenCode worker.
- Worker placement asks Herdr for the thread tab's pane layout, then picks the largest pane and a split direction. When no pane is big enough, it falls back to a second tab for that thread's workers.
- The worker context watch reuses the coordinator rotation threshold, but only sends a notice: workers are not rotated mid-ticket.
- omp gets a `--config` overlay with its compaction threshold when its config supports one.

**Tech Stack:** TypeScript on Bun ≥ 1.1.34, `bun:test`, Herdr CLI.

**Spec:** `docs/specs/2026-10-09-agentthread-design.md` (§12 agents, §13). Follow-ups: `docs/superpowers/followups/2026-11-04-workspace-release-e2e.md`.

## Global Constraints

- **Tests.** Run `env -u HERDR_ENV -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID -u HERDR_PANE_ID -u AGT_HERDR_IT bun test`: the full suite under `timeout 600`, plus `bun run typecheck`, before each commit. Baseline: 1030 pass / 1 skip / 0 fail.
- **Forbidden.**
  - Never run real herdr, agents, `agt start` or tests/release; `--help` is allowed.
  - Leave no `agt daemon run` or `__spawn` processes behind.
  - Never read or print credentials or agent config contents (including `~/.omp`, `~/.config/opencode`, `~/.claude*`).
  - Herdr's and omp's public docs and `--help` output may be read.
- **agt stays agent-agnostic.** Agent specifics live in the adapters only.
- **Texts**, exactly:
  - worker context notice to the coordinator: `The worker for ticket <T> is at <n>% of its context. If it keeps going, return the ticket so a fresh worker continues: agt ticket return <thread>/<T> "<what is left>".`
- **New row ids**, exactly: `ws-edge-return-worker-opencode`, `ws-edge-out-of-ticket-worker-opencode`.

---

### Task 1: OpenCode worker variants of the two worker-behaviour edge rows

**Files:** Modify `tests/release/scenarios/workspace.ts` and `docs/release-e2e.md`. Test `tests/release-harness/rows.test.ts`.

- The two new rows run the same flows as `ws-edge-return` and `ws-edge-out-of-ticket`, with main and coordinator on claude-code and the worker on opencode.
- Each is listed only when the run's `--agents` includes opencode.
- The doc gains both ids and notes they need `AGT_E2E_MODEL_OPENCODE`.

- [ ] **Step 1: Write the failing test.** Both ids are listed with `worker=opencode`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run the full suite and typecheck.** Commit `test: OpenCode worker variants of the return and out-of-ticket rows`.

### Task 2: Worker panes never become slivers

**Files:**
- Modify:
  - `src/herdr/bridge.ts` (a `paneLayout` call and its parser)
  - `src/agents/spawn-job.ts` and/or `src/orchestration/sessions.ts` (where the split target and direction are chosen today: `splitWithFallbacks`)
  - `src/config/config.ts` only if a setting is truly needed (prefer constants)
- Test: `tests/herdr/bridge.test.ts`, `tests/agents/spawn-job.test.ts`

**Behavior:**
- **Read the layout.** Before splitting for a worker, the spawn job reads the thread tab's layout with `herdr pane layout` (find the exact output from Herdr's docs: `herdr --skill`, https://herdr.dev/llms.txt or the agent guide). Never guess the format; if it cannot be read, keep today's behaviour.
- **Choose the split.**
  - Split the largest pane (by area) of the thread tab.
  - Use `--direction right` when that pane is at least 2 × 80 columns wide.
  - Otherwise use `--direction down` when it is at least 2 × 20 rows tall.
- **Fallback tab.** If no pane allows either split, the worker goes to the thread's worker tab `<id>-<slug>-workers`. It is created on first need, with the same tab env as the thread tab, and splits there follow the same rule.
  - If even that tab is full, open one more such tab (`-workers-2`, …).
  - When all its panes have closed, the worker tab is closed too (follow `close_tab_on_done` / `close_worker_pane_on_end` semantics).
- **Coordinator's root pane.** It is never split below 80 × 20.

- [ ] **Step 1: Write the failing tests** (a fake bridge with layouts):
  - a wide single pane splits right;
  - a narrow, tall pane splits down;
  - a full tab uses the workers tab;
  - an unreadable layout falls back to today's split;
  - the parser is tested against the documented format.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `feat: worker panes split the largest pane or move to a workers tab`.

### Task 3: Worker context watch; omp compaction threshold

**Files:**
- Modify: `src/orchestration/reactor.ts` (where coordinator rotation checks `contextTokens`), `src/state/projection.ts` (a once-per-ticket flag derived from events), `src/agents/adapters.ts` (omp launch)
- Test: `tests/orchestration/*.test.ts`, `tests/agents/adapters.test.ts`

**Behavior:**
- **Worker context notice.** When a worker session's `contextTokens / session.rotation.context_window ≥ session.rotation.context_threshold`, its coordinator gets the exact notice once per ticket. Make the flag replay-safe.
  - This applies only to agents whose adapter reports context size.
  - Workers are never rotated automatically.
- **omp compaction.**
  - Find omp's own config key for the compaction threshold from `omp --help`, `omp config --help` or omp's public docs. Do not read the user's omp config.
  - If it exists, the omp adapter passes `--config <file>` with an overlay that sets that threshold to `context_threshold × context_window` tokens. agt writes the overlay file under `.agentthread/` and regenerates it when the config changes.
  - If no such key is documented, change nothing for omp and say so in the report.

- [ ] **Step 1: Write the failing tests.**
  - The notice fires once at the threshold for a worker, not below it, and not again for the same ticket.
  - A coordinator still rotates as before.
  - The omp launch args include the overlay when supported.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `feat: the coordinator hears when a worker's context grows large; omp compacts at agt's threshold`.

### Task 4: Release run (controller)

- Run the new OpenCode rows with `AGT_E2E_MODEL_OPENCODE=myrouter/worker --agents claude-code,opencode --timeout 40m`, plus a Claude Code regression of `ws-happy-claude-code`, `ws-stack-lock` and `ws-cleanup`, which spawn several workers and exercise the new layout.
- Record the results in the follow-ups doc.
