# AgentThread — Design Spec

**Date:** 2026-10-09
**Status:** Draft — revised 2026-10-23 (see §11: agent-agnostic sessions; §11 supersedes the resume parts of §5.4, §6.4 and §7)

## 1. Overview

AgentThread is a local orchestrator for coding agents (initial scope: **Claude Code** and **OpenCode**). Agents coordinate through **markdown files per thread** instead of prompting each other directly through terminals. A **daemon** is the single writer of all state: agents send commands through a CLI, the daemon validates them, stores them as events, and renders the markdown files that agents read.

### Principles

1. **Read markdown, write events.** Agents read `.md` files; every state change goes through the CLI → daemon.
2. **Single writer.** Only the daemon writes state and the rendered `.md` files.
3. **Isolation per thread.** One feature/fix = one subthread = one worktree = one isolated context.
4. **Event-driven.** Agents are woken by events; no polling, no always-on agents.
5. **Sessions are an optimization, not the source of truth.** A fresh agent must always be able to continue using only `sub.thread.md` + `board.md`.

### Non-goals (initial phase)

- Multi-machine / distributed operation.
- Agents other than Claude Code and OpenCode.
- Free-form peer-to-peer communication between subthreads.
- Agents autonomously creating subthreads. Subthreads are created by the user, through the main manager.

## 2. Architecture

```
 User ──► main manager ─┐
 User ──► agt CLI ──────┤        ┌───────────────────── Daemon (always running) ─────────────────────┐
 Agent ─► agt CLI ──────┼──────► │ Queue ─► Command handler ─► Event store (SQLite, append-only)     │
 Hooks ─► agt event ────┘        │                                    │                              │
                                 │               ┌────────────────────┼────────────────────┐         │
                                 │               ▼                    ▼                    ▼         │
                                 │           Renderer             Scheduler           Herdr bridge   │
                                 │        (state → *.md)     (wake/spawn/rotate)   (tabs/panes/agents)│
                                 └────────────────────────────────────┬──────────────────────────────┘
                                                                      ▼
                                                          Runner (adapter per agent)
                                                         claude-code │ opencode
```

### Components

| Component | Responsibility |
|---|---|
| **CLI `agt`** | Single interface for the user, agents, and hooks. Sends commands to the daemon over a Unix socket. |
| **Queue** | Serializes all commands → no race conditions. |
| **Command handler** | Validates commands (schema, legal status transitions, role permissions) → emits events. |
| **Event store** | SQLite: append-only `events` table + projection tables (threads, tickets, sessions). Source of truth. |
| **Renderer** | Re-renders affected `.md` files on every event. `.md` files are read-only for agents. |
| **Scheduler** | Reacts to events: wakes coordinators, spawns workers, rotates sessions, enforces `max_workers`. |
| **Runner** | Launches agents in the correct worktree through adapters (fresh spawn / resume). |
| **Herdr bridge** | Creates/closes tabs and panes, starts agents, sends short prompts, reads agent status (§8). |

> Naming note: `at` collides with the Unix `at` command, so the CLI is named `agt` (can be changed).

## 3. Tech stack

| Concern | Choice |
|---|---|
| Language / runtime | **TypeScript on Bun** |
| Event store | `bun:sqlite` |
| Daemon ↔ CLI transport | Unix socket (`Bun.listen` / `Bun.connect`), JSON messages |
| Herdr / git integration | `Bun.spawn` calling the `herdr` and `git` CLIs; parse JSON responses |
| Markdown rendering | Template functions + YAML frontmatter (`yaml` package) |
| Validation | Schema per command/event (e.g. `zod`) |
| Distribution | Single executable via `bun build --compile` (later) |

## 4. File layout

```
<repo>/
├── .agentthread/
│   ├── config.yaml                 # project config (overrides user config)
│   ├── state.db                    # event store (SQLite) — source of truth
│   ├── main.thread.md              # [rendered] global map of all subthreads
│   └── threads/
│       └── 002-fix-checkout-race/
│           ├── sub.thread.md       # [rendered] goal, context, decisions, handoff, sessions
│           ├── board.md            # [rendered] tickets in this subthread
│           └── log.md              # [rendered] append-only log
└── .worktrees/
    └── 002-fix-checkout-race/      # subthread git worktree (fixed path)
```

- Every `.md` under `.agentthread/` is **rendered output**. Manual edits are overwritten.
- `.worktrees/` and `state.db` are gitignored. Whether `.md` files are committed: see Open Questions.
- All rendered content, templates, and agent prompts use the configured `language` (default `en`).

### 4.1 `main.thread.md`

```markdown
# Main Thread — <project name>

| ID  | Title                    | Type    | Status      | Coordinator | Workers | Depends |
|-----|--------------------------|---------|-------------|-------------|---------|---------|
| 001 | OAuth login              | feature | review      | claude-code | 0/3     | -       |
| 002 | Fix checkout race        | bug     | in_progress | claude-code | 2/3     | 001     |

## Needs user attention
- 001: awaiting review
```

### 4.2 `sub.thread.md`

```markdown
---
id: "002"
title: Fix race condition in checkout
type: bug                     # feature | bug | chore
status: in_progress           # see §6.1
depends_on: ["001"]
branch: thread/002-fix-checkout-race
worktree: /abs/path/<repo>/.worktrees/002-fix-checkout-race
coordinator:
  agent: claude-code          # claude-code | opencode
max_workers: 3                # overrides config
sessions:
  - id: 9b21...
    role: coordinator
    agent: claude-code
    status: active
    started: 2026-10-09T09:00
  - id: 7f3a...
    role: coordinator
    agent: claude-code
    status: rotated
    rotated_reason: precompact
  - id: ses_01...
    role: worker
    agent: opencode
    ticket: T3
    status: ended
---

## Goal
## Acceptance criteria
## Context & decisions
## Handoff
<!-- always the latest; written by the agent via `agt handoff`, validated by the daemon -->
```

