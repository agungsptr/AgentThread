# AgentThread Agent-Agnostic Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sessions disposable and vendor-neutral.
- The thread keeps the memory: working notes, a deterministic `brief.md`, and `AGENTS.md` with `CLAUDE.md` as a symlink.
- Herdr agent status is the primary event source.
- Vendor session resume is removed.
- Claude Code becomes the first adapter behind a thin generic interface. OpenCode follows in Plan 6.

**Architecture:**
- **Memory has three layers.** Automatic facts come from events and git. Agents write working notes (`agt note|progress|question`) under a checkpoint policy. The daemon renders a context pack (`brief.md`) that every fresh agent reads first.
- **Every agent is started the same way.** It runs via `herdr agent start --kind <kind>` with adapter-provided args and a single bootstrap prompt pointing at `brief.md`. The role rules live in `AGENTS.md` in the worktree.
- **Herdr status drives session state.** The daemon polls `herdr agent list` (every 2s by default) and turns per-pane status changes into session events: started, active, idle (counts a turn), blocked, and ended (agent gone).
- **Hooks are optional enrichment.** They report context size and pre-compact, identified by `HERDR_PANE_ID`.
- **Lost or exited coordinators are replaced, never resumed.** The replacement is a fresh session split from the root pane that reads the brief.

**Tech Stack:** TypeScript on Bun ≥ 1.1.34, `bun:test`, Herdr CLI (`agent list`, `agent start`, `agent prompt`), git.

**Spec:** `docs/specs/2026-10-09-agentthread-design.md` §11 (Revision 2026-10-23 — Agent-agnostic sessions). Follow-ups: `docs/superpowers/followups/`.

### Roadmap position

Plan 5 of 6. Plans 1–4 are merged.
- **Plan 6:** the OpenCode adapter (after a short research spike) plus a real-agent memory evaluation runbook.

### Spec adjustments made in this plan

- **Polling instead of a subscription.** Herdr status is read by polling `herdr agent list` (2s, configurable), not by `events.subscribe`. The subscription needs one entry per pane (`pane_id` is required), and polling is simpler and self-healing. A subscription can replace polling later without changing session semantics.
- **Hook identity.** Hooks identify the session by `HERDR_PANE_ID`, which Herdr injects into every pane. The vendor session id is no longer used, and coordinator panes no longer need `AGT_SESSION`.
- **Turns:** a turn is one `working → idle|done` transition observed by the poller.
- **Neutral rotation triggers.** `session.rotation.max_turns` defaults to 150 and `session.rotation.max_age` to `8h`, alongside the existing context and pre-compact triggers, which apply only where hooks provide them.
- **Checkpoint reminder** (policy B), with config `checkpoint.reminder_turns` (default 8) and `checkpoint.reminder_after` (default `30m`). On `agent.idle`, if a coordinator or worker has gone that many turns, or that long, without recording `agt progress`, it is queued: `CHECKPOINT: record where you are with: agt progress <thread> "<what is done, what is next>"`. At most one reminder per session until it records progress.
- **Old event logs still replay.** `session.resuming` and `session.resume_failed` stay in the projection, but nothing emits them any more.

## Global Constraints

- Bun ≥ 1.1.34, TypeScript `strict: true`. Run tests as `env -u HERDR_ENV -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID -u HERDR_PANE_ID -u AGT_HERDR_IT bun test` and run `bun run typecheck` before each commit.
- Never run the real `herdr`/`claude`/`opencode` binaries or `agt start` outside tests. Leave no `agt daemon run` / `agt __spawn` processes.
- `AGENTS.md` lives at the worktree root and `CLAUDE.md` is always a symlink to `AGENTS.md`. Neither is ever committed:
  - When the project does not track them, use `.git/info/exclude` of the main repo (the git common dir).
  - When it does, use `git update-index --skip-worktree` in the worktree.
