# AgentThread Claude Code Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run real Claude Code agents in Herdr panes: `agt start` becomes the main manager, every subthread tab gets a coordinator, coordinators spawn workers (limited by `max_workers`, extra requests queued), Claude Code hooks report session state back to the daemon, and the daemon delivers short notifications to agents when they go idle.

**Architecture:**
- **Sessions are first-class state.** New events cover the session lifecycle: `session.created`, `session.attached`, `session.started`, `session.active`, `agent.idle`, `session.compacting`, `session.ended` and `session.failed`.
- **A pure `react(state, newEvents)` function** turns events into follow-up events and effects. Examples: a tab opened → spawn a coordinator; a ticket done → notify the coordinator; a worker idle with its ticket done → end the worker and close its pane; a slot freed → spawn a queued worker. The daemon runs `react` in a bounded loop after every command.
- **Agent startup runs outside the daemon.** `herdr agent start` can wait up to 60s, so the daemon launches a short-lived `agt __spawn` child for it. The child reports `session.attached` or `session.failed` back as a command.
- **Claude Code is configured entirely through CLI flags:**
  - `--session-id`: AgentThread chooses the UUID.
  - `--settings`: the hooks that call `agt event`.
  - `--append-system-prompt`: the role prompt.
  - `--permission-mode acceptEdits` plus `--allowed-tools`: the allowlist.

**Tech Stack:** TypeScript on Bun ≥ 1.1.34, `bun:test`, `zod`, Herdr CLI (`herdr agent start|prompt`, `herdr pane close`), Claude Code CLI ≥ 2.1 (`--session-id`, `--settings`, `--append-system-prompt`, `--permission-mode`, `--allowed-tools`).

**Spec:** `docs/specs/2026-10-09-agentthread-design.md` (§5.1–5.2 commands and roles, §6.3 workers, §7 adapters, §8 Herdr flow). Follow-ups: `docs/superpowers/followups/2026-10-09-core-engine.md`, `docs/superpowers/followups/2026-10-09-config-herdr-bridge.md`.

### Roadmap position

Plan 3 of 5. Plans 1–2 are merged.
- **Plan 4 (session lifecycle)** builds on the `session.*` events here to add resume, the `lost` fallback, rotation on `session.compacting` and context thresholds, and generated handoffs.
- **Plan 5** adds the OpenCode adapter.

### Decisions taken with the user

- **Permissions:** `--permission-mode acceptEdits` plus an allowlist. Other commands still prompt, and the pane shows `blocked` in Herdr.
  - Coordinators get `agt` and read-only git, plus `git add` / `git commit`.
  - Workers get `agt` and read-only git only, so they cannot commit. This enforces spec §6.3 ("only the coordinator commits").
  - The main manager gets `agt` only.
- **Main manager:** `agt start` sets up the layout and then runs Claude Code in the foreground of the same pane. Exiting Claude returns to the shell. `--no-manager` skips it.

### Spec adjustments made in this plan

- **Only `claude-code` agents are supported.** The daemon refuses to start if any `agents.*` config value is something else. OpenCode arrives in Plan 5.
- **The coordinator's pane env has no `AGT_SESSION`.** Herdr cannot set env for `herdr agent start`, and the tab's root pane was created in Plan 2. Hooks therefore identify the session from the hook's stdin JSON (`session_id`, which equals the `--session-id` we chose). Workers get `AGT_SESSION`/`AGT_TICKET` because their panes are created per session with `--env`.
- **`agt worker spawn <thread> --ticket <T>`** follows the spec. `--agent` is deferred to Plan 5.
- **Added `agt tell <thread|main> <message...>`.** It queues a notification for a thread's coordinator or the main manager. This is the human/agent → agent messaging channel.
- **Session status values are `starting | active | idle | ended | failed`.** `rotating`, `rotated` and `lost` come in Plan 4.
- **Per-thread `max_workers`:** `agt thread new --max-workers N` is stored on the thread and overrides `workers.max_workers` (spec §9 precedence: per-thread > project > user > default).
- **Worker pane layout:** the first worker splits right of the coordinator pane, and later workers split down from the most recent worker pane.

## Global Constraints

- Runtime Bun ≥ 1.1.34, TypeScript `strict: true`; run `env -u HERDR_ENV -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID -u HERDR_PANE_ID -u AGT_HERDR_IT bun test` and `bun run typecheck` before each commit.
- Never run the real `herdr` or `claude` binaries from tests or while implementing. Tests use `tests/fixtures/fake-herdr.ts` and `tests/fixtures/fake-claude.ts`.
- Leave no `agt daemon run` or `agt __spawn` processes behind.
- Session IDs are RFC 4122 UUIDs from `crypto.randomUUID()`. Herdr agent names: `agt-<4 hex of Bun.hash(root)>-main`, `agt-<h>-c<thread>`, `agt-<h>-w<thread>-<ticket lowercased>`. They must match `[a-z][a-z0-9_-]{0,31}`.
- Hook → event mapping exactly:

  | Hook | `agt event` arg | Event |
  |---|---|---|
  | `SessionStart` | `started` | `session.started` |
  | `UserPromptSubmit` | `active` | `session.active` |
  | `Stop` | `idle` | `agent.idle` |
  | `PreCompact` | `compacting` | `session.compacting` |
  | `SessionEnd` | `ended` | `session.ended` |
- Claude args exactly, in this order:
  - `--session-id <uuid>`
  - `--permission-mode <agents.claude.permission_mode>`
  - `--allowed-tools <comma-joined list>`
  - `--settings <hooks JSON>`
  - optional `--model <agents.claude.model>`
  - `--append-system-prompt <role prompt>`
- Allowed tools:
  - main: `Bash(agt *)`
  - worker: `Bash(agt *)`, `Bash(git status*)`, `Bash(git diff*)`, `Bash(git log*)`
  - coordinator: the worker list plus `Bash(git add *)`, `Bash(git commit *)`
  - all roles: plus `agents.claude.extra_allowed_tools`
- Agent pane env:
  - always `AGT_ROOT`, `AGT_ROLE`, `AGT_SESSION`, `AGT_AGENT=claude-code`, and `PATH=<dir of bin/agt>:<daemon PATH>`
  - plus `AGT_THREAD` (and `AGT_TICKET` for workers)
- New config keys and defaults:
  - `agents.claude.permission_mode: acceptEdits`, one of `acceptEdits | auto | bypassPermissions | manual | dontAsk | plan`
  - `agents.claude.extra_allowed_tools: []`
  - `agents.claude.model` is optional
- `agt event` must always exit 0 within ~3s, even if the daemon is down or the session is unknown, because it runs inside Claude Code hooks.

## Review Focus

1. **Worker capacity.** Spawn requests beyond `max_workers` are queued, and when a slot frees exactly one queued worker per free slot is spawned. Two events in one batch must not double-spawn. Tests in Task 4 and Task 7.
2. **Hooks never hurt the agent.** `agt event` exits 0 quickly when the daemon is down, the session is unknown, or stdin is empty or garbage. Test in Task 8.
3. **Notifications are delivered only to an idle agent, and never lost.** A failed delivery keeps the notices for the next idle. Tests in Task 4 and Task 7.
4. **Spawn failure.** When `herdr agent start` fails or times out:
   - the session becomes `failed`;
   - a worker pane we split is closed again;
   - the coordinator is notified;
   - the freed slot spawns the next queued worker.

   Test in Task 7.
5. **The daemon never blocks on agent startup.** While the fake `herdr agent start` hangs, other commands still answer immediately. Test in Task 7.

---

## File structure

```
src/config/config.ts              # (modify) agents.claude section
src/domain/types.ts               # (modify) SessionRole, SESSION_SIGNALS, session/notice/worker events, thread.created maxWorkers
src/state/projection.ts           # (modify) Session, State.sessions, Thread.maxWorkers/workerQueue, session event handling
src/render/markdown.ts            # (modify) sessions + max_workers in sub.thread.md, Coordinator/Workers columns in main.thread.md
src/render/write.ts               # (modify) pass sessions + config to renderers
src/orchestration/sessions.ts     # liveSessions, workerLimit, agentName, spawnCoordinator, spawnWorker
src/orchestration/reactor.ts      # react(): pure follow-up events/effects
src/commands/schema.ts            # (modify) worker.spawn, tell, session.signal, session.attached, session.failed, session.open_main; thread.new maxWorkers
src/commands/handler.ts           # (modify) new effects + commands
src/agents/claude.ts              # AGT_BIN, hookSettings, allowedTools, claudeArgs, agentEnv
src/agents/prompts.ts             # systemPrompt, bootstrapPrompt
src/agents/spawn-job.ts           # SpawnJob, encode/decode, runSpawnJob, launchSpawnJob
src/herdr/bridge.ts               # (modify) agentStart, agentPrompt, closePane
src/daemon/effects.ts             # (modify) agent.spawn / notice.deliver / pane.close
src/daemon/server.ts              # (modify) reactor loop, agent-kind check, writeAll(config)
src/cli/main.ts                   # (modify) worker spawn, tell, event, __spawn, thread new --max-workers, start runs main manager
tests/fixtures/fake-herdr.ts      # (modify) agent start/prompt, pane close
tests/fixtures/fake-claude.ts     # records argv/env to $FAKE_CLAUDE_LOG
tests/helpers.ts                  # (modify) FAKE_CLAUDE, waitFor
```

---

### Task 1: Claude config section

**Files:**
- Modify: `src/config/config.ts`
- Modify: `tests/config/config.test.ts`

**Interfaces:**
- Consumes: Plan 2 `ConfigSchema`.
- Produces: `config.agents.claude: { permission_mode: "acceptEdits" | "auto" | "bypassPermissions" | "manual" | "dontAsk" | "plan"; extra_allowed_tools: string[]; model?: string }` (defaults `acceptEdits`, `[]`, no model). Exported `PERMISSION_MODES` tuple.

- [ ] **Step 1: Update the failing tests**

In `tests/config/config.test.ts`:
- In the "defaults match the spec" test, change the expected `agents` object to:

```ts
    agents: {
      main_manager: "claude-code",
      default_coordinator: "claude-code",
      default_worker: "claude-code",
      claude: { permission_mode: "acceptEdits", extra_allowed_tools: [] },
    },
```

- Append:

```ts
test("claude section: permission mode, extra tools, model", () => {
  const { root, env } = setup({
    project: "agents:\n  claude:\n    permission_mode: bypassPermissions\n    extra_allowed_tools: ['Bash(bun test*)']\n    model: opus\n",
  });
  expect(loadConfig(root, env).agents.claude).toEqual({
    permission_mode: "bypassPermissions",
    extra_allowed_tools: ["Bash(bun test*)"],
    model: "opus",
  });
  const bad = setup({ project: "agents:\n  claude:\n    permission_mode: yolo\n" });
  expect(() => loadConfig(bad.root, bad.env)).toThrow(/agents\.claude\.permission_mode/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/config`
Expected: FAIL. `claude` is missing from the defaults, and the key is unrecognized in the new test.

- [ ] **Step 3: Implement**

In `src/config/config.ts`, add above `ConfigSchema`:

```ts
export const PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"] as const;
```

and inside the `agents` object (after `default_worker`), add:

```ts
        claude: z
          .object({
            permission_mode: z.enum(PERMISSION_MODES).default("acceptEdits"),
            extra_allowed_tools: z.array(z.string().trim().min(1)).default([]),
            model: z.string().trim().min(1).optional(),
          })
          .strict()
          .default({}),
```

- [ ] **Step 4: Verify and commit**

Run: `bun test tests/config && bun run typecheck` → PASS.

```bash
git add src/config/config.ts tests/config/config.test.ts
git commit -m "feat: add Claude Code agent config"
```

---

### Task 2: Session domain (types, projection, rendering)

**Files:**
- Modify: `src/domain/types.ts`, `src/state/projection.ts`, `src/render/markdown.ts`, `src/render/write.ts`
- Modify: `tests/helpers.ts` (`threadCreated` accepts `maxWorkers`, which happens automatically through `Partial<payload>`)
- Test: `tests/state/sessions.test.ts`, plus additions to `tests/render/markdown.test.ts`

**Interfaces:**
- Consumes: Plan 2 `State`, `Thread`, `DEFAULT_CONFIG`.
- Produces:
  - In `types.ts`:
    - `type SessionRole = "main" | "coordinator" | "worker"`
    - `SESSION_SIGNALS = ["started","active","idle","compacting","ended"] as const`, `type SessionSignal`
    - `thread.created` payload gains `maxWorkers?: number`
    - new `EventBody` members:
      - `{ type: "session.created"; thread?: string; payload: { session: string; role: SessionRole; agent: AgentKind; name: string; ticket?: string } }`
      - `{ type: "session.attached"; thread?: string; payload: { session: string; pane: string } }`
      - `{ type: "session.started" | "session.active" | "agent.idle" | "session.compacting" | "session.ended"; thread?: string; payload: { session: string } }`
      - `{ type: "session.failed"; thread?: string; payload: { session: string; reason: string } }`
      - `{ type: "worker.queued"; thread: string; payload: { ticket: string } }`
      - `{ type: "notice.queued"; thread?: string; payload: { session: string; text: string } }`
      - `{ type: "notice.delivered"; thread?: string; payload: { session: string; count: number } }`
  - In `projection.ts`:
    - `type SessionStatus = "starting" | "active" | "idle" | "ended" | "failed"`
    - `interface Session { id: string; role: SessionRole; agent: AgentKind; name: string; thread?: string; ticket?: string; pane?: string; status: SessionStatus; notices: string[] }`
    - `isLive(s: Session): boolean`
    - `State.sessions: Map<string, Session>`
    - `Thread.maxWorkers?: number`, `Thread.workerQueue: string[]`
  - In the renderers:
    - `renderSub(t: Thread, sessions?: Session[])`: the frontmatter gains `max_workers` (number or null) after `tab`, and `sessions` becomes a list of `{ id, role, agent, status, ticket?, pane? }`.
    - `renderMain(state: State, config?: Config)`: two columns are appended, `Coordinator` (status of the live coordinator session, or `-`) and `Workers` (`<live>/<limit>`).
    - `writeAll(root: string, state: State, config?: Config)`.
  - Projection rules:
    - `session.created` → `starting`, and removes the ticket from `workerQueue`.
    - `session.started` / `session.active` → `active` (only while live).
    - `agent.idle` → `idle` (only while live).
    - `session.ended` → `ended`.
    - `session.failed` → `failed`.
    - `notice.queued` appends to `notices`; `notice.delivered` removes the first `count`.
    - `worker.queued` appends to `workerQueue`.
    - Thread log notes are written for `session.created`, `session.attached`, `session.compacting`, `session.ended`, `session.failed` and `worker.queued`. Ids are shortened to their first 8 characters.

