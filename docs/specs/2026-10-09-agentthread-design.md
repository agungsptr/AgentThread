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