- New event types exactly: `note.recorded`, `progress.recorded`, `question.recorded`, `agent.blocked`, `checkpoint.reminded`. The `progress.recorded` payload is `{ message }`, and the thread keeps only the latest progress text plus its timestamp.
- New commands exactly: `note`, `progress`, `question` (`{ thread, message }`, any role).
- `ticket.done` requires a non-empty `summary`. CLI: `agt ticket done <thread>/<ticket> --summary "<text>"`.
- Bootstrap prompts exactly:
  - coordinator: `You are the coordinator of thread <id>. Read <dir>/brief.md, then follow AGENTS.md.`
  - coordinator replacement: `You are the new coordinator of thread <id>; the previous session ended. Read <dir>/brief.md, then follow AGENTS.md.`
  - worker: `You are the worker for ticket <T> of thread <id>. Read <dir>/brief.md, then follow AGENTS.md.`
- Config additions (strict, with defaults):
  - `herdr.poll_interval: duration` (default `2s`)
  - `session.rotation.max_turns: int ≥ 1` (default 150)
  - `session.rotation.max_age: duration` (default `8h`)
  - `checkpoint.reminder_turns: int ≥ 1` (default 8)
  - `checkpoint.reminder_after: duration` (default `30m`)
- Removed: `claudeSessionFile`, `claudeArgs({ resume })`, the `--session-id` and `--append-system-prompt` args, the effect runner's transcript check, and the sweep's resume timeout. Transcript-based context measurement stays, but only inside the Claude hook path.

## Review Focus

1. **Exactly one coordinator per thread** when a coordinator is lost, exits or is rotated. A replacement is always a fresh split that retires the old root pane, and nothing ever resumes. Tests in Tasks 1 and 7.
2. **Poller correctness.**
   - A pane that briefly disappears from `agent list` for one poll is not ended (it takes 2 consecutive misses).
   - Status flaps do not double-count turns.
   - A Herdr error during a poll changes nothing.

   Test in Task 7.
3. **`AGENTS.md`/`CLAUDE.md` never show up in `git status` or a commit**, whether or not the project already tracks its own versions. The symlink is always correct. Test in Task 4.
4. **Memory survives a lost session.** After a coordinator is killed, its replacement's `brief.md` contains the latest progress, findings, open questions, handoff and git trail. Test in Task 9.
5. **Hooks are optional.** A thread runs end to end (spawn, idle, notices, worker teardown, rotation by turns) with no hook signals at all, driven only by polled Herdr status. Test in Task 9.

---

## File structure

```
src/orchestration/reactor.ts, sessions.ts, sweep.ts   # (modify) replace-not-resume; turns/age rotation; checkpoint reminder
src/state/projection.ts, src/domain/types.ts          # (modify) notes/progress/questions, turns, blocked
src/commands/schema.ts, handler.ts                    # (modify) note/progress/question; ticket.done summary required; signal by pane
src/render/markdown.ts, write.ts                      # (modify) Findings/Progress/Open questions; brief.md
src/render/brief.ts                                   # renderBrief()
src/project/gittrail.ts                               # gitTrail(worktree, branch)
src/agents/agents-md.ts                               # agentsMd(), writeAgentsFiles()
src/agents/adapters.ts                                # AgentAdapter, registry, claude adapter
src/agents/claude.ts, prompts.ts                      # (modify) hooks by pane, remove resume/system-prompt; bootstrap prompts
src/herdr/bridge.ts                                   # (modify) agentList()
src/daemon/poller.ts                                  # diffAgentStatus()
src/daemon/effects.ts, server.ts                      # (modify) adapter-based spawn, AGENTS.md, poller timer
src/cli/main.ts                                       # (modify) note/progress/question, ticket done --summary required, event by pane
tests/fixtures/fake-herdr.ts                          # (modify) `agent list` with per-pane status
docs/memory-eval.md                                   # dev runbook for real-agent recovery evaluation
```

---

### Task 1: Replace, never resume

**Files:** Modify `src/orchestration/reactor.ts`, `src/orchestration/sweep.ts`, `src/daemon/effects.ts`, `src/agents/claude.ts`, `src/commands/handler.ts` (Effect type); tests in `tests/orchestration/recovery.test.ts`, `tests/orchestration/rotation.test.ts`, `tests/daemon/lifecycle.test.ts`, `tests/agents/resume.test.ts`, `tests/e2e/lifecycle-flow.test.ts`.