- [ ] **Step 1: Write the failing tests**

Create `tests/state/sessions.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { EventBody } from "../../src/domain/types.ts";
import { isLive } from "../../src/state/projection.ts";
import { INIT, stateOf, threadCreated } from "../helpers.ts";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const created = (session: string, role: "coordinator" | "worker", ticket?: string): EventBody => ({
  type: "session.created",
  thread: "001",
  payload: { session, role, agent: "claude-code", name: `n-${session.slice(0, 4)}`, ...(ticket ? { ticket } : {}) },
});

test("session lifecycle and notices", () => {
  const s = stateOf(
    INIT,
    threadCreated("001", { maxWorkers: 2 }),
    created(S1, "coordinator"),
    { type: "session.attached", thread: "001", payload: { session: S1, pane: "w1:p2" } },
    { type: "session.started", thread: "001", payload: { session: S1 } },
    { type: "agent.idle", thread: "001", payload: { session: S1 } },
    { type: "notice.queued", thread: "001", payload: { session: S1, text: "a" } },
    { type: "notice.queued", thread: "001", payload: { session: S1, text: "b" } },
    { type: "notice.delivered", thread: "001", payload: { session: S1, count: 1 } },
  );
  expect(s.sessions.get(S1)).toEqual({
    id: S1, role: "coordinator", agent: "claude-code", name: "n-1111", thread: "001", pane: "w1:p2", status: "idle", notices: ["b"],
  });
  expect(s.threads.get("001")!.maxWorkers).toBe(2);
});

test("queue, creation removes from queue, ended sessions stay ended", () => {
  const s = stateOf(
    INIT,
    threadCreated("001"),
    { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "x", scope: ["a"] } },
    { type: "worker.queued", thread: "001", payload: { ticket: "T1" } },
    created(S2, "worker", "T1"),
    { type: "session.ended", thread: "001", payload: { session: S2 } },
    { type: "agent.idle", thread: "001", payload: { session: S2 } },
  );
  expect(s.threads.get("001")!.workerQueue).toEqual([]);
  expect(s.sessions.get(S2)!.status).toBe("ended");
  expect(isLive(s.sessions.get(S2)!)).toBe(false);
  expect(s.threads.get("001")!.log.map((e) => e.message).slice(-3)).toEqual([
    "T1 queued for a worker",
    "worker session 22222222 created for T1",
    "session 22222222 ended",
  ]);
});

test("failed sessions and main sessions without a thread", () => {
  const s = stateOf(
    INIT,
    { type: "session.created", payload: { session: S1, role: "main" as const, agent: "claude-code" as const, name: "m" } },
    { type: "session.failed", payload: { session: S1, reason: "boom" } },
  );
  expect(s.sessions.get(S1)).toMatchObject({ status: "failed", thread: undefined });
});

test("unknown session throws", () => {
  expect(() => stateOf(INIT, { type: "agent.idle", payload: { session: S1 } })).toThrow(`unknown session ${S1}`);
});
```

Append to `tests/render/markdown.test.ts`:

```ts
test("sessions and worker capacity are rendered", () => {
  const S = "33333333-3333-4333-8333-333333333333";
  const s = stateOf(
    INIT,
    threadCreated("001", { maxWorkers: 2 }),
    { type: "session.created", thread: "001", payload: { session: S, role: "coordinator", agent: "claude-code", name: "c" } },
    { type: "session.attached", thread: "001", payload: { session: S, pane: "w1:p2" } },
    { type: "agent.idle", thread: "001", payload: { session: S } },
  );
  const t = s.threads.get("001")!;
  const fm = parse(renderSub(t, [...s.sessions.values()]).split("---\n")[1]!);
  expect(fm).toMatchObject({
    max_workers: 2,
    sessions: [{ id: S, role: "coordinator", agent: "claude-code", status: "idle", pane: "w1:p2" }],
  });
  expect(renderMain(s)).toContain("| idle | 0/2 |");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/state tests/render`
Expected: FAIL. You get type errors and unknown event types.

- [ ] **Step 3: Extend types**

In `src/domain/types.ts`:
- add after `AgentKind`:

```ts
export type SessionRole = "main" | "coordinator" | "worker";

export const SESSION_SIGNALS = ["started", "active", "idle", "compacting", "ended"] as const;
export type SessionSignal = (typeof SESSION_SIGNALS)[number];
```

- add `maxWorkers?: number;` to the `thread.created` payload
- add these members to `EventBody`:

```ts
  | {
      type: "session.created";
      thread?: string;
      payload: { session: string; role: SessionRole; agent: AgentKind; name: string; ticket?: string };
    }
  | { type: "session.attached"; thread?: string; payload: { session: string; pane: string } }
  | {
      type: "session.started" | "session.active" | "agent.idle" | "session.compacting" | "session.ended";
      thread?: string;
      payload: { session: string };
    }
  | { type: "session.failed"; thread?: string; payload: { session: string; reason: string } }
  | { type: "worker.queued"; thread: string; payload: { ticket: string } }
  | { type: "notice.queued"; thread?: string; payload: { session: string; text: string } }
  | { type: "notice.delivered"; thread?: string; payload: { session: string; count: number } }
```

- [ ] **Step 4: Extend the projection**

In `src/state/projection.ts`:
- import `AgentKind`, `SessionRole` from `../domain/types.ts`
- add:

```ts
export type SessionStatus = "starting" | "active" | "idle" | "ended" | "failed";

export interface Session {
  id: string;
  role: SessionRole;
  agent: AgentKind;
  name: string;
  thread?: string;
  ticket?: string;
  pane?: string;
  status: SessionStatus;
  notices: string[];
}

export function isLive(s: Session): boolean {
  return s.status !== "ended" && s.status !== "failed";
}
```

- add `maxWorkers?: number;` and `workerQueue: string[];` to `Thread`, and `sessions: Map<string, Session>;` to `State`
- in `emptyState()`, return `{ threads: new Map(), sessions: new Map(), lastSeq: 0 }`
- in the `thread.created` block, add `maxWorkers: p.maxWorkers,` and `workerQueue: [],` to the new thread object
- directly after the `layout.registered` early return, add `if (applySessionEvent(state, ev)) return;`
- add the case `case "worker.queued": t.workerQueue.push(ev.payload.ticket); note(t, ev, \`${ev.payload.ticket} queued for a worker\`); break;` to the thread `switch`
- add at the bottom:

```ts
const short = (id: string) => id.slice(0, 8);

function sessionOf(state: State, seq: number, id: string): Session {
  const s = state.sessions.get(id);
  if (!s) throw new Error(`event ${seq} references unknown session ${id}`);
  return s;
}

function threadNote(state: State, ev: StoredEvent, message: string): void {
  const t = ev.thread ? state.threads.get(ev.thread) : undefined;
  if (t) note(t, ev, message);
}

/** Applies session and notice events; returns false for every other event type. */
function applySessionEvent(state: State, ev: StoredEvent): boolean {
  switch (ev.type) {
    case "session.created": {
      const p = ev.payload;
      state.sessions.set(p.session, {
        id: p.session,
        role: p.role,
        agent: p.agent,
        name: p.name,
        thread: ev.thread,
        ...(p.ticket ? { ticket: p.ticket } : {}),
        status: "starting",
        notices: [],
      });
      const t = ev.thread ? state.threads.get(ev.thread) : undefined;
      if (t && p.ticket) t.workerQueue = t.workerQueue.filter((k) => k !== p.ticket);
      threadNote(state, ev, `${p.role} session ${short(p.session)} created${p.ticket ? ` for ${p.ticket}` : ""}`);
      return true;
    }
    case "session.attached":
      sessionOf(state, ev.seq, ev.payload.session).pane = ev.payload.pane;
      threadNote(state, ev, `session ${short(ev.payload.session)} attached to pane ${ev.payload.pane}`);
      return true;
    case "session.started":
    case "session.active": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      if (isLive(s)) s.status = "active";
      return true;
    }
    case "agent.idle": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      if (isLive(s)) s.status = "idle";
      return true;
    }
    case "session.compacting":
      sessionOf(state, ev.seq, ev.payload.session);
      threadNote(state, ev, `session ${short(ev.payload.session)} is compacting`);
      return true;
    case "session.ended":
      sessionOf(state, ev.seq, ev.payload.session).status = "ended";
      threadNote(state, ev, `session ${short(ev.payload.session)} ended`);
      return true;
    case "session.failed":
      sessionOf(state, ev.seq, ev.payload.session).status = "failed";
      threadNote(state, ev, `session ${short(ev.payload.session)} failed: ${ev.payload.reason}`);
      return true;
    case "notice.queued":
      sessionOf(state, ev.seq, ev.payload.session).notices.push(ev.payload.text);
      return true;
    case "notice.delivered":
      sessionOf(state, ev.seq, ev.payload.session).notices.splice(0, ev.payload.count);
      return true;
    default:
      return false;
  }
}
```

- [ ] **Step 5: Render sessions**

In `src/render/markdown.ts`:
- import `DEFAULT_CONFIG, type Config` from `../config/config.ts`, and `isLive, type Session` from `../state/projection.ts`
- change the signature to `export function renderMain(state: State, config: Config = DEFAULT_CONFIG): string`, and replace the row mapping and header with:

```ts
  const rows = threads.map((t) => {
    const done = t.tickets.filter((k) => k.status === "done").length;
    const live = [...state.sessions.values()].filter((s) => s.thread === t.id && isLive(s));
    const coordinator = live.find((s) => s.role === "coordinator")?.status ?? "-";
    const workers = live.filter((s) => s.role === "worker").length;
    const limit = t.maxWorkers ?? config.workers.max_workers;
    return `| ${t.id} | ${cell(t.title)} | ${t.type} | ${t.status} | ${done}/${t.tickets.length} | ${t.dependsOn.join(", ") || "-"} | ${coordinator} | ${workers}/${limit} |`;
  });
```

```ts
    "| ID | Title | Type | Status | Tickets | Depends | Coordinator | Workers |",
    "|----|-------|------|--------|---------|---------|-------------|---------|",
```

- change `renderSub` to `export function renderSub(t: Thread, sessions: Session[] = []): string`. In its frontmatter object, add `max_workers: t.maxWorkers ?? null,` after `tab: …`, and replace `sessions: [],` with:

```ts
    sessions: sessions.map((s) => ({
      id: s.id,
      role: s.role,
      agent: s.agent,
      status: s.status,
      ...(s.ticket ? { ticket: s.ticket } : {}),
      ...(s.pane ? { pane: s.pane } : {}),
    })),
```

In `src/render/write.ts`: change to `export function writeAll(root: string, state: State, config: Config = DEFAULT_CONFIG): void`, render main with `renderMain(state, config)`, and render each thread with `renderSub(t, [...state.sessions.values()].filter((s) => s.thread === t.id))`. Add the matching imports.

- [ ] **Step 6: Verify and commit**

Run: `bun test && bun run typecheck` → PASS. The earlier row assertions in `tests/render`, `tests/daemon` and `tests/e2e` still match, because the new columns are appended after `Depends`.

```bash
git add src/domain/types.ts src/state/projection.ts src/render tests/state/sessions.test.ts tests/render/markdown.test.ts
git commit -m "feat: model agent sessions, notices and worker queue"
```

---

### Task 3: Session helpers and new commands

**Files:**
- Create: `src/orchestration/sessions.ts`
- Modify: `src/commands/schema.ts`, `src/commands/handler.ts`
- Test: `tests/commands/sessions.test.ts`

