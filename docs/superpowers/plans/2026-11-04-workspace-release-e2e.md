# AgentThread Workspace Release E2E (Plan 13) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the §13 workflow end to end, with real Herdr and real agents, on a scratch multi-repo workspace. That means:
- worktrees per repo;
- tickets bound to files;
- review, accept and return;
- stages and gates;
- the stack lock;
- the squash;
- cleanup;
- a user shell in a thread tab.

Before a release, the user runs it once with consent.

**Architecture:**
- The release harness (`tests/release/`) gains a scratch-workspace builder: two git repos plus a `.docs` repo, built from a new fixture.
- It also gains scenario rows in a new `workspace.ts`, which reuse the existing harness: isolated `agt-e2e-*` Herdr sessions, `waitFor`, `check` and the report.
- Rows give agents hints through each repo's AGENTS.md and the coordinator's task text, not through code paths.
- Unit tests cover what can run without Herdr: the builder, row listing and the config the rows write.

**Tech Stack:** TypeScript on Bun ≥ 1.1.34, `bun:test`, git, Herdr (release only).

**Spec:** `docs/specs/2026-10-09-agentthread-design.md` §13. Plan 4 of 4 for §13; it requires Plans 11 and 12 merged. `docs/release-e2e.md` describes the harness.

## Global Constraints

- **Runtime and checks.**
  - Bun ≥ 1.1.34, TypeScript `strict: true`.
  - Tests: `env -u HERDR_ENV -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID -u HERDR_PANE_ID -u AGT_HERDR_IT bun test`. Run the full suite under `timeout 600`, plus `bun run typecheck`, before each commit.
- **Release runs.** Implementers **never** run `bun run e2e:release`, real herdr, or real agents.
  - The release run in Task 4 is done by the controller, only after the user says yes in this session.
  - It runs only with `--only` on the new rows, and only in isolated `agt-e2e-*` Herdr sessions. It never touches the user's live Herdr session.
- **Cleanup.** Leave no `agt daemon run` or `agt __spawn` processes behind. Never read or print credentials or agent config contents.
- **New row ids**, exactly:
  - `ws-smoke-worktrees`
  - `ws-happy-claude-code`
  - `ws-happy-worker-<agent>` (coordinator on Claude Code)
  - `ws-edge-out-of-ticket`
  - `ws-edge-return`
  - `ws-edge-stage-gates`
  - `ws-stack-lock`
  - `ws-cleanup`
  - `ws-tab-shell`
- **Fixture.** `tests/release/fixture-workspace/` holds two repos, `api` and `web`.
  - Each is a tiny Bun package with `package.json` (scripts `test` and `typecheck`), `src/`, `tests/` and `AGENTS.md`.
  - There is a workspace `Makefile` with `restart:` (writes `{task}` and a timestamp to `.stack.log`, sleeps 5s) and `status:`.
- **Task text.** The shared task is: "Add a `slugify(s)` function to api (`src/slugify.ts`, unit tests) and use it in web to display a slug of the title (`src/title.ts`, unit tests). Use the source branch `main`; do not ask me about it."

## Review Focus

1. **A row that fails leaves no worktree, branch or process behind in the user's real repos.** Every git command targets the scratch workspace. Test in Task 1 (the builder asserts its root is under the scratch base).
2. **The happy rows assert on the outcome.** Each repo's `feat/<task>` is exactly one commit over `main`, its message passes the commit-msg rules, and its diff touches only that repo's ticket files. They do not stop at "the coordinator said done". Test in Task 2.
3. **`ws-tab-shell` asserts what the user sees.** A shell opened by the user in a thread tab can commit on `wip/<task>`. Test in Task 3.
4. **Rows that depend on agent behavior** (out-of-ticket, return) **check the event log, not pane text.** Test in Tasks 2 and 3.

---

### Task 1: Scratch workspace builder and fixture

**Files:**
- Create: `tests/release/fixture-workspace/` (as in Global Constraints)
- Modify: `tests/release/harness.ts`
- Test: `tests/release-harness/workspace-builder.test.ts` (runs in the normal suite; no Herdr)

