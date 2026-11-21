import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { handle, type HandleResult } from "../../src/commands/handler.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import type { Actor, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, threadCreated } from "../helpers.ts";

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const M = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function setup(): State {
  const s = stateOf(
    INIT,
    threadCreated("001"),
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    { type: "session.created", payload: { session: M, role: "main", agent: "claude-code", name: "m" } },
    { type: "session.attached", payload: { session: M, pane: "w1:p0" } },
  );
  return s;
}
const run = (s: State, cmd: unknown, actor: Actor = USER): HandleResult =>
  handle(s, CommandSchema.parse(cmd), actor, { root: "/repo", config: DEFAULT_CONFIG, newId: () => C });

test("signal by pane resolves the live session in that pane", () => {
  const r = run(setup(), { cmd: "session.signal", pane: "w1:p2", signal: "idle" });
  expect(r.ok && r.events).toEqual([{ type: "agent.idle", thread: "001", payload: { session: C } }]);
});

test("an unknown pane is rejected", () => {
  const r = run(setup(), { cmd: "session.signal", pane: "w1:p9", signal: "idle" });
  expect(r).toEqual({ ok: false, error: "no live session in pane w1:p9" });
});

test("session or pane is required", () => {
  expect(run(setup(), { cmd: "session.signal", signal: "idle" })).toEqual({ ok: false, error: "session or pane is required" });
});

test("a pane-addressed signal respects the actor session check", () => {
  const r = run(setup(), { cmd: "session.signal", pane: "w1:p2", signal: "idle" }, { role: "coordinator", thread: "001", session: M });
  expect(r.ok).toBe(false);
});

test("blocked keeps the status, notes it, and notifies main", () => {
  const s = setup();
  applyEvent(s, { type: "session.started", thread: "001", payload: { session: C } , seq: 100, ts: "t", actor: USER } as StoredEvent);
  const r = run(s, { cmd: "session.signal", pane: "w1:p2", signal: "blocked" });
  expect(r.ok && r.events).toEqual([{ type: "agent.blocked", thread: "001", payload: { session: C } }]);
  const ev = { ...(r as { events: object[] }).events[0], seq: 101, ts: "t", actor: USER } as StoredEvent;
  const before = s.sessions.get(C)!.status;
  applyEvent(s, ev);
  expect(s.sessions.get(C)!.status).toBe(before);
  expect(s.threads.get("001")!.log.at(-1)!.message).toBe("session cccccccc is waiting for approval");
  const out = react(s, [ev], { root: "/repo", config: DEFAULT_CONFIG, newId: () => C });
  expect(out.events).toEqual([
    { type: "notice.queued", payload: { session: M, text: "coordinator of thread 001 (Thread 001) is waiting for the user in its pane: it asked a question or needs a permission. Tell the user to answer it in the thread tab 001-thread-001." } },
  ]);
});