### 4.3 `board.md`

```markdown
# Board — 002 Fix checkout race

| Ticket | Title                          | Scope                      | Status      | Assignee          |
|--------|--------------------------------|----------------------------|-------------|-------------------|
| T1     | Reproduce bug with a test      | test/checkout.test.ts      | done        | worker (ses_0a..) |
| T2     | Fix lock release on timeout    | src/checkout/lock.ts       | in_progress | worker (ses_0b..) |
| T3     | Add regression test            | test/regression/           | open        | -                 |
```

### 4.4 `log.md`

Append-only, one line per entry: `- <timestamp> [<role>:<session>] <message>`. Agents are not required to read it in full.

## 5. Commands & events

### 5.1 CLI commands

| Command | Caller | Event |
|---|---|---|
| `agt init` | user | `project.initialized` |
| `agt start` | user | — (sets up Herdr layout §8, ensures daemon is running) |
| `agt thread new <title> --type bug` | user, main manager | `thread.created` (+ worktree created) |
| `agt thread status <id> <status> [--reason]` | user, main manager, coordinator | `thread.status_changed` |
| `agt ticket add <thread> <title> --scope <paths>` | coordinator | `ticket.created` |
| `agt ticket claim <thread>/<ticket>` | worker | `ticket.claimed` |
| `agt ticket done <thread>/<ticket>` | worker | `ticket.completed` |
| `agt ticket block <thread>/<ticket> --reason` | worker | `ticket.blocked` |
| `agt worker spawn <thread> --ticket T3 [--agent opencode]` | coordinator | `worker.requested` |
| `agt log <thread> <msg>` | any | `log.appended` |
| `agt decide <thread> <msg>` | coordinator | `decision.recorded` |
| `agt handoff <thread> --file <path>` | agent | `handoff.submitted` |
| `agt event <type> --session <id>` | hooks | `session.*` / `agent.*` |
| `agt logs -f` | logger pane | — (event stream) |
| `agt daemon start\|stop\|status` | user | — |

Caller identity (thread, role, session) comes from env vars injected by the Runner at spawn (`AGT_THREAD`, `AGT_ROLE`, `AGT_SESSION`, `AGT_TICKET`). The command handler rejects commands not permitted for the caller's role.

### 5.2 Roles

| Role | Agent | Lives in | Can |
|---|---|---|---|
| **main manager** | Claude Code | Herdr tab `main` | Help the user shape issues; create subthreads (`agt thread new`) **only after user confirmation**; change thread status; read all threads |
| **coordinator** | Claude Code / OpenCode | subthread tab | Break the issue into tickets, spawn workers, record decisions, commit, request review |
| **worker** | Claude Code / OpenCode | subthread tab pane | Claim one ticket, edit files within its scope, log, complete/block the ticket |

### 5.3 Event schema

```json
{
  "seq": 1042,
  "ts": "2026-10-09T10:12:03Z",
  "type": "ticket.completed",
  "thread": "002",
  "actor": { "role": "worker", "agent": "opencode", "session": "ses_0b..." },
  "payload": { "ticket": "T2", "summary": "..." }
}
```

## 6. Lifecycles

### 6.1 Thread

```
open ─► in_progress ─► review ─► done
            │   ▲         │
            ▼   │         └─► in_progress (revision)
          blocked
```

- `thread.created` → Scheduler spawns a coordinator → status `in_progress`.
- `blocked` is set automatically while any `depends_on` thread is not `done`.
- `review` → listed under "Needs user attention" in `main.thread.md`.

### 6.2 Ticket

```
open ─► in_progress ─► done
             │
             └─► blocked ─► open
```

### 6.3 Workers

- **The coordinator decides** how many workers to spawn, based on whether the issue is complex enough to split into parallel tickets.
- The daemon enforces `max_workers` (config, overridable per thread). Requests above the limit are queued until a slot frees up.
- **One session per ticket.** Workers are never resumed: ticket done → session `ended`.
- **1 subthread = 1 worktree; n workers share that worktree.**
- Rules to prevent workers from colliding:
  - Each ticket has a `scope` (files/directories). The coordinator splits tickets with non-overlapping scopes; the daemon **rejects** `ticket claim` if the scope overlaps another `in_progress` ticket.
  - **Only the coordinator runs `git commit`** (after `ticket.completed`), avoiding races on `.git/index.lock`. Workers only edit files.

### 6.4 Sessions

```
                    ┌──────────── fallback: session not found ────────────┐
                    ▼                                                     │
   [spawn] ──► ACTIVE ──(Stop hook)──► IDLE ──(new event)──► resume ──────┘
                 │                       │                       └─► ACTIVE
                 │   (rotation trigger, §6.5)
                 └──────────► ROTATING ◄─┘
                                 │ 1. daemon asks the agent to write a handoff
                                 │ 2. old session → rotated
                                 │ 3. spawn new session, prompt: read sub.thread.md + board.md
                                 ▼
                              ACTIVE (new)

   Worker:  ACTIVE ──(ticket done)──► ENDED
   Resume fails ──► LOST ──► fresh spawn from handoff
```

Statuses: `active | idle | rotating | rotated | ended | lost`.

**Resuming a coordinator:**
1. The Runner reads the coordinator session (`active`/`idle`) and the `worktree` from state.
2. Check that the session file exists (Claude Code: `~/.claude/projects/<encoded-cwd>/<id>.jsonl`; OpenCode: TBD, see §7).
3. Exists → launch with the adapter's resume command, with cwd = worktree.
4. Missing → mark `lost`, spawn a fresh session with the bootstrap prompt.
5. The worktree path **never changes** while the thread is alive (`<repo>/.worktrees/<id>-<slug>`).

### 6.5 Rotation

Triggers (all user-configurable, §9):

