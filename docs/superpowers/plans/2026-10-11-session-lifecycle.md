# AgentThread Session Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep coordinators healthy over long-running threads. A coordinator rotates to a fresh session when its context fills up or Claude compacts it, after handing off in writing (or after a generated handoff if it does not respond). A coordinator whose agent disappeared is resumed with `claude --resume` when its saved session exists, and replaced by a fresh one reading the handoff when it does not. A lost worker releases its ticket.

**Architecture:** Extends the event-sourced core and the pure reactor from Plan 3:
- **Rotation.** `session.compacting` or a high context reading on `agent.idle` emits `session.rotation_requested`. That queues a fixed-template handoff request to the coordinator. When it submits `agt handoff --stdin`, the reactor emits `session.rotated`, spawns a replacement coordinator (split from the old pane), and closes the old pane once the new one attaches.
- **Handoff timeout.** A time-based `sweep()` runs every 15s and writes a generated handoff when the coordinator misses `session.handoff.timeout`.
- **Recovery.** `agt start` reconcile probes every live agent pane with `herdr agent get`. A missing agent becomes `session.lost`.
  - A lost coordinator is resumed (`session.resuming` plus `claude --resume <id>`) if its transcript file exists. Otherwise `session.resume_failed` leads to a generated handoff (if none exists) and a fresh coordinator.
  - A lost worker releases its ticket back to `open` and frees its slot.
- **Context.** `agt event idle` reads the Stop hook's `transcript_path` and reports the context size (input + cache tokens of the last assistant message).

**Tech Stack:** TypeScript on Bun ≥ 1.1.34, `bun:test`, Herdr CLI (`agent get`), Claude Code CLI (`--resume <id>`, hook stdin `transcript_path` / `source`, transcripts at `$CLAUDE_CONFIG_DIR/projects/<cwd with every non-alphanumeric char replaced by "-">/<id>.jsonl`).

**Spec:** `docs/specs/2026-10-09-agentthread-design.md` §6.4 (session lifecycle, resume, lost fallback), §6.5 (rotation triggers, deterministic handoff with a generated fallback). Follow-ups: `docs/superpowers/followups/2026-10-10-claude-code-agents.md`.

### Roadmap position

Plan 4 of 5. Plans 1–3 are merged. Plan 5 adds the OpenCode adapter.

### Spec adjustments made in this plan

- **Rotation applies to coordinators only.** Workers live for one ticket (spec §6.3), and the main manager is user-facing and is not rotated automatically.
- **"rotating" is a flag, not a status.** A session keeps `idle`/`active` so notices can still be delivered while a rotation is pending, which is how the handoff request reaches it. Renderers show `rotating` while the flag is set. Status values become `starting | active | idle | rotated | ended | failed | lost`.
- **The idle-timeout trigger rotates immediately** with a generated handoff, without asking the stale session. This happens when the next notice for a coordinator arrives and the coordinator has been idle longer than `session.rotation.idle_timeout`.
- **Context threshold:** `contextTokens / session.rotation.context_window ≥ session.rotation.context_threshold`. A new config key `session.rotation.context_window` defaults to 200000.
- **The handoff is submitted with `agt handoff <thread> --stdin`** (heredoc). That way the agent needs no file outside its worktree, and the existing `Bash(agt *)` allowlist covers it.
- **The Claude config dir is resolved** as `agents.claude.config_dir` (new optional key), then `$CLAUDE_CONFIG_DIR`, then `~/.claude`. The resolved dir is passed to every pane we create as `CLAUDE_CONFIG_DIR`, so agents and the daemon agree on where transcripts live.
- **A `SessionStart` hook with `source: "compact"`** puts the session in `idle` (a manual `/compact` leaves Claude at an empty prompt). `/clear` starts a new Claude session id, which is still not tracked; this is documented and deferred.
- **Plan 3 follow-up folded in:** the coordinator prompt now says to `agt worker spawn` again after reopening a blocked ticket.

## Global Constraints

- Bun ≥ 1.1.34, TypeScript `strict: true`. Always run tests as `env -u HERDR_ENV -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID -u HERDR_PANE_ID -u AGT_HERDR_IT bun test` and run `bun run typecheck` before each commit.
- Never run the real `herdr` or `claude` binaries, or `agt start` outside tests. Leave no `agt daemon run` / `agt __spawn` processes behind.
- New event types exactly: `session.rotation_requested`, `session.rotated`, `session.lost`, `session.resume_failed`, `session.resuming`, `ticket.released`, `thread.root_pane_changed`. The payload of `session.started | session.active | agent.idle | session.compacting | session.ended` becomes `{ session; source?; contextTokens? }`. `session.created` gains `replaces?`.
- Session statuses: `starting | active | idle | rotated | ended | failed | lost`. A session is live unless it is `rotated`, `ended`, `failed` or `lost`.
- Config additions: `session.rotation.context_window` (int ≥ 1000, default 200000) and `agents.claude.config_dir` (optional string). Durations use the existing `^\d+[smhd]$` format.
- Claude args:
  - A fresh spawn is unchanged.
  - A resume replaces `--session-id <id>` with `--resume <id>` in the same position; everything else is unchanged.
- Transcript path: `<configDir>/projects/<cwd.replace(/[^a-zA-Z0-9]/g, "-")>/<session>.jsonl`.
- Context tokens come from the last assistant entry of the transcript: `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Read at most the last 256 KiB.
- Bootstrap texts exactly:
  - start (unchanged): `Start coordinating thread <id>. Read <dir>/sub.thread.md and <dir>/board.md now.`
  - handoff: `Continue coordinating thread <id> as its new coordinator. Read the Handoff section of <dir>/sub.thread.md first, then <dir>/board.md.`
  - resume: `You were resumed after an interruption. Re-read <dir>/sub.thread.md and <dir>/board.md, then continue coordinating thread <id>.`
- The handoff request text starts with the line `HANDOFF REQUEST: your coordinator session for thread <id> is being rotated (<reason>).` Notices starting with `HANDOFF REQUEST:` are never carried over to a replacement session.
- The sweep interval defaults to 15000 ms (daemon option `sweepIntervalMs`).

## Review Focus

1. **Exactly one coordinator per thread across rotation and recovery.**
   - A tab reopen that comes with a probe-detected loss must resume once and must not also spawn a fresh coordinator.
   - A generated handoff after resume failure must not trigger a second rotation.

   Tests in Tasks 4, 5 and 6.
2. **No notice is lost across rotation.** Undelivered notices move to the replacement; handoff requests do not. Test in Task 4.
3. **Rotation is requested at most once per session.** Repeated `compacting` or high-context idles while a rotation is pending must not queue more handoff requests. Test in Task 4.
4. **A lost worker never leaves its ticket stuck.** An `in_progress` ticket it held goes back to `open`, the coordinator is told, and its slot is freed. Test in Task 5.
5. **Hooks stay cheap and safe.** `agt event idle` with a missing, huge or garbage transcript still exits 0 within the 3s budget and simply omits `contextTokens`. Test in Task 3.

---

## File structure

```
src/config/config.ts               # (modify) context_window, claude.config_dir, durationMs()
src/domain/types.ts                # (modify) new events, payload fields
src/state/projection.ts            # (modify) statuses, Session fields, displayStatus(), new event handling
src/render/markdown.ts             # (modify) displayStatus in frontmatter and main table, context_tokens
src/orchestration/handoff.ts       # generateHandoff()
src/orchestration/sessions.ts      # (modify) spawnReplacement(), rotateCoordinator()
src/orchestration/reactor.ts       # (modify) rotation + recovery rules
src/orchestration/sweep.ts         # sweep(): handoff timeouts
src/agents/prompts.ts              # (modify) handoffRequestPrompt(), bootstrap kinds, coordinator prompt tweak
src/agents/claude.ts               # (modify) claudeConfigDir, claudeSessionFile, resume args, CLAUDE_CONFIG_DIR env
src/agents/transcript.ts           # contextTokensFromTranscript()
src/commands/schema.ts, handler.ts # (modify) session.signal fields, reconcile probes, Effect members
src/herdr/bridge.ts                # (modify) agentExists()
src/daemon/effects.ts              # (modify) session.probe, resume spawn, bootstrap kinds, env
src/daemon/server.ts               # (modify) sweep timer, shared apply-and-react
src/cli/main.ts                    # (modify) agt handoff --stdin, agt event sends source/contextTokens
tests/fixtures/fake-herdr.ts       # (modify) agent get, agentPanes
```

---

### Task 1: Config and domain (events, statuses, rendering)

**Files:**
- Modify: `src/config/config.ts`, `src/domain/types.ts`, `src/state/projection.ts`, `src/render/markdown.ts`
- Modify: `tests/config/config.test.ts`
- Test: `tests/state/lifecycle.test.ts`, plus an addition to `tests/render/markdown.test.ts`

**Interfaces:**
- Produces:
  - In config:
    - `config.session.rotation.context_window: number`
    - `config.agents.claude.config_dir?: string`
    - `durationMs(d: string): number`, which throws `invalid duration <d>`
  - In types:
    - The shared signal-event payload is `{ session: string; source?: string; contextTokens?: number }`.
    - `session.created` payload: `replaces?: string`.
    - New members:
      - `{ type: "session.rotation_requested"; thread?: string; payload: { session: string; reason: string } }`
      - `{ type: "session.rotated" | "session.lost" | "session.resume_failed"; thread?: string; payload: { session: string; reason: string } }`
      - `{ type: "session.resuming"; thread?: string; payload: { session: string } }`
      - `{ type: "ticket.released"; thread: string; payload: { ticket: string; reason: string } }`
      - `{ type: "thread.root_pane_changed"; thread: string; payload: { pane: string } }`
  - In the projection:
    - `SessionStatus` adds `rotated | lost`.
    - `Session` gains `lastActiveAt?: string; contextTokens?: number; rotation?: { reason: string; requestedAt: string }; replaces?: string`.
    - `isLive` now excludes `rotated` and `lost`.
    - `displayStatus(s: Session): string` returns `"rotating"` when `s.rotation` is set and the session is live, and `s.status` otherwise.
  - Projection rules:
    - **Activity signals:**
      - `session.started` sets `idle` when the status was `starting` or `payload.source === "compact"`, and `active` otherwise.
      - `session.active`, `session.started`, `agent.idle` and `notice.delivered` set `lastActiveAt = ev.ts`.
      - `agent.idle` stores `contextTokens` when present.
    - **Rotation and endings:**
      - `session.rotation_requested` sets `rotation` (only if live and none is set). Its note is `session <id8> rotation requested (<reason>)`.
      - `session.rotated` sets status `rotated` and clears `rotation` (only if live). Its note is `session <id8> rotated (<reason>)`.
      - `session.lost` sets status `lost` (only if live). Its note is `session <id8> lost: <reason>`.
      - `session.resume_failed` sets status `lost`. Its note is `session <id8> could not be resumed: <reason>`.
      - `session.resuming` applies only to a `lost` session: it sets status `starting` and deletes `pane`. Its note is `session <id8> resuming`.
    - **Threads and tickets:**
      - `ticket.released` sets the ticket to `open` and deletes its assignee. Its note is `<T> released: <reason>`.
      - `thread.root_pane_changed` sets `rootPane`. Its note is `root pane is now <pane>`.
  - Rendering:
    - The frontmatter session `status` uses `displayStatus`, and `context_tokens` is added when known.
    - The main table's Coordinator column uses `displayStatus`.

- [ ] **Step 1: Write the failing tests**

In `tests/config/config.test.ts`, change the expected defaults so that `rotation` is `{ on_precompact: true, context_threshold: 0.7, idle_timeout: "24h", context_window: 200000 }`. Then append:

```ts
test("durationMs", async () => {
  const { durationMs } = await import("../../src/config/config.ts");
  expect([durationMs("30s"), durationMs("5m"), durationMs("24h"), durationMs("2d")]).toEqual([30_000, 300_000, 86_400_000, 172_800_000]);
  expect(() => durationMs("soon")).toThrow("invalid duration soon");
});
```

Create `tests/state/lifecycle.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { EventBody } from "../../src/domain/types.ts";
import { displayStatus, isLive } from "../../src/state/projection.ts";
import { INIT, stateOf, threadCreated } from "../helpers.ts";

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const W = "11111111-1111-4111-8111-111111111111";
const coord: EventBody = { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } };
const at = (pane: string): EventBody => ({ type: "session.attached", thread: "001", payload: { session: C, pane } });