**Interfaces:**
- Reactor `session.lost` for a coordinator, when the thread is not done and has a `rootPane`:
  1. if the thread has no handoff → `handoff.submitted` (generated, why = `the previous coordinator session was lost`);
  2. then `spawnReplacement(t, s, ctx, { splitFrom: t.rootPane, retirePane: t.rootPane, bootstrap: "handoff" })`;
  3. then `redirect(s.id, newId)`.

  No `session.resuming`. The worker branch is unchanged.
- The `session.resume_failed` reactor case is deleted. Events of that type in old logs are still applied by the projection and are not reacted to.
- `Effect` `agent.spawn` loses `resume` and its `bootstrap` becomes `"start" | "handoff"`.
- The sweep's resume-timeout block and `RESUME_TIMEOUT_MS` are deleted.
- `claude.ts`: delete `claudeSessionFile`, the `resume` option and its branch in `claudeArgs`. Keep `claudeConfigDir` (still used for `CLAUDE_CONFIG_DIR` and the transcript).
- `effects.ts`: delete the transcript existence check and the `sessionFileExists` option.

- [ ] **Step 1: Update tests to the new behavior (RED)**
  - `tests/orchestration/recovery.test.ts`:
    - "lost coordinator is resumed…" becomes: lost coordinator → events `["handoff.submitted", "session.created"]` (no `session.resuming`).
    - The effect is `agent.spawn` with `splitFrom: "w1:p2"`, `retirePane` on the created session, and `bootstrap: "handoff"`, with no `resume`.
    - Delete the `resume_failed` tests, and add one asserting that a stored `session.resume_failed` event produces no reaction.
    - The tab-reopen + probe-loss same-batch test now expects one `session.created` replacement and no fresh `spawnCoordinator`.
  - `tests/daemon/lifecycle.test.ts`:
    - Replace the two resume tests with one: a probe loss → a generated handoff (if none) plus a fresh coordinator job (`args` contain no `--resume`, the bootstrap starts with `You are the new coordinator of thread 001`).
    - Keep the handoff-timeout and tab-env tests.
  - `tests/agents/resume.test.ts`: delete the session-file and resume-arg tests. Keep the config-dir, env and transcript tests, and rename the file to `tests/agents/claude-env.test.ts`.
  - `tests/e2e/lifecycle-flow.test.ts`: the recovery part now expects, after `agt start`, an `agent start` call **without** `--resume` in a new split pane, the replacement bootstrap prompt, and exactly one live coordinator.
  - Run → FAIL.

- [ ] **Step 2: Implement** the interface changes above. In `prompts.ts`, drop the `"resume"` bootstrap kind; Task 5 changes the bootstrap texts.

- [ ] **Step 3: Verify, commit** `refactor: replace lost coordinators instead of resuming them`.

---

### Task 2: Working notes and the checkpoint summary

**Files:** Modify `src/domain/types.ts`, `src/state/projection.ts`, `src/commands/schema.ts`, `src/commands/handler.ts`, `src/render/markdown.ts`, `src/cli/main.ts`, `src/orchestration/reactor.ts` (summary text unchanged); tests `tests/state/memory.test.ts`, `tests/cli/memory.test.ts`, and fix existing callers of `ticket.done` without a summary.

**Interfaces:**
- Events:
  - `{ type: "note.recorded" | "question.recorded"; thread: string; payload: { message: string } }`
  - `{ type: "progress.recorded"; thread: string; payload: { message: string } }`
- Projection:
  - `Thread.findings: Entry[]` and `Thread.questions: Entry[]` (append).
  - `Thread.progress?: { message: string; ts: string; actor: Actor }` (latest wins).
  - Each event also writes a log note: `note: …`, `progress: …`, `question: …`.
  - `progress.recorded` also sets `lastProgressAt = ev.ts` and `turnsSinceProgress = 0` on the actor's session. That is the session with `actor.session` if it is set, otherwise the thread's live coordinator when `actor.role === "coordinator"`. Task 6 adds those Session fields; in this task, just declare them optional on `Session`.