| Trigger | Default |
|---|---|
| `PreCompact` hook | enabled |
| Context usage above threshold | 70% |
| Idle longer than limit → rotate on next event | 24h |

**Handoff (deterministic via the daemon):**
1. The daemon sends the agent a handoff instruction with a **fixed template** (goal status, work done, decisions, next steps, risks).
2. The agent submits it via `agt handoff`. The daemon **validates** that all required sections are filled and rejects it otherwise.
3. On timeout or failure, the daemon generates a fallback handoff from the log, board, and decisions, marked `generated: true`.

## 7. Agent adapters

Each adapter implements:

```ts
interface AgentAdapter {
  kind: "claude-code" | "opencode";
  spawn(pane: PaneId, cwd: string, prompt: string, env: Env): Promise<SessionId>;
  resume(pane: PaneId, cwd: string, sessionId: SessionId, prompt: string): Promise<"ok" | "not_found">;
  sessionExists(cwd: string, sessionId: SessionId): Promise<boolean>;
  installHooks(worktree: string): Promise<void>; // hooks call `agt event`
}
```

All agents run **interactively in Herdr panes**, started via `herdr agent start --kind claude|opencode`.

| | Claude Code | OpenCode |
|---|---|---|
| Spawn | `herdr agent start <name> --kind claude --pane <id>` | `herdr agent start <name> --kind opencode --pane <id>` |
| Resume | `... -- --resume <id>` with cwd = worktree | **TBD**: OpenCode resume args |
| Session storage | `~/.claude/projects/<encoded-cwd>/` | **TBD** |
| Session id | `SessionStart` hook + Herdr integration | Herdr integration (`herdr integration install opencode`), **verify** |
| Event source | Hooks: `SessionStart`, `Stop`, `PreCompact`, `SessionEnd` | Herdr agent status (`idle/working/blocked/done`) + **TBD** OpenCode plugin |
| Context usage | **TBD** (transcript / statusline) | **TBD** |

Event source → daemon event mapping:

| Source | Event | Daemon action |
|---|---|---|
| `SessionStart` hook | `session.started` | record id + cwd |
| `Stop` hook / Herdr `idle`,`done` | `agent.idle` | check queued events / next ticket |
| Herdr `blocked` | `agent.blocked` | notify the user (approval/question) |
| `PreCompact` hook | `session.compacting` | start rotation |
| `SessionEnd` hook / agent gone from pane | `session.ended` | mark inactive |

## 8. Herdr layout

```
Workspace (created by the user)
├── Tab "main"
│   ├── Pane: main manager   (Claude Code; the user talks here, subthreads are created from here)
│   └── Pane: logger         (`agt logs -f` — live event stream)
├── Tab "002-fix-checkout-race"   (cwd = worktree 002, env AGT_THREAD=002)
│   ├── Pane: coordinator
│   ├── Pane: worker T2
│   └── Pane: worker T3
└── Tab "003-..."
```

**Flow:**

1. The user creates a workspace in Herdr and runs `agt start` inside it.
   - Ensures the daemon is running (as a background process, **not** inside a pane, so closing a pane never kills it).
   - Turns the current tab into the `main` tab: splits it into main manager (Claude Code, `AGT_ROLE=main`) + logger.
2. The user describes an issue to the main manager → the manager drafts it → after user confirmation, it runs `agt thread new` → the daemon creates the git worktree → `herdr tab create --cwd <worktree> --label <id-slug> --env AGT_THREAD=<id> --no-focus` → spawns the coordinator in the root pane.
3. `agt worker spawn` → the daemon runs `herdr pane split` in the subthread tab (`--env AGT_ROLE=worker --env AGT_TICKET=<t>`) → `herdr agent start`. Split direction follows geometry (wide pane → right, narrow/tall → down).
4. Ticket done → worker session `ended` → `herdr pane close` (if `close_worker_pane_on_end`).
5. Thread `done` → `herdr tab close` (if `close_tab_on_done`). The worktree is **not** removed automatically.
6. The daemon stores `thread ↔ tab_id` and `session ↔ pane_id / agent name` mappings in state, taken from Herdr's JSON responses (never guessed).

**Recovery:** if Herdr or a tab is closed accidentally, `agt start` rebuilds a tab for every thread not `done` and resumes its coordinator per §6.4.

## 9. Configuration

Precedence: **per-thread (frontmatter) > project (`.agentthread/config.yaml`) > user (`~/.config/agentthread/config.yaml`) > defaults.**

```yaml
language: en                  # language for rendered .md, templates, and agent prompts

agents:
  main_manager: claude-code
  default_coordinator: claude-code
  default_worker: claude-code

workers:
  max_workers: 3

session:
  rotation:
    on_precompact: true
    context_threshold: 0.70
    idle_timeout: 24h
  handoff:
    timeout: 5m
    fallback_generate: true

herdr:
  main_tab_label: "main"
  close_tab_on_done: true
  close_worker_pane_on_end: true
```

## 10. Open questions

1. **Commit `.md` files to git?** Useful for history and review, but noisy in diffs.
2. **Cross-subthread communication** beyond `depends_on`: needed or not?
3. OpenCode adapter details (all TBD rows in §7).
4. How to measure **context usage** for the 70% rotation threshold (both agents).

## 11. Revision 2026-10-23 — Agent-agnostic sessions

**Decision:** sessions are disposable and vendor-neutral. The thread holds the memory, and any supported agent (Claude Code, OpenCode, Codex, Gemini CLI, …) can continue a thread by reading files. **Vendor session resume is removed entirely.** There is one path: a fresh session plus a brief.

### 11.1 What supersedes what