test("activity tracking, compact start, context tokens", () => {
  const s = stateOf(
    INIT, threadCreated("001"), coord, at("w1:p2"),
    { type: "session.started", thread: "001", payload: { session: C } },
    { type: "session.active", thread: "001", payload: { session: C } },
    { type: "agent.idle", thread: "001", payload: { session: C, contextTokens: 150_000 } },
    { type: "session.active", thread: "001", payload: { session: C } },
    { type: "session.started", thread: "001", payload: { session: C, source: "compact" } },
  );
  const c = s.sessions.get(C)!;
  expect(c.status).toBe("idle");
  expect(c.contextTokens).toBe(150_000);
  expect(c.lastActiveAt).toBe("2026-10-09T10:00:08.000Z");
});

test("rotation request is set once and shown as rotating; rotated is not live", () => {
  const s = stateOf(
    INIT, threadCreated("001"), coord,
    { type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "precompact" } },
    { type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "context" } },
  );
  const c = s.sessions.get(C)!;
  expect(c.rotation).toEqual({ reason: "precompact", requestedAt: "2026-10-09T10:00:03.000Z" });
  expect(displayStatus(c)).toBe("rotating");
  const r = stateOf(INIT, threadCreated("001"), coord, { type: "session.rotated", thread: "001", payload: { session: C, reason: "precompact" } });
  expect(r.sessions.get(C)!.status).toBe("rotated");
  expect(isLive(r.sessions.get(C)!)).toBe(false);
  expect(r.threads.get("001")!.log.at(-1)!.message).toBe("session cccccccc rotated (precompact)");
});

test("lost → resuming clears the pane; resume_failed is lost again", () => {
  const s = stateOf(
    INIT, threadCreated("001"), coord, at("w1:p2"),
    { type: "session.lost", thread: "001", payload: { session: C, reason: "no agent in pane w1:p2" } },
    { type: "session.resuming", thread: "001", payload: { session: C } },
  );
  expect(s.sessions.get(C)).toMatchObject({ status: "starting", pane: undefined });
  const f = stateOf(
    INIT, threadCreated("001"), coord,
    { type: "session.lost", thread: "001", payload: { session: C, reason: "x" } },
    { type: "session.resuming", thread: "001", payload: { session: C } },
    { type: "session.resume_failed", thread: "001", payload: { session: C, reason: "no saved Claude session" } },
  );
  expect(f.sessions.get(C)!.status).toBe("lost");
  expect(f.threads.get("001")!.log.at(-1)!.message).toBe("session cccccccc could not be resumed: no saved Claude session");
});

test("ticket released and root pane changed; replaces is stored", () => {
  const s = stateOf(
    INIT, threadCreated("001"),
    { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "x", scope: ["a"] } },
    { type: "ticket.claimed", thread: "001", payload: { ticket: "T1", assignee: W } },
    { type: "ticket.released", thread: "001", payload: { ticket: "T1", reason: "worker session lost" } },
    { type: "thread.root_pane_changed", thread: "001", payload: { pane: "w1:p9" } },
    { type: "session.created", thread: "001", payload: { session: W, role: "coordinator", agent: "claude-code", name: "c2", replaces: C } },
  );
  const t = s.threads.get("001")!;
  expect(t.tickets[0]).toEqual({ id: "T1", title: "x", scope: ["a"], status: "open" });
  expect(t.rootPane).toBe("w1:p9");
  expect(s.sessions.get(W)!.replaces).toBe(C);
});
```

Append to `tests/render/markdown.test.ts`:

```ts
test("rotating sessions and context tokens are rendered", () => {
  const S = "44444444-4444-4444-8444-444444444444";
  const s = stateOf(
    INIT,
    threadCreated("001"),
    { type: "session.created", thread: "001", payload: { session: S, role: "coordinator", agent: "claude-code", name: "c" } },
    { type: "agent.idle", thread: "001", payload: { session: S, contextTokens: 1234 } },
    { type: "session.rotation_requested", thread: "001", payload: { session: S, reason: "context" } },
  );
  const fm = parse(renderSub(s.threads.get("001")!, [...s.sessions.values()]).split("---\n")[1]!);
  expect(fm.sessions[0]).toMatchObject({ status: "rotating", context_tokens: 1234 });
  expect(renderMain(s)).toContain("| rotating |");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `env -u HERDR_ENV -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID -u HERDR_PANE_ID -u AGT_HERDR_IT bun test tests/config tests/state tests/render`
Expected: FAIL. `durationMs` and `displayStatus` are missing, and the new events are unknown.

- [ ] **Step 3: Implement config**

In `src/config/config.ts`:
- add `context_window: z.number().int().min(1000).default(200_000),` inside `session.rotation`
- add `config_dir: z.string().trim().min(1).optional(),` inside `agents.claude`
- add:

```ts
export function durationMs(d: string): number {
  const m = /^(\d+)([smhd])$/.exec(d);
  if (!m) throw new Error(`invalid duration ${d}`);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return Number(m[1]) * unit;
}
```

- [ ] **Step 4: Extend types**

In `src/domain/types.ts`:
- change the payload of the `"session.started" | "session.active" | "agent.idle" | "session.compacting" | "session.ended"` member to `{ session: string; source?: string; contextTokens?: number }`
- add `replaces?: string` to the `session.created` payload
- add the five new members listed in Interfaces.

- [ ] **Step 5: Extend the projection**

In `src/state/projection.ts`:
- Change `SessionStatus` to `"starting" | "active" | "idle" | "rotated" | "ended" | "failed" | "lost"`.
- Add `lastActiveAt?: string; contextTokens?: number; rotation?: { reason: string; requestedAt: string }; replaces?: string;` to `Session`.
- Change `isLive` to:

```ts
export function isLive(s: Session): boolean {
  return s.status !== "ended" && s.status !== "failed" && s.status !== "rotated" && s.status !== "lost";
}

export function displayStatus(s: Session): string {
  return s.rotation && isLive(s) ? "rotating" : s.status;
}
```

- In `applySessionEvent`:
  - in `session.created`, add `...(p.replaces ? { replaces: p.replaces } : {}),` to the new session object
  - replace the `session.started` / `session.active` case with:

```ts
    case "session.started":
    case "session.active": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      if (isLive(s)) {
        // A first start, or a manual /compact, leaves the agent at an empty prompt: no turn runs, so no Stop hook follows.
        const atPrompt = ev.type === "session.started" && (s.status === "starting" || ev.payload.source === "compact");
        s.status = atPrompt ? "idle" : "active";
        s.lastActiveAt = ev.ts;
      }
      return true;
    }
```

  - in `agent.idle`, inside `if (isLive(s))`, add `s.lastActiveAt = ev.ts;` and `if (ev.payload.contextTokens !== undefined) s.contextTokens = ev.payload.contextTokens;`
  - in `notice.delivered`, add `s.lastActiveAt = ev.ts;` inside the live branch
  - add the new cases:

```ts
    case "session.rotation_requested": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      if (isLive(s) && !s.rotation) {
        s.rotation = { reason: ev.payload.reason, requestedAt: ev.ts };
        threadNote(state, ev, `session ${short(s.id)} rotation requested (${ev.payload.reason})`);
      }
      return true;
    }
    case "session.rotated": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      if (isLive(s)) {
        s.status = "rotated";
        delete s.rotation;
        threadNote(state, ev, `session ${short(s.id)} rotated (${ev.payload.reason})`);
      }
      return true;
    }
    case "session.lost": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      if (isLive(s)) {
        s.status = "lost";
        threadNote(state, ev, `session ${short(s.id)} lost: ${ev.payload.reason}`);
      }
      return true;
    }
    case "session.resume_failed":
      sessionOf(state, ev.seq, ev.payload.session).status = "lost";
      threadNote(state, ev, `session ${short(ev.payload.session)} could not be resumed: ${ev.payload.reason}`);
      return true;
    case "session.resuming": {
      const s = sessionOf(state, ev.seq, ev.payload.session);
      if (s.status === "lost") {
        s.status = "starting";
        delete s.pane;
        threadNote(state, ev, `session ${short(s.id)} resuming`);
      }
      return true;
    }
```

- Add to the thread `switch`:

```ts
    case "ticket.released": {
      const k = ticket(ev.payload.ticket);
      k.status = "open";
      delete k.assignee;
      note(t, ev, `${k.id} released: ${ev.payload.reason}`);
      break;
    }
    case "thread.root_pane_changed":
      t.rootPane = ev.payload.pane;
      note(t, ev, `root pane is now ${ev.payload.pane}`);
      break;
```

- [ ] **Step 6: Render**

In `src/render/markdown.ts`:
- import `displayStatus`
- in `renderMain`, use `live.find((s) => s.role === "coordinator")` → `displayStatus(...)` (or `-`) for the Coordinator column
- in `renderSub` sessions, use `status: displayStatus(s),` and add `...(s.contextTokens !== undefined ? { context_tokens: s.contextTokens } : {}),`

- [ ] **Step 7: Verify and commit**

Run the full suite and typecheck → PASS.

```bash
git add src/config src/domain src/state src/render tests/config tests/state/lifecycle.test.ts tests/render/markdown.test.ts
git commit -m "feat: model rotation, loss and resume in the session domain"
```

---

### Task 2: Handoff tooling and prompts

**Files:**
- Create: `src/orchestration/handoff.ts`
- Modify: `src/agents/prompts.ts`, `src/cli/main.ts` (`handoff --stdin`)
- Test: `tests/orchestration/handoff.test.ts`, update `tests/agents/claude.test.ts`, add to `tests/cli/agents.test.ts`

**Interfaces:**
- Consumes: `Thread`, `validateHandoff`.
- Produces:
  - `generateHandoff(t: Thread, why: string): string`. It always passes `validateHandoff`, with these sections:
    - `## Goal status`: `Thread <id> ("<title>") is <status>.` plus `Goal: <goal or "not set">.`, followed by `Acceptance criteria:` and the criteria as `- <c>`, or `- none recorded`.
    - `## Work done`: `- <T> <title>` for each done ticket, or `No ticket is done yet.`
    - `## Decisions`: `- <message>` for each decision, or `No decisions recorded.`
    - `## Next steps`: `- <T> <title> (<status>)` for each ticket that is not done, or `No open tickets; check the acceptance criteria and move the thread to review.`
    - `## Risks`: `- This handoff was generated by AgentThread because <why>; it may miss context the previous coordinator had.` followed by `- <T> is blocked.` for each blocked ticket.
  - `HANDOFF_REQUEST_PREFIX = "HANDOFF REQUEST:"` and `handoffRequestPrompt(o: { root: string; thread: { id; title; slug; worktree }; reason: string }): string`
  - `bootstrapPrompt(o, kind: "start" | "handoff" | "resume" = "start")`. Workers and main ignore `kind`.
  - Coordinator system prompt changes:
    - the blocked-ticket line becomes `- If a ticket is blocked, fix the cause, or reopen it with agt ticket reopen <id>/<T> and start a new worker for it with agt worker spawn <id> --ticket <T>.`
    - a new rule is added: `- If you receive a HANDOFF REQUEST, write the handoff exactly as instructed and then stop.`
  - CLI: `agt handoff <thread> (--file <path> | --stdin)`. Exactly one of the two is required; otherwise it is a usage error, exit 2.

- [ ] **Step 1: Write the failing tests**

Create `tests/orchestration/handoff.test.ts`:

```ts
import { expect, test } from "bun:test";
import { validateHandoff } from "../../src/domain/rules.ts";
import { generateHandoff } from "../../src/orchestration/handoff.ts";
import { HANDOFF_REQUEST_PREFIX, handoffRequestPrompt, bootstrapPrompt } from "../../src/agents/prompts.ts";
import { INIT, stateOf, threadCreated } from "../helpers.ts";

const T = { id: "002", title: "Fix race", slug: "fix-race", worktree: "/repo/.worktrees/002-fix-race" };
const DIR = "/repo/.agentthread/threads/002-fix-race";

test("generated handoff is valid and summarizes the board", () => {
  const s = stateOf(
    INIT,
    threadCreated("002", { title: "Fix race", goal: "no double charge", criteria: ["test passes"], status: "in_progress" }),
    { type: "ticket.created", thread: "002", payload: { ticket: "T1", title: "Repro", scope: ["a"] } },
    { type: "ticket.created", thread: "002", payload: { ticket: "T2", title: "Fix", scope: ["b"] } },
    { type: "ticket.claimed", thread: "002", payload: { ticket: "T1", assignee: "w" } },
    { type: "ticket.completed", thread: "002", payload: { ticket: "T1" } },
    { type: "ticket.claimed", thread: "002", payload: { ticket: "T2", assignee: "w2" } },
    { type: "ticket.blocked", thread: "002", payload: { ticket: "T2", reason: "no key" } },
    { type: "decision.recorded", thread: "002", payload: { message: "use a mutex" } },
  );
  const md = generateHandoff(s.threads.get("002")!, "the coordinator did not answer");
  expect(validateHandoff(md)).toEqual({ ok: true });
  for (const line of [
    'Thread 002 ("Fix race") is in_progress.',
    "Goal: no double charge.",
    "- test passes",
    "- T1 Repro",
    "- use a mutex",
    "- T2 Fix (blocked)",
    "because the coordinator did not answer",
    "- T2 is blocked.",
  ]) {
    expect(md).toContain(line);
  }
});

test("empty thread still yields every section", () => {
  const md = generateHandoff(stateOf(INIT, threadCreated("001")).threads.get("001")!, "x");
  expect(validateHandoff(md)).toEqual({ ok: true });
  expect(md).toContain("No ticket is done yet.");
  expect(md).toContain("- none recorded");
});

test("handoff request and bootstrap kinds", () => {
  const p = handoffRequestPrompt({ root: "/repo", thread: T, reason: "precompact" });
  expect(p.startsWith(`${HANDOFF_REQUEST_PREFIX} your coordinator session for thread 002 is being rotated (precompact).`)).toBe(true);
  for (const s of ["agt handoff 002 --stdin <<'EOF'", "## Goal status", "## Work done", "## Decisions", "## Next steps", "## Risks", "EOF"]) expect(p).toContain(s);
  const o = { root: "/repo", role: "coordinator" as const, thread: T };
  expect(bootstrapPrompt(o)).toBe(`Start coordinating thread 002. Read ${DIR}/sub.thread.md and ${DIR}/board.md now.`);
  expect(bootstrapPrompt(o, "handoff")).toBe(
    `Continue coordinating thread 002 as its new coordinator. Read the Handoff section of ${DIR}/sub.thread.md first, then ${DIR}/board.md.`,
  );
  expect(bootstrapPrompt(o, "resume")).toBe(
    `You were resumed after an interruption. Re-read ${DIR}/sub.thread.md and ${DIR}/board.md, then continue coordinating thread 002.`,
  );
});
```

In `tests/agents/claude.test.ts`, in the coordinator-prompt test, add `"agt worker spawn 002 --ticket <T>"` and `"HANDOFF REQUEST"` to the expected substrings.

Append to `tests/cli/agents.test.ts`:

```ts
test("agt handoff --stdin", () => {
  agt(["start", "--no-manager"]);
  agt(["thread", "new", "X", "--type", "bug"]);
  const content = ["Goal status", "Work done", "Decisions", "Next steps", "Risks"].map((s) => `## ${s}\nx`).join("\n");
  expect(agt(["handoff", "001", "--stdin"], { AGT_ROLE: "coordinator", AGT_THREAD: "001" }, content)).toMatchObject({ code: 0, out: "ok" });
  expect(agt(["handoff", "001"], { AGT_ROLE: "coordinator", AGT_THREAD: "001" }).code).toBe(2);
});
```

- [ ] **Step 2: Run to verify failure**

Run the three test files. Expected: FAIL. The module is missing, the exports are missing, and `--stdin` is unknown.

- [ ] **Step 3: Implement `generateHandoff`**

Create `src/orchestration/handoff.ts`:

```ts
import type { Thread } from "../state/projection.ts";