**Interfaces:**
- Consumes: Task 2 types; Plan 2 `HandlerContext`, `Effect`, `DEFAULT_CONFIG`.
- Produces:
  - In `sessions.ts`:
    - `liveSessions(state: State, thread?: string, role?: SessionRole): Session[]`. Live sessions in insertion order; `thread === undefined` means any.
    - `workerLimit(t: Thread, config: Config): number`
    - `agentName(root: string, role: SessionRole, thread?: string, ticket?: string): string`
    - `interface SpawnContext { root: string; newId: () => string }`
    - `spawnCoordinator(t: Thread, ctx: SpawnContext): { events: EventBody[]; effects: Effect[] }`
    - `spawnWorker(state: State, t: Thread, ticket: string, ctx: SpawnContext): { events: EventBody[]; effects: Effect[] }`
  - `Effect` gains:
    - `{ kind: "agent.spawn"; session: string; role: "coordinator" | "worker"; name: string; thread: string; ticket?: string; cwd: string; pane?: string; splitFrom?: string; direction?: "right" | "down" }`
    - `{ kind: "notice.deliver"; session: string; thread?: string; pane: string; text: string; count: number }`
    - `{ kind: "pane.close"; pane: string }`
  - `HandlerContext` gains `newId?: () => string` (default `crypto.randomUUID`).
  - Commands:
    - `thread.new` gains `maxWorkers?: number` (int 1–16).
    - `worker.spawn` (coordinator) `{ thread, ticket }`. The result is `{ session: string, queued: false }` or `{ queued: true }`. It rejects when:
      - the thread is done;
      - the thread has no tab (`thread <id> has no Herdr tab; run \`agt start\``);
      - the ticket is unknown;
      - the ticket is not `open`;
      - the ticket already has a queued or live worker (`ticket <T> already has a worker`).
    - `tell` (any role) `{ target: <thread id> | "main", message }` emits `notice.queued` with text `Message from <role>: <message>` to the live coordinator or main session. It rejects with `no live coordinator for thread <id>` or `no live main manager session`.
    - `session.signal` (any role) `{ session, signal }` emits the mapped event. An unknown session is rejected. A signal for a session that is not live produces no events. If `actor.session` is set and differs from the session, the command is rejected.
    - `session.attached` (user) `{ session, pane }` and `session.failed` (user) `{ session, reason }`. Both are ignored once the session is not live.
    - `session.open_main` (user) `{ session, pane }` emits `session.ended` for any live main session, then `session.created` (role main, no thread) and `session.attached`. The result is `{ session }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/commands/sessions.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { handle, type HandleResult } from "../../src/commands/handler.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import type { Actor, EventBody, StoredEvent } from "../../src/domain/types.ts";
import { agentName } from "../../src/orchestration/sessions.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, threadCreated } from "../helpers.ts";

const COORD: Actor = { role: "coordinator", thread: "001", session: "c" };
let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
const H = agentName("/repo", "main").slice(4, 8);

function exec(state: State, cmd: unknown, actor: Actor = USER, config = DEFAULT_CONFIG): HandleResult {
  const r = handle(state, CommandSchema.parse(cmd), actor, { root: "/repo", config, newId });
  if (r.ok) for (const b of r.events) applyEvent(state, { ...b, seq: state.lastSeq + 1, ts: "t", actor } as StoredEvent);
  return r;
}
const err = (r: HandleResult) => (r.ok ? "accepted" : r.error);

function threadWithTab(maxWorkers?: number): State {
  ids = 0;
  const bodies: EventBody[] = [
    INIT,
    threadCreated("001", maxWorkers ? { maxWorkers } : {}),
    { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } },
  ];
  const s = stateOf(...bodies);
  for (const title of ["A", "B", "C"]) exec(s, { cmd: "ticket.add", thread: "001", title, scope: [title.toLowerCase()] }, COORD);
  return s;
}

describe("agentName", () => {
  test("is herdr-safe and per role", () => {
    expect(agentName("/repo", "main")).toMatch(/^agt-[0-9a-f]{4}-main$/);
    expect(agentName("/repo", "coordinator", "001")).toBe(`agt-${H}-c001`);
    expect(agentName("/repo", "worker", "001", "T12")).toBe(`agt-${H}-w001-t12`);
    expect(agentName("/repo", "worker", "001", "T12")).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });
});

describe("worker.spawn", () => {
  test("spawns into the coordinator pane first, then splits down from the last worker", () => {
    const s = threadWithTab(3);
    const first = exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" }, COORD);
    expect(first.ok && first.result).toEqual({ session: "00000000-0000-4000-8000-000000000001", queued: false });
    expect(first.ok && first.effects).toEqual([
      {
        kind: "agent.spawn", session: "00000000-0000-4000-8000-000000000001", role: "worker", name: `agt-${H}-w001-t1`,
        thread: "001", ticket: "T1", cwd: "/repo/.worktrees/001-thread-001", splitFrom: "w1:p2", direction: "right",
      },
    ]);
    exec(s, { cmd: "session.attached", session: "00000000-0000-4000-8000-000000000001", pane: "w1:p3" });
    const second = exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T2" }, COORD);
    expect(second.ok && second.effects[0]).toMatchObject({ splitFrom: "w1:p3", direction: "down" });
  });

  test("queues beyond the per-thread limit", () => {
    const s = threadWithTab(1);
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" }, COORD);
    const r = exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T2" }, COORD);
    expect(r).toEqual({ ok: true, events: [{ type: "worker.queued", thread: "001", payload: { ticket: "T2" } }], effects: [], result: { queued: true } });
    expect(s.threads.get("001")!.workerQueue).toEqual(["T2"]);
  });

  test("falls back to workers.max_workers from config", () => {
    const s = threadWithTab();
    const config = { ...DEFAULT_CONFIG, workers: { max_workers: 1 } };
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" }, COORD, config);
    expect(exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T2" }, COORD, config)).toMatchObject({ result: { queued: true } });
  });

  test("rejections", () => {
    const s = threadWithTab(1);
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" }, COORD);
    expect(err(exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" }, COORD))).toBe("ticket T1 already has a worker");
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T2" }, COORD);
    expect(err(exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T2" }, COORD))).toBe("ticket T2 already has a worker");
    expect(err(exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T9" }, COORD))).toBe("unknown ticket T9 in thread 001");
    expect(err(exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T3" }, USER))).toBe("role user may not run worker.spawn");
    const noTab = stateOf(INIT, threadCreated("001"));
    exec(noTab, { cmd: "ticket.add", thread: "001", title: "A", scope: ["a"] }, COORD);
    expect(err(exec(noTab, { cmd: "worker.spawn", thread: "001", ticket: "T1" }, COORD))).toBe(
      "thread 001 has no Herdr tab; run `agt start`",
    );
  });
});

describe("sessions", () => {
  test("signals map to events and stop after the session ends", () => {
    const s = threadWithTab();
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" }, COORD);
    const id = "00000000-0000-4000-8000-000000000001";
    expect(exec(s, { cmd: "session.signal", session: id, signal: "idle" }, { role: "worker", thread: "001", session: id })).toMatchObject({
      events: [{ type: "agent.idle", thread: "001", payload: { session: id } }],
    });
    exec(s, { cmd: "session.signal", session: id, signal: "ended" });
    expect(exec(s, { cmd: "session.signal", session: id, signal: "idle" })).toMatchObject({ ok: true, events: [] });
    expect(err(exec(s, { cmd: "session.signal", session: id, signal: "idle" }, { role: "worker", thread: "001", session: "other" }))).toBe(
      `actor session other cannot signal ${id}`,
    );
    expect(err(exec(s, { cmd: "session.signal", session: newId(), signal: "idle" }))).toMatch(/^unknown session /);
  });

  test("attached / failed reports", () => {
    const s = threadWithTab();
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" }, COORD);
    const id = "00000000-0000-4000-8000-000000000001";
    exec(s, { cmd: "session.failed", session: id, reason: "agent_not_ready" });
    expect(s.sessions.get(id)!.status).toBe("failed");
    expect(exec(s, { cmd: "session.attached", session: id, pane: "w1:p9" })).toMatchObject({ ok: true, events: [] });
    expect(err(exec(s, { cmd: "session.failed", session: id, reason: "x" }, COORD))).toBe("role coordinator may not run session.failed");
  });

  test("open_main replaces a stale main session; tell reaches main and coordinators", () => {
    const s = threadWithTab();
    const m1 = newId();
    const m2 = newId();
    exec(s, { cmd: "session.open_main", session: m1, pane: "w1:p0" });
    const r = exec(s, { cmd: "session.open_main", session: m2, pane: "w1:p0" });
    expect(r.ok && r.events.map((e) => e.type)).toEqual(["session.ended", "session.created", "session.attached"]);
    expect(s.sessions.get(m1)!.status).toBe("ended");
    expect(exec(s, { cmd: "tell", target: "main", message: "hi" }, COORD)).toMatchObject({
      events: [{ type: "notice.queued", payload: { session: m2, text: "Message from coordinator: hi" } }],
    });
    expect(err(exec(s, { cmd: "tell", target: "001", message: "x" }))).toBe("no live coordinator for thread 001");
  });

  test("thread.new stores maxWorkers", () => {
    const s = stateOf(INIT);
    const r = exec(s, { cmd: "thread.new", title: "X", type: "bug", maxWorkers: 2 });
    expect(r.ok && r.events[0]).toMatchObject({ payload: { maxWorkers: 2 } });
    expect(() => CommandSchema.parse({ cmd: "thread.new", title: "X", type: "bug", maxWorkers: 0 })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/commands/sessions.test.ts`
Expected: FAIL with `Cannot find module '../../src/orchestration/sessions.ts'`.

- [ ] **Step 3: Implement the session helpers**

Create `src/orchestration/sessions.ts`:

```ts
import type { Effect } from "../commands/handler.ts";
import type { Config } from "../config/config.ts";
import type { EventBody, SessionRole } from "../domain/types.ts";
import { isLive, type Session, type State, type Thread } from "../state/projection.ts";

export interface SpawnContext {
  root: string;
  newId: () => string;
}

export function liveSessions(state: State, thread?: string, role?: SessionRole): Session[] {
  return [...state.sessions.values()].filter(
    (s) => isLive(s) && (thread === undefined || s.thread === thread) && (role === undefined || s.role === role),
  );
}

export function workerLimit(t: Thread, config: Config): number {
  return t.maxWorkers ?? config.workers.max_workers;
}

/** Herdr agent names must be unique per Herdr server, so they carry a short hash of the project root. */
export function agentName(root: string, role: SessionRole, thread?: string, ticket?: string): string {
  const h = Bun.hash(root).toString(16).padStart(4, "0").slice(-4);
  if (role === "main") return `agt-${h}-main`;
  if (role === "coordinator") return `agt-${h}-c${thread}`;
  return `agt-${h}-w${thread}-${(ticket ?? "").toLowerCase()}`;
}

export function spawnCoordinator(t: Thread, ctx: SpawnContext): { events: EventBody[]; effects: Effect[] } {
  const session = ctx.newId();
  const name = agentName(ctx.root, "coordinator", t.id);
  return {
    events: [{ type: "session.created", thread: t.id, payload: { session, role: "coordinator", agent: "claude-code", name } }],
    effects: [{ kind: "agent.spawn", session, role: "coordinator", name, thread: t.id, cwd: t.worktree, pane: t.rootPane! }],
  };
}

export function spawnWorker(state: State, t: Thread, ticket: string, ctx: SpawnContext): { events: EventBody[]; effects: Effect[] } {
  const session = ctx.newId();
  const name = agentName(ctx.root, "worker", t.id, ticket);
  const last = liveSessions(state, t.id, "worker")
    .filter((s) => s.pane)
    .at(-1);
  return {
    events: [{ type: "session.created", thread: t.id, payload: { session, role: "worker", agent: "claude-code", name, ticket } }],
    effects: [
      {
        kind: "agent.spawn",
        session,
        role: "worker",
        name,
        thread: t.id,
        ticket,
        cwd: t.worktree,
        splitFrom: last?.pane ?? t.rootPane!,
        direction: last ? "down" : "right",
      },
    ],
  };
}
```

- [ ] **Step 4: Extend the command schema**

In `src/commands/schema.ts`:
- import `SESSION_SIGNALS` from `../domain/types.ts`
- add `const sessionId = z.string().uuid("session must be a UUID");`
- in the `thread.new` object, add `maxWorkers: z.number().int().min(1).max(16).optional(),`
- add to the union:

```ts
  z.object({ cmd: z.literal("worker.spawn"), thread: threadId, ticket: ticketId }),
  z.object({ cmd: z.literal("tell"), target: z.union([threadId, z.literal("main")]), message: text }),
  z.object({ cmd: z.literal("session.signal"), session: sessionId, signal: z.enum(SESSION_SIGNALS) }),
  z.object({ cmd: z.literal("session.attached"), session: sessionId, pane: herdrId }),
  z.object({ cmd: z.literal("session.failed"), session: sessionId, reason: text }),
  z.object({ cmd: z.literal("session.open_main"), session: sessionId, pane: herdrId }),
```

- [ ] **Step 5: Extend the handler**

In `src/commands/handler.ts`:

1. Add the imports: `import { randomUUID } from "node:crypto";`, `import { agentName, liveSessions, spawnWorker, workerLimit } from "../orchestration/sessions.ts";`, and `isLive` from `../state/projection.ts`.
2. Add the three new members (Interfaces above) to `Effect`, and `newId?: () => string;` to `HandlerContext`.
3. Add to `ALLOWED`:

```ts
  "worker.spawn": ["coordinator"],
  tell: ROLES,
  "session.signal": ROLES,
  "session.attached": ["user"],
  "session.failed": ["user"],
  "session.open_main": ["user"],
```

4. Add near the top of the file:

```ts
const SIGNAL_EVENT = {
  started: "session.started",
  active: "session.active",
  idle: "agent.idle",
  compacting: "session.compacting",
  ended: "session.ended",
} as const;
```

5. In `decide()`, directly after the `layout.reconcile` block, add:

```ts
  if (cmd.cmd === "tell") {
    const target =
      cmd.target === "main" ? liveSessions(state, undefined, "main")[0] : liveSessions(state, cmd.target, "coordinator")[0];
    if (!target) reject(cmd.target === "main" ? "no live main manager session" : `no live coordinator for thread ${cmd.target}`);
    return {
      events: [{ type: "notice.queued", thread: target.thread, payload: { session: target.id, text: `Message from ${actor.role}: ${cmd.message}` } }],
    };
  }
  if (cmd.cmd === "session.signal") {
    const s = state.sessions.get(cmd.session) ?? reject(`unknown session ${cmd.session}`);
    if (actor.session && actor.session !== s.id) reject(`actor session ${actor.session} cannot signal ${s.id}`);
    if (!isLive(s)) return { events: [] };
    return { events: [{ type: SIGNAL_EVENT[cmd.signal], thread: s.thread, payload: { session: s.id } }] };
  }
  if (cmd.cmd === "session.attached" || cmd.cmd === "session.failed") {
    const s = state.sessions.get(cmd.session) ?? reject(`unknown session ${cmd.session}`);
    if (!isLive(s)) return { events: [] };
    return cmd.cmd === "session.attached"
      ? { events: [{ type: "session.attached", thread: s.thread, payload: { session: s.id, pane: cmd.pane } }] }
      : { events: [{ type: "session.failed", thread: s.thread, payload: { session: s.id, reason: cmd.reason } }] };
  }
  if (cmd.cmd === "session.open_main") {
    if (state.sessions.has(cmd.session)) reject(`session ${cmd.session} already exists`);
    const stale: EventBody[] = liveSessions(state, undefined, "main").map((s) => ({ type: "session.ended", payload: { session: s.id } }));
    return {
      events: [
        ...stale,
        { type: "session.created", payload: { session: cmd.session, role: "main", agent: "claude-code", name: agentName(ctx.root, "main") } },
        { type: "session.attached", payload: { session: cmd.session, pane: cmd.pane } },
      ],
      result: { session: cmd.session },
    };
  }
```

6. In the thread `switch`, add:

```ts
    case "worker.spawn": {
      if (t.status === "done") reject(`thread ${t.id} is done`);
      if (!t.rootPane) reject(`thread ${t.id} has no Herdr tab; run \`agt start\``);
      const k = findTicket(t, cmd.ticket);
      if (k.status !== "open") reject(`ticket ${k.id} is ${k.status}`);
      const workers = liveSessions(state, t.id, "worker");
      if (t.workerQueue.includes(k.id) || workers.some((s) => s.ticket === k.id)) reject(`ticket ${k.id} already has a worker`);
      if (workers.length >= workerLimit(t, ctx.config ?? DEFAULT_CONFIG)) {
        return { events: [{ type: "worker.queued", thread: t.id, payload: { ticket: k.id } }], result: { queued: true } };
      }
      const spawned = spawnWorker(state, t, k.id, { root: ctx.root, newId: ctx.newId ?? randomUUID });
      const session = (spawned.events[0] as Extract<EventBody, { type: "session.created" }>).payload.session;
      return { ...spawned, result: { session, queued: false } };
    }
