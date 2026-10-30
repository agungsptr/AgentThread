# AgentThread Release Hardening (Plan 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the release-blocking follow-ups from Plans 5 and 6. Fix the deferred minors that would hit a user. Make the coordinator split work into parallel tickets. Then run the full release matrix until every row passes.

**Architecture:** There are no new subsystems. Each task hardens one existing seam:
- the spawn report path and the sweep;
- poller and hook signal hygiene;
- the brief byte budget;
- config and setup robustness;
- the coordinator prompt;
- the release harness.

The last task runs the real release matrix and fixes what it finds.

**Tech Stack:** TypeScript on Bun ≥ 1.1.34, `bun:test`, zod, yaml, Herdr 0.9.3, git.

**Spec:** `docs/specs/2026-10-09-agentthread-design.md` §11–§12, including §12.9. The inputs are `docs/superpowers/followups/2026-10-24-multi-agent.md` and `docs/superpowers/followups/2026-10-23-agent-agnostic.md`.

## Global Constraints

- Bun ≥ 1.1.34 and TypeScript `strict: true`.
- Run tests as `env -u HERDR_ENV -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID -u HERDR_PANE_ID -u AGT_HERDR_IT bun test`. Run the full suite under `timeout 300`, and `bun run typecheck` before every commit. Every test file must exit on its own.
- Never run the real `herdr`, `claude`, `opencode`, `codex` or `omp` binaries, or `agt start`, outside `tests/release/`. `--help` and `--version` are allowed. Only Task 7 runs `tests/release/`.
- Leave no `agt daemon run`, `agt __spawn` or isolated `agt-e2e-*` Herdr processes behind.
- The release e2e uses only isolated `agt-e2e-*` Herdr sessions, never the user's live session.
- No `Bun.spawnSync` on daemon paths after startup.
- Existing event logs and configs must keep loading and replaying.
- Notice texts, exactly:
  - to the coordinator (worker) or main (coordinator), on a lost spawn: `Session <id> (<role>) never reported back from its spawn; marked failed after <timeout>.`
  - on a worker with no ticket, `ticket <T>` becomes `a worker with no ticket` in every worker notice.

## Review Focus

1. **A spawn whose report is lost never strands a session.** Daemon restart mid-spawn, crash of `__spawn`, and an unreachable socket all end with `session.failed` within the timeout. Tests are in Task 1.
2. **One real turn counts once.** With Claude hooks and the poller both running, a lagging Herdr `working` after a hook `idle` adds no second turn. Tests are in Task 2.
3. **`brief.md` stays under 16384 bytes for any thread**, including multibyte text, 100 open questions, a 5 KB title and a 50 KB handoff. Tests are in Task 3.
4. **A hand-edited or partial `config.yaml` never crashes `agt init`, `agt setup` or `agt start`.** That covers a bare `agents:`, a role naming an uninstalled agent, and `agt init` with no agents installed. Tests are in Task 4.
5. **No release row passes by masking product behavior.** No trust dialog is answered outside main's pane, and no fixture hint replaces a product rule. Checked in Task 6.

---

### Task 1: Lost spawn reports never strand a session

**Files:**
- Modify: `src/cli/main.ts` (the `__spawn` report, ~line 102)
- Modify: `src/orchestration/sweep.ts`
- Modify: `src/config/config.ts`
- Test: `tests/agents/spawn-job.test.ts`, `tests/orchestration/sweep.test.ts`, `tests/daemon/lifecycle.test.ts`

**Interfaces:**
- Produces:
  - config `session.spawn_timeout: duration`, default `"3m"`, at least `"30s"`;
  - `reportWithRetry(send: () => Promise<{ok:boolean; error?:string}>, o?: { attempts?: number; delayMs?: number }): Promise<void>` in `src/agents/spawn-job.ts`.

- [ ] **Step 1: Write the failing tests:**
  - **`reportWithRetry`** retries a thrown connect error and a `{ok:false, error:"daemon is shutting down"}` reply, up to 20 attempts with 500ms between them. It stops at the first `ok`. It does not retry any other `ok:false` error.
  - **The sweep** emits `session.failed` with reason `spawn report lost after 3m` for a live session that has `status === "starting"`, no `pane` and `createdAt` older than `spawn_timeout`. Coordinator or worker, same rule. It does nothing at 2m59s. It does nothing for a session that has a pane.
  - **The reactor's existing `session.failed` handling then:**
    - for a worker: frees the slot and notifies the coordinator;
    - for a coordinator: spawns a replacement.

    Assert the follow-ups. The notice to the coordinator or to main uses the exact text from Global Constraints.
  - **Daemon test:** stop the daemon while a fake spawn job is between split and report, then start it again. The job's report lands, or the sweep fails the session. The session is never left `starting` without a pane past the timeout. Use `spawn_timeout: 30s` and a sweep interval override in the test.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Make `__spawn` use `reportWithRetry`. Add the sweep rule before the existing `starting` skip.