**Interfaces:**
- **Produces:** `scratchWorkspace(hints: {api?: string[], web?: string[]} = {}): Promise<string>`. It creates a temp dir under the existing scratch base and copies the fixture. It then:
  - `git init`s `api` and `web` with one commit on `main` each, with identity set locally;
  - appends the hints to each repo's AGENTS.md;
  - runs `agt init` (which creates `.docs`);
  - writes the config with `writeConfig(...)`, adding `workspace.repos` with `source_branch: main`, `unit: bun test` and `typecheck: bun run typecheck` per repo, and `workflow.stack.restart: make restart TASK={task}` and `status: make status`.

  It returns the root.
- **Produces:** `wsTask(root, thread): Promise<{task: string, worktrees: Record<string, string>}>`, read from the event log.
- **Assertion.** The builder asserts that its root is inside the scratch base before running any git.

- [ ] **Step 1: Write the failing tests.**
  - The built workspace has `api` and `web` on `main` with one commit each, and `.docs` is a git repo.
  - The config parses and lists both repos.
  - `agt` in the root reports a workspace project (`isWorkspaceProject`).
  - The hints are appended.
  - A root outside the scratch base throws.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `test: release harness builds a two-repo scratch workspace`.

### Task 2: Happy and smoke rows

**Files:**
- Create: `tests/release/scenarios/workspace.ts`
- Modify: `tests/release/scenarios/index.ts`, `common.ts` (a `workspace?: true` scenario flag that makes the runner use `scratchWorkspace`), `tests/release/run.ts`
- Test: `tests/release-harness/rows.test.ts` (`--list` includes the new ids; the per-agent expansion drops duplicates)

**Rows:**
- **`ws-smoke-worktrees`** (no model calls, `--no-manager`):
  - The scenario runs, as the coordinator would: `agt thread create … --task kyc-1`, then `agt worktree add <id> api` and `web`.
  - It checks `.worktrees/kyc-1/api` and `/web` on `wip/kyc-1`, the instruction files and the generated skills hidden from `git status`, and brief.md with both `### api` and `### web`.
- **`ws-happy-claude-code`, `ws-happy-worker-<agent>`.** Main gets the task text plus "create the thread without asking me to confirm". The checks, from the event log and git:
  - `worktree.added` for both repos;
  - at least 2 tickets, each with `repo` and `files`;
  - every ticket `ticket.accepted`;
  - each repo's `wip/<task>` commits touch only their ticket's files;
  - `stage.recorded` 8 `na` by `agt` (no browser in config);
  - stage 10 `done`;
  - thread status `review`;
  - each repo's `feat/<task>` is one commit over `main`, with a message free of `Co-Authored-By`, `Generated with`, `.docs/` and `T<n>`;
  - `bun test` passes in each `feat/<task>` checkout, run by the scenario in a temporary worktree it removes afterwards.

- [ ] **Step 1: Write the failing tests** (listing and expansion).
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement the rows.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `test: release rows for workspace worktrees and the happy feature flow`.

### Task 3: Edge, lock, cleanup and tab-shell rows

**Files:**
- Modify: `tests/release/scenarios/workspace.ts`, `docs/release-e2e.md` (a "Workspace rows" list)
- Test: `tests/release-harness/rows.test.ts`

**Rows:**
- **`ws-edge-out-of-ticket`.** api's AGENTS.md hint: "Whenever you change src/slugify.ts, also add a line to CHANGELOG.md." CHANGELOG.md is not in any ticket. The checks:
  - no commit on `wip/<task>` touches CHANGELOG.md;
  - the event log shows the worker's ticket either `ticket.reviewed` without CHANGELOG.md or `ticket.blocked`.
- **`ws-edge-return`.** The coordinator's task text adds: "Return the first ticket once with 'add a test for an empty string' before accepting it." The checks:
  - `ticket.returned` then a second `ticket.reviewed` for that ticket;
  - the same worker session took both if it was still live; otherwise a new worker session for that ticket started after the return;
  - the ticket ends `accepted`.
- **`ws-edge-stage-gates`** (no model calls, scenario drives the CLI). The checks:
  - a coordinator-role commit on `feat/<task>` (env with `AGT_AGENT_PROCESS=1`) is refused before stage 8 and passes after `agt stage <id> 8 na --reason test`;
  - `agt stack acquire <id> --for e2e4` is rejected before `agt stage <id> 7 approve --by user` and acquired after it.
- **`ws-stack-lock`.** Two threads with two task texts; each coordinator is told "restart the stack before testing". The checks:
  - `stack.acquired` for both threads;
  - never two holders at once (replay the events);
  - `.stack.log` shows two restarts, not overlapping in time (each restart sleeps 5s).