```

7. In `newThread`, add `maxWorkers: cmd.maxWorkers,` to the `thread.created` payload. JSON drops it when it is undefined.

- [ ] **Step 6: Verify and commit**

Run: `bun test && bun run typecheck` → PASS.

```bash
git add src/orchestration/sessions.ts src/commands tests/commands/sessions.test.ts
git commit -m "feat: add worker, tell and session commands"
```

---

### Task 4: Reactor

**Files:**
- Create: `src/orchestration/reactor.ts`
- Test: `tests/orchestration/reactor.test.ts`

**Interfaces:**
- Consumes: Task 3 helpers; `Effect`.
- Produces: `interface ReactorContext { root: string; config: Config; newId: () => string }` and `react(state: State, events: StoredEvent[], ctx: ReactorContext): { events: EventBody[]; effects: Effect[] }`. `state` already includes `events`. The rules, in event order:
  1. `thread.tab_opened` → spawn a coordinator (`spawnCoordinator`) when the thread is not done, has a `rootPane`, and has no live coordinator.
  2. `ticket.completed` → notify the coordinator: `Ticket <T> is done: <summary>.`, or `Ticket <T> is done.` without a summary.
  3. `ticket.blocked` → notify the coordinator: `Ticket <T> is blocked: <reason>.`
  4. `thread.status_changed`:
     - `blocked → open` notifies the coordinator: `Thread <id> is unblocked: <reason>.`
     - `→ review` notifies the main session: `Thread <id> (<title>) is ready for review.`
     - `→ done` emits `session.ended` for every live session of the thread.
  5. `session.failed`:
     - for a worker, notify the coordinator: `Worker for <T> failed: <reason>.`
     - for any role, fill the worker slots of the session's thread.
  6. `session.ended` → fill the worker slots of the session's thread.
  7. `notice.queued` / `session.attached` → try delivery to that session.
  8. `agent.idle` → try delivery to that session. If it is a worker whose ticket is `done`, also emit `session.ended` for it, and add `pane.close` when `herdr.close_worker_pane_on_end` is on and the pane is known.
  - **Delivery** happens when the session is live, `idle`, has a pane, and has notices. It produces one `notice.deliver` effect with all notices joined by `\n`. Each session is delivered to at most once per `react` call.
  - **Filling slots** happens when the thread is not done and has a `rootPane`. It spawns the queued tickets in order, while `live workers + spawned in this call < limit`. It skips tickets that are no longer `open` or were already spawned earlier in the same call.
  - A notification only goes to a live target; if there is none, nothing happens.

- [ ] **Step 1: Write the failing tests**

Create `tests/orchestration/reactor.test.ts`:

```ts
import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import type { EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, threadCreated } from "../helpers.ts";

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const W1 = "11111111-1111-4111-8111-111111111111";
const M = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
let n = 0;
const ctx = (config = DEFAULT_CONFIG) => ({ root: "/repo", config, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` });

/** Applies `bodies` to `state` and returns them as stored events, the way the daemon feeds react(). */
function apply(state: State, ...bodies: EventBody[]): StoredEvent[] {
  return bodies.map((b) => {
    const ev = { ...b, seq: state.lastSeq + 1, ts: "t", actor: USER } as StoredEvent;
    applyEvent(state, ev);
    return ev;
  });
}

function base(maxWorkers = 1): State {
  n = 0;
  const s = stateOf(INIT, threadCreated("001", { maxWorkers, title: "Login" }), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
  apply(
    s,
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    { type: "session.created", payload: { session: M, role: "main", agent: "claude-code", name: "m" } },
    { type: "session.attached", payload: { session: M, pane: "w1:p0" } },
  );
  for (const k of ["T1", "T2", "T3"]) apply(s, { type: "ticket.created", thread: "001", payload: { ticket: k, title: k, scope: [k] } });
  return s;
}

test("tab opened spawns exactly one coordinator", () => {
  n = 0;
  const s = stateOf(INIT, threadCreated("001"));
  const evs = apply(s, { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
  const r = react(s, evs, ctx());
  expect(r.events.map((e) => e.type)).toEqual(["session.created"]);
  expect(r.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", role: "coordinator", pane: "w1:p2" })]);
  apply(s, ...r.events);
  expect(react(s, evs, ctx()).events).toEqual([]);
});

test("ticket events notify the coordinator; delivery waits for idle and happens once", () => {
  const s = base();
  const done = apply(s, { type: "ticket.completed", thread: "001", payload: { ticket: "T1", summary: "ok" } });
  const r1 = react(s, done, ctx());
  expect(r1.events).toEqual([{ type: "notice.queued", thread: "001", payload: { session: C, text: "Ticket T1 is done: ok." } }]);
  // coordinator still starting → queued but not delivered
  expect(react(s, apply(s, ...r1.events), ctx()).effects).toEqual([]);
  const blocked = apply(s, { type: "ticket.blocked", thread: "001", payload: { ticket: "T2", reason: "no key" } });
  apply(s, ...react(s, blocked, ctx()).events);
  const idle = apply(s, { type: "agent.idle", thread: "001", payload: { session: C } });
  expect(react(s, idle, ctx()).effects).toEqual([
    { kind: "notice.deliver", session: C, thread: "001", pane: "w1:p2", text: "Ticket T1 is done: ok.\nTicket T2 is blocked: no key.", count: 2 },
  ]);
  const both = [...idle, ...apply(s, { type: "notice.queued", thread: "001", payload: { session: C, text: "x" } })];
  expect(react(s, both, ctx()).effects).toHaveLength(1);
});

test("idle worker with a done ticket ends, closes its pane, and the slot spawns the next queued ticket", () => {
  const s = base(1);
  apply(
    s,
    { type: "session.created", thread: "001", payload: { session: W1, role: "worker", agent: "claude-code", name: "w", ticket: "T1" } },
    { type: "session.attached", thread: "001", payload: { session: W1, pane: "w1:p3" } },
    { type: "worker.queued", thread: "001", payload: { ticket: "T2" } },
    { type: "worker.queued", thread: "001", payload: { ticket: "T3" } },
    { type: "ticket.claimed", thread: "001", payload: { ticket: "T1", assignee: W1 } },
    { type: "ticket.completed", thread: "001", payload: { ticket: "T1" } },
  );
  const r = react(s, apply(s, { type: "agent.idle", thread: "001", payload: { session: W1 } }), ctx());
  expect(r.events).toEqual([{ type: "session.ended", thread: "001", payload: { session: W1 } }]);
  expect(r.effects).toEqual([{ kind: "pane.close", pane: "w1:p3" }]);
  const next = react(s, apply(s, ...r.events), ctx());
  expect(next.events).toEqual([expect.objectContaining({ type: "session.created", payload: expect.objectContaining({ ticket: "T2" }) })]);
  expect(next.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", ticket: "T2", splitFrom: "w1:p2", direction: "right" })]);
});

test("two freed slots in one batch spawn two queued workers, never more", () => {
  const s = base(2);
  const W2 = "22222222-2222-4222-8222-222222222222";
  apply(
    s,
    { type: "session.created", thread: "001", payload: { session: W1, role: "worker", agent: "claude-code", name: "w1", ticket: "T1" } },
    { type: "session.created", thread: "001", payload: { session: W2, role: "worker", agent: "claude-code", name: "w2", ticket: "T2" } },
    { type: "worker.queued", thread: "001", payload: { ticket: "T3" } },
  );
  const ended = apply(
    s,
    { type: "session.ended", thread: "001", payload: { session: W1 } },
    { type: "session.failed", thread: "001", payload: { session: W2, reason: "agent_not_ready" } },
  );
  const r = react(s, ended, ctx());
  expect(r.events.filter((e) => e.type === "session.created")).toHaveLength(1);
  expect(r.events).toContainEqual({ type: "notice.queued", thread: "001", payload: { session: C, text: "Worker for T2 failed: agent_not_ready." } });
});

test("close_worker_pane_on_end: false ends the worker without closing the pane", () => {
  const s = base();
  apply(
    s,
    { type: "session.created", thread: "001", payload: { session: W1, role: "worker", agent: "claude-code", name: "w", ticket: "T1" } },
    { type: "session.attached", thread: "001", payload: { session: W1, pane: "w1:p3" } },
    { type: "ticket.claimed", thread: "001", payload: { ticket: "T1", assignee: W1 } },
    { type: "ticket.completed", thread: "001", payload: { ticket: "T1" } },
  );
  const config = { ...DEFAULT_CONFIG, herdr: { ...DEFAULT_CONFIG.herdr, close_worker_pane_on_end: false } };
  const r = react(s, apply(s, { type: "agent.idle", thread: "001", payload: { session: W1 } }), ctx(config));
  expect(r.effects).toEqual([]);
  expect(r.events.map((e) => e.type)).toEqual(["session.ended"]);
});

test("status changes: unblock notifies coordinator, review notifies main, done ends sessions", () => {
  const s = base();
  expect(react(s, apply(s, { type: "thread.status_changed", thread: "001", payload: { from: "open", to: "blocked" } }), ctx()).events).toEqual([]);
  expect(
    react(s, apply(s, { type: "thread.status_changed", thread: "001", payload: { from: "blocked", to: "open", reason: "dependencies done" } }), ctx()).events,
  ).toEqual([{ type: "notice.queued", thread: "001", payload: { session: C, text: "Thread 001 is unblocked: dependencies done." } }]);
  apply(s, { type: "thread.status_changed", thread: "001", payload: { from: "open", to: "in_progress" } });
  expect(react(s, apply(s, { type: "thread.status_changed", thread: "001", payload: { from: "in_progress", to: "review" } }), ctx()).events).toEqual([
    { type: "notice.queued", payload: { session: M, text: "Thread 001 (Login) is ready for review." } },
  ]);
  expect(react(s, apply(s, { type: "thread.status_changed", thread: "001", payload: { from: "review", to: "done" } }), ctx()).events).toEqual([
    { type: "session.ended", thread: "001", payload: { session: C } },
  ]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/orchestration`
Expected: FAIL with `Cannot find module '../../src/orchestration/reactor.ts'`.

- [ ] **Step 3: Implement**

Create `src/orchestration/reactor.ts`:

```ts
import type { Effect } from "../commands/handler.ts";
import type { Config } from "../config/config.ts";
import type { EventBody, StoredEvent } from "../domain/types.ts";
import { isLive, type Session, type State } from "../state/projection.ts";
import { liveSessions, spawnCoordinator, spawnWorker, workerLimit } from "./sessions.ts";

export interface ReactorContext {
  root: string;
  config: Config;
  newId: () => string;
}

/** Pure follow-ups for freshly applied events: spawns, notifications, deliveries, worker teardown. */
export function react(state: State, events: StoredEvent[], ctx: ReactorContext): { events: EventBody[]; effects: Effect[] } {
  const out: EventBody[] = [];
  const effects: Effect[] = [];
  const delivered = new Set<string>();
  const spawnedPerThread = new Map<string, number>();
  const spawnedTickets = new Set<string>();

  const take = (r: { events: EventBody[]; effects: Effect[] }) => {
    out.push(...r.events);
    effects.push(...r.effects);
  };
  const notify = (target: Session | undefined, text: string) => {
    if (target) out.push({ type: "notice.queued", ...(target.thread ? { thread: target.thread } : {}), payload: { session: target.id, text } });
  };
  const coordinatorOf = (thread: string | undefined) => (thread ? liveSessions(state, thread, "coordinator")[0] : undefined);
  const deliver = (s: Session | undefined) => {
    if (!s || delivered.has(s.id) || !isLive(s) || s.status !== "idle" || !s.pane || s.notices.length === 0) return;
    delivered.add(s.id);
    effects.push({ kind: "notice.deliver", session: s.id, thread: s.thread, pane: s.pane, text: s.notices.join("\n"), count: s.notices.length });
  };
  const fillWorkers = (threadId: string | undefined) => {
    const t = threadId ? state.threads.get(threadId) : undefined;
    if (!t || t.status === "done" || !t.rootPane) return;
    let free = workerLimit(t, ctx.config) - liveSessions(state, t.id, "worker").length - (spawnedPerThread.get(t.id) ?? 0);
    for (const ticket of t.workerQueue) {
      if (free <= 0) break;
      if (spawnedTickets.has(`${t.id}/${ticket}`)) continue; // already spawned earlier in this call; state isn't updated yet
      if (t.tickets.find((k) => k.id === ticket)?.status !== "open") continue;
      spawnedTickets.add(`${t.id}/${ticket}`);
      take(spawnWorker(state, t, ticket, ctx));
      spawnedPerThread.set(t.id, (spawnedPerThread.get(t.id) ?? 0) + 1);
      free--;
    }
  };

  for (const ev of events) {
    switch (ev.type) {
      case "thread.tab_opened": {
        const t = state.threads.get(ev.thread);
        if (t && t.status !== "done" && t.rootPane && !coordinatorOf(t.id)) take(spawnCoordinator(t, ctx));
        break;
      }
      case "ticket.completed":
        notify(coordinatorOf(ev.thread), `Ticket ${ev.payload.ticket} is done${ev.payload.summary ? `: ${ev.payload.summary}` : ""}.`);
        break;
      case "ticket.blocked":
        notify(coordinatorOf(ev.thread), `Ticket ${ev.payload.ticket} is blocked: ${ev.payload.reason}.`);
        break;
      case "thread.status_changed": {
        const t = state.threads.get(ev.thread);
        if (ev.payload.from === "blocked" && ev.payload.to === "open") {
          notify(coordinatorOf(ev.thread), `Thread ${ev.thread} is unblocked: ${ev.payload.reason ?? "no reason given"}.`);
        } else if (ev.payload.to === "review") {
          notify(liveSessions(state, undefined, "main")[0], `Thread ${ev.thread} (${t?.title ?? ""}) is ready for review.`);
        } else if (ev.payload.to === "done") {
          for (const s of liveSessions(state, ev.thread)) out.push({ type: "session.ended", thread: ev.thread, payload: { session: s.id } });
        }
        break;
      }
      case "session.failed": {
        const s = state.sessions.get(ev.payload.session);
        if (s?.role === "worker") notify(coordinatorOf(s.thread), `Worker for ${s.ticket} failed: ${ev.payload.reason}.`);
        fillWorkers(s?.thread);
        break;
      }
      case "session.ended":
        fillWorkers(state.sessions.get(ev.payload.session)?.thread);
        break;
      case "notice.queued":
      case "session.attached":
        deliver(state.sessions.get(ev.payload.session));
        break;
      case "agent.idle": {
        const s = state.sessions.get(ev.payload.session);
        deliver(s);
        if (s && isLive(s) && s.role === "worker" && s.thread) {
          const ticket = state.threads.get(s.thread)?.tickets.find((k) => k.id === s.ticket);
          if (ticket?.status === "done") {
            out.push({ type: "session.ended", thread: s.thread, payload: { session: s.id } });
            if (ctx.config.herdr.close_worker_pane_on_end && s.pane) effects.push({ kind: "pane.close", pane: s.pane });
          }
        }
        break;
      }
    }
  }
  return { events: out, effects };
}
```

- [ ] **Step 4: Verify and commit**

Run: `bun test tests/orchestration && bun test && bun run typecheck` → PASS.

```bash
git add src/orchestration/reactor.ts tests/orchestration
git commit -m "feat: add the reactor for spawns, notifications and worker teardown"
```

---

### Task 5: Claude adapter and role prompts

**Files:**
- Create: `src/agents/claude.ts`, `src/agents/prompts.ts`
- Test: `tests/agents/claude.test.ts`

**Interfaces:**
- Consumes: `Config`, `SessionRole`, `SessionSignal`, `shellQuote`, `paths`.
- Produces:
  - `AGT_BIN: string`: the absolute path of `bin/agt`, resolved from this module's URL.
  - `hookCommand(signal: SessionSignal): string`, which builds `'<bun>' '<AGT_BIN>' event <signal>`.
  - `hookSettings(): { hooks: Record<string, { hooks: { type: "command"; command: string }[] }[]> }` with SessionStart, UserPromptSubmit, Stop, PreCompact and SessionEnd.
  - `allowedTools(role: SessionRole, config: Config): string[]`
  - `claudeArgs(o: { session: string; role: SessionRole; systemPrompt: string; config: Config }): string[]`
  - `agentEnv(o: { root: string; role: SessionRole; session: string; thread?: string; ticket?: string }): Record<string, string>`
  - `systemPrompt(o: { root: string; role: SessionRole; thread?: { id: string; title: string; slug: string; worktree: string }; ticket?: string }): string`
  - `bootstrapPrompt(o: same as systemPrompt): string`. The coordinator gets `Start coordinating thread <id>. Read <dir>/sub.thread.md and <dir>/board.md now.`, the worker gets `Start ticket <T> of thread <id> now.`, and the main manager gets `""`.

- [ ] **Step 1: Write the failing tests**

Create `tests/agents/claude.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGT_BIN, agentEnv, allowedTools, claudeArgs, hookCommand, hookSettings } from "../../src/agents/claude.ts";
import { bootstrapPrompt, systemPrompt } from "../../src/agents/prompts.ts";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { shellQuote } from "../../src/herdr/bridge.ts";

const T = { id: "002", title: "Fix race", slug: "fix-race", worktree: "/repo/.worktrees/002-fix-race" };
const DIR = "/repo/.agentthread/threads/002-fix-race";

describe("claude adapter", () => {
  test("AGT_BIN points at bin/agt", () => {
    expect(AGT_BIN.endsWith(join("bin", "agt"))).toBe(true);
    expect(existsSync(AGT_BIN)).toBe(true);
  });

  test("hooks call agt event with the mapped signal", () => {
    expect(hookCommand("idle")).toBe(`${shellQuote(process.execPath)} ${shellQuote(AGT_BIN)} event idle`);
    const h = hookSettings().hooks;
    expect(Object.keys(h)).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "PreCompact", "SessionEnd"]);
    expect(h.Stop).toEqual([{ hooks: [{ type: "command", command: hookCommand("idle") }] }]);
    expect(h.SessionEnd![0]!.hooks[0]!.command.endsWith(" event ended")).toBe(true);
  });

  test("allowed tools per role, plus configured extras", () => {
    expect(allowedTools("main", DEFAULT_CONFIG)).toEqual(["Bash(agt *)"]);
    expect(allowedTools("worker", DEFAULT_CONFIG)).toEqual(["Bash(agt *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)"]);
    const cfg = { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents, claude: { ...DEFAULT_CONFIG.agents.claude, extra_allowed_tools: ["Bash(bun test*)"] } } };
    expect(allowedTools("coordinator", cfg)).toEqual([
      "Bash(agt *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git add *)", "Bash(git commit *)", "Bash(bun test*)",
    ]);
  });

  test("claude args order and optional model", () => {
    const args = claudeArgs({ session: "s-1", role: "worker", systemPrompt: "SP", config: DEFAULT_CONFIG });
    expect(args).toEqual([
      "--session-id", "s-1",
      "--permission-mode", "acceptEdits",
      "--allowed-tools", "Bash(agt *),Bash(git status*),Bash(git diff*),Bash(git log*)",
      "--settings", JSON.stringify(hookSettings()),
      "--append-system-prompt", "SP",
    ]);
    const withModel = { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents, claude: { ...DEFAULT_CONFIG.agents.claude, model: "opus" } } };
    expect(claudeArgs({ session: "s", role: "main", systemPrompt: "x", config: withModel }).slice(8, 10)).toEqual(["--model", "opus"]);
  });

  test("agent env puts agt on PATH and identifies the session", () => {
    const env = agentEnv({ root: "/repo", role: "worker", session: "s-1", thread: "002", ticket: "T3" });
    expect(env).toMatchObject({ AGT_ROOT: "/repo", AGT_ROLE: "worker", AGT_SESSION: "s-1", AGT_AGENT: "claude-code", AGT_THREAD: "002", AGT_TICKET: "T3" });
    expect(env.PATH!.startsWith(`${dirname(AGT_BIN)}:`)).toBe(true);
    expect(agentEnv({ root: "/repo", role: "main", session: "m" })).not.toHaveProperty("AGT_THREAD");
  });
});

describe("prompts", () => {
  test("coordinator prompt names its thread, files and commands", () => {
    const p = systemPrompt({ root: "/repo", role: "coordinator", thread: T });
    for (const s of [`thread 002 ("Fix race")`, T.worktree, `${DIR}/sub.thread.md`, `${DIR}/board.md`, "agt ticket add 002", "agt worker spawn 002 --ticket", "git commit", "agt thread status 002 review"]) {
      expect(p).toContain(s);
    }
    expect(bootstrapPrompt({ root: "/repo", role: "coordinator", thread: T })).toBe(
      `Start coordinating thread 002. Read ${DIR}/sub.thread.md and ${DIR}/board.md now.`,
    );
  });

  test("worker prompt is scoped to its ticket and forbids commits", () => {
    const p = systemPrompt({ root: "/repo", role: "worker", thread: T, ticket: "T3" });
    for (const s of ["ticket T3 of thread 002", "agt ticket claim 002/T3", "agt ticket done 002/T3", "agt ticket block 002/T3", "Do not commit"]) {
      expect(p).toContain(s);
    }
    expect(bootstrapPrompt({ root: "/repo", role: "worker", thread: T, ticket: "T3" })).toBe("Start ticket T3 of thread 002 now.");
  });

  test("main prompt requires user confirmation before creating threads", () => {
    const p = systemPrompt({ root: "/repo", role: "main" });
    for (const s of ["/repo/.agentthread/main.thread.md", "Only after the user confirms", "agt thread new", "agt tell"]) expect(p).toContain(s);
    expect(bootstrapPrompt({ root: "/repo", role: "main" })).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/agents`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement the adapter**

Create `src/agents/claude.ts`:

```ts
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config/config.ts";
import type { SessionRole, SessionSignal } from "../domain/types.ts";
import { shellQuote } from "../herdr/bridge.ts";

export const AGT_BIN = fileURLToPath(new URL("../../bin/agt", import.meta.url));

export function hookCommand(signal: SessionSignal): string {
  return `${shellQuote(process.execPath)} ${shellQuote(AGT_BIN)} event ${signal}`;
}

export function hookSettings() {
  const on = (signal: SessionSignal) => [{ hooks: [{ type: "command" as const, command: hookCommand(signal) }] }];
  return {
    hooks: {
      SessionStart: on("started"),
      UserPromptSubmit: on("active"),
      Stop: on("idle"),
      PreCompact: on("compacting"),
      SessionEnd: on("ended"),
    },
  };
}

const READ_TOOLS = ["Bash(agt *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)"];

export function allowedTools(role: SessionRole, config: Config): string[] {
  const base = role === "main" ? ["Bash(agt *)"] : role === "coordinator" ? [...READ_TOOLS, "Bash(git add *)", "Bash(git commit *)"] : READ_TOOLS;
  return [...base, ...config.agents.claude.extra_allowed_tools];
}

export function claudeArgs(o: { session: string; role: SessionRole; systemPrompt: string; config: Config }): string[] {
  const claude = o.config.agents.claude;
  return [
    "--session-id", o.session,
    "--permission-mode", claude.permission_mode,
    "--allowed-tools", allowedTools(o.role, o.config).join(","),
    "--settings", JSON.stringify(hookSettings()),
    ...(claude.model ? ["--model", claude.model] : []),
    "--append-system-prompt", o.systemPrompt,
  ];
}

export function agentEnv(o: { root: string; role: SessionRole; session: string; thread?: string; ticket?: string }): Record<string, string> {
  return {
    AGT_ROOT: o.root,
    AGT_ROLE: o.role,
    AGT_SESSION: o.session,
    AGT_AGENT: "claude-code",
    ...(o.thread ? { AGT_THREAD: o.thread } : {}),
    ...(o.ticket ? { AGT_TICKET: o.ticket } : {}),
    PATH: `${dirname(AGT_BIN)}:${process.env.PATH ?? ""}`,
  };
}
```

- [ ] **Step 4: Implement the prompts**

Create `src/agents/prompts.ts`:

```ts
import type { SessionRole } from "../domain/types.ts";
import { paths } from "../project/paths.ts";

interface PromptInput {
  root: string;
  role: SessionRole;
  thread?: { id: string; title: string; slug: string; worktree: string };
  ticket?: string;
}

const threadDir = (o: PromptInput) => paths(o.root).threadDir(o.thread!);

export function systemPrompt(o: PromptInput): string {
  if (o.role === "main") {
    return [
      `You are the AgentThread main manager for the project at ${o.root}. You talk with the user.`,
      `The state of every thread is in ${paths(o.root).mainThread}; read it whenever you need the big picture.`,
      "When the user describes a feature or a bug, draft a short title, a goal and acceptance criteria and show them to the user.",
      'Only after the user confirms, create the thread with: agt thread new "<title>" --type feature|bug|chore --goal "<goal>" --criteria "<criterion>" (repeat --criteria).',
      'To pass a message to a thread\'s coordinator use: agt tell <thread-id> "<message>".',
      "Do not edit project source files yourself; implementation happens in the thread worktrees.",
      "You will receive short notifications (for example a thread ready for review) as prompts; relay them to the user.",
    ].join("\n");
  }
  const t = o.thread!;
  const dir = threadDir(o);
  if (o.role === "coordinator") {
    return [
      `You are the coordinator of AgentThread thread ${t.id} ("${t.title}"). Your working directory is the thread's git worktree ${t.worktree}.`,
      `The thread state is in ${dir}/sub.thread.md and ${dir}/board.md. Read them first, and re-read them whenever you get a notification.`,
      "Rules:",
      `- When you start, run: agt thread status ${t.id} in_progress. When every acceptance criterion is met, run: agt thread status ${t.id} review.`,
      `- Split the work into tickets whose scopes do not overlap: agt ticket add ${t.id} "<title>" --scope <path> [--scope <path>].`,
      `- Start one worker per ticket that can run in parallel: agt worker spawn ${t.id} --ticket <T>. The daemon limits how many run at once and queues the rest.`,
      "- Workers only edit files. You are the only one who commits: when a ticket is done, review the change, then git add and git commit in the worktree.",
      `- Record important decisions with agt decide ${t.id} "<decision>" and progress with agt log ${t.id} "<message>".`,
      `- If a ticket is blocked, fix the cause or reopen it with agt ticket reopen ${t.id}/<T>.`,
      "- You receive short notifications (ticket done or blocked, messages) as prompts. Act on them, then stop and wait.",
    ].join("\n");
  }
  return [
    `You are an AgentThread worker for ticket ${o.ticket} of thread ${t.id} ("${t.title}").`,
    `Work only inside ${t.worktree}, and only on the files in your ticket's scope (see ${dir}/board.md).`,
    "Steps:",
    `1. agt ticket claim ${t.id}/${o.ticket}`,
    "2. Implement the ticket and run the relevant tests.",
    `3. agt ticket done ${t.id}/${o.ticket} --summary "<one line>" — or, if you cannot finish, agt ticket block ${t.id}/${o.ticket} --reason "<why>".`,
    "Do not commit; the coordinator commits. Do not work on other tickets.",
  ].join("\n");
}