const oneLine = (s: string) => s.replace(/\r?\n+/g, " ").trim();
const list = (items: string[], none: string) => (items.length ? items.join("\n") : none);

/** A deterministic handoff assembled from the thread's recorded state, used when the coordinator cannot write one. */
export function generateHandoff(t: Thread, why: string): string {
  const done = t.tickets.filter((k) => k.status === "done");
  const rest = t.tickets.filter((k) => k.status !== "done");
  const blocked = t.tickets.filter((k) => k.status === "blocked");
  return [
    "## Goal status",
    `Thread ${t.id} ("${oneLine(t.title)}") is ${t.status}. Goal: ${oneLine(t.goal) || "not set"}.`,
    "Acceptance criteria:",
    list(t.criteria.map((c) => `- ${oneLine(c)}`), "- none recorded"),
    "## Work done",
    list(done.map((k) => `- ${k.id} ${oneLine(k.title)}`), "No ticket is done yet."),
    "## Decisions",
    list(t.decisions.map((d) => `- ${oneLine(d.message)}`), "No decisions recorded."),
    "## Next steps",
    list(rest.map((k) => `- ${k.id} ${oneLine(k.title)} (${k.status})`), "No open tickets; check the acceptance criteria and move the thread to review."),
    "## Risks",
    `- This handoff was generated by AgentThread because ${why}; it may miss context the previous coordinator had.`,
    ...blocked.map((k) => `- ${k.id} is blocked.`),
  ].join("\n");
}
```

- [ ] **Step 4: Prompts**

In `src/agents/prompts.ts`:
- replace the coordinator line `` `- If a ticket is blocked, fix the cause or reopen it with agt ticket reopen ${t.id}/<T>.` `` with `` `- If a ticket is blocked, fix the cause, or reopen it with agt ticket reopen ${t.id}/<T> and start a new worker for it with agt worker spawn ${t.id} --ticket <T>.` ``
- add the line `"- If you receive a HANDOFF REQUEST, write the handoff exactly as instructed and then stop."` as the last coordinator rule
- add:

```ts
export const HANDOFF_REQUEST_PREFIX = "HANDOFF REQUEST:";

export function handoffRequestPrompt(o: { root: string; thread: { id: string; title: string; slug: string; worktree: string }; reason: string }): string {
  const id = o.thread.id;
  return [
    `${HANDOFF_REQUEST_PREFIX} your coordinator session for thread ${id} is being rotated (${o.reason}).`,
    "Write a handoff for the coordinator who continues after you, and submit it with this exact command shape:",
    `agt handoff ${id} --stdin <<'EOF'`,
    "## Goal status",
    "<where the thread stands against its goal and acceptance criteria>",
    "## Work done",
    "<what is finished, with ticket ids>",
    "## Decisions",
    "<decisions and why>",
    "## Next steps",
    "<what to do next, in order>",
    "## Risks",
    "<open risks, blocked tickets, things to double-check>",
    "EOF",
    "Every section must have content. When the command prints ok, stop: a new coordinator takes over from your handoff.",
  ].join("\n");
}
```

- change `bootstrapPrompt` to:

```ts
export function bootstrapPrompt(o: PromptInput, kind: "start" | "handoff" | "resume" = "start"): string {
  if (o.role === "main") return "";
  const dir = threadDir(o);
  const id = o.thread!.id;
  if (o.role === "worker") return `Start ticket ${o.ticket} of thread ${id} now.`;
  if (kind === "handoff") return `Continue coordinating thread ${id} as its new coordinator. Read the Handoff section of ${dir}/sub.thread.md first, then ${dir}/board.md.`;
  if (kind === "resume") return `You were resumed after an interruption. Re-read ${dir}/sub.thread.md and ${dir}/board.md, then continue coordinating thread ${id}.`;
  return `Start coordinating thread ${id}. Read ${dir}/sub.thread.md and ${dir}/board.md now.`;
}
```

- [ ] **Step 5: CLI `--stdin`**

In `src/cli/main.ts`, replace the `handoff` case with:

```ts
    case "handoff": {
      const { values, positionals } = parse(argv.slice(1), { file: { type: "string" }, stdin: { type: "boolean" } });
      if (!positionals[0] || Boolean(values.file) === Boolean(values.stdin)) throw new UsageError("handoff needs <thread> and exactly one of --file <path> or --stdin");
      const content = values.stdin ? await Bun.stdin.text() : readFileSync(resolve(cwd, values.file as string), "utf8");
      return send(findRoot(cwd, env), env, { cmd: "handoff", thread: positionals[0], content });
    }
```

Update the `USAGE` line to `handoff <thread> (--file <path> | --stdin)`.

- [ ] **Step 6: Verify and commit**

Run the full suite and typecheck → PASS.

```bash
git add src/orchestration/handoff.ts src/agents/prompts.ts src/cli/main.ts tests/orchestration/handoff.test.ts tests/agents/claude.test.ts tests/cli/agents.test.ts
git commit -m "feat: add generated handoffs, handoff requests and agt handoff --stdin"
```

---

### Task 3: Claude resume, config dir and context measurement

**Files:**
- Modify: `src/agents/claude.ts`, `src/commands/schema.ts`, `src/commands/handler.ts`, `src/cli/main.ts` (`hookEvent`)
- Create: `src/agents/transcript.ts`
- Test: `tests/agents/resume.test.ts`, add to `tests/commands/sessions.test.ts` and `tests/cli/agents.test.ts`

**Interfaces:**
- Produces:
  - `claudeConfigDir(config: Config, env?: Record<string, string | undefined>): string`, resolved as `config.agents.claude.config_dir ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")`
  - `claudeSessionFile(o: { configDir: string; cwd: string; session: string }): string`
  - `claudeArgs(o: { session; role; systemPrompt; config; root; resume?: boolean })`. With `resume`, the first two args are `["--resume", session]`.
  - `agentEnv(o: { …; configDir?: string })` adds `CLAUDE_CONFIG_DIR` when `configDir` is given.
  - `contextTokensFromTranscript(path: string, maxBytes = 262_144): number | undefined`
  - Command `session.signal` gains `contextTokens?: number` (int ≥ 0) and `source?: string` (≤ 32 chars). The handler copies `contextTokens` into the `agent.idle` payload only for the `idle` signal, and `source` into the `session.started` payload only for `started`.
  - `agt event`:
    - parses `transcript_path` and `source` from stdin JSON;
    - on `idle`, sends `contextTokens` when the transcript yields one;
    - on `started`, sends `source`.