| Earlier | Now |
|---|---|
| §6.4 resume with `claude --resume`, the `lost` fallback | A lost or exited agent is always replaced by a **fresh session** that reads `brief.md` |
| §7 Claude-specific adapter (hooks, `--session-id`, transcripts) | **Thin generic adapter**; vendor features are optional capabilities |
| Hooks as the primary event source | **Herdr agent status** (`events.subscribe`: `pane.agent_status_changed`, `pane.agent_detected`, `pane.exited`, `pane.closed`, `tab.closed`) is the primary source. Vendor hooks only enrich it (e.g. context size, pre-compact). |
| Role prompt via `--append-system-prompt` | **`AGENTS.md`** in the worktree, with `CLAUDE.md` always a symlink to it (identical content) |
| Rotation triggers: compaction, context %, idle timeout | Neutral triggers (turn count, session age, tickets completed), plus vendor triggers when the adapter supports them |

### 11.2 Thread memory (three layers)

1. **Automatic facts (daemon):** events (tickets, statuses, decisions, sessions) and git (commits on the thread branch, `git diff --stat` of the worktree). Nobody has to write these.
2. **Working notes (agents), checkpoint policy "B":**
   - `agt note <thread> "<finding>"` records findings, `agt progress <thread> "<where I am>"` records the current position (latest wins), and `agt question <thread> "<open question>"` records doubts.
   - These are rendered into `sub.thread.md` sections **Findings**, **Progress**, **Open questions**.
   - Mandatory checkpoints:
     - `agt ticket done` requires `--summary`;
     - when an agent goes idle with no `progress` for N turns or M minutes, the daemon sends a short reminder (both thresholds configurable);
     - rotation still requires a handoff (or generates one).
3. **Context pack `brief.md` (daemon, deterministic):** one file per thread that a fresh agent reads first. It holds:
   - goal, criteria and decisions;
   - the board;
   - progress, findings and open questions;
   - the latest handoff;
   - git trail;
   - a "how to continue" section.

   It is re-rendered on every change and doubles as the thread's metadata.

### 11.3 `AGENTS.md` / `CLAUDE.md`

- The daemon writes `AGENTS.md` at the **worktree root** when the worktree is created and before every spawn. `CLAUDE.md` is always a symlink to `AGENTS.md`.
- Content: common rules (how to use `agt`, where state lives, checkpoint policy), then a **Coordinator** section and a **Worker** section. Coordinator and workers share one worktree, so one file serves both roles. The bootstrap prompt states the role, and `AGT_ROLE` confirms it.
- **Never committed:**
  - If the project has no `AGENTS.md`/`CLAUDE.md`, both are added to the repo's `.git/info/exclude`.
  - If the project already tracks one or both, the generated file is the project's content followed by the AgentThread section, and the tracked paths are marked `git update-index --skip-worktree`. If the project only has a plain `CLAUDE.md`, its content seeds `AGENTS.md`, and `CLAUDE.md` becomes the symlink in the worktree.

### 11.4 Generic adapter

```ts
interface AgentAdapter {
  kind: string;                                  // herdr --kind value: "claude", "opencode", "codex", ...
  startArgs(o: { role; config; root }): string[]; // permissions, model; no session or prompt flags required
  setupWorktree?(worktree: string, role): void;   // vendor-specific permission/config files, if any
  capabilities: { contextSize?: boolean; preCompact?: boolean; hooks?: boolean };
}
```

- Agents start in Herdr panes with `herdr agent start --kind <kind>`. The bootstrap prompt is delivered with `herdr agent prompt`.
- The session identity is AgentThread's own id plus the Herdr pane, not a vendor session id.

### 11.5 Development-only memory evaluation

During development, a repeatable recovery scenario checks that saving and transferring memory works:
1. Run a thread to mid-work.
2. Kill the agent.
3. Spawn a fresh agent, possibly of another vendor, from `brief.md` only.
4. Record:
   - whether it continued from the right point;
   - how much work it repeated;
   - how many questions it asked that were already recorded;
   - the time or tokens it took to become productive.

This is a dev tool, not a product feature.

### 11.6 Open items for the plan

- The Herdr socket protocol for `events.subscribe` (framing, reconnect), with polling `herdr agent list` as a fallback.
- OpenCode specifics: permission config and how it loads `AGENTS.md`. Herdr already reports OpenCode session ids.
- Defaults for N turns and M minutes in the progress reminder.
- Which Plan 4 parts are removed (resume path, transcript lookup, `--resume`) and which stay (rotation, handoff, recovery via replacement, worker release).


## 12. Revision 2026-10-24: Multi-agent adapters, role models, release e2e

**Why.** The user splits models by role. Main and coordinator need strong reasoning (for example Claude Code with Opus 5.5, medium effort). Workers run a cheaper model (for example OpenCode with Gemini Flash 3.8, high effort). OpenCode is chosen for workers because switching models there is easy and the user routes API keys through myrouter; Claude Code would also work. A single vendor for every role must keep working. The aim is **autonomy without needless stops**. The coordinator must use the right tools by itself: read docs, run the stack and the tests, install dependencies in the worktree, and commit. The failure the user would be most disappointed by is a process that stops or blocks where it could have run smoothly.

### 12.1 Goals
1. **Adapters for four agents:** Claude Code (`claude`), OpenCode (`opencode`), Codex (`codex`) and omp / oh-my-pi (`omp`). Values in parentheses are Herdr `--kind` values; Herdr 0.9.3 supports 24 kinds. Any of the four can fill any role. More agents follow later through the same adapter pattern.
2. **Role defaults per project.** Each role (main, coordinator, worker) has a default `{ agent, model, effort }`. Workers always use the worker default.
3. **Complexity tiers for the coordinator.** The user defines a list of named tiers, each `{ agent, model, effort }`. For every new thread, main judges the complexity and proposes a tier with a reason. If the user does not answer within a timeout (default 10s), the proposal is used. Main may only pick from the configured tiers.
4. **Interactive project setup.** `agt init`, or the first `agt start` in a project without a config, does the following:
   - detects which of the four agent binaries are installed;
   - asks for the three role defaults and the complexity tiers;
   - writes them to `.agentthread/config.yaml`, where they can be edited by hand later.
   - Setup is per project. There is no global config.