export function bootstrapPrompt(o: PromptInput): string {
  if (o.role === "main") return "";
  const dir = threadDir(o);
  if (o.role === "coordinator") return `Start coordinating thread ${o.thread!.id}. Read ${dir}/sub.thread.md and ${dir}/board.md now.`;
  return `Start ticket ${o.ticket} of thread ${o.thread!.id} now.`;
}
```

- [ ] **Step 5: Verify and commit**

Run: `bun test tests/agents && bun run typecheck` → PASS.

```bash
git add src/agents tests/agents
git commit -m "feat: add Claude Code adapter and role prompts"
```

---

### Task 6: Herdr agent commands and fakes

**Files:**
- Modify: `src/herdr/bridge.ts`, `tests/fixtures/fake-herdr.ts`, `tests/helpers.ts`
- Create: `tests/fixtures/fake-claude.ts` (executable)
- Test: `tests/herdr/bridge.test.ts` (append)

**Interfaces:**
- Consumes: Plan 2 `HerdrCli.call`.
- Produces:
  - `HerdrBridge` gains:
    - `agentStart(o: { name: string; kind: "claude" | "opencode"; pane: string; args: string[]; timeoutMs?: number }): void`. Its argv is `agent start <name> --kind <kind> --pane <pane> --timeout <timeoutMs> -- <args...>`, where `timeoutMs` defaults to 60000. Our own watchdog for this call is `timeoutMs + 10000`.
    - `agentPrompt(target: string, text: string): void` → `agent prompt <target> <text>`
    - `closePane(pane: string): void` → `pane close <pane>`
  - Fake herdr:
    - `agent start` fails with `pane_not_found` if the pane is unknown, and otherwise records the agent name in a new `agents: string[]` state field.
    - `agent prompt` always succeeds.
    - `pane close` removes the pane, or fails with `pane_not_found`.
  - Fake claude: appends `{ argv, env: { AGT_* } }` as one JSON line to `$FAKE_CLAUDE_LOG`, then exits with `$FAKE_CLAUDE_EXIT` (default 0).
  - Helpers:
    - `FAKE_CLAUDE` (path)
    - `FakeHerdrState.agents?: string[]`
    - `waitFor<T>(fn: () => Maybe<T> | Promise<Maybe<T>>, timeoutMs = 5000): Promise<T>`, which awaits `fn` every 50ms and throws `waitFor timed out` on timeout.

- [ ] **Step 1: Write the failing tests**

Append to `tests/herdr/bridge.test.ts`:

```ts
describe("agent commands", () => {
  test("argv for agent start / prompt and pane close", () => {
    const calls: { args: string[]; timeout: number }[] = [];
    const runner: Runner = (_bin, args, _env, timeoutMs) => {
      calls.push({ args, timeout: timeoutMs });
      return { exitCode: 0, stdout: '{"result":{"type":"ok"}}', stderr: "" };
    };
    const h = new HerdrCli({ bin: "herdr", runner });
    h.agentStart({ name: "agt-ab12-c001", kind: "claude", pane: "w1:p2", args: ["--session-id", "s"] });
    h.agentStart({ name: "n", kind: "claude", pane: "w1:p3", args: [], timeoutMs: 5000 });
    h.agentPrompt("w1:p2", "Ticket T1 is done.");
    h.closePane("w1:p3");
    expect(calls).toEqual([
      { args: ["agent", "start", "agt-ab12-c001", "--kind", "claude", "--pane", "w1:p2", "--timeout", "60000", "--", "--session-id", "s"], timeout: 70000 },
      { args: ["agent", "start", "n", "--kind", "claude", "--pane", "w1:p3", "--timeout", "5000", "--"], timeout: 15000 },
      { args: ["agent", "prompt", "w1:p2", "Ticket T1 is done."], timeout: 10000 },
      { args: ["pane", "close", "w1:p3"], timeout: 10000 },
    ]);
  });

  test("fake herdr: agent start needs a known pane; pane close removes it", () => {
    const fake = fakeHerdrState({ panes: ["w1:p2"] });
    const h = new HerdrCli({ bin: FAKE_HERDR, env: { ...process.env, FAKE_HERDR_STATE: fake.file } });
    h.agentStart({ name: "a", kind: "claude", pane: "w1:p2", args: ["x"] });
    expect(() => h.agentStart({ name: "b", kind: "claude", pane: "w1:p9", args: [] })).toThrow(/pane w1:p9 not found/);
    h.closePane("w1:p2");
    expect(fake.read().panes).toEqual([]);
    expect(fake.read().agents).toEqual(["a"]);
  });
});
```

(Add `Runner` to the bridge import if needed; `FAKE_HERDR`/`fakeHerdrState` are already imported in this file.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/herdr`
Expected: FAIL. `agentStart` is not a function.