- [ ] **Step 1: Write the failing tests**

Create `tests/agents/resume.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnv, claudeArgs, claudeConfigDir, claudeSessionFile } from "../../src/agents/claude.ts";
import { contextTokensFromTranscript } from "../../src/agents/transcript.ts";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";

test("config dir precedence", () => {
  const withDir = { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents, claude: { ...DEFAULT_CONFIG.agents.claude, config_dir: "/cfg" } } };
  expect(claudeConfigDir(withDir, { CLAUDE_CONFIG_DIR: "/env" })).toBe("/cfg");
  expect(claudeConfigDir(DEFAULT_CONFIG, { CLAUDE_CONFIG_DIR: "/env" })).toBe("/env");
  expect(claudeConfigDir(DEFAULT_CONFIG, {})).toBe(join(homedir(), ".claude"));
});

test("session file path encodes every non-alphanumeric character", () => {
  expect(claudeSessionFile({ configDir: "/c", cwd: "/repo/.worktrees/001-x", session: "s-1" })).toBe("/c/projects/-repo--worktrees-001-x/s-1.jsonl");
});

test("resume args and CLAUDE_CONFIG_DIR env", () => {
  const args = claudeArgs({ session: "s-1", role: "coordinator", systemPrompt: "SP", config: DEFAULT_CONFIG, root: "/repo", resume: true });
  expect(args.slice(0, 4)).toEqual(["--resume", "s-1", "--permission-mode", "acceptEdits"]);
  expect(args).not.toContain("--session-id");
  expect(agentEnv({ root: "/repo", role: "worker", session: "s", configDir: "/c" }).CLAUDE_CONFIG_DIR).toBe("/c");
  expect(agentEnv({ root: "/repo", role: "worker", session: "s" })).not.toHaveProperty("CLAUDE_CONFIG_DIR");
});

test("context tokens from the last assistant usage; robust to junk", () => {
  const dir = mkdtempSync(join(tmpdir(), "agt-tr-"));
  const file = join(dir, "t.jsonl");
  const lines = [
    { type: "user", message: { content: "hi" } },
    { type: "assistant", message: { usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 } } },
    { type: "assistant", message: { usage: { input_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 1 } } },
    { type: "user", message: { content: "x" } },
  ];
  writeFileSync(file, `garbage line\n${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  expect(contextTokensFromTranscript(file)).toBe(1020);
  expect(contextTokensFromTranscript(join(dir, "missing.jsonl"))).toBeUndefined();
  writeFileSync(file, "x".repeat(300_000));
  expect(contextTokensFromTranscript(file)).toBeUndefined();
});
```

Append to `tests/commands/sessions.test.ts` (inside the `sessions` describe block):

```ts
  test("signal carries contextTokens on idle and source on started only", () => {
    const s = threadWithTab();
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" }, COORD);
    const id = "00000000-0000-4000-8000-000000000001";
    expect(exec(s, { cmd: "session.signal", session: id, signal: "idle", contextTokens: 42 })).toMatchObject({
      events: [{ type: "agent.idle", payload: { session: id, contextTokens: 42 } }],
    });
    expect(exec(s, { cmd: "session.signal", session: id, signal: "started", source: "compact", contextTokens: 9 })).toMatchObject({
      events: [{ type: "session.started", payload: { session: id, source: "compact" } }],
    });
    const started = exec(s, { cmd: "session.signal", session: id, signal: "started", contextTokens: 9 });
    expect(started.ok && started.events[0]!.payload).toEqual({ session: id });
  });
```

Append to `tests/cli/agents.test.ts`:

```ts
test("agt event idle reports context tokens from the hook transcript", () => {
  agt(["start", "--no-manager"]);
  agt(["thread", "new", "X", "--type", "bug"]);
  const fm = () => parse(readFileSync(join(root, ".agentthread/threads/001-x/sub.thread.md"), "utf8").split("---\n")[1]!) as { sessions: { id: string; role: string; context_tokens?: number }[] };
  const c = fm().sessions.find((s) => s.role === "coordinator")!;
  const transcript = join(xdg, "t.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 5, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 } } })}\n`);
  expect(agt(["event", "idle"], { AGT_ROLE: "coordinator", AGT_THREAD: "001" }, JSON.stringify({ session_id: c.id, transcript_path: transcript })).code).toBe(0);
  expect(fm().sessions.find((s) => s.id === c.id)!.context_tokens).toBe(55);
  // a huge garbage transcript still exits 0 quickly
  writeFileSync(transcript, "y".repeat(5_000_000));
  const t0 = Date.now();
  expect(agt(["event", "idle"], { AGT_ROLE: "coordinator", AGT_THREAD: "001" }, JSON.stringify({ session_id: c.id, transcript_path: transcript })).code).toBe(0);
  expect(Date.now() - t0).toBeLessThan(3000);
});
```

Add `parse` from `yaml` and `writeFileSync` to that file's imports if missing.

- [ ] **Step 2: Run to verify failure**

Run the three test files. Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/agents/claude.ts`:
- add the imports `homedir` from `node:os` and `join` from `node:path`
- add:

```ts
export function claudeConfigDir(config: Config, env: Record<string, string | undefined> = process.env): string {
  return config.agents.claude.config_dir ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/** Claude Code stores each session's transcript under projects/<cwd with every non-alphanumeric character as "-">. */
export function claudeSessionFile(o: { configDir: string; cwd: string; session: string }): string {
  return join(o.configDir, "projects", o.cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${o.session}.jsonl`);
}
```

- in `claudeArgs`, add `resume?: boolean` to the options, and replace `"--session-id", o.session,` with `...(o.resume ? ["--resume", o.session] : ["--session-id", o.session]),`
- in `agentEnv`, add `configDir?: string` to the options, and `...(o.configDir ? { CLAUDE_CONFIG_DIR: o.configDir } : {}),` to the result

Create `src/agents/transcript.ts`:

```ts
import { closeSync, openSync, readSync, statSync } from "node:fs";

interface Usage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Context size of the last assistant turn in a Claude Code transcript; undefined when it cannot be read quickly. */
export function contextTokensFromTranscript(path: string, maxBytes = 262_144): number | undefined {
  let text: string;
  try {
    const size = statSync(path).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, len, size - len);
    } finally {
      closeSync(fd);
    }
    text = buf.toString("utf8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    let entry: { type?: string; message?: { usage?: Usage } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the first line of the window may be cut in half
    }
    const u = entry.message?.usage;
    if (entry.type === "assistant" && u && typeof u.input_tokens === "number") {
      return u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }
  }
  return undefined;
}
```

In `src/commands/schema.ts`, change the `session.signal` object to add `contextTokens: z.number().int().min(0).optional(), source: z.string().max(32).optional(),`.

In `src/commands/handler.ts` `session.signal`, build the payload as:

```ts
    const payload = {
      session: s.id,
      ...(cmd.signal === "idle" && cmd.contextTokens !== undefined ? { contextTokens: cmd.contextTokens } : {}),
      ...(cmd.signal === "started" && cmd.source ? { source: cmd.source } : {}),
    };
    return { events: [{ type: SIGNAL_EVENT[cmd.signal], thread: s.thread, payload }] };
```

In `src/cli/main.ts` `hookEvent`:
- parse `transcript_path` and `source` from the stdin JSON as well
- import `contextTokensFromTranscript`
- send:

```ts
    const contextTokens = signal === "idle" && typeof transcript === "string" ? contextTokensFromTranscript(transcript) : undefined;
    const command = {
      cmd: "session.signal",
      session,
      signal,
      ...(contextTokens !== undefined ? { contextTokens } : {}),
      ...(signal === "started" && typeof source === "string" ? { source } : {}),
    };
```

- [ ] **Step 4: Verify and commit**

Run the full suite and typecheck → PASS.

```bash
git add src/agents src/commands src/cli/main.ts tests/agents/resume.test.ts tests/commands/sessions.test.ts tests/cli/agents.test.ts
git commit -m "feat: resume args, Claude config dir and context measurement from hooks"
```

---

### Task 4: Rotation in the reactor, and the sweep

**Files:**
- Modify: `src/orchestration/sessions.ts`, `src/orchestration/reactor.ts`, `src/commands/handler.ts` (Effect member fields)
- Create: `src/orchestration/sweep.ts`
- Test: `tests/orchestration/rotation.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - The `Effect` `agent.spawn` gains `bootstrap?: "start" | "handoff" | "resume"` and `resume?: boolean`.
  - Coordinator agent names gain the session suffix: `agt-<h>-c<thread>-<4 hex of session>`. This is needed because old and new coordinators briefly coexist during a rotation.
  - `spawnReplacement(t: Thread, old: Session, ctx: SpawnContext, how: { pane?: string; bootstrap: "handoff" | "resume" }): { events; effects }` creates a new coordinator session (`replaces: old.id`):
    - `agent.spawn` targets `how.pane`, or otherwise `splitFrom: old.pane ?? t.rootPane` with `direction: "right"`.
    - Undelivered notices of the old session that do not start with `HANDOFF_REQUEST_PREFIX` are carried over as one `notice.queued` for the new session, joined by `\n`.
  - `rotateCoordinator(state: State, s: Session, reason: string, ctx: SpawnContext): { events; effects }` emits `session.rotated` followed by `spawnReplacement(t, s, ctx, { bootstrap: "handoff" })`.
  - Reactor rules:
    - `session.compacting` for a live coordinator, when `session.rotation.on_precompact` is on and no rotation is pending → `session.rotation_requested` (reason `precompact`).
    - `agent.idle` for a live coordinator with no rotation pending and `contextTokens / context_window ≥ context_threshold` → `session.rotation_requested` (reason `context`).
    - `session.rotation_requested` → `notice.queued` with `handoffRequestPrompt(...)` for that session.
    - `handoff.submitted` → if the thread's live coordinator has a rotation pending → `rotateCoordinator(…, rotation.reason)`.
    - `notice.queued` for a live coordinator with no rotation pending, whose `lastActiveAt` is older than `session.rotation.idle_timeout` at `ev.ts` → `handoff.submitted` (generated, why = `the coordinator was idle for more than <idle_timeout>`) plus `rotateCoordinator(…, "idle_timeout")`. No delivery to the stale session.
    - `session.attached` for a session with `replaces`:
      - `pane.close` for the replaced session's pane when that pane is known and differs from the new pane;
      - `thread.root_pane_changed` when the new pane differs from `t.rootPane`;
      - then the usual `deliver`.
    - Each session is rotated at most once per call.
  - `sweep(state: State, now: string, ctx: ReactorContext): { events; effects }`. For each live coordinator with a rotation pending for longer than `session.handoff.timeout`:
    - if `fallback_generate` is on → `handoff.submitted` (generated, why = `the coordinator did not write a handoff within <timeout>`); the reactor then rotates;
    - otherwise → `rotateCoordinator(…, "handoff_timeout")`.