5. **No permission stops.** Every role runs its agent in that agent's autonomous or auto-approve mode.
   - Only main and the coordinator ever talk to the user, and only for decisions about the thread or feature, never for tool permission.
   - Workers never wait for the user. They are the coordinator's responsibility, and they ask the coordinator with `agt question`.
   - A blocked worker (a dialog, a stuck prompt) is reported to the **coordinator**. Today it is reported to main. The coordinator waits, replaces the worker, or escalates to the user.
   - Safety comes from three things: each thread works in its own worktree; only the coordinator commits; and the `AGENTS.md` rules (no push, nothing outside the worktree, never commit `AGENTS.md`/`CLAUDE.md`).
6. **Remove the `claude-code` hard-code** from the daemon (`server.ts`, which rejects non-Claude agents) and from the runner. `agt worker spawn --agent <kind>` stays available as an explicit override.
7. **Release e2e** against real Herdr with real agents and real models. It is not part of `bun test`. It runs only when a release is final, and it must pass before the release. It checks **artifacts**, never LLM wording:
   - events in the log,
   - `brief.md`,
   - `AGENTS.md` and the `CLAUDE.md` symlink present and uncommitted,
   - commits on the thread branch,
   - panes opened and closed as expected,
   - tickets done.
   A second purpose is to find gaps between `tests/fixtures/fake-herdr.ts` and real Herdr and fix the fake; each mismatch found becomes a fix to the fake plus a regression test in the fast suite.

### 12.2 Non-goals
- Choosing a model per ticket. Workers always use the worker default.
- A global or user-level config.
- Managing API keys or routers such as myrouter. These stay in each agent's own config.
- Switching vendor in the middle of a thread for daily use. A replacement coordinator uses the same tier as the session it replaces. Cross-vendor continuation is only exercised by the memory eval (§11.5).
- Agents beyond the four above.
- Running the release e2e in the normal development loop.

### 12.3 Anti-goals
These would count as failure even if everything technically works:
- An agent stops on a permission prompt during normal work.
- A worker waits for the user.
- Main invents a model that is not in the configured tiers.

### 12.4 Config shape (builder may refine names)
```yaml
agents:
  roles:
    main:        { agent: claude-code, model: claude-opus-5-5, effort: medium }
    coordinator: { agent: claude-code, model: claude-opus-5-5, effort: medium }   # used when no tier is chosen
    worker:      { agent: opencode,    model: myrouter/gemini-flash, effort: high }
  complexity:
    timeout: 10s
    tiers:
      high:   { agent: claude-code, model: claude-opus-5-5,   effort: high }
      medium: { agent: claude-code, model: claude-opus-5-5,   effort: medium }
      low:    { agent: claude-code, model: claude-sonnet-5-5, effort: medium }
  claude:   { config_dir: ... }   # per-vendor extras; existing keys keep working where sensible
```
- `model` and `effort` are optional. When they are absent, the agent's own default applies.
- `effort` is passed in each agent's own form. Values a given agent does not support are rejected at config load with a clear message.
- Existing configs (`main_manager`, `default_coordinator`, `default_worker`, `claude.model`, `claude.permission_mode`, `claude.extra_allowed_tools`) must still load. Map them onto the new shape, or migrate with a warning.

### 12.5 Adapter contract
This extends §11.4. Each adapter declares, honestly:
- the Herdr `kind`;
- start args for the role, model and effort;
- its autonomous mode (args, env, and any config file written into the worktree);
- how it reads instructions. Native `AGENTS.md` readers: OpenCode, Codex, omp. Claude needs the `CLAUDE.md` symlink. An agent that needs another file name gets it the same way, as a symlink to `AGENTS.md`;
- how the bootstrap prompt is delivered: a positional argument, `--prompt`, or `herdr agent prompt`;
- optional capabilities: hooks, context size, pre-compact.

Required for an adapter to ship:
- autonomous start,
- model selection,
- reading `AGENTS.md`, natively or through a symlink.

Known facts, still to be verified in the plan's research step:
- **OpenCode v2.0.27** (installed):
  - The TUI takes `--auto` and `--prompt`.
  - `opencode run` and `mini` take `-m provider/model` (run: `provider/model#variant`). The TUI has no `--model`.
  - A config can set `model` and `"permission": "allow"`. It can be overridden per process with `OPENCODE_CONFIG_CONTENT` / `OPENCODE_CONFIG`.
  - `doom_loop`, `external_directory` and `.env` reads default to "ask", so they must be set explicitly.
- **Codex** (not installed on the dev machine):
  - `-m`;
  - `-c model_reasoning_effort=<low|medium|high>`;
  - `--dangerously-bypass-approvals-and-sandbox` / `--yolo`, or `-s workspace-write -a never`;
  - a positional initial prompt;
  - `-C <dir>`;
  - native `AGENTS.md`.
- **omp** (not installed):
  - Model roles are set in `~/.omp/agent/config.yml`. `--model` likely exists.
  - It reads `AGENTS.md`.
  - The approval behavior and how to seed the first prompt are unknown, so this is the most research.
- **Claude Code** (installed, 2.1.296):
  - `--model`;
  - `--permission-mode` values include `bypassPermissions`/`auto`/`dontAsk`;
  - effort is set through settings or the env;
  - hooks already exist.