- [ ] **Step 3: Implement the bridge methods**

In `src/herdr/bridge.ts`:
- add to `HerdrBridge`:

```ts
  agentStart(o: { name: string; kind: "claude" | "opencode"; pane: string; args: string[]; timeoutMs?: number }): void;
  agentPrompt(target: string, text: string): void;
  closePane(pane: string): void;
```

- give the private `call` an optional second parameter: `private call(args: string[], timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS): unknown`. It passes `timeoutMs` to the runner, in place of whatever it passes today. Keep the existing timeout error message, which uses this value.
- add the methods to `HerdrCli`:

```ts
  agentStart(o: { name: string; kind: "claude" | "opencode"; pane: string; args: string[]; timeoutMs?: number }): void {
    const herdrTimeout = o.timeoutMs ?? 60_000;
    this.call(
      ["agent", "start", o.name, "--kind", o.kind, "--pane", o.pane, "--timeout", String(herdrTimeout), "--", ...o.args],
      herdrTimeout + 10_000,
    );
  }

  agentPrompt(target: string, text: string): void {
    this.call(["agent", "prompt", target, text]);
  }

  closePane(pane: string): void {
    this.call(["pane", "close", pane]);
  }
```

- [ ] **Step 4: Extend the fakes and helpers**

In `tests/fixtures/fake-herdr.ts`:
- add `agents?: string[];` to `FakeState`
- add these branches before the final `ok({ type: "ok" });`:

```ts
if (group === "agent" && sub === "start") {
  const pane = args[args.indexOf("--pane") + 1] ?? "";
  if (!state.panes.includes(pane)) fail("pane_not_found", `pane ${pane} not found`);
  state.agents = [...(state.agents ?? []), target ?? ""];
  ok({ type: "agent_started", agent: { name: target, pane_id: pane } });
}
if (group === "pane" && sub === "close") {
  if (!state.panes.includes(target ?? "")) fail("pane_not_found", `pane ${target} not found`);
  state.panes = state.panes.filter((p) => p !== target);
  ok({ type: "ok" });
}
```

Create `tests/fixtures/fake-claude.ts`, then `chmod +x tests/fixtures/fake-claude.ts`:

```ts
#!/usr/bin/env bun
// Test double for the claude CLI: records argv and AGT_* env as one JSON line in $FAKE_CLAUDE_LOG.
import { appendFileSync } from "node:fs";

const log = process.env.FAKE_CLAUDE_LOG;
if (log) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("AGT_")));
  appendFileSync(log, `${JSON.stringify({ argv: process.argv.slice(2), env })}\n`);
}
process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? "0"));
```

In `tests/helpers.ts`:
- add `agents?: string[];` to `FakeHerdrState`
- add:

```ts
export const FAKE_CLAUDE = join(import.meta.dir, "fixtures", "fake-claude.ts");

type Maybe<T> = T | undefined | false | null;

/** Polls `fn` (sync or async) until it returns a truthy value. */
export async function waitFor<T>(fn: () => Maybe<T> | Promise<Maybe<T>>, timeoutMs = 5000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(50);
  }
  throw new Error("waitFor timed out");
}
```

- [ ] **Step 5: Verify and commit**

Run: `bun test tests/herdr && bun run typecheck` → PASS.

```bash
git add src/herdr/bridge.ts tests/fixtures tests/helpers.ts tests/herdr/bridge.test.ts
git commit -m "feat: add Herdr agent start/prompt and pane close"
```

---

### Task 7: Daemon: spawner, effects and reactor loop

**Files:**
- Create: `src/agents/spawn-job.ts`
- Modify: `src/daemon/effects.ts`, `src/daemon/server.ts`, `src/cli/main.ts` (hidden `__spawn` subcommand only)
- Test: `tests/agents/spawn-job.test.ts`, `tests/daemon/agents.test.ts`

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces:
  - In `spawn-job.ts`:
    - `interface SpawnJob { root: string; herdrBin: string; herdrSocket?: string; session: string; name: string; kind: "claude"; pane?: string; split?: { pane: string; direction: "right" | "down"; cwd: string; env: Record<string, string> }; args: string[]; bootstrap: string }`
    - `encodeJob(job): string` (base64 JSON) and `decodeJob(s): SpawnJob`
    - `runSpawnJob(job, deps: { herdr: HerdrBridge; report: (command: object) => Promise<void> }): Promise<void>`. It splits a pane if needed, runs `agentStart`, and runs `agentPrompt(name, bootstrap)` unless the bootstrap is empty. Then it reports `session.attached`. On any error it closes the pane it created (best effort) and reports `session.failed` with the error message.
    - `launchSpawnJob(job, opts: { logFile: string }): void`. It spawns `process.execPath AGT_BIN __spawn <encoded>` with stdout and stderr appended to `logFile`, then calls `unref()`.
  - `createEffectRunner` opts gain:
    - `config: Config`
    - `thread: (id: string) => Thread | undefined`
    - `launch?: (job: SpawnJob) => void` (default `launchSpawnJob` with `paths(root).daemonLog`)

    It handles the new effects:
    - `agent.spawn`: with no layout → `[session.failed "no Herdr layout registered"]`. Otherwise it builds the job (role prompt, `claudeArgs`, bootstrap; for workers `split` with `agentEnv`) and launches it → `[]`. If launching throws → `[session.failed <message>]`.
    - `notice.deliver`: `bridge.agentPrompt(pane, text)` → `[notice.delivered]`. A failure is logged and returns `[]`, so the notices stay queued.
    - `pane.close`: `bridge.closePane(pane)`. A failure is logged. Always returns `[]`.
  - Daemon:
    - Refuses to start if any `config.agents.{main_manager,default_coordinator,default_worker}` is not `claude-code`, with `agents.<key>: <value> is not supported yet`.
    - After every command it runs `react` in a loop of at most 10 rounds over the freshly stored events (`newId = randomUUID`), running effects and appending results.
    - It renders with `writeAll(root, state, config)`.
    - `startDaemon` opts gain `launch?: (job: SpawnJob) => void`, so tests can intercept spawns.
  - CLI: `agt __spawn <encoded>` decodes the job and runs `runSpawnJob` with `HerdrCli({ bin, env: { ...process.env, HERDR_SOCKET_PATH? }, timeoutMs: 90_000 })`. It reports to the daemon socket as actor `{ role: "user" }` and exits 0.

- [ ] **Step 1: Write the failing tests**

Create `tests/agents/spawn-job.test.ts`:

```ts
import { expect, test } from "bun:test";
import { decodeJob, encodeJob, runSpawnJob, type SpawnJob } from "../../src/agents/spawn-job.ts";
import type { HerdrBridge } from "../../src/herdr/bridge.ts";

const JOB: SpawnJob = {
  root: "/repo", herdrBin: "herdr", session: "s-1", name: "agt-ab12-w001-t1", kind: "claude",
  split: { pane: "w1:p2", direction: "right", cwd: "/wt", env: { AGT_SESSION: "s-1" } }, args: ["--session-id", "s-1"], bootstrap: "Start ticket T1 of thread 001 now.",
};

function bridge(fail?: "start") {
  const calls: string[] = [];
  const b = {
    splitPane: (o: { pane: string }) => (calls.push(`split ${o.pane}`), "w1:p3"),
    agentStart: (o: { name: string; pane: string }) => {
      calls.push(`start ${o.name} ${o.pane}`);
      if (fail === "start") throw new Error("herdr agent start: agent_not_ready");
    },
    agentPrompt: (t: string, text: string) => void calls.push(`prompt ${t} ${text}`),
    closePane: (p: string) => void calls.push(`close ${p}`),
  } as unknown as HerdrBridge;
  return { b, calls };
}

test("encode/decode round-trips", () => {
  expect(decodeJob(encodeJob(JOB))).toEqual(JOB);
});

test("success: split, start, bootstrap, report attached", async () => {
  const { b, calls } = bridge();
  const reports: object[] = [];
  await runSpawnJob(JOB, { herdr: b, report: async (c) => void reports.push(c) });
  expect(calls).toEqual(["split w1:p2", "start agt-ab12-w001-t1 w1:p3", "prompt agt-ab12-w001-t1 Start ticket T1 of thread 001 now."]);
  expect(reports).toEqual([{ cmd: "session.attached", session: "s-1", pane: "w1:p3" }]);
});

test("failure closes the pane it split and reports failed", async () => {
  const { b, calls } = bridge("start");
  const reports: object[] = [];
  await runSpawnJob(JOB, { herdr: b, report: async (c) => void reports.push(c) });
  expect(calls.at(-1)).toBe("close w1:p3");
  expect(reports).toEqual([{ cmd: "session.failed", session: "s-1", reason: "herdr agent start: agent_not_ready" }]);
});

test("existing pane is never closed on failure; empty bootstrap sends no prompt", async () => {
  const { b, calls } = bridge("start");
  await runSpawnJob({ ...JOB, split: undefined, pane: "w1:p2", bootstrap: "" }, { herdr: b, report: async () => {} });
  expect(calls).toEqual(["start agt-ab12-w001-t1 w1:p2"]);
});
```