- **`ws-cleanup`.** After the happy flow:
  - the scenario runs `agt thread status <id> done` and `agt thread cleanup <id>` as the user;
  - it checks `thread.cleaned`, both worktrees gone, `wip/<task>` deleted, and `feat/<task>` kept.
- **`ws-tab-shell`** (no model calls beyond the coordinator start):
  - The scenario splits a new pane in the thread's tab with the isolated `herdr`, the way a user would.
  - It runs `env | grep '^AGT_' > <scratch>/tabshell.env` and records the result as a note.
  - In the api worktree it makes a commit on `wip/<task>` from that pane.
  - Check: the commit exists. Plan 12's agent marker makes the user's shell pass.

- [ ] **Step 1: Write the failing tests:** listing, plus the stack-lock event replay helper (`maxHolders(events) === 1`) unit-tested on synthetic events.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement the rows and the doc.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `test: release rows for edges, stack lock, cleanup and a user shell in a thread tab`.

### Task 4: Release run (controller, with the user's consent)

Not dispatched to an implementer.

- [ ] **Step 1: Ask the user.** The question: "Run the workspace release rows now (real Herdr in isolated sessions, real Claude Code and the agents you pick, about N minutes)?" Name the agents found by `detectAgents`.
- [ ] **Step 2: Run, on yes only.** `--agents` must include `claude-code` (a row whose roles name an unlisted agent is dropped). Canary first: `bun run e2e:release --only ws-smoke-worktrees,ws-edge-stage-gates,ws-tab-shell --agents claude-code`. Then the heavy rows: `bun run e2e:release --only ws-happy-claude-code,ws-cleanup,ws-edge-return,ws-edge-out-of-ticket,ws-stack-lock[,ws-happy-worker-<x>] --agents claude-code[,<x>] --timeout 40m`, where `<x>` is each other agent the user picked. Budget up to about 40 minutes per heavy row.
- [ ] **Step 3: Record the results.** Write the report path and the result of each row into the followups doc. A failing row becomes a fix task, or a ruling with the user.

### Task 5: agt answers Claude Code's trust dialog in folders it created

Added after the first heavy run. All five heavy rows stopped at Claude Code's workspace-trust dialog in the coordinator's pane (cwd `.worktrees/<task>/`), even though main had accepted trust for the workspace root. A non-git workspace root's trust is not inherited by the folders under it. The user wants this automatic, without interruptions, and agt must not edit Claude's config.

**Files:**
- Modify: the agent spawn path (`src/agents/spawn-job.ts` and/or `src/agents/adapters.ts`), `tests/release/harness.ts` (`watchTrustDialogs`, the trust gate)
- Test: `tests/agents/spawn-job.test.ts`, `tests/release-harness/*`

**Behavior:**
- **When agt answers.** After starting a claude-code agent whose cwd is inside `<root>/.worktrees/`, which agt created, the spawn job watches that pane for up to 60s.
- **How it answers.** If the visible screen matches the trust dialog (`/trust this folder|Do you trust the files/i`), it sends `down` then `enter`, which chooses the "trust" option. It does this once, and logs `trusted <cwd> for Claude Code (a folder agt created)`.
- **Where it never answers:**
  - outside `<root>/.worktrees/`, so main's pane in the user's own root stays the user's one-time choice;
  - for other agent kinds (adapters can opt in later through an optional `trustPrompt` field).
- **Claude's config.** agt never reads or writes Claude's config files.
- **Harness gate.** A trust dialog in a coordinator or worker pane fails the row only when it is still showing after 30s, which gives agt its chance first. Each folder agt trusted is recorded as a note.

- [ ] **Step 1: Write the failing tests.** Use a fake Herdr bridge:
  - a trust screen in a `.worktrees/` pane is answered once with down + enter;
  - a pane outside `.worktrees/` is not answered;
  - no dialog within 60s means no keys are sent;
  - a non-claude agent is not answered.

  The harness gate test: a dialog shown under 30s does not fail the row, and one past 30s does.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.** The spawn job is its own process, not the daemon, so polling with sleeps is fine there.
- [ ] **Step 4: Run the full suite and typecheck.** Commit `feat: agt trusts the folders it creates for Claude Code`.
- [ ] **Step 5: Rerun the heavy rows** (controller).

### Task 6: a worker that ends before claiming never strands its ticket; failed rows keep screen evidence