### 12.6 Complexity proposal flow (my call, the builder may refine)
1. The user asks main for a feature. Main runs `agt thread new <title> --tier <name> --reason "<why>"` (plus the existing flags). This records the thread as **proposed** and returns at once. Main tells the user the proposed tier and reason, says it starts in 10s unless they change it, and ends its turn.
2. The daemon starts the thread with the proposed tier after `complexity.timeout`, unless an explicit choice arrives first. Main relays the user's answer with `agt thread choose <id> --tier <name>` or `agt thread cancel <id>`.
3. `agt thread new … --tier <name> --now` skips the wait. Use it when the user named a tier themselves.
4. The chosen tier, the reason, and whether it was auto-accepted are recorded as events and shown in `brief.md`.
5. A replacement or rotated coordinator keeps its thread's tier.

### 12.7 Release e2e matrix
- **Happy flow, for each of the four agents in both the coordinator and the worker role:**
  1. `agt start` in a scratch repo.
  2. Main proposes a tier, and the timeout auto-accepts it.
  3. The coordinator splits a small feature into 2–3 tickets.
  4. Workers finish with `--summary` and are torn down.
  5. The coordinator commits and requests review.
- **Possible usage, run with the user's daily combination** (Claude Code for main and coordinator, OpenCode for workers):
  - a single vendor for all roles;
  - two concurrent threads with `max-workers`;
  - the user overrides the proposed tier;
  - a worker asks the coordinator, and the coordinator answers;
  - the coordinator asks the user.
- **Edge cases, run with the daily combination:**
  - the coordinator is killed mid-work, and the automatic replacement continues from `brief.md`;
  - a coordinator keeps exiting, and the brake fires;
  - a worker is killed, and its ticket is released with the coordinator notified;
  - a worker is blocked, and the coordinator is notified;
  - rotation by turns and by age, the latter with lowered limits;
  - a daemon restart;
  - a Herdr restart, or a thread tab is closed;
  - a missing agent binary or a bad model name fails clearly and fast.
- Agents that are not installed are reported as skipped, not as passed. A release needs every matrix row run.
- Runs are driven by one command, for example `bun run e2e:release [--only …]`, and produce a pass/fail report per scenario under `.agentthread/e2e-reports/`.

### 12.8 Left to the builder
- Exact config key names, migration details, and the setup wizard UX.
- Per-agent autonomous-mode details, after verification.
- How the e2e drives a "user" reply, for example by sending the reply to main's pane with `herdr agent prompt`.
- The scratch-repo task design.
- The release report format.

### 12.9 Decisions after the builder check
- **Worker questions (user):**
  - `agt question` from a worker notifies its coordinator at once.
  - The worker ends its turn and waits.
  - The coordinator replies with `agt answer <thread> <question-id> "<text>"`. The answer is delivered to that worker's pane and recorded on the question.
  - Workers never use the user as a channel.
- **Late tier choice (user, option A):**
  - The proposal timer pauses as soon as main's pane goes `working` after the proposal, meaning the user is replying.
  - If main then runs `agt thread choose`, that tier starts.
  - If main goes idle again without a choice, the full timeout restarts.
  - The daemon watches main's status from the poller.
- **Codex / omp (user):**
  - The research step may install them and run read-only commands such as `--help`. The user handles logins and keys.
  - An agent that cannot meet §12.5's ship bar is dropped from this revision as a follow-up. That does not block the release.
- **Enforcement (my call):**
  - "Only the coordinator commits" stays enforced, through a pre-commit hook installed for each thread worktree. The hook uses per-worktree `core.hooksPath`, reusing the `extensions.worktreeConfig` setup, and refuses when `AGT_ROLE=worker`.
  - "Nothing outside the worktree" and "no push" stay as `AGENTS.md` rules, plus vendor deny rules where an agent supports them cheaply. The rules must still allow reads of `<root>/.agentthread/`, which holds brief.md and the state files, and the package caches dependency installs need.
- **User-level config (my call):**
  - `~/.config/agentthread/config.yaml` keeps loading under the project file, as in §9, for backward compatibility.
  - The setup wizard runs when the merged config has no `agents.roles`. It writes only to the project config.
  - "Per project" means the wizard asks per project. It does not forbid the user file.
- **Legacy permission keys (my call):**
  - Autonomous mode is the default for every role.
  - `claude.permission_mode` and `claude.extra_allowed_tools` still load, but they no longer reduce autonomy. They are ignored with a one-time warning, unless the user sets `agents.autonomous: false` to keep the old restricted behavior.

## 13. Revision 2026-10-31: Multi-repo workspaces and the feature workflow

**Why.** The user's real projects are workspaces of several git repos in one parent folder that is not itself a repo. Examples:
- `Clients/project-a`, with `web`, `web-fe`, `admin-fe`, `auth`, `auth-fe`, `finance` and `notif`;
- `Clients/project-b`, with `project-b-api` and `project-b-web`.

One task often spans several of these repos (most often an API repo plus its frontend). The user already runs a proven process there by hand: the `feature-workflow` skill, with ten stages, one manager and three workers, one worktree per task per repo, workers that commit, and a manager that squashes. AgentThread must run that same process, with the same results in every project, including new projects set up from scratch. This revision supersedes the single-repo parts of §4, §11.3 and §12 where they conflict.

### 13.1 Roles
| Role | Focus | Talks to the user | Never |
|---|---|---|---|
| **main** | Manages many tasks at once. It takes a task from the user, creates its thread, proposes a tier (§12.6), watches every thread, and tells the user which pane needs an answer. | yes | discusses one task's details, or edits repos |
| **coordinator** | Does one task through the ten stages (§13.4). It discusses the task with the user directly, decides which repos the task needs, and creates the worktrees. It writes the spec and tickets, dispatches workers, reviews each commit, runs tests, the stack, e2e and the browser check, writes the release doc, and squashes. | yes, directly in its pane | edits a repo file (even one line: it sends the worker the exact change), pushes, opens PRs |
| **worker** | One ticket in a fresh session. It edits only the files its ticket lists, validates its own work first, commits them with a pathspec on `wip/<task>`, and reports back. | no (it asks the coordinator) | pushes, amends, rebases, resets, stashes, runs `git add -A`/`.`/`commit -a`, touches servers, or edits the user's checkouts |
| **user** | Decides, pushes, opens PRs, and runs manual migration SQL. An optional browser check of their own whenever they like. | — | — |