- [ ] **Step 4: Run the full suite and typecheck.** Expected: PASS.
- [ ] **Step 5: Commit** `fix: a spawn whose report is lost is retried, then failed by the sweep`.

### Task 2: Signal hygiene: one turn per real turn, deduped blocks, ticket-less workers

**Files:**
- Modify: `src/daemon/poller.ts`, `src/daemon/server.ts` (poll tick), `src/orchestration/reactor.ts`
- Test: `tests/daemon/poller.test.ts`, `tests/orchestration/reactor.test.ts`, `tests/state/turns.test.ts`

**Interfaces:**
- Consumes: `adapterFor(session.agent).capabilities.hooks` (`src/agents/adapters.ts`).
- Produces: `diffAgentStatus(o & { hooks: (session: Session) => boolean })`. For a session with hooks, it emits only `started`, `blocked` and `ended`; never `active` or `idle`.

- [ ] **Step 1: Write the failing tests:**
  - A claude-code session with hook `idle`, then a poll showing `working`, then a poll showing `idle` gives `turns === 1`. Today it gives 2.
  - An opencode session, which has no hooks, still gets `active` and `idle` from the poller.
  - Main stays polled for `active` and `idle` only when its agent has no hooks. The tier timer tests from Plan 6 still pass.
  - A second `agent.blocked` for the same session with no `active`/`idle` in between produces no second notice. Hooks and poller dedupe alike.
  - The notices for a worker with no ticket say `a worker with no ticket` and never contain `undefined`:
    - blocked;
    - question;
    - ended or lost;
    - the stall notice.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** The poll tick passes `hooks: (s) => adapterFor(s.agent).capabilities.hooks`. Dedupe blocked notices with a per-session `blockedNotified` flag in the projection: set it on `agent.blocked`, and clear it on `session.active`, `agent.idle` and `session.started`.
- [ ] **Step 4: Run the full suite and typecheck.** Expected: PASS.
- [ ] **Step 5: Commit** `fix: count one turn per real turn; dedupe blocked notices; name ticket-less workers`.

### Task 3: `brief.md` byte budget holds for every thread

**Files:**
- Modify: `src/render/brief.ts`
- Test: `tests/render/brief.test.ts`

**Interfaces:**
- Produces:
  - `Limits` gains `open: number`, `answered: number` and `title: number`;
  - `capBytes(s: string, maxBytes: number): string` cuts on a UTF-8 boundary and ends with `…`.

- [ ] **Step 1: Write the failing tests.** For each of these threads, `Buffer.byteLength(renderBrief(...)) < 16384`:
  - (a) 100 open questions of 1000 multibyte characters (`"é"` × 1000);
  - (b) a 5000-character title;
  - (c) a 50 KB handoff plus 40 tickets with 300-character Thai titles;
  - (d) 10 answered questions with 2000-character answers, plus (a).

  Also:
  - Each test asserts that `## Progress`, `## Open questions` (the heading, at least), `## Git trail` and `## How to continue` survive.
  - Every rendered entry line is at most 300 bytes, not 300 characters.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Replace `cap` with `capBytes` for entries and the title.
  - Add `open`, `answered` and `title` to every `LEVELS` row. Shrink them in this order: answered, then open (down to 5), then title (down to 200 bytes).
  - After the last level, a hard `capBytes(md, 16383)` with `TRUNC` keeps the bound even in theory.
- [ ] **Step 4: Run the full suite and typecheck.** Expected: PASS.
- [ ] **Step 5: Commit** `fix: brief.md stays under 16384 bytes for any thread content`.

### Task 4: Config and setup robustness

**Files:**
- Modify: `src/project/setup.ts`, `src/agents/roles.ts` (`installWarnings`), `src/cli/main.ts` (`init`)
- Test: `tests/project/setup.test.ts`, `tests/cli/cli.test.ts`, `tests/cli/start.test.ts`

**Interfaces:**
- Produces: `installWarnings(config, which?)`. It checks each role's and tier's agent with `adapterFor(agent).bin` on PATH (via `Bun.which`) for coordinator, worker and tier paths, because Herdr starts those by kind. It checks `agentBin(agent, env)` for main.

- [ ] **Step 1: Write the failing tests:**
  - **A bare `agents:` (null).** `runSetup` on a config.yaml containing `agents:` with no value writes `agents.roles`. It keeps other keys and comments, does not throw, and `loadConfig` accepts the result.
  - **Re-running setup.** Over an existing `agents.roles` and `agents.complexity`, it replaces both cleanly, with no stale tier left.
  - **`agt init` on a TTY with no agent installed.** It prints `initialized`, then `no supported agent found; install one (see README) and run agt setup`, and exits 0. Init itself succeeded.
  - **`installWarnings` and overrides.** It warns for a worker role on `opencode` when `opencode` is not on PATH, even with `AGT_OPENCODE_BIN` set.
  - **Going back to the model.** In the wizard, an opencode effort given with an empty model re-asks the model, not only the effort.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Replace a null `agents` node with a map before `setIn`.