- [ ] **Step 1: Write the failing tests**

Create `tests/orchestration/rotation.test.ts`:

```ts
import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import type { EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { sweep } from "../../src/orchestration/sweep.ts";
import { HANDOFF_REQUEST_PREFIX } from "../../src/agents/prompts.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, threadCreated } from "../helpers.ts";

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let n = 0;
const ctx = (config = DEFAULT_CONFIG) => ({ root: "/repo", config, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` });

function apply(state: State, ts: string, ...bodies: EventBody[]): StoredEvent[] {
  return bodies.map((b) => {
    const ev = { ...b, seq: state.lastSeq + 1, ts, actor: USER } as StoredEvent;
    applyEvent(state, ev);
    return ev;
  });
}

function base(): State {
  n = 0;
  const s = stateOf(INIT, threadCreated("001", { status: "in_progress" }), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
  apply(
    s,
    "2026-10-11T10:00:00.000Z",
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    { type: "session.started", thread: "001", payload: { session: C } },
  );
  return s;
}

test("precompact requests rotation once and queues a handoff request", () => {
  const s = base();
  const r = react(s, apply(s, "2026-10-11T10:01:00.000Z", { type: "session.compacting", thread: "001", payload: { session: C } }), ctx());
  expect(r.events).toEqual([{ type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "precompact" } }]);
  const q = react(s, apply(s, "2026-10-11T10:01:00.000Z", ...r.events), ctx());
  expect(q.events).toHaveLength(1);
  expect((q.events[0] as { payload: { text: string } }).payload.text.startsWith(HANDOFF_REQUEST_PREFIX)).toBe(true);
  // a second compacting while pending does nothing
  expect(react(s, apply(s, "2026-10-11T10:02:00.000Z", { type: "session.compacting", thread: "001", payload: { session: C } }), ctx()).events).toEqual([]);
});

test("high context on idle requests rotation; below threshold does not", () => {
  const s = base();
  expect(react(s, apply(s, "2026-10-11T10:01:00.000Z", { type: "agent.idle", thread: "001", payload: { session: C, contextTokens: 100_000 } }), ctx()).events).toEqual([]);
  expect(react(s, apply(s, "2026-10-11T10:02:00.000Z", { type: "agent.idle", thread: "001", payload: { session: C, contextTokens: 150_000 } }), ctx()).events).toEqual([
    { type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "context" } },
  ]);
});

test("handoff while rotating: rotated, replacement split from old pane, carried notices exclude the request", () => {
  const s = base();
  apply(
    s,
    "2026-10-11T10:01:00.000Z",
    { type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "context" } },
    { type: "notice.queued", thread: "001", payload: { session: C, text: `${HANDOFF_REQUEST_PREFIX} rotate` } },
    { type: "notice.queued", thread: "001", payload: { session: C, text: "Ticket T1 is done." } },
  );
  const r = react(s, apply(s, "2026-10-11T10:02:00.000Z", { type: "handoff.submitted", thread: "001", payload: { content: "## …", generated: false } }), ctx());
  const newId = "00000000-0000-4000-8000-000000000001";
  expect(r.events).toEqual([
    { type: "session.rotated", thread: "001", payload: { session: C, reason: "context" } },
    { type: "session.created", thread: "001", payload: { session: newId, role: "coordinator", agent: "claude-code", name: expect.any(String), replaces: C } },
    { type: "notice.queued", thread: "001", payload: { session: newId, text: "Ticket T1 is done." } },
  ]);
  expect(r.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", session: newId, splitFrom: "w1:p2", direction: "right", bootstrap: "handoff" })]);
  // attach of the replacement closes the old pane and moves the root pane
  apply(s, "2026-10-11T10:02:00.000Z", ...r.events);
  const a = react(s, apply(s, "2026-10-11T10:03:00.000Z", { type: "session.attached", thread: "001", payload: { session: newId, pane: "w1:p5" } }), ctx());
  expect(a.events).toEqual([{ type: "thread.root_pane_changed", thread: "001", payload: { pane: "w1:p5" } }]);
  expect(a.effects).toEqual([{ kind: "pane.close", pane: "w1:p2" }]);
});

test("handoff without a pending rotation does nothing", () => {
  const s = base();
  expect(react(s, apply(s, "2026-10-11T10:02:00.000Z", { type: "handoff.submitted", thread: "001", payload: { content: "x", generated: false } }), ctx()).events).toEqual([]);
});

test("idle timeout: a stale coordinator is rotated with a generated handoff instead of receiving the notice", () => {
  const s = base();
  apply(s, "2026-10-11T10:00:30.000Z", { type: "agent.idle", thread: "001", payload: { session: C } });
  const r = react(s, apply(s, "2026-10-13T10:00:00.000Z", { type: "notice.queued", thread: "001", payload: { session: C, text: "wake up" } }), ctx());
  expect(r.events.map((e) => e.type)).toEqual(["handoff.submitted", "session.rotated", "session.created", "notice.queued"]);
  expect(r.events[0]).toMatchObject({ payload: { generated: true } });
  expect(r.effects.map((e) => e.kind)).toEqual(["agent.spawn"]);
});