Create `tests/daemon/agents.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpawnJob } from "../../src/agents/spawn-job.ts";
import { request } from "../../src/daemon/client.ts";
import { startDaemon, type Daemon } from "../../src/daemon/server.ts";
import type { Actor, StoredEvent } from "../../src/domain/types.ts";
import { initProject } from "../../src/project/init.ts";
import { paths } from "../../src/project/paths.ts";
import { FAKE_HERDR, fakeHerdrState, isolatedConfigHome, tempRepo, waitFor } from "../helpers.ts";

let root: string;
let daemon: Daemon;
let fake: ReturnType<typeof fakeHerdrState>;
const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, FAKE_HERDR_STATE: process.env.FAKE_HERDR_STATE };

beforeAll(() => {
  process.env.XDG_CONFIG_HOME = isolatedConfigHome();
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});
afterEach(async () => {
  await daemon.stop();
});

async function boot(opts: { launch?: (job: SpawnJob) => void; seed?: Parameters<typeof fakeHerdrState>[0] } = {}) {
  root = tempRepo();
  initProject(root, "demo");
  fake = fakeHerdrState(opts.seed);
  process.env.FAKE_HERDR_STATE = fake.file;
  daemon = await startDaemon(root, { log: () => {}, ...(opts.launch ? { launch: opts.launch } : {}) });
  await cmd({ cmd: "layout.register", workspace: "w1", mainTab: "w1:t0", managerPane: "w1:p0", loggerPane: "w1:p00", herdrBin: FAKE_HERDR });
}

const cmd = (command: object, actor: Actor = { role: "user" }) => request(paths(root).socket, { op: "command", command, actor });
const events = async () => {
  const r = await request(paths(root).socket, { op: "events.since", seq: 0 });
  return r.ok ? (r.result as StoredEvent[]) : [];
};
const sessionOf = async (role: string, ticket?: string) =>
  (await events()).find((e) => e.type === "session.created" && e.payload.role === role && (ticket === undefined || e.payload.ticket === ticket))
    ?.payload as { session: string } | undefined;
const coord: Actor = { role: "coordinator", thread: "001" };

test("a new thread gets a coordinator that is started through the spawner child", async () => {
  await boot();
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  await waitFor(async () => (await events()).some((e) => e.type === "session.attached"), 10_000);
  const start = fake.read().calls.find((c) => c[0] === "agent" && c[1] === "start")!;
  expect(start.slice(0, 9)).toEqual(["agent", "start", expect.stringMatching(/^agt-[0-9a-f]{4}-c001$/), "--kind", "claude", "--pane", "w1:p1", "--timeout", "60000"]);
  expect(start).toContain("--session-id");
  expect(start).toContain("acceptEdits");
  expect(fake.read().calls.some((c) => c[0] === "agent" && c[1] === "prompt" && c[3]!.startsWith("Start coordinating thread 001."))).toBe(true);
});

test("worker capacity: queue, finish, next worker spawns; coordinator gets notified when idle", async () => {
  const jobs: SpawnJob[] = [];
  await boot({ launch: (j) => void jobs.push(j) });
  await cmd({ cmd: "thread.new", title: "X", type: "bug", maxWorkers: 1 });
  const c = (await sessionOf("coordinator"))!.session;
  await cmd({ cmd: "session.attached", session: c, pane: "w1:p1" });
  for (const t of ["A", "B"]) await cmd({ cmd: "ticket.add", thread: "001", title: t, scope: [t] }, coord);
  expect(await cmd({ cmd: "worker.spawn", thread: "001", ticket: "T1" }, coord)).toMatchObject({ ok: true, result: { queued: false } });
  expect(await cmd({ cmd: "worker.spawn", thread: "001", ticket: "T2" }, coord)).toMatchObject({ ok: true, result: { queued: true } });
  const w1 = (await sessionOf("worker", "T1"))!.session;
  expect(jobs.at(-1)).toMatchObject({ name: expect.stringMatching(/-w001-t1$/), split: { pane: "w1:p1", direction: "right", env: expect.objectContaining({ AGT_SESSION: w1, AGT_TICKET: "T1" }) } });
  // attach the worker pane in the fake so pane.close can find it
  const s = fake.read();
  writeFileSync(fake.file, JSON.stringify({ ...s, panes: [...s.panes, "w1:p7"] }));
  await cmd({ cmd: "session.attached", session: w1, pane: "w1:p7" });
  const worker: Actor = { role: "worker", thread: "001", session: w1, ticket: "T1" };
  await cmd({ cmd: "ticket.claim", thread: "001", ticket: "T1" }, worker);
  await cmd({ cmd: "ticket.done", thread: "001", ticket: "T1", summary: "ok" }, worker);
  await cmd({ cmd: "session.signal", session: w1, signal: "idle" }, worker);
  expect(fake.read().calls.some((c) => c.join(" ") === "pane close w1:p7")).toBe(true);
  expect(await sessionOf("worker", "T2")).toBeDefined();
  expect(jobs.filter((j) => j.split)).toHaveLength(2);
  // coordinator idle → one delivery with the queued notice
  await cmd({ cmd: "session.signal", session: c, signal: "idle" });
  expect(fake.read().calls.filter((x) => x[0] === "agent" && x[1] === "prompt" && x[2] === "w1:p1").map((x) => x[3])).toEqual(["Ticket T1 is done: ok."]);
  expect((await events()).at(-1)!.type).toBe("notice.delivered");
});

test("spawn failure: session failed, coordinator notified, slot freed", async () => {
  await boot();
  await cmd({ cmd: "thread.new", title: "X", type: "bug", maxWorkers: 1 });
  await waitFor(async () => (await events()).some((e) => e.type === "session.attached"), 10_000);
  for (const t of ["A", "B"]) await cmd({ cmd: "ticket.add", thread: "001", title: t, scope: [t] }, coord);
  // make every later `agent start` fail in the fake
  const s = fake.read();
  writeFileSync(fake.file, JSON.stringify({ ...s, fail: ["agent start"] }));
  await cmd({ cmd: "worker.spawn", thread: "001", ticket: "T1" }, coord);
  await cmd({ cmd: "worker.spawn", thread: "001", ticket: "T2" }, coord);
  await waitFor(async () => (await events()).filter((e) => e.type === "session.failed").length >= 2, 10_000);
  const all = await events();
  expect(all.some((e) => e.type === "notice.queued" && (e.payload as { text: string }).text.startsWith("Worker for T1 failed:"))).toBe(true);
  // the split pane of the failed worker was closed again
  expect(fake.read().calls.filter((c) => c[0] === "pane" && c[1] === "close").length).toBeGreaterThanOrEqual(1);
});

test("a hanging agent start never blocks the daemon", async () => {
  await boot({ seed: { hang: ["agent start"] } });
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  const t0 = Date.now();
  expect(await cmd({ cmd: "log", thread: "001", message: "still responsive" })).toEqual({ ok: true, result: null });
  expect(Date.now() - t0).toBeLessThan(1000);
});

test("non-claude agents refuse to start the daemon", async () => {
  await boot();
  await daemon.stop();
  writeFileSync(join(root, ".agentthread", "config.yaml"), "agents:\n  default_worker: opencode\n");
  await expect(startDaemon(root, { log: () => {} })).rejects.toThrow("agents.default_worker: opencode is not supported yet");
  writeFileSync(join(root, ".agentthread", "config.yaml"), "");
  daemon = await startDaemon(root, { log: () => {} });
});
```

Note on the hanging test: the spawner child keeps waiting on the fake's hang until its own watchdog kills it (70s). Because the child is `unref()`'d, it does not keep the test process alive. The child's report then fails silently, because the daemon has stopped, and it exits. If `bun test` reports a leaked process, add `pkill -f "__spawn"` cleanup to that test's `finally`, and record that in the report.

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/agents/spawn-job.test.ts tests/daemon/agents.test.ts`
Expected: FAIL with `Cannot find module '../../src/agents/spawn-job.ts'`.

- [ ] **Step 3: Implement the spawn job**

Create `src/agents/spawn-job.ts`:

```ts
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import type { HerdrBridge } from "../herdr/bridge.ts";
import { AGT_BIN } from "./claude.ts";

export interface SpawnJob {
  root: string;
  herdrBin: string;
  herdrSocket?: string;
  session: string;
  name: string;
  kind: "claude";
  pane?: string;
  split?: { pane: string; direction: "right" | "down"; cwd: string; env: Record<string, string> };
  args: string[];
  bootstrap: string;
}

export const encodeJob = (job: SpawnJob): string => Buffer.from(JSON.stringify(job)).toString("base64");
export const decodeJob = (s: string): SpawnJob => JSON.parse(Buffer.from(s, "base64").toString("utf8")) as SpawnJob;

/** Runs in the `agt __spawn` child so the daemon never waits for an agent to boot. */
export async function runSpawnJob(job: SpawnJob, deps: { herdr: HerdrBridge; report: (command: object) => Promise<void> }): Promise<void> {
  let created: string | undefined;
  try {
    const pane = job.pane ?? (created = deps.herdr.splitPane(job.split!));
    deps.herdr.agentStart({ name: job.name, kind: job.kind, pane, args: job.args });
    if (job.bootstrap) deps.herdr.agentPrompt(job.name, job.bootstrap);
    await deps.report({ cmd: "session.attached", session: job.session, pane });
  } catch (e) {
    if (created) {
      try {
        deps.herdr.closePane(created);
      } catch {
        // best effort: the pane may already be gone
      }
    }
    await deps.report({ cmd: "session.failed", session: job.session, reason: e instanceof Error ? e.message : String(e) });
  }
}