- Commands `note`, `progress`, `question`: `{ thread, message: text }`, ALLOWED = all roles. They obey the existing thread-binding rule for coordinators and workers.
- `ticket.done.summary` is required (`text`, non-empty).
- Rendering: `sub.thread.md` gets three new sections after `## Context & decisions`:
  - `## Progress`: the latest message with its timestamp, or `_None yet._`
  - `## Findings`: `- <ts> <message>`
  - `## Open questions`: `- <ts> <message>`
- CLI:
  - `agt note|progress|question <thread> <message...>`, for example `agt progress 001 fix done, tests next`.
  - `agt ticket done <thread>/<T> --summary <text>`, where a missing `--summary` is a usage error (exit 2).
- Update every existing test and fixture that runs `ticket.done` or `agt ticket done` without a summary so it passes one, for example `--summary ok` / `summary: "ok"`.

- [ ] **Step 1: Tests (RED)**:
  - The projection keeps findings and questions in order, with progress latest-wins.
  - Render order of the new sections.
  - The handler rejects `ticket.done` without a summary through the schema.
  - CLI round-trip for all three commands, and `ticket done` without `--summary` exits 2.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify, commit** `feat: add working notes, progress and open questions to threads`.

---

### Task 3: Git trail and `brief.md`

**Files:** Create `src/project/gittrail.ts`, `src/render/brief.ts`. Modify `src/render/write.ts`. Tests `tests/render/brief.test.ts`, `tests/project/gittrail.test.ts`.

**Interfaces:**
- `gitTrail(o: { root: string; worktree: string; branch: string; base?: string }): { commits: string[]; diffStat: string } | undefined`:
  - `commits`: `git -C <worktree> log --oneline <base>..HEAD`, at most 20 lines. `base` defaults to the merge-base of `HEAD` and the main repo's current `HEAD`.
  - `diffStat`: the last line of `git -C <worktree> diff --stat HEAD` (uncommitted changes), or `""`.
  - Returns `undefined` on any git failure.
  - Use `Bun.spawnSync` with a 2s budget per call (`timeout` may be ignored on Bun 1.1.34; acceptable because these are fast local commands).
- `renderBrief(o: { thread: Thread; sessions: Session[]; trail?: { commits: string[]; diffStat: string }; dir: string }): string`. The sections, in order:
  1. `# Brief — thread <id>: <title>`
  2. `## Where things stand`: thread status, plus the latest progress (`<ts> <message>`) or `No progress recorded yet.`
  3. `## Goal` and `## Acceptance criteria` (same text rules as `sub.thread.md`)
  4. `## Board`: one line per ticket `- <T> [<status>] <title> — scope: <paths>`, plus `(assignee: <session8>)` when assigned
  5. `## Findings` (last 20), `## Open questions` (all), `## Decisions` (all)
  6. `## Handoff`: the latest handoff with headings clamped, or `None yet.`
  7. `## Git trail`: commits as a list, or `No commits on this thread yet.`, then `Uncommitted: <diffStat>` when non-empty
  8. `## How to continue`: 3 fixed lines:
     - `1. Read AGENTS.md in your working directory for your role's rules.`
     - `2. Check the board and progress above; continue from the latest progress.`
     - `3. Record progress with agt progress <id> "<…>", findings with agt note, doubts with agt question.`
- `writeAll` also writes `threads/<id>-<slug>/brief.md`. The daemon computes `gitTrail` for each thread that is not done. Done threads get `trail` undefined, rendered as `No commits on this thread yet.` In `writeAll`, accept an optional `trail?: (t: Thread) => GitTrail | undefined` dependency (default: `gitTrail` with the project root), so tests can stub it.
- `brief.md` must stay under 16 KiB: truncate findings to the last 20 and commits to 20; everything else is already bounded.