Added after heavy rerun 2 (report `.agentthread/e2e-reports/2026-11-02T08-03-53-733Z.md`).
- **What happened.** `ws-edge-return` passed, but in `ws-happy-claude-code`, `ws-cleanup` and `ws-stack-lock` the second of two workers spawned together (the `web` ticket) ended 4–8s after `session.created`, without ever claiming its ticket.
- **Effect.** After that nothing happened for 40 minutes: no notice and no respawn. The coordinator sat idle and the ticket stayed `open`.
- **Unknown.** The reason the worker exited is not known. The daemon log and the event log carry no screen.

**Files:**
- Modify:
  - `src/orchestration/reactor.ts` (and `sessions.ts` if the spawn helpers live there)
  - `src/state/projection.ts` if a counter is needed
  - `tests/release/harness.ts`, `tests/release/run.ts`, `tests/release/scenarios/workspace.ts`
- Test: `tests/orchestration/*.test.ts`, `tests/release-harness/*`

**Behavior:**
- **Respawn after an early end.** A worker session that ends, is lost or fails before its ticket is claimed (it is still `open`, or `in_progress` with that worker never having claimed) gets a fresh worker automatically, at most 2 times per ticket. The counter is rebuilt from events.
  - Each respawn notifies the coordinator: `The worker for ticket <T> exited before starting; agt started a fresh one.`
  - After the second, the ticket stays open, no further worker is started, and the coordinator gets: `The worker for ticket <T> exited before starting, twice; check its pane or spawn it again with agt worker spawn <thread> --ticket <T>.`
  - It never double-spawns while another live worker holds the ticket, and it respects max_workers and file conflicts (it uses the normal queue).
- **Screen evidence.**
  - The ws rows set `herdr.close_worker_pane_on_end: false` so panes stay readable.
  - When a row fails or times out, the harness reads every pane of the isolated Herdr session (`pane read <id> --source visible`) and adds each screen, truncated to its last 40 lines, to the row's notes before it stops the server.
  - `agt __spawn` writes the visible screen to the daemon log when its agent start fails or the trust watch ends without answering while the agent was blocked.
- **Startup timeout evidence.** For a `layout.registered` timeout at startup (seen once in `ws-edge-out-of-ticket`), the same screen dump records what main's pane showed.

- [ ] **Step 1: Write the failing tests.**
  - A worker ended before its claim gets a respawn plus the exact notice, and a second early end gets a second respawn.
  - A third early end gets no respawn, with the exact notice.
  - An ended worker that had already claimed the ticket follows the existing flow unchanged.
  - The respawn waits in the queue at max_workers.
  - The harness screen dump on failure, tested with a fake Herdr.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `fix: a worker that exits before starting is replaced; failed e2e rows keep pane screens`.
- [ ] **Step 5: Rerun the failed heavy rows** (controller).

### Task 7: the trust answer never picks "No, exit"; the bootstrap reaches a ready agent