test("sweep: handoff timeout generates a handoff, or rotates directly when fallback is off", () => {
  const s = base();
  apply(s, "2026-10-11T10:01:00.000Z", { type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "precompact" } });
  expect(sweep(s, "2026-10-11T10:05:00.000Z", ctx()).events).toEqual([]);
  const late = sweep(s, "2026-10-11T10:07:00.000Z", ctx());
  expect(late.events).toEqual([{ type: "handoff.submitted", thread: "001", payload: { content: expect.stringContaining("did not write a handoff within 5m"), generated: true } }]);
  const off = { ...DEFAULT_CONFIG, session: { ...DEFAULT_CONFIG.session, handoff: { timeout: "5m", fallback_generate: false } } };
  expect(sweep(s, "2026-10-11T10:07:00.000Z", ctx(off)).events.map((e) => e.type)).toEqual(["session.rotated", "session.created"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run `tests/orchestration/rotation.test.ts`. Expected: FAIL. `sweep` is missing and the rules are missing.

- [ ] **Step 3: Implement helpers**

In `src/commands/handler.ts`, add `bootstrap?: "start" | "handoff" | "resume"; resume?: boolean;` to the `agent.spawn` effect member.

In `src/orchestration/sessions.ts`:
- add the imports `HANDOFF_REQUEST_PREFIX` from `../agents/prompts.ts`, plus `Session`
- add:

```ts
export function spawnReplacement(
  t: Thread,
  old: Session,
  ctx: SpawnContext,
  how: { pane?: string; bootstrap: "handoff" | "resume" },
): { events: EventBody[]; effects: Effect[] } {
  const session = ctx.newId();
  const name = agentName(ctx.root, "coordinator", t.id);
  const carried = old.notices.filter((n) => !n.startsWith(HANDOFF_REQUEST_PREFIX));
  return {
    events: [
      { type: "session.created", thread: t.id, payload: { session, role: "coordinator", agent: "claude-code", name, replaces: old.id } },
      ...(carried.length ? [{ type: "notice.queued" as const, thread: t.id, payload: { session, text: carried.join("\n") } }] : []),
    ],
    effects: [
      {
        kind: "agent.spawn",
        session,
        role: "coordinator",
        name,
        thread: t.id,
        cwd: t.worktree,
        ...(how.pane ? { pane: how.pane } : { splitFrom: old.pane ?? t.rootPane!, direction: "right" as const }),
        bootstrap: how.bootstrap,
      },
    ],
  };
}

export function rotateCoordinator(state: State, s: Session, reason: string, ctx: SpawnContext): { events: EventBody[]; effects: Effect[] } {
  const t = s.thread ? state.threads.get(s.thread) : undefined;
  if (!t) return { events: [], effects: [] };
  const next = spawnReplacement(t, s, ctx, { bootstrap: "handoff" });
  return { events: [{ type: "session.rotated", thread: t.id, payload: { session: s.id, reason } }, ...next.events], effects: next.effects };
}
```

Herdr agent names must be unique among live agents, but the old coordinator still holds its name while the replacement starts. So coordinators get the same 4-hex session suffix that workers already have. In `agentName` (currently `agentName(root, role, thread?, ticket?, session?)`), compute `suffix` before the role branches and change the coordinator branch to `` return `agt-${h}-c${thread}${suffix}`; ``. A call without `session` keeps the bare `agt-<h>-c<thread>`. Then pass the session id as the 5th argument in `spawnCoordinator` (`agentName(ctx.root, "coordinator", t.id, undefined, session)`) and in `spawnReplacement` (same call). Update the one test that asserts a spawned coordinator name: in `tests/daemon/agents.test.ts`, change `/^agt-[0-9a-f]{4}-c001$/` to `/^agt-[0-9a-f]{4}-c001-[0-9a-f]{4}$/`. The bare-name assertions in `tests/commands/sessions.test.ts` and `tests/herdr/bridge.test.ts` stay unchanged.

Create `src/orchestration/sweep.ts`:

```ts
import type { Effect } from "../commands/handler.ts";
import { durationMs } from "../config/config.ts";
import type { EventBody } from "../domain/types.ts";
import type { State } from "../state/projection.ts";
import { generateHandoff } from "./handoff.ts";
import type { ReactorContext } from "./reactor.ts";
import { liveSessions, rotateCoordinator } from "./sessions.ts";

/** Time-based follow-ups the event stream cannot trigger by itself: overdue handoffs. */
export function sweep(state: State, now: string, ctx: ReactorContext): { events: EventBody[]; effects: Effect[] } {
  const events: EventBody[] = [];
  const effects: Effect[] = [];
  const { timeout, fallback_generate } = ctx.config.session.handoff;
  for (const s of liveSessions(state, undefined, "coordinator")) {
    if (!s.rotation || Date.parse(now) - Date.parse(s.rotation.requestedAt) <= durationMs(timeout)) continue;
    const t = s.thread ? state.threads.get(s.thread) : undefined;
    if (!t) continue;
    if (fallback_generate) {
      events.push({ type: "handoff.submitted", thread: t.id, payload: { content: generateHandoff(t, `the coordinator did not write a handoff within ${timeout}`), generated: true } });
    } else {
      const r = rotateCoordinator(state, s, "handoff_timeout", ctx);
      events.push(...r.events);
      effects.push(...r.effects);
    }
  }
  return { events, effects };
}
```

- [ ] **Step 4: Reactor rules**

In `src/orchestration/reactor.ts`:
- add the imports: `durationMs` from config; `handoffRequestPrompt` from `../agents/prompts.ts`; `generateHandoff` from `./handoff.ts`; `rotateCoordinator` from `./sessions.ts`
- add helpers after `fillWorkers`:

```ts
  const rotated = new Set<string>();
  const rotate = (s: Session, reason: string) => {
    if (rotated.has(s.id)) return;
    rotated.add(s.id);
    take(rotateCoordinator(state, s, reason, ctx));
  };
  const requested = new Set<string>();
  const requestRotation = (s: Session | undefined, reason: string) => {
    if (s && isLive(s) && s.role === "coordinator" && !s.rotation && !requested.has(s.id) && !rotated.has(s.id)) {
      requested.add(s.id);
      out.push({ type: "session.rotation_requested", thread: s.thread, payload: { session: s.id, reason } } as EventBody);
    }
  };
  const { rotation } = ctx.config.session;
```

- add or extend cases:

```ts
      case "session.compacting":
        if (rotation.on_precompact) requestRotation(state.sessions.get(ev.payload.session), "precompact");
        break;
      case "session.rotation_requested": {
        const s = state.sessions.get(ev.payload.session);
        const t = s?.thread ? state.threads.get(s.thread) : undefined;
        if (s && t && s.rotation) notify(s, handoffRequestPrompt({ root: ctx.root, thread: t, reason: ev.payload.reason }));
        break;
      }
      case "handoff.submitted": {
        const c = coordinatorOf(ev.thread);
        if (c?.rotation) rotate(c, c.rotation.reason);
        break;
      }
```

- in the existing `agent.idle` case, in the non-worker branch, call this before `deliver(s)`:

```ts
        if (s && s.role === "coordinator" && s.contextTokens !== undefined && s.contextTokens / rotation.context_window >= rotation.context_threshold) {
          requestRotation(s, "context");
        }
```

- split `notice.queued` out of the shared `notice.queued | session.attached | session.started` case:

```ts
      case "notice.queued": {
        const s = state.sessions.get(ev.payload.session);
        const t = s?.thread ? state.threads.get(s.thread) : undefined;
        const stale =
          s && t && isLive(s) && s.role === "coordinator" && !s.rotation && s.status === "idle" && s.lastActiveAt &&
          Date.parse(ev.ts) - Date.parse(s.lastActiveAt) > durationMs(rotation.idle_timeout);
        if (stale && !rotated.has(s.id)) {
          out.push({ type: "handoff.submitted", thread: t.id, payload: { content: generateHandoff(t, `the coordinator was idle for more than ${rotation.idle_timeout}`), generated: true } });
          rotate(s, "idle_timeout");
        } else {
          deliver(s);
        }
        break;
      }
      case "session.attached": {
        const s = state.sessions.get(ev.payload.session);
        const old = s?.replaces ? state.sessions.get(s.replaces) : undefined;
        const t = s?.thread ? state.threads.get(s.thread) : undefined;
        if (old?.pane && old.pane !== ev.payload.pane) effects.push({ kind: "pane.close", pane: old.pane });
        if (s?.replaces && t && t.rootPane !== ev.payload.pane) out.push({ type: "thread.root_pane_changed", thread: t.id, payload: { pane: ev.payload.pane } });
        deliver(s);
        break;
      }
      case "session.started":
        deliver(state.sessions.get(ev.payload.session));
        break;
```

The idle-timeout handoff is pushed before `rotate`, so the generated `handoff.submitted` reaches the reactor in the next round. By then the session is already `rotated`, so `coordinatorOf` returns the replacement, which has no rotation pending, and nothing rotates twice.

- [ ] **Step 5: Verify and commit**

Run the full suite and typecheck → PASS.

```bash
git add src/orchestration src/commands/handler.ts tests/orchestration/rotation.test.ts tests/commands/sessions.test.ts
git commit -m "feat: rotate coordinators on compaction, context and idle timeout"
```

---

### Task 5: Recovery in the reactor, and reconcile probes

**Files:**
- Modify: `src/orchestration/reactor.ts`, `src/commands/handler.ts`
- Test: `tests/orchestration/recovery.test.ts`, add to `tests/commands/layout.test.ts`

**Interfaces:**
- Produces:
  - `Effect` member `{ kind: "session.probe"; session: string; thread?: string; pane: string }`
  - `layout.reconcile` emits its existing `herdr.tab.ensure`/`herdr.tab.close` effects first, then one `session.probe` per live coordinator or worker session that has a pane. The result stays `{ threads }`.
  - Reactor rules:
    - **`thread.tab_opened`:**
      - if the thread has a live coordinator whose pane differs from the new `rootPane` → `session.lost` (reason `tab was reopened`) for that coordinator and for every live worker of the thread;
      - otherwise, if there is no live coordinator and no coordinator of this thread was lost in this batch → spawn a fresh coordinator, as before.
    - **`session.lost` for a coordinator** of a thread that is not done and has a `rootPane` → `session.resuming` plus `agent.spawn { session: same id, name, role: coordinator, thread, cwd: worktree, pane: rootPane, resume: true, bootstrap: "resume" }`.
    - **`session.lost` for a worker:**
      - if its ticket is `in_progress` and assigned to it → `ticket.released` (reason `worker session lost`);
      - notify the coordinator: `Worker for <T> was lost; the ticket is open again.`;
      - fill the worker slots.
    - **`session.resume_failed` for a coordinator** of a thread that is not done:
      - if the thread has no handoff → `handoff.submitted` (generated, why = `the previous coordinator session could not be resumed`);
      - then `spawnReplacement(t, s, ctx, { pane: t.rootPane, bootstrap: "handoff" })`.

- [ ] **Step 1: Write the failing tests**

Create `tests/orchestration/recovery.test.ts`:

```ts
import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import type { EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, threadCreated } from "../helpers.ts";

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const W = "11111111-1111-4111-8111-111111111111";
let n = 0;
const ctx = () => ({ root: "/repo", config: DEFAULT_CONFIG, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` });
const apply = (s: State, ...bodies: EventBody[]): StoredEvent[] =>
  bodies.map((b) => {
    const ev = { ...b, seq: s.lastSeq + 1, ts: "2026-10-11T10:00:00.000Z", actor: USER } as StoredEvent;
    applyEvent(s, ev);
    return ev;
  });

function base(): State {
  n = 0;
  const s = stateOf(INIT, threadCreated("001", { status: "in_progress" }), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
  apply(
    s,
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "agt-ab12-c001" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "a", scope: ["a"] } },
    { type: "ticket.created", thread: "001", payload: { ticket: "T2", title: "b", scope: ["b"] } },
    { type: "session.created", thread: "001", payload: { session: W, role: "worker", agent: "claude-code", name: "w", ticket: "T1" } },
    { type: "session.attached", thread: "001", payload: { session: W, pane: "w1:p3" } },
    { type: "ticket.claimed", thread: "001", payload: { ticket: "T1", assignee: W } },
  );
  return s;
}

test("lost coordinator is resumed into the root pane with the same session id", () => {
  const s = base();
  const r = react(s, apply(s, { type: "session.lost", thread: "001", payload: { session: C, reason: "no agent in pane w1:p2" } }), ctx());
  expect(r.events).toEqual([{ type: "session.resuming", thread: "001", payload: { session: C } }]);
  expect(r.effects).toEqual([
    { kind: "agent.spawn", session: C, role: "coordinator", name: "agt-ab12-c001", thread: "001", cwd: "/repo/.worktrees/001-thread-001", pane: "w1:p2", resume: true, bootstrap: "resume" },
  ]);
});