- **Communication chain.** Worker → coordinator uses `agt question` and `agt answer` (§12.9). The coordinator talks to the user directly.
- **Needs-you notices.** When a coordinator waits for the user, main is notified and tells the user which pane and which thread need an answer. The coordinator emits this with a new command, `agt thread waiting <id> "<what>"`; the next activity in that thread clears it.

### 13.2 Workspace
- **Project root.** `agt init` runs in the workspace folder, which does not have to be a git repo.
- **Repos.** The repos are the workspace's direct child folders that are git top levels. They are listed in config as `workspace.repos`, which can be edited by hand.
- **Single-repo projects.** A workspace whose root is itself a git repo is a one-repo workspace: the repo is the root, under its folder name. Existing projects keep working (my call).
- **Private docs.** `.docs/` at the workspace root is a private git repo. It holds `shared/` plus one folder per repo, each with `issues/`, `specs/`, `plans/`, `adr/`, `notes/` and `agents/`. `agt init` creates it when it is missing. The coordinator commits its own `.docs` changes automatically, one commit per logical change, and never pushes.
- **Shared docs.** Each repo's own `docs/` holds shared docs, committed with the code. Each touched repo gets one new feature doc after the final test. Existing docs are never edited. Nothing in a repo may point at `.docs/`.

### 13.3 Threads, worktrees and branches
- **One thread per task.**
  - The task name is a slug; the user may give one, such as `kyc-reject-pg`. It must be unique. Otherwise it is derived from the title (my call).
  - Thread directory: `<root>/.worktrees/<task>/`. It is not a git repo. It is the coordinator's working directory and holds that thread's `AGENTS.md`/`CLAUDE.md` and the generated skills.
- **The coordinator creates the worktrees** after asking the user for the source branch (the default comes from config, per repo).
  - Command: `agt worktree add <thread> <repo> [--from <branch>]`, which produces `<root>/.worktrees/<task>/<repo>` on a new `wip/<task>` from the source branch.
  - When config names a setup command (for example `make wt-new TASK={task} SRC={src} REPOS={repo}`), agt runs it instead and then verifies the result. Otherwise it runs plain `git worktree add`.
  - A worktree is never moved or renamed once a session has used it.
