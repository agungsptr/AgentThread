# AgentThread Core Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the agent-free core of AgentThread: an event-sourced daemon that validates commands from the `agt` CLI, stores them as events in SQLite, and renders `main.thread.md`, `sub.thread.md`, `board.md` and `log.md`.

**Architecture:** Commands flow `agt CLI → Unix socket → daemon queue → pure command handler → SQLite event store → in-memory projection → markdown renderer`. The handler is a pure function `(state, command, actor) → events + effects`, so all business rules are unit-testable without I/O. The daemon is the single writer; `agt init` is the only command that writes before a daemon exists.

**Tech Stack:** TypeScript on Bun (≥ 1.1.34), `bun:sqlite`, `bun:test`, `zod`, `yaml`, git CLI.

**Spec:** `docs/specs/2026-10-09-agentthread-design.md`

### Roadmap (this is Plan 1 of 5)

| Plan | Scope | Spec sections |
|---|---|---|
| **1. Core engine (this plan)** | Event store, projection, command handler, renderer, daemon, CLI, worktree creation | §2, §4, §5, §6.1–6.3 |
| 2. Config + Herdr bridge | Config precedence, `agt start`, main tab layout, subthread tabs, tab/pane close | §8, §9 |
| 3. Claude Code adapter | Spawning main manager / coordinator / workers, `max_workers`, hooks → `agt event`, role prompts (coordinator-only commits) | §5.2, §6.3, §7 |
| 4. Session lifecycle | Session tracking, resume, `lost` fallback, rotation, handoff request + generated fallback | §6.4, §6.5 |
| 5. OpenCode adapter | After researching the TBD rows in spec §7 | §7 |

### Spec adjustments made in this plan

- **Projection is in memory**, rebuilt from the event log at daemon start, instead of SQLite projection tables. The event log stays the source of truth; persisted projections can be added later if startup gets slow.
- **Socket lives in the OS temp dir** (`$TMPDIR/agt-<hash>.sock`) instead of `.agentthread/`, because macOS limits Unix socket paths to ~104 bytes.
- **`agt ticket reopen`** (coordinator) is added: the spec's ticket lifecycle has `blocked → open` but no command for it.
- **`main.thread.md` shows a `Tickets` column** (`done/total`) instead of `Coordinator`/`Workers` until Plan 3 introduces agents.
- **Handoff required sections** are fixed as: `Goal status`, `Work done`, `Decisions`, `Next steps`, `Risks` (spec §6.5 lists these topics).
- **`.md` files are not committed** (spec open question 1, default chosen): `.gitignore` gets `.worktrees/`, `.agentthread/*`, `!.agentthread/config.yaml`.

## Global Constraints

- Runtime: Bun ≥ 1.1.34, TypeScript with `strict: true`.
- CLI binary name: `agt`.
- State directory: `<repo>/.agentthread/`; event store: `.agentthread/state.db`.
- Worktree path: `<repo>/.worktrees/<id>-<slug>`; branch: `thread/<id>-<slug>`; thread ids are zero-padded to 3 digits (`001`).
- Every `.md` under `.agentthread/` is rendered output; only the daemon writes it (except `agt init`).
- Rendered text and messages are in English (`language: en`).
- Event type names exactly: `project.initialized`, `thread.created`, `thread.status_changed`, `ticket.created`, `ticket.claimed`, `ticket.completed`, `ticket.blocked`, `ticket.reopened`, `log.appended`, `decision.recorded`, `handoff.submitted`.
- Roles: `user`, `main`, `coordinator`, `worker`. Caller identity env vars: `AGT_ROLE` (default `user`), `AGT_THREAD`, `AGT_SESSION`, `AGT_TICKET`, `AGT_AGENT`, plus `AGT_ROOT` to override project discovery.
- Thread statuses: `open | in_progress | blocked | review | done`. Ticket statuses: `open | in_progress | blocked | done`.

## Review Focus

1. **Two workers claim overlapping scopes at the same instant** → exactly one succeeds, the other gets "scope … overlaps in-progress ticket …". Test in Task 7.
2. **User text containing `|`, newlines or `#` headings** (titles, log messages, handoffs) must not break markdown tables or the `sub.thread.md` section structure. Test in Task 5.
3. **Daemon restart or crash** → state is rebuilt from events, thread ids keep counting (`002` after `001`), and a stale socket file left by a crash does not block a new daemon. Test in Task 7.
4. **An agent runs `agt` from inside its worktree subdirectory without `AGT_ROOT`** → project root is still found. Test in Task 6 and Task 8.
5. **Deep project paths** → Unix socket path stays under the macOS 104-byte limit. Test in Task 5.

---

## File structure

```
package.json, tsconfig.json, .gitignore
bin/agt                         # executable entry: calls src/cli/main.ts
src/domain/types.ts             # roles, statuses, Actor, EventBody, StoredEvent
src/domain/rules.ts             # slugify, scope overlap, status transitions, handoff validation
src/store/event-store.ts        # SQLite append-only event log
src/state/projection.ts         # State model + applyEvent/project reducer
src/commands/schema.ts          # zod schemas for commands and actors
src/commands/handler.ts         # pure command handler: state + command + actor → events + effects
src/project/paths.ts            # all filesystem/socket paths for a project root
src/project/root.ts             # findRoot (walk up / AGT_ROOT)
src/project/git.ts              # isGitRepo, addWorktree
src/project/init.ts             # initProject (agt init)
src/render/markdown.ts          # pure renderers for the four .md files
src/render/write.ts             # writeAll: atomic writes of rendered files
src/daemon/framing.ts           # newline-delimited JSON framing over sockets
src/daemon/protocol.ts          # Request / Response types
src/daemon/client.ts            # request(), isAlive()
src/daemon/server.ts            # startDaemon(): queue + handler + store + renderer
src/cli/main.ts                 # argument parsing and subcommands
tests/...                       # mirrors src/
```

---

### Task 1: Project scaffold and domain rules

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `src/domain/types.ts`
- Create: `src/domain/rules.ts`
- Test: `tests/domain/rules.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Types: `Role`, `ROLES`, `AgentKind`, `ThreadType`, `THREAD_TYPES`, `ThreadStatus`, `THREAD_STATUSES`, `TicketStatus`, `Actor`, `EventBody`, `EventType`, `StoredEvent`.
  - `slugify(title: string): string`
  - `normalizePath(p: string): string`
  - `pathsOverlap(a: string, b: string): boolean`
  - `scopesOverlap(a: string[], b: string[]): boolean`
  - `canTransitionThread(from: ThreadStatus, to: ThreadStatus): boolean`
  - `canTransitionTicket(from: TicketStatus, to: TicketStatus): boolean`
  - `HANDOFF_SECTIONS: readonly ["Goal status", "Work done", "Decisions", "Next steps", "Risks"]`
  - `validateHandoff(markdown: string): { ok: true } | { ok: false; missing: string[] }`

- [ ] **Step 1: Initialize git and the Bun project**

```bash
cd <repo>
git init -b main
```

Create `package.json`:

```json
{
  "name": "agentthread",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "agt": "bin/agt" },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "yaml": "^2.5.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/bun": "^1.1.13",
    "typescript": "^5.6.3"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src", "tests"]
}
```

Create `.gitignore`:

```
node_modules/
```

Run: `bun install`
Expected: creates `bun.lockb` and `node_modules/`, no errors.

- [ ] **Step 2: Write the domain types**

Create `src/domain/types.ts`:

```ts
export const ROLES = ["user", "main", "coordinator", "worker"] as const;
export type Role = (typeof ROLES)[number];

export const AGENT_KINDS = ["claude-code", "opencode"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const THREAD_TYPES = ["feature", "bug", "chore"] as const;
export type ThreadType = (typeof THREAD_TYPES)[number];

export const THREAD_STATUSES = ["open", "in_progress", "blocked", "review", "done"] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export type TicketStatus = "open" | "in_progress" | "blocked" | "done";

export interface Actor {
  role: Role;
  thread?: string;
  session?: string;
  ticket?: string;
  agent?: AgentKind;
}

export type EventBody =
  | { type: "project.initialized"; thread?: undefined; payload: { name: string } }
  | {
      type: "thread.created";
      thread: string;
      payload: {
        title: string;
        threadType: ThreadType;
        slug: string;
        goal: string;
        criteria: string[];
        dependsOn: string[];
        branch: string;
        worktree: string;
        status: ThreadStatus;
      };
    }
  | { type: "thread.status_changed"; thread: string; payload: { from: ThreadStatus; to: ThreadStatus; reason?: string } }
  | { type: "ticket.created"; thread: string; payload: { ticket: string; title: string; scope: string[] } }
  | { type: "ticket.claimed"; thread: string; payload: { ticket: string; assignee: string } }
  | { type: "ticket.completed"; thread: string; payload: { ticket: string; summary?: string } }
  | { type: "ticket.blocked"; thread: string; payload: { ticket: string; reason: string } }
  | { type: "ticket.reopened"; thread: string; payload: { ticket: string } }
  | { type: "log.appended"; thread: string; payload: { message: string } }
  | { type: "decision.recorded"; thread: string; payload: { message: string } }
  | { type: "handoff.submitted"; thread: string; payload: { content: string; generated: boolean } };

export type EventType = EventBody["type"];

export type StoredEvent = EventBody & { seq: number; ts: string; actor: Actor };
```

- [ ] **Step 3: Write the failing tests for the rules**

Create `tests/domain/rules.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  canTransitionThread,
  canTransitionTicket,
  pathsOverlap,
  scopesOverlap,
  slugify,
  validateHandoff,
} from "../../src/domain/rules.ts";

describe("slugify", () => {
  test("lowercases and joins words with dashes", () => {
    expect(slugify("Fix race in Checkout!")).toBe("fix-race-in-checkout");
  });
  test("caps at 40 chars without a trailing dash", () => {
    const s = slugify(`${"a".repeat(39)} bbbb`);
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith("-")).toBe(false);
  });
  test("falls back to 'thread' when nothing is left", () => {
    expect(slugify("!!!")).toBe("thread");
  });
});

describe("scope overlap", () => {
  test("same path overlaps", () => expect(pathsOverlap("src/a.ts", "src/a.ts")).toBe(true));
  test("parent and child overlap", () => expect(pathsOverlap("src/checkout", "src/checkout/lock.ts")).toBe(true));
  test("sibling with shared prefix does not overlap", () => expect(pathsOverlap("src/a", "src/ab")).toBe(false));
  test("normalizes ./ and trailing slashes", () => expect(pathsOverlap("./src/", "src/x.ts")).toBe(true));
  test("'.' overlaps everything", () => expect(pathsOverlap(".", "docs/x.md")).toBe(true));
  test("lists overlap when any pair overlaps", () => {
    expect(scopesOverlap(["docs/"], ["src/a", "docs/readme.md"])).toBe(true);
    expect(scopesOverlap(["docs/"], ["src/a"])).toBe(false);
  });
});

describe("transitions", () => {
  test("thread", () => {
    expect(canTransitionThread("open", "in_progress")).toBe(true);
    expect(canTransitionThread("in_progress", "review")).toBe(true);
    expect(canTransitionThread("review", "in_progress")).toBe(true);
    expect(canTransitionThread("blocked", "open")).toBe(true);
    expect(canTransitionThread("open", "done")).toBe(false);
    expect(canTransitionThread("done", "open")).toBe(false);
  });
  test("ticket", () => {
    expect(canTransitionTicket("open", "in_progress")).toBe(true);
    expect(canTransitionTicket("in_progress", "blocked")).toBe(true);
    expect(canTransitionTicket("blocked", "open")).toBe(true);
    expect(canTransitionTicket("open", "done")).toBe(false);
    expect(canTransitionTicket("done", "open")).toBe(false);
  });
});