test("resume failure: generated handoff (only if none) and a fresh replacement in the same pane", () => {
  const s = base();
  apply(s, { type: "session.lost", thread: "001", payload: { session: C, reason: "x" } }, { type: "session.resuming", thread: "001", payload: { session: C } });
  const r = react(s, apply(s, { type: "session.resume_failed", thread: "001", payload: { session: C, reason: "no saved Claude session" } }), ctx());
  expect(r.events.map((e) => e.type)).toEqual(["handoff.submitted", "session.created"]);
  expect(r.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", pane: "w1:p2", bootstrap: "handoff" })]);
  // with an existing handoff, none is generated
  const s2 = base();
  apply(s2, { type: "handoff.submitted", thread: "001", payload: { content: "x", generated: false } });
  apply(s2, { type: "session.lost", thread: "001", payload: { session: C, reason: "x" } }, { type: "session.resuming", thread: "001", payload: { session: C } });
  expect(react(s2, apply(s2, { type: "session.resume_failed", thread: "001", payload: { session: C, reason: "y" } }), ctx()).events.map((e) => e.type)).toEqual(["session.created"]);
});

test("lost worker releases its ticket, tells the coordinator, frees its slot", () => {
  const s = base();
  apply(s, { type: "worker.queued", thread: "001", payload: { ticket: "T2" } });
  const r = react(s, apply(s, { type: "session.lost", thread: "001", payload: { session: W, reason: "no agent in pane w1:p3" } }), ctx());
  expect(r.events).toEqual([
    { type: "ticket.released", thread: "001", payload: { ticket: "T1", reason: "worker session lost" } },
    { type: "notice.queued", thread: "001", payload: { session: C, text: "Worker for T1 was lost; the ticket is open again." } },
    expect.objectContaining({ type: "session.created", payload: expect.objectContaining({ ticket: "T2" }) }),
  ]);
});

test("tab reopened with a stale coordinator: loses it and its workers, no fresh spawn", () => {
  const s = base();
  const r = react(s, apply(s, { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t9", rootPane: "w1:p9" } }), ctx());
  expect(r.events).toEqual([
    { type: "session.lost", thread: "001", payload: { session: C, reason: "tab was reopened" } },
    { type: "session.lost", thread: "001", payload: { session: W, reason: "tab was reopened" } },
  ]);
  expect(r.effects).toEqual([]);
});

test("tab reopened in the same batch as a probe loss: resume once, no fresh coordinator", () => {
  const s = base();
  const evs = apply(
    s,
    { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t9", rootPane: "w1:p9" } },
    { type: "session.lost", thread: "001", payload: { session: C, reason: "no agent in pane w1:p2" } },
  );
  const r = react(s, evs, ctx());
  expect(r.events.filter((e) => e.type === "session.created")).toEqual([]);
  expect(r.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", session: C, pane: "w1:p9", resume: true })]);
});
```

Append to `tests/commands/layout.test.ts`:

```ts
test("reconcile probes live coordinator and worker panes after tab effects", () => {
  const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const r = run(
    [
      INIT,
      REGISTERED,
      threadCreated("001"),
      { type: "thread.tab_opened", thread: "001", payload: { tab: "w7:t3", rootPane: "w7:p5" } },
      { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } },
      { type: "session.attached", thread: "001", payload: { session: C, pane: "w7:p5" } },
    ],
    { cmd: "layout.reconcile" },
  );
  expect(r.ok && r.effects.map((e) => e.kind)).toEqual(["herdr.tab.ensure", "session.probe"]);
  expect(r.ok && r.effects[1]).toEqual({ kind: "session.probe", session: C, thread: "001", pane: "w7:p5" });
});
```

- [ ] **Step 2: Run to verify failure**

Run the two files. Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/commands/handler.ts`:
- add `| { kind: "session.probe"; session: string; thread?: string; pane: string }` to `Effect`
- in `layout.reconcile`, after building the ensure and close effects, append:

```ts
    const probes: Effect[] = [...state.sessions.values()]
      .filter((s) => isLive(s) && (s.role === "coordinator" || s.role === "worker") && s.pane)
      .map((s) => ({ kind: "session.probe", session: s.id, ...(s.thread ? { thread: s.thread } : {}), pane: s.pane! }));
```

  and return the effects as `[...existingEffects, ...probes]`.

In `src/orchestration/reactor.ts`:
- add the import `spawnReplacement`
- add `const lostSet = new Set<string>(); const lose = (s: Session, reason: string) => { if (!lostSet.has(s.id)) { lostSet.add(s.id); out.push({ type: "session.lost", thread: s.thread, payload: { session: s.id, reason } } as EventBody); } };`
- before the loop, compute:

```ts
  const coordinatorLostIn = new Set(
    events.filter((e) => e.type === "session.lost").map((e) => state.sessions.get(e.payload.session)).filter((s) => s?.role === "coordinator").map((s) => s!.thread),
  );
```

- replace the `thread.tab_opened` case with:

```ts
      case "thread.tab_opened": {
        const t = state.threads.get(ev.thread);
        if (!t || t.status === "done" || !t.rootPane) break;
        const c = coordinatorOf(t.id);
        if (c && c.pane && c.pane !== t.rootPane) {
          lose(c, "tab was reopened");
          for (const w of liveSessions(state, t.id, "worker")) lose(w, "tab was reopened");
        } else if (!c && !coordinatorLostIn.has(t.id)) {
          take(spawnCoordinator(t, ctx));
        }
        break;
      }
```

- add:

```ts
      case "session.lost": {
        const s = state.sessions.get(ev.payload.session);
        const t = s?.thread ? state.threads.get(s.thread) : undefined;
        if (!s || !t || t.status === "done") break;
        if (s.role === "coordinator" && t.rootPane) {
          out.push({ type: "session.resuming", thread: t.id, payload: { session: s.id } });
          effects.push({ kind: "agent.spawn", session: s.id, role: "coordinator", name: s.name, thread: t.id, cwd: t.worktree, pane: t.rootPane, resume: true, bootstrap: "resume" });
        } else if (s.role === "worker") {
          const k = t.tickets.find((x) => x.id === s.ticket);
          if (k?.status === "in_progress" && k.assignee === s.id) {
            out.push({ type: "ticket.released", thread: t.id, payload: { ticket: k.id, reason: "worker session lost" } });
          }
          notify(coordinatorOf(t.id), `Worker for ${s.ticket} was lost; the ticket is open again.`);
          fillWorkers(t.id);
        }
        break;
      }
      case "session.resume_failed": {
        const s = state.sessions.get(ev.payload.session);
        const t = s?.thread ? state.threads.get(s.thread) : undefined;
        if (!s || s.role !== "coordinator" || !t || t.status === "done" || !t.rootPane) break;
        if (!t.handoff) {
          out.push({ type: "handoff.submitted", thread: t.id, payload: { content: generateHandoff(t, "the previous coordinator session could not be resumed"), generated: true } });
        }
        take(spawnReplacement(t, s, ctx, { pane: t.rootPane, bootstrap: "handoff" }));
        break;
      }
```

The worker's ticket was released by an event in this same call, so it is not yet `open` in `state`. That means `fillWorkers` here only spawns *other* queued tickets, which is intended: the coordinator decides whether to respawn the released one.

- [ ] **Step 4: Verify and commit**

Run the full suite and typecheck → PASS.

```bash
git add src/orchestration/reactor.ts src/commands/handler.ts tests/orchestration/recovery.test.ts tests/commands/layout.test.ts
git commit -m "feat: resume or replace lost coordinators and release lost workers' tickets"
```

---

### Task 6: Herdr probe, resume spawn and the daemon sweep

**Files:**
- Modify: `src/herdr/bridge.ts`, `tests/fixtures/fake-herdr.ts`, `tests/helpers.ts`, `src/daemon/effects.ts`, `src/daemon/server.ts`
- Test: `tests/herdr/bridge.test.ts` (append), `tests/daemon/lifecycle.test.ts`

**Interfaces:**
- Produces:
  - `HerdrBridge.agentExists(target: string): boolean`. It calls `agent get <target>` and returns true on success, false for codes `agent_not_found`, `pane_not_found` or `not_found`, and rethrows anything else.
  - Fake herdr: a new state field `agentPanes?: string[]`.
    - `agent start` adds its pane to `agentPanes`.
    - `pane close` removes the pane from both `panes` and `agentPanes`.
    - `agent get <target>` succeeds if `target` is in `agentPanes` or `agents`, and otherwise fails with `agent_not_found`.
  - Effect runner (new opts: `sessionFileExists?: (path: string) => boolean`, default `existsSync`):
    - `agent.spawn`:
      - resolves `configDir = claudeConfigDir(config)` and passes it to `agentEnv`;
      - uses `bootstrapPrompt(prompt, effect.bootstrap ?? "start")`;
      - with `resume: true` checks `claudeSessionFile({ configDir, cwd: effect.cwd, session })`. If the file is missing → `[session.resume_failed { reason: "no saved Claude session at <file>" }]`; otherwise it launches with `claudeArgs({ …, resume: true })`.
    - `session.probe`: `agentExists(pane)` true → `[]`; false → `[session.lost { reason: "no agent in pane <pane>" }]`; an error is logged → `[]`.
    - The `herdr.tab.ensure` tab env gains `CLAUDE_CONFIG_DIR: claudeConfigDir(config)`.
  - Daemon:
    - `startDaemon` opts gain `sweepIntervalMs?: number` (default 15000).
    - A timer (unref'd, cleared on stop) runs `sweep(state, new Date().toISOString(), ctx)` through the command queue when not shutting down. Its events and effects are committed and followed by the same reactor loop as commands, with actor `{ role: "user" }`.
    - Extract a shared `applyAndReact(bodies: EventBody[], actor: Actor): void` used by both `runCommand` and the sweep.

- [ ] **Step 1: Write the failing tests**

Append to `tests/herdr/bridge.test.ts`:

```ts
describe("agentExists", () => {
  test("true on success, false for not-found codes, rethrows others", () => {
    const run = (exitCode: number, stderr = "") => new HerdrCli({ bin: "herdr", runner: () => ({ exitCode, stdout: '{"result":{"type":"agent_info"}}', stderr }) });
    expect(run(0).agentExists("w1:p2")).toBe(true);
    expect(run(1, '{"error":{"code":"agent_not_found","message":"x"}}').agentExists("w1:p2")).toBe(false);
    expect(run(1, '{"error":{"code":"pane_not_found","message":"x"}}').agentExists("w1:p2")).toBe(false);
    expect(() => run(1, '{"error":{"code":"server_unavailable","message":"down"}}').agentExists("w1:p2")).toThrow("down");
  });

  test("fake herdr tracks agent panes", () => {
    const fake = fakeHerdrState({ panes: ["w1:p2"] });
    const h = new HerdrCli({ bin: FAKE_HERDR, env: { ...process.env, FAKE_HERDR_STATE: fake.file } });
    expect(h.agentExists("w1:p2")).toBe(false);
    h.agentStart({ name: "a", kind: "claude", pane: "w1:p2", args: [] });
    expect(h.agentExists("w1:p2")).toBe(true);
    h.closePane("w1:p2");
    expect(h.agentExists("w1:p2")).toBe(false);
  });
});
```

Create `tests/daemon/lifecycle.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpawnJob } from "../../src/agents/spawn-job.ts";
import { claudeSessionFile } from "../../src/agents/claude.ts";
import { request } from "../../src/daemon/client.ts";
import { startDaemon, type Daemon } from "../../src/daemon/server.ts";
import type { Actor, StoredEvent } from "../../src/domain/types.ts";
import { initProject } from "../../src/project/init.ts";
import { paths } from "../../src/project/paths.ts";
import { FAKE_HERDR, fakeHerdrState, isolatedConfigHome, tempRepo, waitFor } from "../helpers.ts";

let root: string;
let daemon: Daemon;
let fake: ReturnType<typeof fakeHerdrState>;
let claudeDir: string;
let jobs: SpawnJob[];
const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, FAKE_HERDR_STATE: process.env.FAKE_HERDR_STATE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };

beforeAll(() => {
  process.env.XDG_CONFIG_HOME = isolatedConfigHome();
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});
afterEach(async () => {
  await daemon.stop();
});

async function boot(configYaml = "", sweepIntervalMs?: number) {
  root = tempRepo();
  initProject(root, "demo");
  writeFileSync(join(root, ".agentthread", "config.yaml"), configYaml);
  fake = fakeHerdrState();
  process.env.FAKE_HERDR_STATE = fake.file;
  claudeDir = isolatedConfigHome();
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  jobs = [];
  daemon = await startDaemon(root, { log: () => {}, launch: (j) => void jobs.push(j), ...(sweepIntervalMs ? { sweepIntervalMs } : {}) });
  await cmd({ cmd: "layout.register", workspace: "w1", mainTab: "w1:t0", managerPane: "w1:p0", loggerPane: "w1:p00", herdrBin: FAKE_HERDR });
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
}

const cmd = (command: object, actor: Actor = { role: "user" }) => request(paths(root).socket, { op: "command", command, actor });
const events = async () => {
  const r = await request(paths(root).socket, { op: "events.since", seq: 0 });
  return r.ok ? (r.result as StoredEvent[]) : [];
};
const coordinator = async () =>
  (await events()).filter((e) => e.type === "session.created" && e.payload.role === "coordinator").map((e) => e.payload as { session: string }).at(-1)!.session;

test("reconcile probe → lost → resumed with --resume when the transcript exists", async () => {
  await boot();
  const c = await coordinator();
  await cmd({ cmd: "session.attached", session: c, pane: "w1:p1" }); // fake: pane w1:p1 exists but has no agent
  const file = claudeSessionFile({ configDir: claudeDir, cwd: join(root, ".worktrees", "001-x"), session: c });
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "{}\n");
  await cmd({ cmd: "layout.reconcile" });
  const types = (await events()).map((e) => e.type);
  expect(types).toContain("session.lost");
  expect(types).toContain("session.resuming");
  const job = jobs.at(-1)!;
  expect(job.session).toBe(c);
  expect(job.pane).toBe("w1:p1");
  expect(job.args.slice(0, 2)).toEqual(["--resume", c]);
  expect(job.bootstrap.startsWith("You were resumed after an interruption.")).toBe(true);
});

test("no transcript: resume fails, a handoff is generated, a fresh coordinator takes the pane", async () => {
  await boot();
  const c = await coordinator();
  await cmd({ cmd: "session.attached", session: c, pane: "w1:p1" });
  await cmd({ cmd: "layout.reconcile" });
  const all = await events();
  expect(all.map((e) => e.type)).toContain("session.resume_failed");
  expect(all.find((e) => e.type === "handoff.submitted")).toMatchObject({ payload: { generated: true } });
  const job = jobs.at(-1)!;
  expect(job.session).not.toBe(c);
  expect(job.args.slice(0, 2)).toEqual(["--session-id", job.session]);
  expect(job.bootstrap.startsWith("Continue coordinating thread 001 as its new coordinator.")).toBe(true);
});

test("handoff timeout: the sweep generates a handoff and rotates", async () => {
  await boot("session:\n  handoff:\n    timeout: 1s\n", 200);
  const c = await coordinator();
  await cmd({ cmd: "session.attached", session: c, pane: "w1:p1" });
  await cmd({ cmd: "session.signal", session: c, signal: "compacting" });
  await waitFor(async () => (await events()).some((e) => e.type === "session.rotated"), 5000);
  const all = await events();
  expect(all.find((e) => e.type === "handoff.submitted")).toMatchObject({ payload: { generated: true } });
  expect(jobs.at(-1)).toMatchObject({ split: { pane: "w1:p1" } });
});

test("tab env carries CLAUDE_CONFIG_DIR", async () => {
  await boot();
  const create = fake.read().calls.find((x) => x[0] === "tab" && x[1] === "create")!;
  expect(create).toContain(`CLAUDE_CONFIG_DIR=${claudeDir}`);
});
```

- [ ] **Step 2: Run to verify failure**

Run the two files. Expected: FAIL.

- [ ] **Step 3: Bridge and fake**

In `src/herdr/bridge.ts`, add `agentExists(target: string): boolean;` to `HerdrBridge`, and to `HerdrCli`:

```ts
  agentExists(target: string): boolean {
    try {
      this.call(["agent", "get", target]);
      return true;
    } catch (e) {
      if (e instanceof HerdrError && (e.code === "agent_not_found" || e.code === "pane_not_found" || e.code === "not_found")) return false;
      throw e;
    }
  }
```

In `tests/fixtures/fake-herdr.ts`:
- add `agentPanes?: string[]` to the state
- in `agent start`, after recording the agent, add `state.agentPanes = [...(state.agentPanes ?? []), pane];`
- in `pane close`, also remove the pane from `agentPanes`
- add before the final `ok`:

```ts
if (group === "agent" && sub === "get") {
  if (!(state.agentPanes ?? []).includes(target ?? "") && !(state.agents ?? []).includes(target ?? "")) fail("agent_not_found", `agent target ${target} not found`);
  ok({ type: "agent_info", agent: { pane_id: target } });
}
```

Add `agentPanes?: string[]` to `FakeHerdrState` in `tests/helpers.ts`.

- [ ] **Step 4: Effects**

In `src/daemon/effects.ts`:
- add the imports `existsSync` from `node:fs`, plus `claudeConfigDir` and `claudeSessionFile`
- add `sessionFileExists?: (path: string) => boolean;` to the opts
- in `agent.spawn`:
  - compute `const configDir = claudeConfigDir(opts.config);`
  - if `effect.resume`:

```ts
          const file = claudeSessionFile({ configDir, cwd: effect.cwd, session: effect.session });
          if (!(opts.sessionFileExists ?? existsSync)(file)) {
            return [{ type: "session.resume_failed", thread: effect.thread, payload: { session: effect.session, reason: `no saved Claude session at ${file}` } }];
          }
```

  - pass `configDir` into `agentEnv(...)`, `resume: effect.resume` into `claudeArgs(...)`, and `bootstrap: bootstrapPrompt(prompt, effect.bootstrap ?? "start")`
- add:

```ts
      case "session.probe": {
        const layout = opts.layout();
        if (!layout) return [];
        try {
          return bridgeFor(layout).agentExists(effect.pane)
            ? []
            : [{ type: "session.lost", ...(effect.thread ? { thread: effect.thread } : {}), payload: { session: effect.session, reason: `no agent in pane ${effect.pane}` } }];
        } catch (e) {
          log(`probing pane ${effect.pane} failed: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        }
      }
```

- in `runHerdr`, add `CLAUDE_CONFIG_DIR: configDir` to the tab env. Pass `configDir` in as a new parameter from the call site.

- [ ] **Step 5: Daemon sweep**

In `src/daemon/server.ts`:
- add the import `sweep` from `../orchestration/sweep.ts`
- add `sweepIntervalMs?: number` to the opts
- refactor `runCommand` so that, after `handle(...)` succeeds, it calls a new local function:

```ts
  const applyAndReact = (bodies: EventBody[], actor: Actor) => {
    const commit = (b: EventBody[]) => {
      const stored = store.append(b, actor);
      for (const ev of stored) applyEvent(state, ev);
      return stored;
    };
    const fresh = bodies.length ? commit(bodies) : [];
    runFollowUps(
      fresh,
      (evs) => {
        const next = react(state, evs, { root, config, newId: randomUUID });
        const more = [...next.events, ...next.effects.flatMap(runEffect)];
        return more.length === 0 ? [] : commit(more);
      },
      opts.log ?? console.error,
    );
    try {
      writeAll(root, state, config);
    } catch (e) {
      (opts.log ?? console.error)(`render failed after commit: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
```

  Inside `runCommand`, after `if (!decision.ok) return decision;`, the body becomes `applyAndReact([...decision.events, ...decision.effects.flatMap(runEffect)], actor.data); return { ok: true, result: decision.result };`. Keep the behavior identical, including always rendering.
- after the listener is created, add:

```ts
  const sweepTimer = setInterval(() => {
    if (shuttingDown) return;
    void enqueue(() => {
      const r = sweep(state, new Date().toISOString(), { root, config, newId: randomUUID });
      const bodies = [...r.events, ...r.effects.flatMap(runEffect)];
      if (bodies.length) applyAndReact(bodies, { role: "user" });
    }).catch((e) => (opts.log ?? console.error)(`sweep failed: ${e instanceof Error ? e.message : String(e)}`));
  }, opts.sweepIntervalMs ?? 15_000);
  sweepTimer.unref?.();
```

- in `stop`, call `clearInterval(sweepTimer);` before awaiting the chain.
- add the imports `Actor`/`EventBody` if missing.

- [ ] **Step 6: Verify and commit**

Run the full suite and typecheck → PASS, with no processes left.

```bash
git add src/herdr/bridge.ts src/daemon tests/fixtures/fake-herdr.ts tests/helpers.ts tests/herdr/bridge.test.ts tests/daemon/lifecycle.test.ts
git commit -m "feat: probe agents on reconcile, resume from saved sessions, sweep overdue handoffs"
```

---

### Task 7: End-to-end lifecycle scenario

**Files:**
- Test: `tests/e2e/lifecycle-flow.test.ts`

**Interfaces:**
- Consumes: the `agt` binary, fake herdr and fake claude.
- Produces: a regression test that drives a full rotation through the CLI (precompact → handoff request → `agt handoff --stdin` → replacement in a split pane, with the old pane closed) and then a recovery (agent gone → `agt start` → resume with `--resume`).

- [ ] **Step 1: Write the scenario**

Create `tests/e2e/lifecycle-flow.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { claudeSessionFile } from "../../src/agents/claude.ts";
import { initProject } from "../../src/project/init.ts";
import { FAKE_CLAUDE, FAKE_HERDR, fakeHerdrState, isolatedConfigHome, tempRepo, waitFor } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");
let root: string;
let fake: ReturnType<typeof fakeHerdrState>;
let xdg: string;
let claudeDir: string;

function agt(args: string[], extra: Record<string, string> = {}, stdin?: string) {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "", HOME: "/nonexistent", XDG_CONFIG_HOME: xdg, AGT_ROOT: root, FAKE_HERDR_STATE: fake.file,
      HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t0", HERDR_PANE_ID: "w1:p0", HERDR_BIN_PATH: FAKE_HERDR,
      AGT_CLAUDE_BIN: FAKE_CLAUDE, CLAUDE_CONFIG_DIR: claudeDir, ...extra,
    },
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`agt ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

type Sess = { id: string; role: string; status: string; pane?: string };
const sessions = () =>
  (parse(readFileSync(join(root, ".agentthread/threads/001-login/sub.thread.md"), "utf8").split("---\n")[1]!) as { sessions: Sess[] }).sessions;
const liveCoordinator = () => sessions().find((s) => s.role === "coordinator" && s.pane && !["rotated", "lost", "ended", "failed"].includes(s.status));
const hook = (signal: string, id: string) => agt(["event", signal], { AGT_ROLE: "coordinator", AGT_THREAD: "001" }, JSON.stringify({ session_id: id }));
const HANDOFF = ["Goal status", "Work done", "Decisions", "Next steps", "Risks"].map((s) => `## ${s}\n${s} written by the coordinator`).join("\n");

beforeAll(() => {
  root = tempRepo();
  initProject(root, "shop");
  fake = fakeHerdrState({ tabs: ["w1:t0"], panes: ["w1:p0"] });
  xdg = isolatedConfigHome();
  claudeDir = isolatedConfigHome();
});

afterAll(() => {
  try {
    agt(["daemon", "stop"]);
  } catch {
    // never started
  }
});

test("rotation on precompact, then recovery by resume", async () => {
  agt(["start", "--no-manager"]);
  agt(["thread", "new", "Login", "--type", "feature"]);
  const c1 = await waitFor(() => liveCoordinator(), 10_000);
  hook("started", c1.id);

  // compaction → rotation requested → handoff request delivered at idle
  hook("compacting", c1.id);
  hook("idle", c1.id);
  const prompts = () => fake.read().calls.filter((x) => x[0] === "agent" && x[1] === "prompt").map((x) => x[3] ?? "");
  expect(prompts().some((p) => p.startsWith("HANDOFF REQUEST:") && p.includes("agt handoff 001 --stdin"))).toBe(true);
  expect(sessions().find((s) => s.id === c1.id)!.status).toBe("rotating");

  // the coordinator writes its handoff → replacement split from its pane, old pane closed
  agt(["handoff", "001", "--stdin"], { AGT_ROLE: "coordinator", AGT_THREAD: "001" }, HANDOFF);
  const c2 = await waitFor(() => {
    const c = liveCoordinator();
    return c && c.id !== c1.id ? c : undefined;
  }, 10_000);
  expect(sessions().find((s) => s.id === c1.id)!.status).toBe("rotated");
  expect(c2.pane).not.toBe(c1.pane);
  expect(fake.read().calls.some((x) => x.join(" ") === `pane close ${c1.pane}`)).toBe(true);
  expect(prompts().some((p) => p.startsWith("Continue coordinating thread 001 as its new coordinator."))).toBe(true);
  expect(readFileSync(join(root, ".agentthread/threads/001-login/sub.thread.md"), "utf8")).toContain("Goal status written by the coordinator");

  // the agent in c2's pane disappears; its transcript exists → agt start resumes it with --resume
  const s = fake.read();
  writeFileSync(fake.file, JSON.stringify({ ...s, agentPanes: (s.agentPanes ?? []).filter((p) => p !== c2.pane) }));
  const file = claudeSessionFile({ configDir: claudeDir, cwd: join(root, ".worktrees", "001-login"), session: c2.id });
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "{}\n");
  const before = fake.read().calls.length;
  agt(["start", "--no-manager"]);
  const resumed = await waitFor(() => {
    const calls = fake.read().calls.slice(before);
    return calls.find((x) => x[0] === "agent" && x[1] === "start" && x.includes("--resume"));
  }, 10_000);
  expect(resumed).toContain(c2.id);
  expect(resumed[resumed.indexOf("--pane") + 1]).toBe(c2.pane);
});
```

- [ ] **Step 2: Run the scenario**

Run: `env -u HERDR_ENV -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID -u HERDR_PANE_ID -u AGT_HERDR_IT bun test tests/e2e/lifecycle-flow.test.ts`
Expected: PASS. If it fails, fix the owning task's code, not the scenario. Use `agt logs` to inspect the events.

- [ ] **Step 3: Full suite and commit**

Run the full suite and typecheck → all PASS, with no processes left.

```bash
git add tests/e2e/lifecycle-flow.test.ts
git commit -m "test: add end-to-end rotation and recovery scenario"
```

---

## After merging: manual smoke test additions

Add these to the README's manual smoke-test list, done in the same task as the README edit (Task 2 is fine; edit `README.md` there):

5. In a coordinator pane, run `/compact`. The pane should get a HANDOFF REQUEST, the coordinator should submit it with `agt handoff … --stdin`, and a new coordinator pane should replace it.
6. Quit a coordinator's Claude (`/exit`), then run `agt start` from the main tab. The coordinator should come back with `claude --resume` in the same pane.