export function launchSpawnJob(job: SpawnJob, opts: { logFile: string }): void {
  const fd = openSync(opts.logFile, "a");
  try {
    spawn(process.execPath, [AGT_BIN, "__spawn", encodeJob(job)], { stdio: ["ignore", fd, fd], env: { ...process.env, AGT_ROOT: job.root } }).unref();
  } finally {
    closeSync(fd);
  }
}
```

- [ ] **Step 4: Handle the new effects**

In `src/daemon/effects.ts`:
- extend the options type with `config: Config; thread: (id: string) => Thread | undefined; launch?: (job: SpawnJob) => void;`
- inside `createEffectRunner`, add `const launch = opts.launch ?? ((job: SpawnJob) => launchSpawnJob(job, { logFile: paths(opts.root).daemonLog }));`
- add these cases to the returned switch:

```ts
      case "agent.spawn": {
        const layout = opts.layout();
        const t = opts.thread(effect.thread);
        const failed = (reason: string): EventBody[] => [{ type: "session.failed", thread: effect.thread, payload: { session: effect.session, reason } }];
        if (!layout) return failed("no Herdr layout registered");
        if (!t) return failed(`unknown thread ${effect.thread}`);
        const prompt = { root: opts.root, role: effect.role, thread: t, ticket: effect.ticket };
        try {
          launch({
            root: opts.root,
            herdrBin: layout.herdrBin,
            ...(layout.herdrSocket ? { herdrSocket: layout.herdrSocket } : {}),
            session: effect.session,
            name: effect.name,
            kind: "claude",
            ...(effect.pane ? { pane: effect.pane } : {}),
            ...(effect.splitFrom
              ? {
                  split: {
                    pane: effect.splitFrom,
                    direction: effect.direction ?? "right",
                    cwd: effect.cwd,
                    env: agentEnv({ root: opts.root, role: effect.role, session: effect.session, thread: effect.thread, ticket: effect.ticket }),
                  },
                }
              : {}),
            args: claudeArgs({ session: effect.session, role: effect.role, systemPrompt: systemPrompt(prompt), config: opts.config }),
            bootstrap: bootstrapPrompt(prompt),
          });
          return [];
        } catch (e) {
          return failed(e instanceof Error ? e.message : String(e));
        }
      }
      case "notice.deliver": {
        const layout = opts.layout();
        if (!layout) return [];
        try {
          bridgeFor(layout).agentPrompt(effect.pane, effect.text);
          return [{ type: "notice.delivered", ...(effect.thread ? { thread: effect.thread } : {}), payload: { session: effect.session, count: effect.count } }];
        } catch (e) {
          log(`notice delivery to session ${effect.session} failed: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        }
      }
      case "pane.close": {
        const layout = opts.layout();
        if (!layout) return [];
        try {
          bridgeFor(layout).closePane(effect.pane);
        } catch (e) {
          log(`closing pane ${effect.pane} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return [];
      }
```

Add the matching imports: `Config`, `Thread`, `SpawnJob`/`launchSpawnJob`, `agentEnv`/`claudeArgs`, `systemPrompt`/`bootstrapPrompt` and `paths`.

- [ ] **Step 5: Wire the reactor loop into the daemon**

In `src/daemon/server.ts`:
1. Add the imports `import { randomUUID } from "node:crypto";`, `import { react } from "../orchestration/reactor.ts";` and `import type { SpawnJob } from "../agents/spawn-job.ts";`.
2. Change the opts type to `{ log?: (message: string) => void; launch?: (job: SpawnJob) => void }`.
3. In the startup `try`, directly after `config = loadConfig(root);`, add:

```ts
    for (const key of ["main_manager", "default_coordinator", "default_worker"] as const) {
      if (config.agents[key] !== "claude-code") throw new Error(`agents.${key}: ${config.agents[key]} is not supported yet`);
    }
```

4. Replace `writeAll(root, state)` with `writeAll(root, state, config)` everywhere in this file.
5. Change the runner creation to:

```ts
  const runEffect = createEffectRunner({
    root,
    config,
    layout: () => state.layout,
    thread: (id) => state.threads.get(id),
    log: opts.log,
    launch: opts.launch,
  });
```

6. In `runCommand`, replace:

```ts
    const decision = handle(state, command.data, actor.data, { root, config });
    if (!decision.ok) return decision;
    const effectEvents = decision.effects.flatMap(runEffect);
    for (const ev of store.append([...decision.events, ...effectEvents], actor.data)) applyEvent(state, ev);
```

with:

```ts
    const decision = handle(state, command.data, actor.data, { root, config, newId: randomUUID });
    if (!decision.ok) return decision;
    const commit = (bodies: EventBody[]) => {
      const stored = store.append(bodies, actor.data);
      for (const ev of stored) applyEvent(state, ev);
      return stored;
    };
    let fresh = commit([...decision.events, ...decision.effects.flatMap(runEffect)]);
    // Follow-ups (spawns, notifications, teardown) are themselves events; bound the chain so a bug can't loop forever.
    for (let round = 0; round < 10 && fresh.length > 0; round++) {
      const next = react(state, fresh, { root, config, newId: randomUUID });
      const bodies = [...next.events, ...next.effects.flatMap(runEffect)];
      if (bodies.length === 0) break;
      fresh = commit(bodies);
    }
```

Add `import type { EventBody } from "../domain/types.ts";`.

- [ ] **Step 6: Add the hidden `__spawn` CLI command**

In `src/cli/main.ts`, add the imports `import { decodeJob, runSpawnJob } from "../agents/spawn-job.ts";`, then add this case to `run()` (not listed in `USAGE`):

```ts
    case "__spawn": {
      const job = decodeJob(sub ?? "");
      const herdr = new HerdrCli({
        bin: job.herdrBin,
        env: { ...process.env, ...(job.herdrSocket ? { HERDR_SOCKET_PATH: job.herdrSocket } : {}) },
        timeoutMs: 90_000,
      });
      const socket = paths(job.root).socket;
      await runSpawnJob(job, {
        herdr,
        report: async (command) => {
          try {
            const res = await request(socket, { op: "command", command, actor: { role: "user" } });
            if (!res.ok) console.error(`agt __spawn: ${res.error}`);
          } catch (e) {
            console.error(`agt __spawn: cannot report to daemon: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      });
      return 0;
    }
```

- [ ] **Step 7: Verify and commit**

Run: `env -u HERDR_ENV -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID -u HERDR_PANE_ID -u AGT_HERDR_IT bun test && bun run typecheck` → PASS. `pgrep -fl "agt.*(daemon run|__spawn)"` shows nothing from this repo after about 75s at most; mention it in the report if a hung spawner from the hang test was still alive at the check.

```bash
git add src/agents/spawn-job.ts src/daemon src/cli/main.ts tests/agents/spawn-job.test.ts tests/daemon/agents.test.ts
git commit -m "feat: spawn Claude Code agents and react to session events"
```

---

### Task 8: CLI: worker spawn, tell, event, max-workers, main manager

**Files:**
- Modify: `src/cli/main.ts`
- Modify: `tests/cli/start.test.ts`, `tests/e2e/herdr-flow.test.ts` (existing `agt start` calls get `--no-manager`)
- Test: `tests/cli/agents.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 5, 7.
- Produces (CLI):
  - `agt thread new … [--max-workers <n>]` sends `maxWorkers: Number(n)`. A non-integer is a usage error, exit 2.
  - `agt worker spawn <thread> --ticket <T>` → `worker.spawn`. It prints `{"session":"…","queued":false}` or `{"queued":true}`.
  - `agt tell <thread|main> <message...>` → `tell`, and prints `ok`.
  - `agt event <started|active|idle|compacting|ended>`:
    - reads stdin when it is not a TTY, and takes `session_id` from the JSON (falling back to `AGT_SESSION`);
    - sends `session.signal` with a 3s request timeout;
    - **always exits 0**, writing problems to stderr as `agt event: <message>`;
    - prints nothing on success.
  - `agt start [--no-manager]`: after reconcile, unless `--no-manager`, it:
    1. sends `session.open_main` with a new UUID and `HERDR_PANE_ID`;
    2. prints `main manager session <uuid>`;
    3. runs `${AGT_CLAUDE_BIN ?? "claude"} <claudeArgs(main)>` in the foreground, with stdio inherited and env `{ ...env, ...agentEnv(main) }`;
    4. after it exits, sends `session.signal ended` (errors ignored) and returns Claude's exit code.
  - USAGE lists `start [--no-manager]`, `worker spawn`, `tell`, `event`, and `--max-workers`.

- [ ] **Step 1: Update existing tests for `--no-manager`**

In `tests/cli/start.test.ts` and `tests/e2e/herdr-flow.test.ts`, change every `agt(["start"]…)` call to `agt(["start", "--no-manager"]…)`, keeping their other arguments. Do not change anything else in those files.

- [ ] **Step 2: Write the failing tests**

Create `tests/cli/agents.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { initProject } from "../../src/project/init.ts";
import { FAKE_CLAUDE, FAKE_HERDR, fakeHerdrState, isolatedConfigHome, tempRepo } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");
let root: string;
let fake: ReturnType<typeof fakeHerdrState>;
let xdg: string;
let claudeLog: string;

function agt(args: string[], extra: Record<string, string> = {}, stdin?: string) {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "", HOME: "/nonexistent", XDG_CONFIG_HOME: xdg, AGT_ROOT: root, FAKE_HERDR_STATE: fake.file,
      HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t0", HERDR_PANE_ID: "w1:p0", HERDR_BIN_PATH: FAKE_HERDR,
      AGT_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_LOG: claudeLog,
      ...extra,
    },
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

beforeEach(() => {
  root = tempRepo();
  initProject(root, "demo");
  fake = fakeHerdrState({ tabs: ["w1:t0"], panes: ["w1:p0"] });
  xdg = isolatedConfigHome();
  claudeLog = join(xdg, "claude.jsonl");
});

afterEach(() => {
  agt(["daemon", "stop"]);
});

test("agt start runs the main manager in the foreground with session, hooks and role", () => {
  const r = agt(["start"]);
  expect(r.code).toBe(0);
  const id = /main manager session ([0-9a-f-]{36})/.exec(r.out)![1]!;
  const run = JSON.parse(readFileSync(claudeLog, "utf8").trim()) as { argv: string[]; env: Record<string, string> };
  expect(run.argv.slice(0, 4)).toEqual(["--session-id", id, "--permission-mode", "acceptEdits"]);
  expect(run.argv).toContain("--settings");
  expect(run.env).toMatchObject({ AGT_ROLE: "main", AGT_SESSION: id, AGT_ROOT: root, AGT_AGENT: "claude-code" });
  const fm = readFileSync(join(root, ".agentthread", "main.thread.md"), "utf8");
  expect(fm).toContain("# Main Thread");
});

test("--no-manager skips Claude", () => {
  expect(agt(["start", "--no-manager"]).code).toBe(0);
  expect(existsSync(claudeLog)).toBe(false);
});

test("thread new --max-workers, worker spawn and tell", () => {
  agt(["start", "--no-manager"]);
  expect(agt(["thread", "new", "X", "--type", "bug", "--max-workers", "x"]).code).toBe(2);
  agt(["thread", "new", "X", "--type", "bug", "--max-workers", "1"]);
  const coord = { AGT_ROLE: "coordinator", AGT_THREAD: "001" };
  agt(["ticket", "add", "001", "A", "--scope", "a"], coord);
  agt(["ticket", "add", "001", "B", "--scope", "b"], coord);
  expect(JSON.parse(agt(["worker", "spawn", "001", "--ticket", "T1"], coord).out)).toMatchObject({ queued: false });
  expect(agt(["worker", "spawn", "001", "--ticket", "T2"], coord).out).toBe('{"queued":true}');
  expect(agt(["tell", "001", "please", "hurry"]).out).toBe("ok");
});

test("agt event always exits 0, reading the session from hook stdin", () => {
  // daemon not running yet
  expect(agt(["event", "idle"], {}, "{}")).toMatchObject({ code: 0 });
  agt(["daemon", "start"]);
  const bad = agt(["event", "idle"], {}, "not json");
  expect(bad.code).toBe(0);
  expect(bad.err).toStartWith("agt event:");
  expect(agt(["event", "idle"], {}, JSON.stringify({ session_id: "00000000-0000-4000-8000-000000000000" }))).toMatchObject({ code: 0 });
  expect(agt(["event", "bogus"]).code).toBe(0);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `env -u HERDR_ENV -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID -u HERDR_PANE_ID bun test tests/cli/agents.test.ts`
Expected: FAIL. `worker`, `tell` and `event` are unknown, and `start` does not run Claude.

- [ ] **Step 4: Implement the CLI**

In `src/cli/main.ts`:

1. Add the imports `import { randomUUID } from "node:crypto";`, `import { agentEnv, claudeArgs } from "../agents/claude.ts";`, `import { systemPrompt } from "../agents/prompts.ts";`, and `SESSION_SIGNALS` from the domain types.
2. Update `USAGE` with these lines, inserted in the matching places:

```
  start [--no-manager]       set up the Herdr layout and run the main manager (inside a Herdr pane)
  thread new <title...> --type feature|bug|chore [--goal <text>] [--criteria <text>]... [--depends <id>]... [--max-workers <n>]
  worker spawn <thread> --ticket <T>
  tell <thread|main> <message...>
  event started|active|idle|compacting|ended   (used by Claude Code hooks)
```

3. In `thread()` `new`: add `"max-workers": { type: "string" }` to the parsed options. Before sending, add:

```ts
    let maxWorkers: number | undefined;
    if (values["max-workers"] !== undefined) {
      maxWorkers = Number(values["max-workers"]);
      if (!Number.isInteger(maxWorkers)) throw new UsageError("--max-workers must be an integer");
    }
```

and add `maxWorkers` to the sent command object.

4. Add these cases to `run()`:

```ts
    case "worker": {
      if (sub !== "spawn") throw new UsageError(`unknown worker subcommand '${sub ?? ""}'`);
      const { values, positionals } = parse(rest, { ticket: { type: "string" } });
      if (!positionals[0] || !values.ticket) throw new UsageError("worker spawn needs <thread> --ticket <T>");
      return send(findRoot(cwd, env), env, { cmd: "worker.spawn", thread: positionals[0], ticket: values.ticket });
    }
    case "tell": {
      const [target, ...words] = argv.slice(1);
      if (!target || !words.length) throw new UsageError("tell needs <thread|main> <message>");
      return send(findRoot(cwd, env), env, { cmd: "tell", target, message: words.join(" ") });
    }
    case "event":
      return hookEvent(sub, env, cwd);
```

5. Add:

```ts
/** Runs inside Claude Code hooks: it must never fail or hang the agent, so every problem is reported and swallowed. */
async function hookEvent(signal: string | undefined, env: Env, cwd: string): Promise<number> {
  try {
    if (!signal || !(SESSION_SIGNALS as readonly string[]).includes(signal)) throw new Error(`unknown signal '${signal ?? ""}'`);
    const input = process.stdin.isTTY ? "" : (await Bun.stdin.text()).trim();
    let session = env.AGT_SESSION;
    if (input) {
      const parsed = JSON.parse(input) as { session_id?: unknown };
      if (typeof parsed.session_id === "string") session = parsed.session_id;
    }
    if (!session) throw new Error("no session id (hook stdin session_id or AGT_SESSION)");
    const res = await request(paths(findRoot(cwd, env)).socket, { op: "command", command: { cmd: "session.signal", session, signal }, actor: actorFromEnv(env) }, 3_000);
    if (!res.ok) throw new Error(res.error);
  } catch (e) {
    console.error(`agt event: ${e instanceof Error ? e.message : String(e)}`);
  }
  return 0;
}
```

Note: `agt event` runs with the agent's env. For coordinators, `AGT_SESSION` is absent and the stdin `session_id` is used. `actorFromEnv` gives the coordinator's role and thread, and `session.signal` only checks `actor.session` when it is set.

6. In `start()`:
   - Change the signature to `start(root, env, argv)` and pass `argv.slice(1)` from `run()`.
   - Parse the arguments with `parse(argv, { "no-manager": { type: "boolean" } })` at the very top. A usage error must happen before any Herdr call.
   - Replace the final `return 0;` with:

```ts
  if (values["no-manager"]) return 0;
  const session = randomUUID();
  await commandOrThrow(socket, { cmd: "session.open_main", session, pane: managerPane });
  console.log(`main manager session ${session}`);
  const proc = Bun.spawn([env.AGT_CLAUDE_BIN ?? "claude", ...claudeArgs({ session, role: "main", systemPrompt: systemPrompt({ root, role: "main" }), config })], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...env, ...agentEnv({ root, role: "main", session }) },
  });
  const code = await proc.exited;
  try {
    await request(socket, { op: "command", command: { cmd: "session.signal", session, signal: "ended" }, actor: { role: "user" } }, 3_000);
  } catch {
    // the SessionEnd hook normally reports this already
  }
  return code;
```

- [ ] **Step 5: Verify and commit**

Run: `env -u HERDR_ENV -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID -u HERDR_PANE_ID -u AGT_HERDR_IT bun test && bun run typecheck` → PASS.

```bash
git add src/cli/main.ts tests/cli tests/e2e/herdr-flow.test.ts
git commit -m "feat: add worker spawn, tell, event and the main manager to the CLI"
```

---

### Task 9: End-to-end agent scenario

**Files:**
- Test: `tests/e2e/agents-flow.test.ts`

**Interfaces:**
- Consumes: the `agt` binary, fake herdr, and fake claude.
- Produces: a regression test that drives the whole agent loop through the CLI, simulating the hooks with `agt event` and stdin JSON.

- [ ] **Step 1: Write the scenario**

Create `tests/e2e/agents-flow.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { initProject } from "../../src/project/init.ts";
import { FAKE_CLAUDE, FAKE_HERDR, fakeHerdrState, isolatedConfigHome, tempRepo, waitFor } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");
let root: string;
let fake: ReturnType<typeof fakeHerdrState>;
let xdg: string;

function agt(args: string[], extra: Record<string, string> = {}, stdin?: string) {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "", HOME: "/nonexistent", XDG_CONFIG_HOME: xdg, AGT_ROOT: root, FAKE_HERDR_STATE: fake.file,
      HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t0", HERDR_PANE_ID: "w1:p0", HERDR_BIN_PATH: FAKE_HERDR,
      AGT_CLAUDE_BIN: FAKE_CLAUDE, ...extra,
    },
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`agt ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

type Fm = { sessions: { id: string; role: string; ticket?: string; status: string; pane?: string }[] };
const fm = () => parse(readFileSync(join(root, ".agentthread/threads/001-login/sub.thread.md"), "utf8").split("---\n")[1]!) as Fm;
const session = (role: string, ticket?: string) => fm().sessions.find((s) => s.role === role && (ticket === undefined || s.ticket === ticket));
const hook = (signal: string, id: string, env: Record<string, string> = {}) => agt(["event", signal], env, JSON.stringify({ session_id: id }));
const coordEnv = { AGT_ROLE: "coordinator", AGT_THREAD: "001" };

beforeAll(() => {
  root = tempRepo();
  initProject(root, "shop");
  fake = fakeHerdrState({ tabs: ["w1:t0"], panes: ["w1:p0"] });
  xdg = isolatedConfigHome();
});

afterAll(() => {
  try {
    agt(["daemon", "stop"]);
  } catch {
    // never started
  }
});

test("coordinator spawns, workers queue and rotate, notices reach the idle coordinator", async () => {
  agt(["start", "--no-manager"]);
  agt(["thread", "new", "Login", "--type", "feature", "--max-workers", "1"]);

  const c = await waitFor(() => session("coordinator")?.pane && session("coordinator"), 10_000);
  expect(c.pane).toBe("w1:p2");
  hook("started", c.id, coordEnv);
  agt(["thread", "status", "001", "in_progress"], coordEnv);
  agt(["ticket", "add", "001", "API", "--scope", "src/api"], coordEnv);
  agt(["ticket", "add", "001", "UI", "--scope", "src/ui"], coordEnv);
  agt(["worker", "spawn", "001", "--ticket", "T1"], coordEnv);
  expect(agt(["worker", "spawn", "001", "--ticket", "T2"], coordEnv)).toBe('{"queued":true}');
  hook("idle", c.id, coordEnv);

  const w1 = await waitFor(() => session("worker", "T1")?.pane && session("worker", "T1"), 10_000);
  const w1Env = { AGT_ROLE: "worker", AGT_THREAD: "001", AGT_SESSION: w1.id, AGT_TICKET: "T1" };
  hook("started", w1.id, w1Env);
  agt(["ticket", "claim", "001/T1"], w1Env);
  agt(["ticket", "done", "001/T1", "--summary", "endpoint added"], w1Env);
  hook("idle", w1.id, w1Env);

  expect(fake.read().calls.some((x) => x.join(" ") === `pane close ${w1.pane}`)).toBe(true);
  expect(fm().sessions.find((s) => s.id === w1.id)!.status).toBe("ended");
  const w2 = await waitFor(() => session("worker", "T2")?.pane && session("worker", "T2"), 10_000);
  expect(w2.pane).not.toBe(w1.pane);

  const prompts = fake.read().calls.filter((x) => x[0] === "agent" && x[1] === "prompt" && x[2] === "w1:p2").map((x) => x[3]);
  expect(prompts).toContain("Ticket T1 is done: endpoint added.");
});
```

- [ ] **Step 2: Run the scenario**

Run: `env -u HERDR_ENV -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID -u HERDR_PANE_ID -u AGT_HERDR_IT bun test tests/e2e/agents-flow.test.ts`
Expected: PASS. If it fails, fix the owning task's code, not the scenario.

Note: the coordinator receives the T1 notice only after its idle hook. The scenario sends `idle` for the coordinator before the worker finishes. When the worker's `ticket done` queues the notice, the coordinator is already `idle`, so delivery happens immediately in the same reaction chain.

- [ ] **Step 3: Full suite and commit**

Run: `env -u HERDR_ENV -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID -u HERDR_PANE_ID -u AGT_HERDR_IT bun test && bun run typecheck` → all PASS; no `daemon run` / `__spawn` processes left.

```bash
git add tests/e2e/agents-flow.test.ts
git commit -m "test: add end-to-end agent orchestration scenario"
```

---

## After merging: manual smoke test with real Herdr and Claude Code

The test suite never runs real binaries. After merge, the user should run this once in a scratch git repo:

1. `agt init`, then `agt start` inside a Herdr pane. Claude Code opens as the main manager.
2. Ask the main manager to create a small thread and confirm it. A new tab appears, and a coordinator Claude starts in it.
3. Check that the coordinator can run `agt …` without a permission prompt (this confirms the `Bash(agt *)` allowlist pattern), and that `git commit` works for the coordinator but prompts for a worker.
4. Close the main-manager pane and run `agt daemon status` from another pane. The daemon must still be running (Plan 2 follow-up).