describe("validateHandoff", () => {
  const sections = (overrides: Record<string, string> = {}) =>
    ["Goal status", "Work done", "Decisions", "Next steps", "Risks"]
      .map((name) => `## ${name}\n${overrides[name] ?? `${name} text`}`)
      .join("\n");

  test("accepts a complete handoff", () => {
    expect(validateHandoff(sections())).toEqual({ ok: true });
  });
  test("reports a missing section", () => {
    const md = sections().replace(/## Risks\nRisks text/, "");
    expect(validateHandoff(md)).toEqual({ ok: false, missing: ["Risks"] });
  });
  test("treats an empty section as missing", () => {
    expect(validateHandoff(sections({ Decisions: "   " }))).toEqual({ ok: false, missing: ["Decisions"] });
  });
  test("matches headings case-insensitively", () => {
    expect(validateHandoff(sections().replace("## Work done", "## work DONE"))).toEqual({ ok: true });
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `bun test tests/domain/rules.test.ts`
Expected: FAIL with `Cannot find module '../../src/domain/rules.ts'`.

- [ ] **Step 5: Implement the rules**

Create `src/domain/rules.ts`:

```ts
import type { ThreadStatus, TicketStatus } from "./types.ts";

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "thread";
}

export function normalizePath(p: string): string {
  const s = p.trim().replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  return s === "" ? "." : s;
}

export function pathsOverlap(a: string, b: string): boolean {
  const x = normalizePath(a);
  const y = normalizePath(b);
  if (x === "." || y === ".") return true;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

export function scopesOverlap(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => pathsOverlap(x, y)));
}

const THREAD_TRANSITIONS: Record<ThreadStatus, ThreadStatus[]> = {
  open: ["in_progress", "blocked"],
  in_progress: ["blocked", "review"],
  blocked: ["open", "in_progress"],
  review: ["done", "in_progress"],
  done: [],
};

const TICKET_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  open: ["in_progress"],
  in_progress: ["done", "blocked"],
  blocked: ["open"],
  done: [],
};

export function canTransitionThread(from: ThreadStatus, to: ThreadStatus): boolean {
  return THREAD_TRANSITIONS[from].includes(to);
}

export function canTransitionTicket(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_TRANSITIONS[from].includes(to);
}

export const HANDOFF_SECTIONS = ["Goal status", "Work done", "Decisions", "Next steps", "Risks"] as const;

export function validateHandoff(markdown: string): { ok: true } | { ok: false; missing: string[] } {
  const sections = new Map<string, string>();
  let current: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1]!.toLowerCase();
      sections.set(current, "");
      continue;
    }
    if (current !== null) sections.set(current, `${sections.get(current)}${line}\n`);
  }
  const missing = HANDOFF_SECTIONS.filter((name) => !(sections.get(name.toLowerCase()) ?? "").trim());
  return missing.length ? { ok: false, missing } : { ok: true };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/domain/rules.test.ts && bun run typecheck`
Expected: all tests PASS, typecheck prints nothing.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lockb tsconfig.json .gitignore src/domain tests/domain
git commit -m "feat: scaffold project and add domain rules"
```

---

### Task 2: SQLite event store

**Files:**
- Create: `src/store/event-store.ts`
- Test: `tests/store/event-store.test.ts`

**Interfaces:**
- Consumes: `Actor`, `EventBody`, `StoredEvent` from `src/domain/types.ts`.
- Produces:
  - `class EventStore { constructor(path: string); append(bodies: EventBody[], actor: Actor, now?: Date): StoredEvent[]; since(seq: number): StoredEvent[]; all(): StoredEvent[]; close(): void }`

- [ ] **Step 1: Write the failing tests**

Create `tests/store/event-store.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../../src/store/event-store.ts";

const dbPath = () => join(mkdtempSync(join(tmpdir(), "agt-store-")), "state.db");
const actor = { role: "user" as const };

test("append assigns increasing seq and round-trips payloads", () => {
  const store = new EventStore(dbPath());
  const now = new Date("2026-10-09T10:00:00Z");
  const stored = store.append(
    [
      { type: "project.initialized", payload: { name: "demo" } },
      { type: "log.appended", thread: "001", payload: { message: "hello" } },
    ],
    actor,
    now,
  );
  expect(stored.map((e) => e.seq)).toEqual([1, 2]);
  expect(store.all()).toEqual([
    { seq: 1, ts: "2026-10-09T10:00:00.000Z", type: "project.initialized", actor, payload: { name: "demo" } },
    { seq: 2, ts: "2026-10-09T10:00:00.000Z", type: "log.appended", thread: "001", actor, payload: { message: "hello" } },
  ]);
  store.close();
});

test("events persist across reopen", () => {
  const path = dbPath();
  const first = new EventStore(path);
  first.append([{ type: "project.initialized", payload: { name: "demo" } }], actor);
  first.close();
  const second = new EventStore(path);
  expect(second.all()).toHaveLength(1);
  expect(second.append([{ type: "log.appended", thread: "001", payload: { message: "x" } }], actor)[0]!.seq).toBe(2);
  second.close();
});

test("since returns only newer events", () => {
  const store = new EventStore(dbPath());
  store.append(
    [1, 2, 3].map((n) => ({ type: "log.appended" as const, thread: "001", payload: { message: `m${n}` } })),
    actor,
  );
  expect(store.since(2).map((e) => e.seq)).toEqual([3]);
  store.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/store`
Expected: FAIL with `Cannot find module '../../src/store/event-store.ts'`.

- [ ] **Step 3: Implement the event store**

Create `src/store/event-store.ts`:

```ts
import { Database } from "bun:sqlite";
import type { Actor, EventBody, StoredEvent } from "../domain/types.ts";

interface Row {
  seq: number;
  ts: string;
  type: string;
  thread: string | null;
  actor: string;
  payload: string;
}

export class EventStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      thread TEXT,
      actor TEXT NOT NULL,
      payload TEXT NOT NULL
    )`);
  }

  append(bodies: EventBody[], actor: Actor, now: Date = new Date()): StoredEvent[] {
    const ts = now.toISOString();
    const insert = this.db.prepare(
      "INSERT INTO events (ts, type, thread, actor, payload) VALUES (?, ?, ?, ?, ?) RETURNING seq",
    );
    const tx = this.db.transaction((items: EventBody[]) =>
      items.map((body) => {
        const row = insert.get(ts, body.type, body.thread ?? null, JSON.stringify(actor), JSON.stringify(body.payload)) as {
          seq: number;
        };
        return { ...body, seq: row.seq, ts, actor } as StoredEvent;
      }),
    );
    return tx(bodies);
  }

  since(seq: number): StoredEvent[] {
    const rows = this.db.query("SELECT * FROM events WHERE seq > ? ORDER BY seq").all(seq) as Row[];
    return rows.map(toEvent);
  }

  all(): StoredEvent[] {
    return this.since(0);
  }

  close(): void {
    this.db.close();
  }
}

function toEvent(row: Row): StoredEvent {
  return {
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    ...(row.thread !== null ? { thread: row.thread } : {}),
    actor: JSON.parse(row.actor),
    payload: JSON.parse(row.payload),
  } as StoredEvent;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/store && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store tests/store
git commit -m "feat: add SQLite append-only event store"
```

---

### Task 3: State projection

**Files:**
- Create: `src/state/projection.ts`
- Create: `tests/helpers.ts`
- Test: `tests/state/projection.test.ts`

**Interfaces:**
- Consumes: `StoredEvent`, `Actor`, statuses from `src/domain/types.ts`.
- Produces:
  - `interface Ticket { id: string; title: string; scope: string[]; status: TicketStatus; assignee?: string }`
  - `interface Entry { ts: string; actor: Actor; message: string }`
  - `interface Thread { id; slug; title; type: ThreadType; status: ThreadStatus; goal; criteria: string[]; dependsOn: string[]; branch; worktree; tickets: Ticket[]; decisions: Entry[]; log: Entry[]; handoff?: { content: string; generated: boolean; ts: string } }`
  - `interface State { project?: { name: string }; threads: Map<string, Thread>; lastSeq: number }`
  - `emptyState(): State`, `applyEvent(state: State, ev: StoredEvent): void`, `project(events: StoredEvent[]): State`
  - Test helpers in `tests/helpers.ts`: `USER`, `INIT`, `stored(bodies, actor?)`, `stateOf(...bodies)`, `threadCreated(id, overrides?)`

- [ ] **Step 1: Write the test helpers**

Create `tests/helpers.ts`:

```ts
import type { Actor, EventBody, StoredEvent } from "../src/domain/types.ts";
import { project, type State } from "../src/state/projection.ts";

export const USER: Actor = { role: "user" };

export const INIT: EventBody = { type: "project.initialized", payload: { name: "demo" } };

type ThreadPayload = Extract<EventBody, { type: "thread.created" }>["payload"];

export function threadCreated(id: string, overrides: Partial<ThreadPayload> = {}): EventBody {
  return {
    type: "thread.created",
    thread: id,
    payload: {
      title: `Thread ${id}`,
      threadType: "feature",
      slug: `thread-${id}`,
      goal: "",
      criteria: [],
      dependsOn: [],
      branch: `thread/${id}-thread-${id}`,
      worktree: `/repo/.worktrees/${id}-thread-${id}`,
      status: "open",
      ...overrides,
    },
  };
}

export function stored(bodies: EventBody[], actor: Actor = USER): StoredEvent[] {
  return bodies.map(
    (body, i) => ({ ...body, seq: i + 1, ts: `2026-10-09T10:00:${String(i % 60).padStart(2, "0")}.000Z`, actor }) as StoredEvent,
  );
}

export function stateOf(...bodies: EventBody[]): State {
  return project(stored(bodies));
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/state/projection.test.ts`:

```ts
import { expect, test } from "bun:test";
import { project } from "../../src/state/projection.ts";
import { INIT, stateOf, stored, threadCreated } from "../helpers.ts";

test("project.initialized sets the project", () => {
  expect(stateOf(INIT).project).toEqual({ name: "demo" });
});

test("tracks a ticket through its lifecycle", () => {
  const state = stateOf(
    INIT,
    threadCreated("001"),
    { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "Fix", scope: ["src/a.ts"] } },
    { type: "ticket.claimed", thread: "001", payload: { ticket: "T1", assignee: "w1" } },
    { type: "ticket.blocked", thread: "001", payload: { ticket: "T1", reason: "waiting" } },
    { type: "ticket.reopened", thread: "001", payload: { ticket: "T1" } },
  );
  expect(state.threads.get("001")!.tickets).toEqual([{ id: "T1", title: "Fix", scope: ["src/a.ts"], status: "open" }]);
  expect(state.lastSeq).toBe(6);
});

test("records status, decisions, handoff and a log line per event", () => {
  const t = stateOf(
    INIT,
    threadCreated("001"),
    { type: "thread.status_changed", thread: "001", payload: { from: "open", to: "in_progress" } },
    { type: "decision.recorded", thread: "001", payload: { message: "use a mutex" } },
    { type: "log.appended", thread: "001", payload: { message: "found root cause" } },
    { type: "handoff.submitted", thread: "001", payload: { content: "## Goal status\nok", generated: false } },
  ).threads.get("001")!;
  expect(t.status).toBe("in_progress");
  expect(t.decisions.map((d) => d.message)).toEqual(["use a mutex"]);
  expect(t.handoff).toEqual({ content: "## Goal status\nok", generated: false, ts: "2026-10-09T10:00:05.000Z" });
  expect(t.log.map((e) => e.message)).toEqual([
    "thread created (open)",
    "status open → in_progress",
    "decision: use a mutex",
    "found root cause",
    "handoff submitted",
  ]);
});

test("throws on an event for an unknown thread", () => {
  expect(() => project(stored([INIT, { type: "log.appended", thread: "999", payload: { message: "x" } }]))).toThrow(
    "unknown thread 999",
  );
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test tests/state`
Expected: FAIL with `Cannot find module '../../src/state/projection.ts'`.

- [ ] **Step 4: Implement the projection**

Create `src/state/projection.ts`:

```ts
import type { Actor, StoredEvent, ThreadStatus, ThreadType, TicketStatus } from "../domain/types.ts";

export interface Ticket {
  id: string;
  title: string;
  scope: string[];
  status: TicketStatus;
  assignee?: string;
}

export interface Entry {
  ts: string;
  actor: Actor;
  message: string;
}

export interface Thread {
  id: string;
  slug: string;
  title: string;
  type: ThreadType;
  status: ThreadStatus;
  goal: string;
  criteria: string[];
  dependsOn: string[];
  branch: string;
  worktree: string;
  tickets: Ticket[];
  decisions: Entry[];
  log: Entry[];
  handoff?: { content: string; generated: boolean; ts: string };
}

export interface State {
  project?: { name: string };
  threads: Map<string, Thread>;
  lastSeq: number;
}

export function emptyState(): State {
  return { threads: new Map(), lastSeq: 0 };
}

export function project(events: StoredEvent[]): State {
  const state = emptyState();
  for (const ev of events) applyEvent(state, ev);
  return state;
}

export function applyEvent(state: State, ev: StoredEvent): void {
  state.lastSeq = ev.seq;

  if (ev.type === "project.initialized") {
    state.project = { name: ev.payload.name };
    return;
  }

  if (ev.type === "thread.created") {
    const p = ev.payload;
    const thread: Thread = {
      id: ev.thread,
      slug: p.slug,
      title: p.title,
      type: p.threadType,
      status: p.status,
      goal: p.goal,
      criteria: p.criteria,
      dependsOn: p.dependsOn,
      branch: p.branch,
      worktree: p.worktree,
      tickets: [],
      decisions: [],
      log: [],
    };
    state.threads.set(ev.thread, thread);
    note(thread, ev, `thread created (${p.status})`);
    return;
  }

  const t = state.threads.get(ev.thread);
  if (!t) throw new Error(`event ${ev.seq} references unknown thread ${ev.thread}`);
  const ticket = (id: string) => {
    const found = t.tickets.find((k) => k.id === id);
    if (!found) throw new Error(`event ${ev.seq} references unknown ticket ${id}`);
    return found;
  };

  switch (ev.type) {
    case "thread.status_changed": {
      t.status = ev.payload.to;
      const reason = ev.payload.reason ? `: ${ev.payload.reason}` : "";
      note(t, ev, `status ${ev.payload.from} → ${ev.payload.to}${reason}`);
      break;
    }
    case "ticket.created":
      t.tickets.push({ id: ev.payload.ticket, title: ev.payload.title, scope: ev.payload.scope, status: "open" });
      note(t, ev, `${ev.payload.ticket} created: ${ev.payload.title}`);
      break;
    case "ticket.claimed": {
      const k = ticket(ev.payload.ticket);
      k.status = "in_progress";
      k.assignee = ev.payload.assignee;
      note(t, ev, `${k.id} claimed by ${k.assignee}`);
      break;
    }
    case "ticket.completed": {
      const k = ticket(ev.payload.ticket);
      k.status = "done";
      note(t, ev, `${k.id} done${ev.payload.summary ? `: ${ev.payload.summary}` : ""}`);
      break;
    }
    case "ticket.blocked": {
      const k = ticket(ev.payload.ticket);
      k.status = "blocked";
      note(t, ev, `${k.id} blocked: ${ev.payload.reason}`);
      break;
    }
    case "ticket.reopened": {
      const k = ticket(ev.payload.ticket);
      k.status = "open";
      delete k.assignee;
      note(t, ev, `${k.id} reopened`);
      break;
    }
    case "log.appended":
      note(t, ev, ev.payload.message);
      break;
    case "decision.recorded":
      t.decisions.push({ ts: ev.ts, actor: ev.actor, message: ev.payload.message });
      note(t, ev, `decision: ${ev.payload.message}`);
      break;
    case "handoff.submitted":
      t.handoff = { content: ev.payload.content, generated: ev.payload.generated, ts: ev.ts };
      note(t, ev, `handoff submitted${ev.payload.generated ? " (generated)" : ""}`);
      break;
  }
}

function note(thread: Thread, ev: StoredEvent, message: string): void {
  thread.log.push({ ts: ev.ts, actor: ev.actor, message });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/state && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/state tests/state tests/helpers.ts
git commit -m "feat: add in-memory state projection"
```

---

### Task 4: Command schemas and pure command handler

**Files:**
- Create: `src/commands/schema.ts`
- Create: `src/commands/handler.ts`
- Test: `tests/commands/handler.test.ts`

**Interfaces:**
- Consumes: rules from Task 1; `State`, `Thread`, `applyEvent` from Task 3; test helpers from Task 3.
- Produces:
  - `CommandSchema` (zod, discriminated on `cmd`), `type Command`, `type CommandName`, `ActorSchema`.
  - Command shapes:
    - `{ cmd: "thread.new"; title; type: ThreadType; goal?: string; criteria?: string[]; dependsOn?: string[] }`
    - `{ cmd: "thread.status"; thread; status: ThreadStatus; reason?: string }`
    - `{ cmd: "ticket.add"; thread; title; scope: string[] }` (scope ≥ 1)
    - `{ cmd: "ticket.claim" | "ticket.reopen"; thread; ticket }`
    - `{ cmd: "ticket.done"; thread; ticket; summary?: string }`
    - `{ cmd: "ticket.block"; thread; ticket; reason }`
    - `{ cmd: "log" | "decide"; thread; message }`
    - `{ cmd: "handoff"; thread; content }`
  - `type Effect = { kind: "git.worktree.add"; branch: string; path: string }`
  - `type HandleResult = { ok: true; events: EventBody[]; effects: Effect[]; result: unknown } | { ok: false; error: string }`
  - `handle(state: State, cmd: Command, actor: Actor, ctx: { root: string }): HandleResult`
  - Results: `thread.new` → `{ thread: string; worktree: string }`; `ticket.add` → `{ ticket: string }`; others → `null`.

- [ ] **Step 1: Write the failing tests**

Create `tests/commands/handler.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { handle, type HandleResult } from "../../src/commands/handler.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import type { Actor, StoredEvent } from "../../src/domain/types.ts";
import { applyEvent, emptyState, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, threadCreated } from "../helpers.ts";

const COORD: Actor = { role: "coordinator", thread: "001", session: "c1" };
const worker = (session: string, ticket?: string): Actor => ({ role: "worker", thread: "001", session, ticket });

function run(state: State, cmd: unknown, actor: Actor = USER): HandleResult {
  return handle(state, CommandSchema.parse(cmd), actor, { root: "/repo" });
}

/** Runs a command and, if accepted, applies its events to `state`. */
function exec(state: State, cmd: unknown, actor: Actor = USER): HandleResult {
  const r = run(state, cmd, actor);
  if (r.ok) {
    for (const body of r.events) {
      applyEvent(state, { ...body, seq: state.lastSeq + 1, ts: "2026-10-09T11:00:00.000Z", actor } as StoredEvent);
    }
  }
  return r;
}

const errorOf = (r: HandleResult) => (r.ok ? "accepted" : r.error);

function withTickets(): State {
  const s = stateOf(INIT, threadCreated("001"));
  exec(s, { cmd: "ticket.add", thread: "001", title: "Lock", scope: ["src/checkout"] }, COORD);
  exec(s, { cmd: "ticket.add", thread: "001", title: "Lock file", scope: ["src/checkout/lock.ts"] }, COORD);
  exec(s, { cmd: "ticket.add", thread: "001", title: "Cart", scope: ["src/checkout-ui"] }, COORD);
  return s;
}

describe("thread.new", () => {
  test("rejects before the project is initialized", () => {
    expect(errorOf(run(emptyState(), { cmd: "thread.new", title: "X", type: "bug" }))).toContain("not initialized");
  });

  test("creates thread 001 with branch, worktree and a worktree effect", () => {
    const r = run(stateOf(INIT), { cmd: "thread.new", title: "Fix checkout race", type: "bug", goal: "no double charge" });
    if (!r.ok) throw new Error(r.error);
    expect(r.result).toEqual({ thread: "001", worktree: "/repo/.worktrees/001-fix-checkout-race" });
    expect(r.effects).toEqual([
      { kind: "git.worktree.add", branch: "thread/001-fix-checkout-race", path: "/repo/.worktrees/001-fix-checkout-race" },
    ]);
    expect(r.events[0]).toMatchObject({ type: "thread.created", thread: "001", payload: { status: "open", goal: "no double charge" } });
  });

  test("continues numbering after existing threads", () => {
    const r = run(stateOf(INIT, threadCreated("001")), { cmd: "thread.new", title: "Next", type: "feature" });
    expect(r.ok && r.result).toMatchObject({ thread: "002" });
  });

  test("starts blocked when a dependency is not done", () => {
    const r = run(stateOf(INIT, threadCreated("001")), { cmd: "thread.new", title: "B", type: "feature", dependsOn: ["001"] });
    expect(r.ok && r.events[0]).toMatchObject({ payload: { status: "blocked", dependsOn: ["001"] } });
  });

  test("rejects an unknown dependency", () => {
    expect(errorOf(run(stateOf(INIT), { cmd: "thread.new", title: "B", type: "bug", dependsOn: ["042"] }))).toContain(
      "unknown dependency 042",
    );
  });

  test("workers may not create threads", () => {
    expect(errorOf(run(stateOf(INIT), { cmd: "thread.new", title: "B", type: "bug" }, worker("w1")))).toContain(
      "role worker may not run thread.new",
    );
  });
});

describe("thread binding", () => {
  test("coordinator of another thread is rejected", () => {
    const s = stateOf(INIT, threadCreated("001"), threadCreated("002"));
    const r = run(s, { cmd: "decide", thread: "002", message: "x" }, COORD);
    expect(errorOf(r)).toContain("coordinator is bound to thread 001");
  });
});

describe("tickets", () => {
  test("ticket ids are sequential", () => {
    const s = withTickets();
    expect(s.threads.get("001")!.tickets.map((k) => k.id)).toEqual(["T1", "T2", "T3"]);
  });

  test("claim is rejected when scope overlaps an in-progress ticket", () => {
    const s = withTickets();
    expect(errorOf(exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, worker("w1")))).toBe("accepted");
    expect(errorOf(exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T2" }, worker("w2")))).toBe(
      "scope of T2 overlaps in-progress ticket T1",
    );
    expect(errorOf(exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T3" }, worker("w3")))).toBe("accepted");
  });

  test("worker bound to a ticket cannot claim another", () => {
    const s = withTickets();
    expect(errorOf(run(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, worker("w1", "T3")))).toBe(
      "worker is bound to ticket T3",
    );
  });

  test("only the assignee can complete a ticket", () => {
    const s = withTickets();
    exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, worker("w1"));
    expect(errorOf(run(s, { cmd: "ticket.done", thread: "001", ticket: "T1" }, worker("w2")))).toBe(
      "ticket T1 is assigned to w1",
    );
    expect(errorOf(exec(s, { cmd: "ticket.done", thread: "001", ticket: "T1" }, worker("w1")))).toBe("accepted");
  });

  test("illegal ticket transition is rejected", () => {
    const s = withTickets();
    expect(errorOf(run(s, { cmd: "ticket.done", thread: "001", ticket: "T1" }, worker("w1")))).toBe(
      "ticket T1 cannot go open → done",
    );
  });

  test("coordinator reopens a blocked ticket", () => {
    const s = withTickets();
    exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, worker("w1"));
    exec(s, { cmd: "ticket.block", thread: "001", ticket: "T1", reason: "need API key" }, worker("w1"));
    expect(errorOf(exec(s, { cmd: "ticket.reopen", thread: "001", ticket: "T1" }, COORD))).toBe("accepted");
    expect(s.threads.get("001")!.tickets[0]!.status).toBe("open");
  });

  test("unknown ticket is rejected", () => {
    expect(errorOf(run(withTickets(), { cmd: "ticket.claim", thread: "001", ticket: "T9" }, worker("w1")))).toBe(
      "unknown ticket T9 in thread 001",
    );
  });
});

describe("thread.status", () => {
  test("illegal transition is rejected", () => {
    expect(errorOf(run(stateOf(INIT, threadCreated("001")), { cmd: "thread.status", thread: "001", status: "done" }))).toBe(
      "thread 001 cannot go open → done",
    );
  });

  test("done unblocks dependents whose dependencies are all done", () => {
    const s = stateOf(
      INIT,
      threadCreated("001", { status: "review" }),
      threadCreated("002", { status: "blocked", dependsOn: ["001"] }),
    );
    const r = exec(s, { cmd: "thread.status", thread: "001", status: "done" });
    expect(r.ok && r.events.map((e) => [e.thread, e.type])).toEqual([
      ["001", "thread.status_changed"],
      ["002", "thread.status_changed"],
    ]);
    expect(s.threads.get("002")!.status).toBe("open");
  });

  test("cannot open a thread whose dependencies are unfinished", () => {
    const s = stateOf(INIT, threadCreated("001"), threadCreated("002", { status: "blocked", dependsOn: ["001"] }));
    expect(errorOf(run(s, { cmd: "thread.status", thread: "002", status: "open" }))).toBe(
      "thread 002 has unfinished dependencies: 001",
    );
  });
});

describe("handoff", () => {
  test("rejects a handoff with missing sections", () => {
    const r = run(stateOf(INIT, threadCreated("001")), { cmd: "handoff", thread: "001", content: "## Goal status\nok" }, COORD);
    expect(errorOf(r)).toBe("handoff missing sections: Work done, Decisions, Next steps, Risks");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/commands`
Expected: FAIL with `Cannot find module '../../src/commands/handler.ts'`.

- [ ] **Step 3: Implement the schemas**

Create `src/commands/schema.ts`:

```ts
import { z } from "zod";
import { AGENT_KINDS, ROLES, THREAD_STATUSES, THREAD_TYPES } from "../domain/types.ts";

const threadId = z.string().regex(/^\d{3,}$/, "thread id must be numeric, like 002");
const ticketId = z.string().regex(/^T\d+$/, "ticket id must look like T1");
const text = z.string().trim().min(1);

export const CommandSchema = z.discriminatedUnion("cmd", [
  z.object({
    cmd: z.literal("thread.new"),
    title: text,
    type: z.enum(THREAD_TYPES),
    goal: z.string().default(""),
    criteria: z.array(text).default([]),
    dependsOn: z.array(threadId).default([]),
  }),
  z.object({ cmd: z.literal("thread.status"), thread: threadId, status: z.enum(THREAD_STATUSES), reason: z.string().optional() }),
  z.object({ cmd: z.literal("ticket.add"), thread: threadId, title: text, scope: z.array(text).min(1) }),
  z.object({ cmd: z.literal("ticket.claim"), thread: threadId, ticket: ticketId }),
  z.object({ cmd: z.literal("ticket.done"), thread: threadId, ticket: ticketId, summary: z.string().optional() }),
  z.object({ cmd: z.literal("ticket.block"), thread: threadId, ticket: ticketId, reason: text }),
  z.object({ cmd: z.literal("ticket.reopen"), thread: threadId, ticket: ticketId }),
  z.object({ cmd: z.literal("log"), thread: threadId, message: text }),
  z.object({ cmd: z.literal("decide"), thread: threadId, message: text }),
  z.object({ cmd: z.literal("handoff"), thread: threadId, content: text }),
]);

export type Command = z.infer<typeof CommandSchema>;
export type CommandName = Command["cmd"];

export const ActorSchema = z.object({
  role: z.enum(ROLES),
  thread: z.string().optional(),
  session: z.string().optional(),
  ticket: z.string().optional(),
  agent: z.enum(AGENT_KINDS).optional(),
});
```

- [ ] **Step 4: Implement the handler**

Create `src/commands/handler.ts`:

```ts
import { join } from "node:path";
import { canTransitionThread, canTransitionTicket, scopesOverlap, slugify, validateHandoff } from "../domain/rules.ts";
import { ROLES, type Actor, type EventBody, type Role, type ThreadStatus, type TicketStatus } from "../domain/types.ts";
import type { State, Thread, Ticket } from "../state/projection.ts";
import type { Command, CommandName } from "./schema.ts";

export type Effect = { kind: "git.worktree.add"; branch: string; path: string };

export type HandleResult =
  | { ok: true; events: EventBody[]; effects: Effect[]; result: unknown }
  | { ok: false; error: string };

interface Decision {
  events: EventBody[];
  effects?: Effect[];
  result?: unknown;
}

const ALLOWED: Record<CommandName, readonly Role[]> = {
  "thread.new": ["user", "main"],
  "thread.status": ["user", "main", "coordinator"],
  "ticket.add": ["coordinator"],
  "ticket.claim": ["worker"],
  "ticket.done": ["worker"],
  "ticket.block": ["worker"],
  "ticket.reopen": ["coordinator"],
  log: ROLES,
  decide: ["coordinator"],
  handoff: ["main", "coordinator", "worker"],
};

class Rejection extends Error {}

function reject(message: string): never {
  throw new Rejection(message);
}

export function handle(state: State, cmd: Command, actor: Actor, ctx: { root: string }): HandleResult {
  try {
    const d = decide(state, cmd, actor, ctx);
    return { ok: true, events: d.events, effects: d.effects ?? [], result: d.result ?? null };
  } catch (e) {
    if (e instanceof Rejection) return { ok: false, error: e.message };
    throw e;
  }
}

function decide(state: State, cmd: Command, actor: Actor, ctx: { root: string }): Decision {
  if (!state.project) reject("project not initialized; run `agt init`");
  if (!ALLOWED[cmd.cmd].includes(actor.role)) reject(`role ${actor.role} may not run ${cmd.cmd}`);
  if (cmd.cmd === "thread.new") return newThread(state, cmd, ctx);

  const t = state.threads.get(cmd.thread) ?? reject(`unknown thread ${cmd.thread}`);
  if ((actor.role === "coordinator" || actor.role === "worker") && actor.thread !== t.id) {
    reject(`${actor.role} is bound to thread ${actor.thread ?? "(none)"}`);
  }

  switch (cmd.cmd) {
    case "thread.status":
      return threadStatus(state, t, cmd.status, cmd.reason);
    case "ticket.add": {
      if (t.status === "done") reject(`thread ${t.id} is done`);
      const ticket = `T${t.tickets.length + 1}`;
      return {
        events: [{ type: "ticket.created", thread: t.id, payload: { ticket, title: cmd.title, scope: cmd.scope } }],
        result: { ticket },
      };
    }
    case "ticket.claim": {
      const k = workerTicket(t, cmd.ticket, actor);
      transitionTicket(k, "in_progress");
      const clash = t.tickets.find((o) => o.id !== k.id && o.status === "in_progress" && scopesOverlap(o.scope, k.scope));
      if (clash) reject(`scope of ${k.id} overlaps in-progress ticket ${clash.id}`);
      return { events: [{ type: "ticket.claimed", thread: t.id, payload: { ticket: k.id, assignee: actor.session ?? actor.role } }] };
    }
    case "ticket.done": {
      const k = assignedTicket(t, cmd.ticket, actor);
      transitionTicket(k, "done");
      return { events: [{ type: "ticket.completed", thread: t.id, payload: { ticket: k.id, summary: cmd.summary } }] };
    }
    case "ticket.block": {
      const k = assignedTicket(t, cmd.ticket, actor);
      transitionTicket(k, "blocked");
      return { events: [{ type: "ticket.blocked", thread: t.id, payload: { ticket: k.id, reason: cmd.reason } }] };
    }
    case "ticket.reopen": {
      const k = findTicket(t, cmd.ticket);
      transitionTicket(k, "open");
      return { events: [{ type: "ticket.reopened", thread: t.id, payload: { ticket: k.id } }] };
    }
    case "log":
      return { events: [{ type: "log.appended", thread: t.id, payload: { message: cmd.message } }] };
    case "decide":
      return { events: [{ type: "decision.recorded", thread: t.id, payload: { message: cmd.message } }] };
    case "handoff": {
      const v = validateHandoff(cmd.content);
      if (!v.ok) reject(`handoff missing sections: ${v.missing.join(", ")}`);
      return { events: [{ type: "handoff.submitted", thread: t.id, payload: { content: cmd.content, generated: false } }] };
    }
  }
}

function newThread(state: State, cmd: Extract<Command, { cmd: "thread.new" }>, ctx: { root: string }): Decision {
  for (const dep of cmd.dependsOn) if (!state.threads.has(dep)) reject(`unknown dependency ${dep}`);
  const next = Math.max(0, ...[...state.threads.keys()].map(Number)) + 1;
  const id = String(next).padStart(3, "0");
  const slug = slugify(cmd.title);
  const name = `${id}-${slug}`;
  const branch = `thread/${name}`;
  const worktree = join(ctx.root, ".worktrees", name);
  const status: ThreadStatus = depsDone(state, cmd.dependsOn) ? "open" : "blocked";
  return {
    events: [
      {
        type: "thread.created",
        thread: id,
        payload: {
          title: cmd.title,
          threadType: cmd.type,
          slug,
          goal: cmd.goal,
          criteria: cmd.criteria,
          dependsOn: cmd.dependsOn,
          branch,
          worktree,
          status,
        },
      },
    ],
    effects: [{ kind: "git.worktree.add", branch, path: worktree }],
    result: { thread: id, worktree },
  };
}

function threadStatus(state: State, t: Thread, to: ThreadStatus, reason: string | undefined): Decision {
  if (!canTransitionThread(t.status, to)) reject(`thread ${t.id} cannot go ${t.status} → ${to}`);
  if ((to === "open" || to === "in_progress") && !depsDone(state, t.dependsOn)) {
    reject(`thread ${t.id} has unfinished dependencies: ${t.dependsOn.join(", ")}`);
  }
  const events: EventBody[] = [{ type: "thread.status_changed", thread: t.id, payload: { from: t.status, to, reason } }];
  if (to === "done") {
    for (const other of state.threads.values()) {
      if (other.status === "blocked" && other.dependsOn.includes(t.id) && depsDone(state, other.dependsOn, t.id)) {
        events.push({
          type: "thread.status_changed",
          thread: other.id,
          payload: { from: "blocked", to: "open", reason: "dependencies done" },
        });
      }
    }
  }
  return { events };
}

function depsDone(state: State, deps: string[], alsoDone?: string): boolean {
  return deps.every((d) => d === alsoDone || state.threads.get(d)?.status === "done");
}

function findTicket(t: Thread, id: string): Ticket {
  return t.tickets.find((k) => k.id === id) ?? reject(`unknown ticket ${id} in thread ${t.id}`);
}

function workerTicket(t: Thread, id: string, actor: Actor): Ticket {
  if (actor.ticket && actor.ticket !== id) reject(`worker is bound to ticket ${actor.ticket}`);
  return findTicket(t, id);
}

function assignedTicket(t: Thread, id: string, actor: Actor): Ticket {
  const k = workerTicket(t, id, actor);
  if (k.assignee && actor.session && k.assignee !== actor.session) reject(`ticket ${k.id} is assigned to ${k.assignee}`);
  return k;
}

function transitionTicket(k: Ticket, to: TicketStatus): void {
  if (!canTransitionTicket(k.status, to)) reject(`ticket ${k.id} cannot go ${k.status} → ${to}`);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/commands && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/commands tests/commands
git commit -m "feat: add command schemas and pure command handler"
```

---

### Task 5: Paths and markdown renderer

**Files:**
- Create: `src/project/paths.ts`
- Create: `src/render/markdown.ts`
- Create: `src/render/write.ts`
- Test: `tests/render/markdown.test.ts`
- Test: `tests/project/paths.test.ts`

**Interfaces:**
- Consumes: `State`, `Thread` from Task 3.
- Produces:
  - `paths(root: string): { root; dir; db; socket; daemonLog; mainThread; threadsDir; threadDir(t: { id: string; slug: string }): string }`
  - `renderMain(state: State): string`, `renderSub(t: Thread): string`, `renderBoard(t: Thread): string`, `renderLog(t: Thread): string`
  - `writeAll(root: string, state: State): void`. Writes `main.thread.md` and, per thread, `threads/<id>-<slug>/{sub.thread.md,board.md,log.md}` atomically.

- [ ] **Step 1: Write the failing tests**

Create `tests/project/paths.test.ts`:

```ts
import { expect, test } from "bun:test";
import { paths } from "../../src/project/paths.ts";

test("layout under .agentthread", () => {
  const p = paths("/repo");
  expect(p.db).toBe("/repo/.agentthread/state.db");
  expect(p.mainThread).toBe("/repo/.agentthread/main.thread.md");
  expect(p.threadDir({ id: "002", slug: "fix-race" })).toBe("/repo/.agentthread/threads/002-fix-race");
});

test("socket path stays short for deep project roots", () => {
  const deep = `/Users/someone/${"very-long-directory-name/".repeat(8)}project`;
  expect(Buffer.byteLength(paths(deep).socket)).toBeLessThan(104);
});

test("socket path is stable per root and distinct across roots", () => {
  expect(paths("/a").socket).toBe(paths("/a").socket);
  expect(paths("/a").socket).not.toBe(paths("/b").socket);
});
```

Create `tests/render/markdown.test.ts`:

```ts
import { expect, test } from "bun:test";
import { parse } from "yaml";
import { renderBoard, renderLog, renderMain, renderSub } from "../../src/render/markdown.ts";
import { INIT, stateOf, threadCreated } from "../helpers.ts";

const state = () =>
  stateOf(
    INIT,
    threadCreated("001", { title: "OAuth | login", goal: "Users log in with Google", criteria: ["Google works"], status: "review" }),
    threadCreated("002", { title: "Fix race", dependsOn: ["001"], status: "blocked" }),
    { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "Add\nbutton", scope: ["src/ui", "src/auth"] } },
    { type: "ticket.claimed", thread: "001", payload: { ticket: "T1", assignee: "w1" } },
    { type: "decision.recorded", thread: "001", payload: { message: "use PKCE" } },
    { type: "handoff.submitted", thread: "001", payload: { content: "## Goal status\nok\n## Risks\nnone", generated: false } },
  );

test("main thread lists threads and what needs attention", () => {
  const md = renderMain(state());
  expect(md).toContain("# Main Thread — demo");
  expect(md).toContain("| 001 | OAuth \\| login | feature | review | 0/1 | - |");
  expect(md).toContain("| 002 | Fix race | feature | blocked | 0/0 | 001 |");
  expect(md).toContain("- 001: awaiting review");
  expect(md).toContain("- 002: blocked");
});

test("sub thread has parseable frontmatter and fixed sections", () => {
  const md = renderSub(state().threads.get("001")!);
  const fm = parse(md.split("---\n")[1]!);
  expect(fm).toMatchObject({ id: "001", title: "OAuth | login", status: "review", depends_on: [], sessions: [] });
  expect(md).toContain("## Goal\n\nUsers log in with Google");
  expect(md).toContain("- [ ] Google works");
  expect(md).toContain("use PKCE");
});

test("handoff headings are demoted so they cannot break sub.thread.md sections", () => {
  const md = renderSub(state().threads.get("001")!);
  expect(md).toContain("### Goal status");
  expect(md.match(/^## /gm)).toHaveLength(4);
});

test("board escapes newlines and pipes in cells", () => {
  const md = renderBoard(state().threads.get("001")!);
  expect(md).toContain("| T1 | Add button | src/ui, src/auth | in_progress | w1 |");
});

test("log has one line per entry", () => {
  const md = renderLog(state().threads.get("001")!);
  expect(md).toContain("[user] T1 claimed by w1");
  expect(md.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(5);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/render tests/project/paths.test.ts`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement paths**

Create `src/project/paths.ts`:

```ts
import { tmpdir } from "node:os";
import { join } from "node:path";

export function paths(root: string) {
  const dir = join(root, ".agentthread");
  const threadsDir = join(dir, "threads");
  return {
    root,
    dir,
    db: join(dir, "state.db"),
    // macOS limits Unix socket paths to ~104 bytes, so the socket lives in the temp dir keyed by root.
    socket: join(tmpdir(), `agt-${Bun.hash(root).toString(16)}.sock`),
    daemonLog: join(dir, "daemon.log"),
    mainThread: join(dir, "main.thread.md"),
    threadsDir,
    threadDir: (t: { id: string; slug: string }) => join(threadsDir, `${t.id}-${t.slug}`),
  };
}
```

- [ ] **Step 4: Implement the renderers**

Create `src/render/markdown.ts`:

```ts
import { stringify } from "yaml";
import type { State, Thread } from "../state/projection.ts";

const oneLine = (s: string) => s.replace(/\r?\n+/g, " ").trim();
const cell = (s: string) => oneLine(s).replace(/\|/g, "\\|");
const demoteHeadings = (s: string) => s.replace(/^(#{1,5}) /gm, "#$1 ");
const orNone = (lines: string[], none: string) => (lines.length ? lines : [none]);

export function renderMain(state: State): string {
  const threads = [...state.threads.values()];
  const rows = threads.map((t) => {
    const done = t.tickets.filter((k) => k.status === "done").length;
    return `| ${t.id} | ${cell(t.title)} | ${t.type} | ${t.status} | ${done}/${t.tickets.length} | ${t.dependsOn.join(", ") || "-"} |`;
  });
  const attention = threads.flatMap((t) =>
    t.status === "review" ? [`- ${t.id}: awaiting review`] : t.status === "blocked" ? [`- ${t.id}: blocked`] : [],
  );
  return [
    `# Main Thread — ${oneLine(state.project?.name ?? "")}`,
    "",
    "| ID | Title | Type | Status | Tickets | Depends |",
    "|----|-------|------|--------|---------|---------|",
    ...rows,
    "",
    "## Needs user attention",
    "",
    ...orNone(attention, "_Nothing right now._"),
    "",
  ].join("\n");
}

export function renderSub(t: Thread): string {
  const frontmatter = stringify({
    id: t.id,
    title: t.title,
    type: t.type,
    status: t.status,
    depends_on: t.dependsOn,
    branch: t.branch,
    worktree: t.worktree,
    sessions: [],
  }).trimEnd();
  const handoff = t.handoff
    ? [...(t.handoff.generated ? ["> Generated by the daemon.", ""] : []), demoteHeadings(t.handoff.content.trim())]
    : ["_No handoff yet._"];
  return [
    "---",
    frontmatter,
    "---",
    "",
    "## Goal",
    "",
    t.goal.trim() || "_Not set._",
    "",
    "## Acceptance criteria",
    "",
    ...orNone(t.criteria.map((c) => `- [ ] ${oneLine(c)}`), "_None yet._"),
    "",
    "## Context & decisions",
    "",
    ...orNone(t.decisions.map((d) => `- ${d.ts} ${oneLine(d.message)}`), "_None yet._"),
    "",
    "## Handoff",
    "",
    ...handoff,
    "",
  ].join("\n");
}

export function renderBoard(t: Thread): string {
  return [
    `# Board — ${t.id} ${oneLine(t.title)}`,
    "",
    "| Ticket | Title | Scope | Status | Assignee |",
    "|--------|-------|-------|--------|----------|",
    ...t.tickets.map(
      (k) => `| ${k.id} | ${cell(k.title)} | ${cell(k.scope.join(", "))} | ${k.status} | ${cell(k.assignee ?? "-")} |`,
    ),
    "",
  ].join("\n");
}

export function renderLog(t: Thread): string {
  return [
    `# Log — ${t.id} ${oneLine(t.title)}`,
    "",
    ...t.log.map((e) => {
      const who = e.actor.session ? `${e.actor.role}:${e.actor.session}` : e.actor.role;
      return `- ${e.ts} [${who}] ${oneLine(e.message)}`;
    }),
    "",
  ].join("\n");
}
```

- [ ] **Step 5: Implement the writer**

Create `src/render/write.ts`:

```ts
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../project/paths.ts";
import type { State } from "../state/projection.ts";
import { renderBoard, renderLog, renderMain, renderSub } from "./markdown.ts";

export function writeAll(root: string, state: State): void {
  const p = paths(root);
  mkdirSync(p.threadsDir, { recursive: true });
  writeAtomic(p.mainThread, renderMain(state));
  for (const t of state.threads.values()) {
    const dir = p.threadDir(t);
    mkdirSync(dir, { recursive: true });
    writeAtomic(join(dir, "sub.thread.md"), renderSub(t));
    writeAtomic(join(dir, "board.md"), renderBoard(t));
    writeAtomic(join(dir, "log.md"), renderLog(t));
  }
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/render tests/project/paths.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/project/paths.ts src/render tests/render tests/project/paths.test.ts
git commit -m "feat: add project paths and markdown renderer"
```

---

### Task 6: Project init, root discovery and git worktrees

**Files:**
- Create: `src/project/git.ts`
- Create: `src/project/root.ts`
- Create: `src/project/init.ts`
- Modify: `tests/helpers.ts` (add `tempRepo`)
- Test: `tests/project/init.test.ts`

**Interfaces:**
- Consumes: `EventStore` (Task 2), `project` (Task 3), `paths` and `writeAll` (Task 5).
- Produces:
  - `isGitRepo(root: string): boolean`
  - `addWorktree(root: string, branch: string, path: string): void` (throws `git worktree add failed: <stderr>`)
  - `findRoot(start: string, env?: Record<string, string | undefined>): string` (honors `AGT_ROOT`, walks up looking for `.agentthread/state.db`)
  - `initProject(root: string, name?: string): void`
  - Test helper `tempRepo(): string`: a real-path temp git repo with one empty commit on `main`.

- [ ] **Step 1: Add the temp repo helper**

Append to `tests/helpers.ts`:

```ts
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agt-repo-")));
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", dir, ...args], { stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}
```

Move the three new `import` lines to the top of the file with the existing imports.

- [ ] **Step 2: Write the failing tests**

Create `tests/project/init.test.ts`:

```ts
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree } from "../../src/project/git.ts";
import { initProject } from "../../src/project/init.ts";
import { paths } from "../../src/project/paths.ts";
import { findRoot } from "../../src/project/root.ts";
import { EventStore } from "../../src/store/event-store.ts";
import { tempRepo } from "../helpers.ts";

test("init creates the event store, gitignore entries and main thread", () => {
  const root = tempRepo();
  initProject(root, "demo");
  const p = paths(root);
  const store = new EventStore(p.db);
  expect(store.all().map((e) => e.type)).toEqual(["project.initialized"]);
  store.close();
  expect(readFileSync(p.mainThread, "utf8")).toContain("# Main Thread — demo");
  const ignore = readFileSync(join(root, ".gitignore"), "utf8");
  expect(ignore).toContain(".worktrees/\n.agentthread/*\n!.agentthread/config.yaml\n");
});

test("init refuses to run twice", () => {
  const root = tempRepo();
  initProject(root);
  expect(() => initProject(root)).toThrow("already initialized");
});

test("init refuses a directory that is not a git repo", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agt-nogit-")));
  expect(() => initProject(dir)).toThrow("not a git repository");
});

test("findRoot walks up from a worktree subdirectory", () => {
  const root = tempRepo();
  initProject(root);
  const deep = join(root, ".worktrees", "001-x", "src", "lib");
  mkdirSync(deep, { recursive: true });
  expect(findRoot(deep, {})).toBe(root);
});

test("findRoot honors AGT_ROOT and fails outside a project", () => {
  expect(findRoot("/", { AGT_ROOT: "/some/root" })).toBe("/some/root");
  expect(() => findRoot(realpathSync(tmpdir()), {})).toThrow("not inside an AgentThread project");
});

test("addWorktree creates the branch and directory", () => {
  const root = tempRepo();
  const path = join(root, ".worktrees", "001-x");
  addWorktree(root, "thread/001-x", path);
  expect(existsSync(join(path, ".git"))).toBe(true);
  expect(() => addWorktree(root, "thread/001-x", join(root, ".worktrees", "dup"))).toThrow("git worktree add failed");
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test tests/project/init.test.ts`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 4: Implement git helpers**

Create `src/project/git.ts`:

```ts
export function isGitRepo(root: string): boolean {
  return Bun.spawnSync(["git", "-C", root, "rev-parse", "--is-inside-work-tree"], { stderr: "pipe" }).exitCode === 0;
}

export function addWorktree(root: string, branch: string, path: string): void {
  const r = Bun.spawnSync(["git", "-C", root, "worktree", "add", "-b", branch, path], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git worktree add failed: ${r.stderr.toString().trim()}`);
}
```

- [ ] **Step 5: Implement root discovery**

Create `src/project/root.ts`:

```ts
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function findRoot(start: string, env: Record<string, string | undefined> = process.env): string {
  if (env.AGT_ROOT) return resolve(env.AGT_ROOT);
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".agentthread", "state.db"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("not inside an AgentThread project (run `agt init`)");
    dir = parent;
  }
}
```

- [ ] **Step 6: Implement init**

Create `src/project/init.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { writeAll } from "../render/write.ts";
import { project } from "../state/projection.ts";
import { EventStore } from "../store/event-store.ts";
import { isGitRepo } from "./git.ts";
import { paths } from "./paths.ts";

const IGNORE_LINES = [".worktrees/", ".agentthread/*", "!.agentthread/config.yaml"];

export function initProject(root: string, name: string = basename(root)): void {
  const p = paths(root);
  if (!isGitRepo(root)) throw new Error(`${root} is not a git repository`);
  if (existsSync(p.db)) throw new Error(`already initialized at ${p.dir}`);
  mkdirSync(p.threadsDir, { recursive: true });
  ensureGitignore(root);
  const store = new EventStore(p.db);
  try {
    const events = store.append([{ type: "project.initialized", payload: { name } }], { role: "user" });
    writeAll(root, project(events));
  } finally {
    store.close();
  }
}

function ensureGitignore(root: string): void {
  const file = join(root, ".gitignore");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const present = new Set(current.split(/\r?\n/));
  const missing = IGNORE_LINES.filter((line) => !present.has(line));
  if (!missing.length) return;
  const sep = current && !current.endsWith("\n") ? "\n" : "";
  writeFileSync(file, `${current}${sep}# AgentThread\n${missing.join("\n")}\n`);
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test tests/project && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/project tests/project tests/helpers.ts
git commit -m "feat: add project init, root discovery and worktree helper"
```

---

### Task 7: Daemon server and client

**Files:**
- Create: `src/daemon/framing.ts`
- Create: `src/daemon/protocol.ts`
- Create: `src/daemon/client.ts`
- Create: `src/daemon/server.ts`
- Test: `tests/daemon/daemon.test.ts`

**Interfaces:**
- Consumes: `EventStore` (Task 2), `project`/`applyEvent` (Task 3), `CommandSchema`/`ActorSchema`/`handle`/`Effect` (Task 4), `paths`/`writeAll` (Task 5), `addWorktree`/`initProject` (Task 6).
- Produces:
  - `type Request = { op: "ping" } | { op: "shutdown" } | { op: "events.since"; seq: number } | { op: "command"; command: unknown; actor: unknown }`
  - `type Response = { ok: true; result: unknown } | { ok: false; error: string }`
  - `class DaemonUnavailable extends Error`
  - `request(socketPath: string, req: Request, timeoutMs?: number): Promise<Response>`
  - `isAlive(socketPath: string): Promise<boolean>`
  - `interface Daemon { stop(): Promise<void>; closed: Promise<void> }`
  - `startDaemon(root: string): Promise<Daemon>` (throws `daemon already running` / `project not initialized`)
  - Ping result: `{ pid: number }`. `events.since` result: `StoredEvent[]`.

- [ ] **Step 1: Write the failing tests**

Create `tests/daemon/daemon.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "../../src/daemon/client.ts";
import { startDaemon, type Daemon } from "../../src/daemon/server.ts";
import type { Actor, StoredEvent } from "../../src/domain/types.ts";
import { initProject } from "../../src/project/init.ts";
import { paths } from "../../src/project/paths.ts";
import { tempRepo } from "../helpers.ts";

let root: string;
let daemon: Daemon;

beforeEach(async () => {
  root = tempRepo();
  initProject(root, "demo");
  daemon = await startDaemon(root);
});

afterEach(async () => {
  await daemon.stop();
});

const sock = () => paths(root).socket;
const cmd = (command: object, actor: Actor = { role: "user" }) => request(sock(), { op: "command", command, actor });
const COORD: Actor = { role: "coordinator", thread: "001", session: "c1" };

const HANDOFF = (risks: string) =>
  ["Goal status", "Work done", "Decisions", "Next steps"].map((s) => `## ${s}\n${s} text`).join("\n") + `\n## Risks\n${risks}`;

test("ping returns the pid", async () => {
  expect(await request(sock(), { op: "ping" })).toEqual({ ok: true, result: { pid: process.pid } });
});

test("thread.new creates the worktree and renders markdown", async () => {
  const r = await cmd({ cmd: "thread.new", title: "Fix race", type: "bug" });
  expect(r).toEqual({ ok: true, result: { thread: "001", worktree: join(root, ".worktrees", "001-fix-race") } });
  expect(existsSync(join(root, ".worktrees", "001-fix-race", ".git"))).toBe(true);
  expect(readFileSync(join(root, ".agentthread/threads/001-fix-race/sub.thread.md"), "utf8")).toContain("title: Fix race");
  expect(readFileSync(paths(root).mainThread, "utf8")).toContain("| 001 | Fix race | bug | open |");
});

test("invalid commands return validation errors without writing events", async () => {
  const r = await cmd({ cmd: "thread.new", title: "", type: "nope" });
  expect(r.ok).toBe(false);
  const events = await request(sock(), { op: "events.since", seq: 0 });
  expect((events.ok && (events.result as StoredEvent[]).length) || 0).toBe(1);
});

test("concurrent overlapping claims: exactly one succeeds", async () => {
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  await cmd({ cmd: "ticket.add", thread: "001", title: "A", scope: ["src/a"] }, COORD);
  await cmd({ cmd: "ticket.add", thread: "001", title: "B", scope: ["src/a/b.ts"] }, COORD);
  const results = await Promise.all([
    cmd({ cmd: "ticket.claim", thread: "001", ticket: "T1" }, { role: "worker", thread: "001", session: "w1" }),
    cmd({ cmd: "ticket.claim", thread: "001", ticket: "T2" }, { role: "worker", thread: "001", session: "w2" }),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  const failed = results.find((r) => !r.ok);
  expect(failed && !failed.ok && failed.error).toMatch(/overlaps in-progress ticket/);
});

test("state survives a restart and ids keep counting", async () => {
  await cmd({ cmd: "thread.new", title: "First", type: "feature" });
  await daemon.stop();
  daemon = await startDaemon(root);
  expect(await cmd({ cmd: "thread.new", title: "Second", type: "feature" })).toMatchObject({
    ok: true,
    result: { thread: "002" },
  });
});

test("refuses a second daemon and recovers from a stale socket", async () => {
  await expect(startDaemon(root)).rejects.toThrow("daemon already running");
  await daemon.stop();
  writeFileSync(sock(), "stale");
  daemon = await startDaemon(root);
  expect((await request(sock(), { op: "ping" })).ok).toBe(true);
});

test("large payloads round-trip", async () => {
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  const big = "é".repeat(200_000);
  expect(await cmd({ cmd: "handoff", thread: "001", content: HANDOFF(big) }, COORD)).toEqual({ ok: true, result: null });
  expect(readFileSync(join(root, ".agentthread/threads/001-x/sub.thread.md"), "utf8")).toContain(big);
});

test("a failing effect rejects the command and writes no event", async () => {
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  Bun.spawnSync(["git", "-C", root, "branch", "thread/002-y"]);
  const r = await cmd({ cmd: "thread.new", title: "Y", type: "bug" });
  expect(r.ok).toBe(false);
  const events = await request(sock(), { op: "events.since", seq: 0 });
  expect(events.ok && (events.result as StoredEvent[]).map((e) => e.type)).toEqual(["project.initialized", "thread.created"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/daemon`
Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement framing and protocol**

Create `src/daemon/framing.ts`:

```ts
/** Splits a byte stream into newline-terminated UTF-8 lines without breaking multi-byte characters. */
export class LineReader {
  private buf = Buffer.alloc(0);

  push(chunk: Uint8Array): string[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const lines: string[] = [];
    let i: number;
    while ((i = this.buf.indexOf(10)) >= 0) {
      lines.push(this.buf.subarray(0, i).toString("utf8"));
      this.buf = this.buf.subarray(i + 1);
    }
    return lines;
  }
}

/** Queues JSON lines and flushes them across partial socket writes. Call flush() from the drain handler. */
export class LineWriter {
  private out = Buffer.alloc(0);

  constructor(private readonly write: (bytes: Uint8Array) => number) {}

  send(value: unknown): void {
    this.out = Buffer.concat([this.out, Buffer.from(`${JSON.stringify(value)}\n`)]);
    this.flush();
  }

  flush(): void {
    while (this.out.length) {
      const n = this.write(this.out);
      if (n <= 0) return;
      this.out = this.out.subarray(n);
    }
  }
}
```

Create `src/daemon/protocol.ts`:

```ts
export type Request =
  | { op: "ping" }
  | { op: "shutdown" }
  | { op: "events.since"; seq: number }
  | { op: "command"; command: unknown; actor: unknown };

export type Response = { ok: true; result: unknown } | { ok: false; error: string };
```

- [ ] **Step 4: Implement the client**

Create `src/daemon/client.ts`:

```ts
import { LineReader, LineWriter } from "./framing.ts";
import type { Request, Response } from "./protocol.ts";

export class DaemonUnavailable extends Error {
  constructor() {
    super("daemon is not running; run `agt daemon start`");
  }
}

export function request(socketPath: string, req: Request, timeoutMs = 10_000): Promise<Response> {
  return new Promise((resolve, reject) => {
    const reader = new LineReader();
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("daemon did not respond in time"))), timeoutMs);

    Bun.connect<{ writer: LineWriter }>({
      unix: socketPath,
      socket: {
        open(s) {
          s.data = { writer: new LineWriter((b) => s.write(b)) };
          s.data.writer.send(req);
        },
        drain(s) {
          s.data.writer.flush();
        },
        data(s, chunk) {
          const [line] = reader.push(chunk);
          if (line === undefined) return;
          s.end();
          finish(() => resolve(JSON.parse(line) as Response));
        },
        close() {
          finish(() => reject(new Error("daemon closed the connection")));
        },
        connectError() {
          finish(() => reject(new DaemonUnavailable()));
        },
        error(_s, err) {
          finish(() => reject(err));
        },
      },
    }).catch(() => finish(() => reject(new DaemonUnavailable())));
  });
}

export async function isAlive(socketPath: string): Promise<boolean> {
  try {
    return (await request(socketPath, { op: "ping" }, 1_000)).ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Implement the server**

Create `src/daemon/server.ts`:

```ts
import { existsSync, rmSync } from "node:fs";
import { handle, type Effect } from "../commands/handler.ts";
import { ActorSchema, CommandSchema } from "../commands/schema.ts";
import { addWorktree } from "../project/git.ts";
import { paths } from "../project/paths.ts";
import { writeAll } from "../render/write.ts";
import { applyEvent, project } from "../state/projection.ts";
import { EventStore } from "../store/event-store.ts";
import { isAlive } from "./client.ts";
import { LineReader, LineWriter } from "./framing.ts";
import type { Request, Response } from "./protocol.ts";

export interface Daemon {
  stop(): Promise<void>;
  closed: Promise<void>;
}

export async function startDaemon(root: string): Promise<Daemon> {
  const p = paths(root);
  if (existsSync(p.socket)) {
    if (await isAlive(p.socket)) throw new Error("daemon already running");
    rmSync(p.socket, { force: true });
  }

  const store = new EventStore(p.db);
  const state = project(store.all());
  if (!state.project) {
    store.close();
    throw new Error("project not initialized; run `agt init`");
  }
  writeAll(root, state);

  // Every command runs strictly one after another: this queue is what makes the daemon the single writer.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => T): Promise<T> => {
    const next = chain.then(fn);
    chain = next.catch(() => {});
    return next;
  };

  const runEffect = (effect: Effect) => {
    switch (effect.kind) {
      case "git.worktree.add":
        addWorktree(root, effect.branch, effect.path);
        break;
    }
  };

  const runCommand = (raw: { command: unknown; actor: unknown }): Response => {
    const command = CommandSchema.safeParse(raw.command);
    if (!command.success) return { ok: false, error: `invalid command: ${command.error.issues.map((i) => i.message).join("; ")}` };
    const actor = ActorSchema.safeParse(raw.actor);
    if (!actor.success) return { ok: false, error: `invalid actor: ${actor.error.issues.map((i) => i.message).join("; ")}` };
    const decision = handle(state, command.data, actor.data, { root });
    if (!decision.ok) return decision;
    for (const effect of decision.effects) runEffect(effect);
    for (const ev of store.append(decision.events, actor.data)) applyEvent(state, ev);
    writeAll(root, state);
    return { ok: true, result: decision.result };
  };

  let stopping: Promise<void> | null = null;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));

  const respond = async (req: Request): Promise<Response> => {
    switch (req.op) {
      case "ping":
        return { ok: true, result: { pid: process.pid } };
      case "events.since":
        return { ok: true, result: store.since(req.seq) };
      case "shutdown":
        setTimeout(() => void stop(), 50);
        return { ok: true, result: null };
      case "command":
        return enqueue(() => runCommand(req));
      default:
        return { ok: false, error: "unknown op" };
    }
  };

  const listener = Bun.listen<{ reader: LineReader; writer: LineWriter }>({
    unix: p.socket,
    socket: {
      open(s) {
        s.data = { reader: new LineReader(), writer: new LineWriter((b) => s.write(b)) };
      },
      drain(s) {
        s.data.writer.flush();
      },
      data(s, chunk) {
        for (const line of s.data.reader.push(chunk)) {
          let req: Request;
          try {
            req = JSON.parse(line) as Request;
          } catch {
            s.data.writer.send({ ok: false, error: "invalid JSON" });
            continue;
          }
          respond(req)
            .catch((e: unknown): Response => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
            .then((res) => s.data.writer.send(res));
        }
      },
    },
  });

  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      await chain;
      listener.stop(true);
      store.close();
      rmSync(p.socket, { force: true });
      resolveClosed();
    })();
    return stopping;
  };

  return { stop, closed };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/daemon && bun run typecheck`
Expected: PASS. If the "large payloads" test hangs, the `drain` → `flush()` wiring is wrong. Check both `drain` handlers before changing anything else.

- [ ] **Step 7: Commit**

```bash
git add src/daemon tests/daemon
git commit -m "feat: add single-writer daemon over a Unix socket"
```

---

### Task 8: `agt` CLI

**Files:**
- Create: `src/cli/main.ts`
- Create: `bin/agt`
- Test: `tests/cli/cli.test.ts`

**Interfaces:**
- Consumes: `initProject`, `findRoot`, `paths` (Tasks 5–6); `request`, `isAlive`, `startDaemon` (Task 7); `ROLES`, `Actor`, `StoredEvent` (Task 1).
- Produces:
  - `main(argv: string[], env?: Record<string, string | undefined>, cwd?: string): Promise<number>`: exit code.
  - `actorFromEnv(env): Actor`
  - `parseTicketRef(ref: string): { thread: string; ticket: string }` (format `002/T3`)
  - Commands: `init [--name]`, `daemon start|stop|status|run`, `thread new <title...> --type <t> [--goal] [--criteria ...] [--depends ...]`, `thread status <id> <status> [--reason]`, `ticket add <thread> <title...> --scope <path> [--scope ...]`, `ticket claim|reopen <thread>/<ticket>`, `ticket done <ref> [--summary]`, `ticket block <ref> --reason`, `log <thread> <message...>`, `decide <thread> <message...>`, `handoff <thread> --file <path>`, `logs [-f]`.
  - Output: command results print as one JSON line; `null` results print `ok`. Errors print `agt: <message>` to stderr with exit code 1. Usage errors exit 2.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli/cli.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempRepo } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");

let root: string;

function agt(args: string[], opts: { env?: Record<string, string>; cwd?: string; root?: boolean } = {}) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...opts.env };
  if (opts.root !== false) env.AGT_ROOT = root;
  const r = Bun.spawnSync([process.execPath, BIN, ...args], { cwd: opts.cwd ?? root, env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

const COORD = { AGT_ROLE: "coordinator", AGT_THREAD: "001", AGT_SESSION: "c1" };
const WORKER = { AGT_ROLE: "worker", AGT_THREAD: "001", AGT_SESSION: "w1" };

beforeEach(() => {
  root = tempRepo();
  expect(agt(["init", "--name", "demo"]).code).toBe(0);
});

afterEach(() => {
  agt(["daemon", "stop"]);
});

test("daemon lifecycle", () => {
  expect(agt(["daemon", "status"]).code).toBe(1);
  expect(agt(["daemon", "start"])).toMatchObject({ code: 0, out: "daemon started" });
  expect(agt(["daemon", "status"]).out).toMatch(/^running \(pid \d+\)$/);
  expect(agt(["daemon", "stop"])).toMatchObject({ code: 0, out: "daemon stopped" });
  expect(agt(["daemon", "status"]).code).toBe(1);
});

test("commands without a daemon explain how to start it", () => {
  expect(agt(["log", "001", "hi"])).toMatchObject({ code: 1, err: "agt: daemon is not running; run `agt daemon start`" });
});

test("thread, ticket and log commands", () => {
  agt(["daemon", "start"]);
  expect(JSON.parse(agt(["thread", "new", "Fix", "race", "--type", "bug", "--criteria", "no double charge"]).out)).toMatchObject({
    thread: "001",
  });
  expect(agt(["ticket", "add", "001", "Lock", "fix", "--scope", "src/lock.ts"], { env: COORD }).out).toBe('{"ticket":"T1"}');
  expect(agt(["ticket", "claim", "001/T1"], { env: WORKER }).out).toBe("ok");
  expect(agt(["ticket", "done", "001/T1", "--summary", "fixed"], { env: WORKER }).out).toBe("ok");
  expect(agt(["log", "001", "all", "good"], { env: WORKER }).out).toBe("ok");
  const logs = agt(["logs"]).out.split("\n");
  expect(logs.at(-1)).toMatch(/^\d+ \S+ log\.appended 001 worker:w1$/);
});

test("permission errors surface from the daemon", () => {
  agt(["daemon", "start"]);
  agt(["thread", "new", "X", "--type", "bug"]);
  expect(agt(["ticket", "add", "001", "T", "--scope", "a"])).toMatchObject({
    code: 1,
    err: "agt: role user may not run ticket.add",
  });
});

test("invalid AGT_ROLE is rejected locally", () => {
  expect(agt(["log", "001", "x"], { env: { AGT_ROLE: "boss" } })).toMatchObject({ code: 1, err: "agt: invalid AGT_ROLE boss" });
});

test("handoff reads the file", () => {
  agt(["daemon", "start"]);
  agt(["thread", "new", "X", "--type", "bug"]);
  const file = join(root, "handoff.md");
  writeFileSync(file, ["Goal status", "Work done", "Decisions", "Next steps", "Risks"].map((s) => `## ${s}\nx`).join("\n"));
  expect(agt(["handoff", "001", "--file", file], { env: COORD }).out).toBe("ok");
});

test("finds the project from a worktree subdirectory without AGT_ROOT", () => {
  agt(["daemon", "start"]);
  agt(["thread", "new", "X", "--type", "bug"]);
  const sub = join(root, ".worktrees", "001-x", "src");
  mkdirSync(sub, { recursive: true });
  expect(agt(["log", "001", "from worktree"], { cwd: sub, root: false, env: WORKER }).out).toBe("ok");
});

test("unknown commands print usage", () => {
  expect(agt(["frobnicate"]).code).toBe(2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/cli`
Expected: FAIL. `bin/agt` does not exist, so `init` exits non-zero.

- [ ] **Step 3: Implement the CLI**

Create `src/cli/main.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { isAlive, request } from "../daemon/client.ts";
import { startDaemon } from "../daemon/server.ts";
import { ROLES, type Actor, type StoredEvent } from "../domain/types.ts";
import { initProject } from "../project/init.ts";
import { paths } from "../project/paths.ts";
import { findRoot } from "../project/root.ts";

type Env = Record<string, string | undefined>;

const USAGE = `usage: agt <command>

  init [--name <name>]
  daemon start|stop|status
  thread new <title...> --type feature|bug|chore [--goal <text>] [--criteria <text>]... [--depends <id>]...
  thread status <id> <status> [--reason <text>]
  ticket add <thread> <title...> --scope <path> [--scope <path>]...
  ticket claim|reopen <thread>/<ticket>
  ticket done <thread>/<ticket> [--summary <text>]
  ticket block <thread>/<ticket> --reason <text>
  log <thread> <message...>
  decide <thread> <message...>
  handoff <thread> --file <path>
  logs [-f]`;

class UsageError extends Error {}

export async function main(argv: string[], env: Env = process.env, cwd: string = process.cwd()): Promise<number> {
  try {
    return await run(argv, env, cwd);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message ? `agt: ${e.message}\n\n${USAGE}` : USAGE);
      return 2;
    }
    console.error(`agt: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

export function actorFromEnv(env: Env): Actor {
  const role = env.AGT_ROLE ?? "user";
  if (!(ROLES as readonly string[]).includes(role)) throw new Error(`invalid AGT_ROLE ${role}`);
  const actor: Record<string, string> = { role };
  for (const [key, field] of [
    ["AGT_THREAD", "thread"],
    ["AGT_SESSION", "session"],
    ["AGT_TICKET", "ticket"],
    ["AGT_AGENT", "agent"],
  ] as const) {
    if (env[key]) actor[field] = env[key];
  }
  return actor as unknown as Actor;
}

export function parseTicketRef(ref: string | undefined): { thread: string; ticket: string } {
  const m = /^(\d{3,})\/(T\d+)$/.exec(ref ?? "");
  if (!m) throw new UsageError(`expected <thread>/<ticket>, like 002/T3, got '${ref ?? ""}'`);
  return { thread: m[1]!, ticket: m[2]! };
}

async function run(argv: string[], env: Env, cwd: string): Promise<number> {
  const [group, sub, ...rest] = argv;
  switch (group) {
    case "init": {
      const { values } = parse(argv.slice(1), { name: { type: "string" } });
      initProject(resolve(env.AGT_ROOT ?? cwd), values.name as string | undefined);
      console.log("initialized");
      return 0;
    }
    case "daemon":
      return daemon(sub, findRoot(cwd, env), env);
    case "thread":
      return thread(sub, rest, findRoot(cwd, env), env);
    case "ticket":
      return ticket(sub, rest, findRoot(cwd, env), env);
    case "log":
    case "decide": {
      const [threadId, ...words] = argv.slice(1);
      if (!threadId || !words.length) throw new UsageError(`${group} needs <thread> <message>`);
      return send(findRoot(cwd, env), env, { cmd: group, thread: threadId, message: words.join(" ") });
    }
    case "handoff": {
      const { values, positionals } = parse(argv.slice(1), { file: { type: "string" } });
      if (!positionals[0] || !values.file) throw new UsageError("handoff needs <thread> --file <path>");
      const content = readFileSync(resolve(cwd, values.file as string), "utf8");
      return send(findRoot(cwd, env), env, { cmd: "handoff", thread: positionals[0], content });
    }
    case "logs": {
      const { values } = parse(argv.slice(1), { follow: { type: "boolean", short: "f" } });
      return logs(findRoot(cwd, env), Boolean(values.follow));
    }
    default:
      throw new UsageError(group ? `unknown command '${group}'` : "");
  }
}

function parse(args: string[], options: ParseArgsConfig["options"]) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
}

async function send(root: string, env: Env, command: object): Promise<number> {
  const actor = actorFromEnv(env);
  const res = await request(paths(root).socket, { op: "command", command, actor });
  if (!res.ok) throw new Error(res.error);
  console.log(res.result === null ? "ok" : JSON.stringify(res.result));
  return 0;
}

async function thread(sub: string | undefined, args: string[], root: string, env: Env): Promise<number> {
  if (sub === "new") {
    const { values, positionals } = parse(args, {
      type: { type: "string" },
      goal: { type: "string" },
      criteria: { type: "string", multiple: true },
      depends: { type: "string", multiple: true },
    });
    if (!positionals.length || !values.type) throw new UsageError("thread new needs <title> --type <type>");
    return send(root, env, {
      cmd: "thread.new",
      title: positionals.join(" "),
      type: values.type,
      goal: values.goal ?? "",
      criteria: values.criteria ?? [],
      dependsOn: values.depends ?? [],
    });
  }
  if (sub === "status") {
    const { values, positionals } = parse(args, { reason: { type: "string" } });
    const [id, status] = positionals;
    if (!id || !status) throw new UsageError("thread status needs <id> <status>");
    return send(root, env, { cmd: "thread.status", thread: id, status, reason: values.reason });
  }
  throw new UsageError(`unknown thread subcommand '${sub ?? ""}'`);
}

async function ticket(sub: string | undefined, args: string[], root: string, env: Env): Promise<number> {
  switch (sub) {
    case "add": {
      const { values, positionals } = parse(args, { scope: { type: "string", multiple: true } });
      const [threadId, ...title] = positionals;
      if (!threadId || !title.length) throw new UsageError("ticket add needs <thread> <title> --scope <path>");
      return send(root, env, { cmd: "ticket.add", thread: threadId, title: title.join(" "), scope: values.scope ?? [] });
    }
    case "claim":
    case "reopen":
      return send(root, env, { cmd: `ticket.${sub}`, ...parseTicketRef(args[0]) });
    case "done": {
      const { values, positionals } = parse(args, { summary: { type: "string" } });
      return send(root, env, { cmd: "ticket.done", ...parseTicketRef(positionals[0]), summary: values.summary });
    }
    case "block": {
      const { values, positionals } = parse(args, { reason: { type: "string" } });
      return send(root, env, { cmd: "ticket.block", ...parseTicketRef(positionals[0]), reason: values.reason ?? "" });
    }
    default:
      throw new UsageError(`unknown ticket subcommand '${sub ?? ""}'`);
  }
}

async function daemon(sub: string | undefined, root: string, env: Env): Promise<number> {
  const p = paths(root);
  switch (sub) {
    case "run": {
      const d = await startDaemon(root);
      process.on("SIGTERM", () => void d.stop());
      process.on("SIGINT", () => void d.stop());
      await d.closed;
      return 0;
    }
    case "start": {
      if (await isAlive(p.socket)) {
        console.log("daemon already running");
        return 0;
      }
      const spawned = Bun.spawnSync(
        ["/bin/sh", "-c", 'nohup "$0" "$1" daemon run >>"$2" 2>&1 &', process.execPath, Bun.main, p.daemonLog],
        { env: { ...env, AGT_ROOT: root } },
      );
      if (spawned.exitCode !== 0) throw new Error("failed to launch daemon");
      for (let i = 0; i < 50; i++) {
        if (await isAlive(p.socket)) {
          console.log("daemon started");
          return 0;
        }
        await Bun.sleep(100);
      }
      throw new Error(`daemon failed to start; see ${p.daemonLog}`);
    }
    case "stop": {
      if (!(await isAlive(p.socket))) {
        console.log("daemon not running");
        return 0;
      }
      await request(p.socket, { op: "shutdown" });
      for (let i = 0; i < 50 && (await isAlive(p.socket)); i++) await Bun.sleep(100);
      console.log("daemon stopped");
      return 0;
    }
    case "status": {
      try {
        const res = await request(p.socket, { op: "ping" }, 1_000);
        if (res.ok) {
          console.log(`running (pid ${(res.result as { pid: number }).pid})`);
          return 0;
        }
      } catch {
        // fall through
      }
      console.log("not running");
      return 1;
    }
    default:
      throw new UsageError(`unknown daemon subcommand '${sub ?? ""}'`);
  }
}

async function logs(root: string, follow: boolean): Promise<number> {
  const socket = paths(root).socket;
  let seq = 0;
  while (true) {
    const res = await request(socket, { op: "events.since", seq });
    if (!res.ok) throw new Error(res.error);
    for (const e of res.result as StoredEvent[]) {
      const who = e.actor.session ? `${e.actor.role}:${e.actor.session}` : e.actor.role;
      console.log(`${e.seq} ${e.ts} ${e.type} ${e.thread ?? "-"} ${who}`);
      seq = e.seq;
    }
    if (!follow) return 0;
    await Bun.sleep(500);
  }
}
```

Create `bin/agt`:

```ts
#!/usr/bin/env bun
import { main } from "../src/cli/main.ts";

process.exit(await main(process.argv.slice(2)));
```

Run: `chmod +x bin/agt`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/cli && bun run typecheck`
Expected: PASS. Then check that no daemons leaked: `pgrep -fl "agt daemon run"` should print nothing.

- [ ] **Step 5: Commit**

```bash
git add src/cli bin/agt tests/cli
git commit -m "feat: add agt CLI"
```

---

### Task 9: End-to-end scenario

**Files:**
- Test: `tests/e2e/flow.test.ts`

**Interfaces:**
- Consumes: the `agt` binary from Task 8.
- Produces: a regression test covering the full single-machine flow from spec §6.1–6.3.

- [ ] **Step 1: Write the scenario test**

Create `tests/e2e/flow.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempRepo } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");
let root: string;

function agt(args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AGT_ROOT: root, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`agt ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const read = (rel: string) => readFileSync(join(root, ".agentthread", rel), "utf8");
const coord = (thread: string) => ({ AGT_ROLE: "coordinator", AGT_THREAD: thread, AGT_SESSION: `c${thread}` });
const worker = (thread: string, session: string) => ({ AGT_ROLE: "worker", AGT_THREAD: thread, AGT_SESSION: session });

beforeAll(() => {
  root = tempRepo();
  agt(["init", "--name", "shop"]);
  agt(["daemon", "start"]);
});

afterAll(() => {
  agt(["daemon", "stop"]);
});

test("feature → dependent bugfix → review → done unblocks dependent", () => {
  agt(["thread", "new", "OAuth login", "--type", "feature", "--goal", "Google login", "--criteria", "login works"], {
    AGT_ROLE: "main",
  });
  agt(["thread", "new", "Fix session race", "--type", "bug", "--depends", "001"]);
  expect(read("main.thread.md")).toContain("| 002 | Fix session race | bug | blocked | 0/0 | 001 |");

  agt(["thread", "status", "001", "in_progress"], coord("001"));
  agt(["ticket", "add", "001", "Backend", "--scope", "src/auth"], coord("001"));
  agt(["ticket", "add", "001", "Button", "--scope", "src/ui/login.tsx"], coord("001"));
  agt(["ticket", "claim", "001/T1"], worker("001", "w1"));
  agt(["ticket", "claim", "001/T2"], worker("001", "w2"));
  agt(["ticket", "done", "001/T1"], worker("001", "w1"));
  agt(["ticket", "done", "001/T2"], worker("001", "w2"));
  agt(["decide", "001", "use PKCE"], coord("001"));

  const handoff = join(root, "h.md");
  writeFileSync(handoff, "## Goal status\ndone\n## Work done\nT1, T2\n## Decisions\nPKCE\n## Next steps\nreview\n## Risks\nnone");
  agt(["handoff", "001", "--file", handoff], coord("001"));
  agt(["thread", "status", "001", "review"], coord("001"));
  expect(read("main.thread.md")).toContain("- 001: awaiting review");

  agt(["thread", "status", "001", "done"]);
  expect(read("main.thread.md")).toContain("| 001 | OAuth login | feature | done | 2/2 | - |");
  expect(read("main.thread.md")).toContain("| 002 | Fix session race | bug | open | 0/0 | 001 |");

  const sub = read("threads/001-oauth-login/sub.thread.md");
  expect(sub).toContain("- [ ] login works");
  expect(sub).toContain("### Decisions");
  expect(read("threads/001-oauth-login/board.md")).toContain("| T2 | Button | src/ui/login.tsx | done | w2 |");
  expect(read("threads/001-oauth-login/log.md")).toContain("[coordinator:c001] decision: use PKCE");
});
```

- [ ] **Step 2: Run the scenario**

Run: `bun test tests/e2e`
Expected: PASS. If it fails, the failing `agt` call's stderr is in the error message. Fix the owning task's code, not the scenario.

- [ ] **Step 3: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: all tests PASS, typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e
git commit -m "test: add end-to-end thread lifecycle scenario"
```