- [ ] **Step 1: Tests (RED)**:
  - The exact section order and fallbacks.
  - Truncation.
  - The git trail against a real temp repo with one commit on the thread branch and one uncommitted change.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify, commit** `feat: render a per-thread brief.md context pack with git trail`.

---

### Task 4: `AGENTS.md` + `CLAUDE.md` in the worktree, never committed

**Files:** Create `src/agents/agents-md.ts`. Modify `src/daemon/effects.ts` (after `git.worktree.add`, and before each `agent.spawn`). Test `tests/agents/agents-md.test.ts`.

**Interfaces:**
- `agentsMd(o: { root: string; thread: { id; title; slug; worktree } }): string`. It is the AgentThread section, built from the current `systemPrompt` texts, now role-sectioned:
  - `# AgentThread`: the project, thread id and title; where state lives (`<dir>/brief.md`, `sub.thread.md`, `board.md`); "your role is in your first prompt and in $AGT_ROLE".
  - `## Working memory (required)`: when to use `agt note`, `agt progress` and `agt question`. Before ending a turn with meaningful progress, run `agt progress`. `agt ticket done` always needs `--summary`.
  - `## Coordinator`: the rules from the coordinator system prompt, including the handoff instruction and worker respawn after reopen.
  - `## Worker`: the rules from the worker system prompt, including "Do not commit".
- `writeAgentsFiles(o: { root: string; worktree: string; content: string }): void`:
  1. `projectAgents` = tracked content of `AGENTS.md` at the worktree's HEAD (`git -C <worktree> ls-files --error-unmatch AGENTS.md`, then read it), else `""`. `projectClaude` = the same for `CLAUDE.md`, but only if it is a regular tracked file.
  2. Final text: the project content (`projectAgents || projectClaude`), then `\n\n` if it is non-empty, then `content`.
  3. Write `<worktree>/AGENTS.md`, then make `<worktree>/CLAUDE.md` a symlink to `AGENTS.md` (remove an existing file or link first).
  4. For each of `AGENTS.md`, `CLAUDE.md`:
     - if tracked → `git -C <worktree> update-index --skip-worktree <file>`;
     - else → ensure the line `/AGENTS.md` / `/CLAUDE.md` is in `<git common dir>/info/exclude`. Get the dir from `git -C <worktree> rev-parse --git-common-dir`, resolved against the worktree. Add the line once, idempotently.
  5. Idempotent: running twice gives the same files and no duplicate exclude lines.
- The effect runner calls `writeAgentsFiles` right after `addWorktree` succeeds, and again at the start of every `agent.spawn`, so instruction updates reach new sessions. A failure is logged and does not block the spawn.
- `systemPrompt` stays only as the source text for `agentsMd`; it is no longer passed to Claude (Task 5).

- [ ] **Step 1: Tests (RED)** with real temp repos and worktrees:
  1. Project without `AGENTS.md`/`CLAUDE.md` → both files exist, `CLAUDE.md` is a symlink to `AGENTS.md` with identical content, and `git -C <wt> status --porcelain` is empty.
  2. Project tracking `AGENTS.md` → the generated file starts with the project content and then the AgentThread section, and `git status` is empty (skip-worktree).
  3. Project tracking only `CLAUDE.md` → `AGENTS.md` = its content + section, `CLAUDE.md` is a symlink, and `git status` is empty.
  4. Running twice → same content and no duplicate exclude lines.
  5. `git add -A && git commit` in the worktree never includes either file.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify, commit** `feat: write AGENTS.md and CLAUDE.md symlink into worktrees without committing them`.

---

### Task 5: Generic adapter and Claude adapter

**Files:** Create `src/agents/adapters.ts`. Modify `src/agents/claude.ts`, `src/agents/prompts.ts`, `src/daemon/effects.ts`, `src/agents/spawn-job.ts` (kind type), `src/cli/main.ts` (main manager launch). Tests `tests/agents/adapters.test.ts`, plus updates to `tests/agents/claude.test.ts` and `tests/daemon/agents.test.ts`.

**Interfaces:**
- In `adapters.ts`:

```ts
export interface AgentAdapter {
  agent: AgentKind;                 // AgentThread name, e.g. "claude-code"
  herdrKind: string;                // herdr --kind, e.g. "claude"
  startArgs(o: { role: SessionRole; config: Config; root: string }): string[];
  capabilities: { hooks: boolean; contextSize: boolean; preCompact: boolean };
}
export function adapterFor(agent: AgentKind): AgentAdapter; // throws `no adapter for agent <x>`
```

- Claude adapter: `startArgs` = `--permission-mode <mode>`, `--allowed-tools <list>`, `--settings <hooks JSON>`, plus `--model` when set. **No** `--session-id` and **no** `--append-system-prompt`. Capabilities are all true.
- Hook commands become `'<bun>' '<agt>' event <signal>` (unchanged). `agt event` now identifies the session as described in Task 6.
- `SpawnJob.kind` becomes `string` (the herdr kind). The effect runner uses `adapterFor(session agent)`, which is always `claude-code` until Plan 6.
- Bootstrap prompts are replaced by the Global Constraints texts. `bootstrapPrompt(o, kind: "start" | "handoff")` returns the coordinator, replacement or worker text, and `""` for main.
- Main manager launch (`agt start`): `adapterFor(config.agents.main_manager).startArgs({ role: "main", … })`, followed by `systemPrompt({ role: "main", root })` as Claude's positional initial prompt (`claude [flags] "<prompt>"` starts interactive mode with that first message). The main manager runs at the project root, whose own `AGENTS.md`/`CLAUDE.md` must not be modified, so it gets its role through this first message rather than through `AGENTS.md`.
- `agentEnv` is unchanged (`AGT_*`, `PATH`, `CLAUDE_CONFIG_DIR`).

- [ ] **Step 1: Tests (RED)**:
  - `adapterFor` for claude-code, and an unknown agent throws.
  - The Claude `startArgs` exact list per role, with no `--session-id` or `--append-system-prompt`.
  - Bootstrap texts exact.
  - The daemon spawn job's `args` have no session or prompt flags, `kind === "claude"`, and the bootstrap matches.
  - `agt start` (fake claude) argv ends with the main role prompt and contains no `--session-id`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify, commit** `refactor: start agents through a generic adapter; Claude adapter without session or prompt flags`.

---

### Task 6: Pane-based hook identity and Herdr status in the domain

**Files:** Modify `src/domain/types.ts`, `src/state/projection.ts`, `src/commands/schema.ts`, `src/commands/handler.ts`, `src/cli/main.ts` (`hookEvent`). Tests `tests/commands/signal-pane.test.ts`, `tests/state/turns.test.ts`, `tests/cli/agents.test.ts` (update).

**Interfaces:**
- `session.signal` accepts `{ session?: uuid; pane?: herdrId; signal; contextTokens?; source? }`, with at least one of `session` or `pane`. The handler resolves `pane` to the live session whose `pane` matches, and rejects `no live session in pane <p>` otherwise.
- New signal value `blocked` → event `agent.blocked` (`{ session }`). The projection leaves the status unchanged and writes the note `session <id8> is waiting for approval`. The reactor notifies the main session: `<role> for thread <id> is waiting for approval in pane <pane>.`
- `Session` gains `turns: number` (starts at 0), `turnsSinceProgress: number` (0), `lastProgressAt?: string`, `createdAt: string` (`session.created` ts).
- `agent.idle` increments `turns` and `turnsSinceProgress`, but only when the previous status was `active` (a real working → idle transition). This keeps idle flaps from double-counting.
- `hookEvent`: when stdin has no usable session and `AGT_SESSION` is unset, send `pane: env.HERDR_PANE_ID`. Prefer `AGT_SESSION`, then `pane`, and never the vendor `session_id`. Remove the stdin `session_id` use; keep `transcript_path` and `source`.

- [ ] **Step 1: Tests (RED)**:
  - Signal by pane resolves and an unknown pane is rejected.
  - `blocked` notifies main.
  - Turns count only active → idle.
  - `agt event idle` with `HERDR_PANE_ID` and no `AGT_SESSION` reaches the right session.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify, commit** `feat: identify hook signals by Herdr pane; count turns; report blocked agents`.