- **Tickets share the task's worktree.** There is no per-ticket worktree. Parallel workers in one worktree only work on disjoint file sets.
- **Squash.** At stage 10 the coordinator creates `feat/<task>` from the source branch, runs `git merge --squash wip/<task>`, and makes one plain commit. Commit messages carry no AI attribution, session trailers, ticket ids, `.docs` mentions, or the config's banned words. This overrides any harness attribution reminder.
- **Commit guard** (replaces §12.9's worker refusal):
  - A worker may commit only on `wip/<task>`, and only files listed in its ticket. The per-worktree pre-commit hook checks the staged files against the ticket through `agt`.
  - The coordinator may commit only the squash on `feat/<task>`. It also commits in `.docs/`.
  - Nobody pushes.
  - In the user's own checkouts (the repo folders at the workspace root), agents never commit.
- **Instruction files.** Every repo worktree gets `AGENTS.md` + `CLAUDE.md` + the generated skills, hidden from git as today (§11.3, Plan 9).
- **brief.md.** The brief's git trail covers each of the task's worktrees.

### 13.4 The ten stages (the built-in workflow)
agt carries the content of the user's `feature-workflow` skill, at `~/.agents/my-marketplace/plugins/my-skills/skills/feature-workflow/`, with its templates `spec.md`, `ticket.md`, `release.md` and `project-config.md`. It also carries the content of `manage-docs`. Both are delivered through the coordinator and worker role rules, through `agt guide`, and as skills generated into the thread and worktree directories (§Plan 9 mechanism). One source lives in agt, so the result is the same in every project.

1. **Task discussion.** The coordinator and the user go story by story, down to file level. Each decision is recorded as `Dn (user|coordinator, date)`. The e2e cases, the browser checklist per role and viewport, and the shared docs affected are all designed here. The source branch is asked here.
2. **Spec** in `.docs/<area>/issues/<task>/spec.md`. The area is `shared` when the task spans repos. The API contract is read from the controllers.
3. **Tickets** in `issues/NN-<slug>.md`, each with its repo and the files it may edit, plus a file matrix that decides parallel versus sequence.
4. **Delegation.** One fresh worker session per ticket, with a fixed dispatch message shape. Up to `workers.max_workers` run in parallel. Implementation questions are answered by the coordinator itself.
5. **Review per commit:**
   - (a) the stat ⊆ the ticket's files;
   - (b) the diff matches the spec;
   - (c) the coordinator re-runs the ticket's tests;
   - (d) red-first is proven for bug fixes;
   - (e) no banned mentions;
   - (f) any extras are noted.

   A returned ticket goes back to the same worker, as a new commit.
6. **Combined verification:** the full unit suite plus a type check, once per repo, in the task worktree.
7. **Staged e2e.** The coordinator decides how many stages the task needs. Stages 2 and 3 run without asking. Stage 4 (all suites) runs only after the user confirms, and is compared against a saved baseline of the source branch.
8. **Browser check by the coordinator** (Chrome DevTools MCP when available), on the stack restarted from the task worktrees. Workers validate their own ticket first. This check gates stages 9–10. The user's own final check is optional.
9. **Shared feature docs**, one new file per touched repo, written by the worker who wrote the code.
10. **`release.md`** covers PR order, deploy order, manual migration SQL (simulated, stopping before COMMIT), post-deploy checks and rollback. Then the squash. The user pushes and opens the PRs.

### 13.5 Project config (replaces `.docs/shared/notes/feature-workflow.md`)
`agt setup` asks for these, and they are stored in `.agentthread/config.yaml`:
- **Repos.** `workspace.repos`, and per repo: production and staging branches, the default source branch, and PR order.
- **Commands.** Worktree setup, stack restart (`{task}` is substituted), stack status, and per-repo unit, typecheck and e2e commands.
- **Rules.** Banned words in commits and repo files, never-commit paths, and the rule files every agent must read first (for example `.docs/shared/notes/product-decisions.md`).
- **Report words** for workers' reports: Zentro uses `SELESAI` and `TERHALANG`; the default is `done` and `blocked`.

Project-owned skills, such as Zentro's `run-stack` and `run-e2e`, stay the project's own. Config only points at them.

### 13.6 Non-goals
- A Telegram bridge. That is the next feature, after a week of real use.
- Pushing, PRs, or merges to protected branches.
- Per-ticket worktrees.
- Dokploy or any deploy target.
- Persistent named worker panes. agt spawns a fresh worker per ticket, which matches the "fresh session per ticket" rule.

### 13.7 Anti-goals
- A coordinator that edits code.
- A worker commit that contains files outside its ticket.
- Anything committed in the user's own checkouts.
- A `.docs` path or AI attribution in a repo or a commit message.
- The process silently skipping a stage. A stage is skipped only when the user says so, and the spec records that.

### 13.8 Left to the builder
- How the pre-commit hook asks agt for a ticket's files (for example `agt ticket files <thread>/<T>` from the hook).
- How `agt worktree add` reports setup-command failures.
- How old single-repo threads in existing logs keep replaying. They keep their old worktree path, and only new threads use the workspace layout.
- The exact wording of the role rules, as long as they carry every rule above.

### 13.9 Decisions after the builder check

**User decisions**

- **Stages are tracked, with two gates.**
  - The coordinator records each stage with `agt stage <thread> <n> done|skipped|na [--reason "<why>"] [--by user]`.
  - brief.md and main.thread.md show each thread's current stage.
  - The daemon refuses two out-of-order actions:
    - the squash, while stage 8 is neither `done` nor `na`;
    - a stage-4 e2e run, until the user's yes is recorded with `agt stage <thread> 7 approve --by user`.
  - Nothing else is refused.
- **Stages follow config.** A stage whose config commands are missing is marked `na` automatically, with the reason recorded in the spec:
  - stage 7 has no e2e commands;
  - stage 8 has no browser URL or stack command;
  - stage 10's migration SQL has no migration tool configured.

  Every other stage is mandatory. A user may still skip a stage for one task with `skipped --by user`.
- **Stack lock.**
  - agt keeps one stack lock per workspace: `agt stack acquire <thread>` and `agt stack release <thread>`.
  - The coordinator acquires it before a stack restart, e2e or browser check, and releases it afterwards.
  - Other coordinators wait in a queue that main shows.
  - A lock whose holder session has ended is released automatically.

**My calls (correctable)**

1. **Worker session lifetime.**
   - After `ticket done`, the ticket goes to `review`. The worker session stays alive and keeps its slot until the coordinator runs `agt ticket accept <thread>/<T>`, which ends the session (the done notice and teardown move to accept), or `agt ticket return <thread>/<T> "<what>"`, which sends the text to the same session for a new commit.
   - If that session is gone, a fresh worker is spawned for the returned ticket, with the ticket file and the return note.
   - The stage-9 docs are their own ticket from stage 3, assigned when stage 8 passes.
   - The finished-worker grace sweep (Plan 8) then applies only after `accept`.
2. **Ticket source of truth.**
   - agt's ticket state holds the machine fields: id `T<n>`, repo, files, status and assignee.
   - It is registered with `agt ticket add <thread> "<title>" --repo <r> --file <path>... --doc <.docs path>`.
   - The `.docs` ticket file, named `NN-<slug>.md` with NN equal to n, holds the prose. The coordinator writes it from the template, and the worker appends evidence under `## Comments`.
   - The pre-commit hook checks staged files against `agt ticket files`.
   - The new status `review` sits between `in_progress` and `done`.
3. **Workers write to `.docs`.** A worker may write its own ticket file under `.docs`. That file is the one exception to "nothing outside the worktree", and it is added to the role rules and vendor allow rules. Report words are only text in the summary; agt does not parse them.
4. **Workflow content.**
   - It is a snapshot copied into the agt repo (`src/workflow/` with the templates) and versioned with agt. The user edits agt's copy from now on.
   - The manage-docs content is the generic `multi-repo-doc/templates/manage-docs-SKILL.md`.
   - A generated skill never overwrites a project skill of the same name that is not generated (Plan 9 rule). In that case the project's own skill wins, and agt logs it.
   - A CLAUDE.md "Feature workflow config" pointer is left alone.
5. **Config fields added to §13.5.**
   - migration tool and its "executed" table;
   - whether production migrates on start;
   - the e2e baseline path;
   - an optional read-only production query command;
   - browser URLs and a login-note path;
   - chat language and file language;
   - e2e commands per stage, at workspace level (`e2e.stage2|stage3|stage4`), as well as per-repo unit and typecheck commands.

   `agt setup` asks for these, and pre-fills from `Makefile` targets and `package.json`/Gradle scripts it finds. It does not import `.docs/shared/notes/feature-workflow.md`; that file stays as it is, but agt no longer reads it.
6. **Thread done and cleanup.**
   - A thread goes to `review` after the squash and `release.md`.
   - The user tells main it is merged (`agt thread status <id> done`).
   - Cleanup is `agt thread cleanup <id>`, which removes the task worktrees and the `wip/<task>` branches. It runs only on the user's go-ahead, through main.
   - The stages map onto statuses: 1–9 are `in_progress`, 10 after the squash is `review`, and merged is `done`.
