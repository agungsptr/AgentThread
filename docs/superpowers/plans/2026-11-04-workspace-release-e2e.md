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