---

### Task 7: Herdr status poller

**Files:** Modify `src/herdr/bridge.ts`, `tests/fixtures/fake-herdr.ts`, `tests/helpers.ts`. Create `src/daemon/poller.ts`. Modify `src/daemon/server.ts`, `src/config/config.ts`. Tests `tests/daemon/poller.test.ts`, `tests/daemon/poller-daemon.test.ts`.

**Interfaces:**
- `HerdrBridge.agentList(): { pane: string; status: "idle" | "working" | "blocked" | "done" | "unknown"; kind: string }[]`. It parses `result.agents[]` from `herdr agent list` (`pane_id`, `agent_status`, `agent`).
- Fake herdr:
  - `agent list` returns one entry per pane in `agentPanes`, with status from a new state map `status?: Record<pane, string>` (default `idle`) and kind from `kinds?: Record<pane, string>` (default `claude`).
  - `agent start` sets the pane's status to `idle`.
  - Tests can edit `status` to simulate work.
- `diffAgentStatus(o: { sessions: Session[]; listed: { pane; status }[]; misses: Map<string, number> }): { session: string; signal: "started" | "active" | "idle" | "blocked" | "ended" }[]`. The `misses` map is owned by the caller and mutated. For each live coordinator or worker session with a pane:
  - **listed:** reset its misses to 0, then:
    - `working` → `active` if the session's status is not `active`;
    - `idle`/`done` → `started` if the status is `starting`, else `idle` if the status is `active`;
    - `blocked` → `blocked`, once per entry into blocked (track it in a set inside the same `misses`-owning object, or encode it as `misses` key `blocked:<pane>`);
    - `unknown` → nothing.
  - **not listed:** increment its misses. On the 2nd consecutive miss → `ended`, then delete the key.