- [ ] **Step 4: Run the full suite and typecheck.** Expected: PASS.
- [ ] **Step 5: Commit** `fix: setup survives partial configs; install checks match how agents start`.

### Task 5: The coordinator splits work into parallel tickets

**Files:**
- Modify: `src/agents/prompts.ts` (coordinator rules)
- Modify: `README.md` (the ancestor-`CLAUDE.md` note, if missing)
- Test: `tests/agents/claude.test.ts`, `tests/agents/agents-md.test.ts`

- [ ] **Step 1: Write the failing test.** The coordinator rules contain these lines exactly:
  - `- Plan before you spawn: split the work into the largest set of tickets that can run in parallel without touching the same files (usually 2–4). Use one ticket only when the work is genuinely a single change.`
  - `- Spawn a worker for every ticket that is ready, all at once; the daemon queues any beyond max-workers.`

  They come before the existing ticket line, and AGENTS.md renders them.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.** Add the lines. If the README does not already have it, add a note that Claude Code also loads the project root's `CLAUDE.md` in thread worktrees.
- [ ] **Step 4: Run the full suite and typecheck.** Commit `feat: coordinators plan parallel tickets before spawning`.

### Task 6: Release harness without masking

**Files:**
- Modify: `tests/release/harness.ts`, `tests/release/run.ts`, `tests/release/scenarios/edge.ts`, `tests/release/scenarios/happy.ts`
- Modify: `src/agents/adapters.ts` (the Codex trust key)
- Test: `tests/agents/adapters.test.ts`, `tests/orchestration/stall.test.ts`

**Behavior:**
- **`watchTrustDialogs`** never answers outside main's pane. It records the failing check and leaves the dialog in place. The row then fails on its own, by timeout or by the check.
- **`happy-mixed-main`:**
  - It first performs the README trust step: start `claude` in an isolated pane in the scratch root, answer its trust dialog there, which stands in for the user, and exit.
  - It asserts that `agt start` printed the trust warning.
  - It sets `CLAUDE_CONFIG_DIR` to a per-row copy of the user's Claude config dir, so trust entries never reach `~/.claude.json`. It copies the auth files only; the copy is deleted in teardown.
  - Other Claude rows use the same per-row copy.
- **`edge-tab-closed`** waits for `session.ended` or `session.lost` of the coordinator.
- **`rowConfigHome()`** moves inside the row's `try`.
- **Codex trust key:** the inline table also includes `realpathSync(root)` and `realpathSync(worktree)` when they differ from the given paths.
- **Allowlist guard test.** A test that fails if any event type in the `authored` allowlist is emitted by `src/orchestration/reactor.ts`, `src/orchestration/sweep.ts` or `src/daemon/effects.ts`. It works by scanning their source for `type: "<allowlisted>"` literals.

- [ ] **Step 1: Write the failing fast-suite tests:**
  - the Codex realpath key, an adapters row with `/tmp` → `/private/tmp`;
  - the allowlist guard test.
- [ ] **Step 2: Implement** the harness changes, then the product change.
- [ ] **Step 3: Verify** without real agents: run `bun tests/release/run.ts --only smoke-layout`, which is agent-free.
- [ ] **Step 4: Run the full fast suite and typecheck.** Commit `test: release harness never masks trust dialogs; mixed-main row trusts like a user`.

### Task 7: Run the full release matrix and fix what fails

This needs the user first: Codex and omp logged in, and `AGT_E2E_MODEL_OPENCODE` set. The controller confirms with the user before starting, because it spends tokens.

- [ ] **Step 1: Run** `bun run e2e:release` with the user's env. Save the report path.
- [ ] **Step 2: Triage every non-PASS row** as one of:
  - a product bug: fix it with a fast-suite test, then re-run that row;
  - a fake-herdr gap: fix the fake, add a regression test, then re-run the row;
  - a scenario bug: fix the scenario, then re-run the row;
  - an agent that cannot meet §12.5's ship bar: drop it from this release with a docs note and a ledger ruling, per §12.9.
- [ ] **Step 3: Repeat** until every remaining row is PASS. A full final run must be all PASS with no SKIPPED rows, apart from agents dropped by ruling.
- [ ] **Step 4: Update `docs/agents.md`.** Turn every "verified from --help only" marker that the run confirmed into "verified by the release matrix <date>".
- [ ] **Step 5: Run the full fast suite and typecheck.** Commit `test: release matrix green` along with any fixes in their own commits.