Added after heavy rerun 3 (report `.agentthread/e2e-reports/2026-11-02T10-46-38-747Z.md`). The pane screens show three things:
- **Claude exits.** In stack-lock (main's pane) and cleanup (the T2 worker), Claude exited because the trust answer's `enter` landed on "No, exit". The screen keeps the dialog with `❯ No, exit` above the shell prompt. The blind `down` went in before the dialog took input.
- **The bootstrap is lost.** In happy and cleanup, a worker whose dialog was answered correctly sits at an empty Claude prompt. Its bootstrap was delivered while the dialog was still up, and was lost.
- **Noise for the coordinator.** It is told "worker … is blocked" for a trust dialog that agt answers itself.

**Behavior:**
- **Confirmed trust answer**, in agt's spawn-job trust watch and in the harness's `answerTrustIn` and `watchTrustDialogs`:
  - send `down`, then re-read the screen;
  - press `enter` only when the selected line is "Yes, I trust this folder" (the line with the `❯` marker);
  - otherwise send `down` again and re-read, up to 5 tries;
  - never press `enter` while "No, exit" is selected.

  If it gives up, log the screen and leave the dialog for the user.
- **Bootstrap after the dialog.** The worker or coordinator bootstrap is not delivered while that pane's agent is blocked on the trust dialog. It is delivered once the dialog is gone and the agent is ready (idle).
  - Trace how the bootstrap is delivered today: the agent-start prompt, or a `notice.queued` delivered on idle or `session.started`.
  - Fix it at the point where it can reach a dialog.
  - Prefer that the spawn job, which owns the trust watch, releases delivery only after the watch resolves (answered, or no dialog seen).
- **Poller.** A session still `starting` is not ended by poll misses. The sweep's spawn_timeout already fails starts that never come up.
- **No noise.** No "is blocked" notice is sent to the coordinator for a pane whose agt trust watch is still running.

- [ ] **Step 1: Write the failing tests.** Use a fake Herdr whose screen changes per read.
  - `down` does not move the cursor at first, so agt sends `down` again and presses `enter` only once "Yes" is selected.
  - "No, exit" stays selected, so `enter` is never pressed and the screen is logged.
  - The bootstrap is held while the trust dialog is up and delivered after it clears.
  - A starting session that is missing from the poll is not ended.
  - No blocked notice is sent during the trust watch.
  - The harness answer uses the same confirmation.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `fix: agt confirms the trust choice before enter and sends the bootstrap after the dialog`.
- [ ] **Step 5: Rerun happy, cleanup and stack-lock** (controller).

### Task 8: no early "No, exit" in the second worker's pane

Added after heavy rerun 4 (report `.agentthread/e2e-reports/2026-11-02T12-54-03-463Z.md`).
- **What passed:** `ws-happy-claude-code` and `ws-stack-lock`.
- **What failed:** in `ws-cleanup`, every worker for T2 (repo `web`) exited about 5s after launch, 4 times. The pane screens show the trust dialog with `❯ No, exit` and then the shell prompt. The daemon log says agt trusted only `api`, never `web`.

**Behavior:**
- **Find out from the evidence who pressed enter in the `web` pane:**
  - the kept scratch root `agt-e2e-repo-Bb3TLT`, with its `state.db` events and `daemon.log`;
  - the run log's screens;
  - the code paths that type into a pane: notice delivery, the agent-start prompt, the trust watch, the harness.

  Then fix the cause, so nothing types `enter` into a pane whose agent is blocked on the trust dialog unless the confirmed trust answer does it.
- **If the `web` watch never ran,** find why the second start in the same tab is not watched, and fix it.
- **Write a regression test** that reproduces the found sequence with a fake Herdr.

- [ ] **Step 1: Read the evidence.** Write the cause into the report, citing event seqs and screen lines.
- [ ] **Step 2: Write the failing test.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit.
- [ ] **Step 5: Rerun `ws-cleanup`, plus the OpenCode-worker rows** (controller).

### Task 9: an idle worker with an unfinished ticket is never silent

Added after rerun 5 of `ws-cleanup` (report `.agentthread/e2e-reports/2026-11-11T11-59-12-081Z.md`).
- **What now works:** trust for both repos and both workers starting.
- **What still failed:** the T2 worker committed its files, then ended its turn with "waiting for T3 … then ticket done" (seq 77, idle at 82). It never ran `ticket done` or `ticket block`.
- **The deadlock:** T3 was accepted at 89. The coordinator then waited for T2's done notice, and T2 waited for nobody to wake it. The thread sat for 33 minutes.

**Behavior:**
- **Idle notice.** When a worker's turn ends (`agent.idle`) and its ticket is still `in_progress` (not `review`, `done` or `blocked`), the coordinator is told once per idle stretch: `The worker for ticket <T> went idle without reporting: <its last progress or note, if any>. Tell it what to do with agt tell, or return or block the ticket.`
  - The stretch ends when the worker becomes active again.
  - Use the existing notice path.
  - No notice during the worker's first turn (the existing stall watchdog covers that).
- **Worker rule** (task threads):
  - Never end a turn waiting for someone. If your ticket needs another ticket first, run `agt ticket block <thread>/<T> "<what you wait for>"` and stop.
  - When it is done, run `agt ticket done`.
- **Coordinator rule** (task threads): when you accept a ticket that another ticket was blocked on, reopen the blocked one with `agt ticket reopen` and tell its worker.
  - Check the existing reopen and tell commands, and use their exact names.

- [ ] **Step 1: Write the failing tests.**
  - A worker going idle with an `in_progress` ticket triggers the exact notice once, and not again on a second idle without activity in between.
  - The notice fires again after the worker is active and idle again.
  - There is no notice for tickets in `review`, `blocked` or `done`, or for the first turn.
  - Prompt tests cover the two rules; legacy prompts stay byte-identical.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `fix: a worker that goes idle without reporting is reported to the coordinator`.
- [ ] **Step 5: Rerun `ws-cleanup`** (controller).