- The daemon runs a poll timer (`config.herdr.poll_interval`, unref'd, cleared on stop) through the queue:
  - It does nothing without a layout.
  - It calls `agentList()`; a throw is logged and skipped.
  - For each diff entry it runs the same path as a `session.signal` command with actor `{ role: "user" }`, via `applyAndReact`, using the events the handler would emit. Reuse `handle()` with a constructed command, so the rules stay in one place.
- `session.ended` from the poller for a coordinator then follows Plan 4's reconcile recovery; no immediate respawn. A worker's ticket release on ended is unchanged.

- [ ] **Step 1: Tests (RED)**:
  - Pure `diffAgentStatus` table tests: start, work, idle and turn; blocked once; one miss → nothing; two misses → ended; recovery after one miss resets.
  - Daemon test with fake herdr and `poll_interval: 100ms` in project config: spawn a coordinator (fake agent start), flip the fake status to `working`, then `idle`. Expect `session.started`, `session.active` and `agent.idle` events and `turns === 1`. Remove the pane from `agentPanes` and expect `session.ended` after ≥ 2 polls.
  - A poll error (fake `fail: ["agent list"]`) produces no events.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify, commit** `feat: drive session state from polled Herdr agent status`.

---

### Task 8: Neutral rotation triggers and the checkpoint reminder

**Files:** Modify `src/config/config.ts`, `src/orchestration/reactor.ts`, `src/orchestration/sweep.ts`. Tests: add to `tests/orchestration/rotation.test.ts`, plus `tests/orchestration/checkpoint.test.ts`.

**Interfaces:**
- Config: `session.rotation.max_turns`, `session.rotation.max_age`, `checkpoint.reminder_turns`, `checkpoint.reminder_after` (see Global Constraints). Add the defaults to the defaults test.
- Reactor `agent.idle` for a live coordinator with no rotation pending → `requestRotation(s, "turns")` when `s.turns >= max_turns`. The existing context rule stays.
- Sweep → `requestRotation`-equivalent event `session.rotation_requested` (reason `age`) when a live, attached coordinator with no rotation pending has `now - createdAt > max_age`. The sweep emits the event and the reactor queues the request as today.
- Checkpoint: on `agent.idle` for a live coordinator or worker that is not being torn down, if `turnsSinceProgress >= reminder_turns`, or `lastProgressAt` (or `createdAt` when never recorded) is older than `reminder_after` at `ev.ts`, and no reminder has been sent since the last progress:
  - emit `checkpoint.reminded { session }`, which sets `remindedSinceProgress = true` in the projection, cleared by `progress.recorded`;
  - plus `notice.queued` with `CHECKPOINT: record where you are with: agt progress <thread> "<what is done, what is next>"`.
- No reminder or rotation for a session with a pending rotation.

- [ ] **Step 1: Tests (RED)**:
  - Turns trigger at exactly `max_turns`.
  - Age trigger in the sweep.
  - The reminder fires once by turns and once by time, is reset by progress, is skipped while rotating, and is skipped for a worker being torn down.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify, commit** `feat: rotate by turns and age; remind agents to checkpoint their progress`.

---

### Task 9: Memory pipeline scenario and dev runbook

**Files:** Create `tests/e2e/memory-flow.test.ts` and `docs/memory-eval.md`.

**Interfaces:**
- E2E, through the CLI with fake herdr and fake claude, with **no hook signals at all**. The status is driven by editing the fake's `status` map with `poll_interval: 100ms`.
  1. `agt start --no-manager`, then `agt thread new Login --type feature --max-workers 1`. Wait for the coordinator's pane, then set its status idle (`session.started`).
  2. As the coordinator: `ticket add T1`, `worker spawn T1`, `agt note 001 "root cause in auth.ts:42"`, `agt question 001 "retry 3 or 5?"`, `agt progress 001 "T1 running; next: review"`.
  3. Commit one file in the worktree (as the test, via git) so the git trail has a commit.
  4. Kill the coordinator: remove its pane from `agentPanes`. Wait for `session.ended`, then run `agt start --no-manager` to trigger reconcile recovery.
  5. Assert:
     - exactly one live coordinator, new id, in a new split pane, started without `--resume`/`--session-id`;
     - its bootstrap prompt is `You are the new coordinator of thread 001; the previous session ended. Read …/brief.md, then follow AGENTS.md.`;
     - `brief.md` contains the progress text, the finding, the question, a generated handoff, the commit subject, and the How-to-continue section;
     - the worktree has `AGENTS.md` and a `CLAUDE.md` symlink, and `git status --porcelain` in the worktree shows neither.
  6. Worker flow without hooks: set the worker pane `working` → `idle` after `ticket done --summary` and expect the worker torn down (pane closed). Then set the coordinator idle and expect it to receive `Ticket T1 is done: …`.
- `docs/memory-eval.md` is the dev runbook for the real-agent recovery evaluation (spec §11.5):
  - **Setup:** a scratch repo with a small task that needs ≥3 tickets.
  - **Steps:**
    1. Run to mid-work.
    2. Kill the coordinator's agent.
    3. Run `agt start`.
    4. Let the replacement continue, with the same vendor first and later another vendor.
  - **Score sheet:** a table with continued-from-right-point (y/n), repeated work (min), questions already answered by the brief (#), time and tokens to the first productive action, and notes on what was missing from the brief.

- [ ] **Step 1: Write the scenario. It should pass if Tasks 1–8 are correct; if it fails, fix the owning task's code, not the scenario.**
- [ ] **Step 2: Write the runbook.**
- [ ] **Step 3: Full suite + typecheck, commit** `test: add the memory pipeline scenario and the recovery evaluation runbook`.

---

## After merging: manual checks

Add these to the README smoke list (in Task 9):
1. `agt start`, then make a thread. The worktree has `AGENTS.md` and `CLAUDE.md -> AGENTS.md`, and `git status` in the worktree is clean.
2. Let a coordinator work, then kill its Claude (`/exit`) and run `agt start`. A fresh coordinator should start in a new pane and continue from `brief.md`.
3. Check that a coordinator becomes idle and receives ticket notices even with hooks removed from its settings (status from Herdr only).
