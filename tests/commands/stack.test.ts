import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { handle, type HandleResult } from "../../src/commands/handler.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import type { Actor, EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { sweep } from "../../src/orchestration/sweep.ts";
import { renderMain } from "../../src/render/markdown.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, taskThreadCreated, threadCreated } from "../helpers.ts";

const CA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const WK: Actor = { role: "worker", thread: "001", session: "w1", ticket: "T1" };
const coord = (thread: string): Actor => ({ role: "coordinator", thread });
const ctx = { root: "/repo", config: DEFAULT_CONFIG, newId: () => "00000000-0000-4000-8000-000000000001" };
const run = (state: State, cmd: unknown, actor: Actor): HandleResult => handle(state, CommandSchema.parse(cmd), actor, { root: "/repo" });

/** Applies bodies as stored events and returns them, the way the daemon feeds react(). */
function apply(state: State, ...bodies: EventBody[]): StoredEvent[] {
  return bodies.map((b) => {
    const ev = { ...b, seq: state.lastSeq + 1, ts: "2026-10-11T10:00:00.000Z", actor: USER } as StoredEvent;
    applyEvent(state, ev);
    return ev;
  });
}
/** Runs a command, applies its events, and applies what the reactor decides, until it settles. */
function exec(state: State, cmd: unknown, actor: Actor): HandleResult {
  const r = run(state, cmd, actor);
  if (!r.ok) return r;
  let evs = apply(state, ...r.events);
  for (let i = 0; i < 5 && evs.length; i++) evs = apply(state, ...react(state, evs, ctx).events);
  return r;
}
const errorOf = (r: HandleResult) => (r.ok ? "accepted" : r.error);
const acquire = (thread: string, extra: Record<string, unknown> = {}) => ({ cmd: "stack.acquire", thread, ...extra });
const release = (thread: string) => ({ cmd: "stack.release", thread });

function base(): State {
  const s = stateOf(INIT, taskThreadCreated("001", "a"), taskThreadCreated("002", "b"), taskThreadCreated("003", "c"));
  for (const [thread, session] of [["001", CA], ["002", CB], ["003", CC]] as const) {
    apply(s, { type: "session.created", thread, payload: { session, role: "coordinator", agent: "claude-code", name: session } }, { type: "session.attached", thread, payload: { session, pane: `p${thread}` } });
  }
  return s;
}
const notices = (s: State, session: string) => s.sessions.get(session)!.notices;

describe("agt stack", () => {
  test("A acquires, B queues at position 1, A releases and B gets it with the notice", () => {
    const s = base();
    const a = exec(s, acquire("001"), coord("001"));
    expect(a.ok && a.result).toEqual({ acquired: true });
    expect(s.stack.holder).toMatchObject({ thread: "001" });
    const b = exec(s, acquire("002", {}), coord("002"));
    expect(b.ok && b.result).toEqual({ acquired: false, position: 1 });
    expect(s.stack.queue).toEqual([{ thread: "002" }]);
    exec(s, release("001"), coord("001"));
    expect(s.stack.holder).toMatchObject({ thread: "002" });
    expect(s.stack.queue).toEqual([]);
    expect(notices(s, CB)).toEqual(["The stack lock is yours for thread 002."]);
  });

  test("events: acquired and queued carry the purpose, released the reason", () => {
    const s = base();
    s.threads.get("001")!.stage7Approved = true;
    expect(run(s, acquire("001", { for: "e2e4" }), coord("001"))).toMatchObject({ ok: true, events: [{ type: "stack.acquired", thread: "001", payload: { thread: "001", purpose: "e2e4" } }] });
    exec(s, acquire("001", { for: "e2e4" }), coord("001"));
    expect(run(s, acquire("002"), coord("002"))).toMatchObject({ ok: true, events: [{ type: "stack.queued", thread: "002", payload: { thread: "002" } }] });
    expect(run(s, release("001"), coord("001"))).toMatchObject({ ok: true, events: [{ type: "stack.released", thread: "001", payload: { thread: "001", reason: "released" } }] });
  });

  test("a double acquire by the holder is a no-op; a queued thread keeps its position", () => {
    const s = base();
    exec(s, acquire("001"), coord("001"));
    const again = run(s, acquire("001"), coord("001"));
    expect(again).toMatchObject({ ok: true, events: [], result: { acquired: true } });
    exec(s, acquire("002"), coord("002"));
    exec(s, acquire("003"), coord("003"));
    const second = run(s, acquire("002"), coord("002"));
    expect(second).toMatchObject({ ok: true, events: [], result: { acquired: false, position: 1 } });
    expect(s.stack.queue.map((q) => q.thread)).toEqual(["002", "003"]);
  });

  test("e2e4 without the user's approval is rejected; with it the lock is acquired", () => {
    const s = base();
    expect(errorOf(run(s, acquire("001", { for: "e2e4" }), coord("001")))).toBe("stage 4 e2e needs the user's approval: agt stage 001 7 approve --by user");
    exec(s, { cmd: "stage", thread: "001", stage: 7, state: "approve", by: "user" }, USER);
    const r = exec(s, acquire("001", { for: "e2e4" }), coord("001"));
    expect(r.ok && r.result).toEqual({ acquired: true });
    expect(s.stack.holder).toMatchObject({ thread: "001", purpose: "e2e4" });
  });

  test("workers may not acquire or release; the user may; status is open to every role", () => {
    const s = base();
    expect(errorOf(run(s, acquire("001"), WK))).toBe("role worker may not run stack.acquire");
    expect(errorOf(run(s, release("001"), WK))).toBe("role worker may not run stack.release");
    expect(errorOf(run(s, acquire("001"), coord("002")))).toBe("coordinator is bound to thread 002");
    exec(s, acquire("001"), USER);
    expect(s.stack.holder?.thread).toBe("001");
    for (const actor of [WK, USER, { role: "main" } as Actor, coord("002")]) {
      expect(run(s, { cmd: "stack.status" }, actor)).toMatchObject({ ok: true, events: [], result: { holder: { thread: "001" }, queue: [] } });
    }
  });

  test("a legacy thread may use the lock too", () => {
    const s = stateOf(INIT, threadCreated("001"));
    expect(run(s, acquire("001"), coord("001"))).toMatchObject({ ok: true, result: { acquired: true } });
  });

  test("releasing from the queue leaves it; releasing from a thread that neither holds nor waits is a no-op", () => {
    const s = base();
    exec(s, acquire("001"), coord("001"));
    exec(s, acquire("002"), coord("002"));
    expect(run(s, release("003"), coord("003"))).toMatchObject({ ok: true, events: [] });
    const r = run(s, release("002"), coord("002"));
    expect(r).toMatchObject({ ok: true, events: [{ type: "stack.released", thread: "002", payload: { thread: "002", reason: "left the queue" } }] });
    exec(s, release("002"), coord("002"));
    expect(s.stack.queue).toEqual([]);
    expect(s.stack.holder?.thread).toBe("001");
  });

  test("with no one queued, a release frees the lock", () => {
    const s = base();
    exec(s, acquire("001"), coord("001"));
    exec(s, release("001"), coord("001"));
    expect(s.stack.holder).toBeUndefined();
  });

  test("the sweep releases a holder without a live coordinator and the lock passes to the next", () => {
    const s = base();
    exec(s, acquire("001"), coord("001"));
    exec(s, acquire("002"), coord("002"));
    expect(sweep(s, "2026-10-11T10:00:01.000Z", ctx).events.filter((e) => e.type.startsWith("stack."))).toEqual([]);
    apply(s, { type: "session.lost", thread: "001", payload: { session: CA, reason: "gone" } });
    const r = sweep(s, "2026-10-11T10:00:01.000Z", ctx);
    expect(r.events.filter((e) => e.type.startsWith("stack."))).toEqual([{ type: "stack.released", thread: "001", payload: { thread: "001", reason: "holder thread has no live coordinator" } }]);
    let evs = apply(s, ...r.events);
    evs = apply(s, ...react(s, evs, ctx).events);
    expect(s.stack.holder).toMatchObject({ thread: "002" });
    expect(notices(s, CB)).toEqual(["The stack lock is yours for thread 002."]);
    void evs;
  });

  test("a done holder is released by the sweep", () => {
    const s = base();
    exec(s, acquire("001"), coord("001"));
    apply(s, { type: "thread.status_changed", thread: "001", payload: { from: "open", to: "done" } });
    expect(sweep(s, "2026-10-11T10:00:01.000Z", ctx).events).toContainEqual({ type: "stack.released", thread: "001", payload: { thread: "001", reason: "holder thread has no live coordinator" } });
  });

  test("a queued thread without a live coordinator is dropped, never handed the lock", () => {
    const s = base();
    exec(s, acquire("001"), coord("001"));
    exec(s, acquire("002"), coord("002"));
    exec(s, acquire("003"), coord("003"));
    apply(s, { type: "session.lost", thread: "001", payload: { session: CA, reason: "gone" } }, { type: "session.lost", thread: "002", payload: { session: CB, reason: "gone" } });
    const r = sweep(s, "2026-10-11T10:00:01.000Z", ctx);
    expect(r.events.filter((e) => e.type.startsWith("stack."))).toEqual([
      { type: "stack.released", thread: "001", payload: { thread: "001", reason: "holder thread has no live coordinator" } },
      { type: "stack.released", thread: "002", payload: { thread: "002", reason: "left the queue" } },
    ]);
    let evs = apply(s, ...r.events);
    evs = apply(s, ...react(s, evs, ctx).events);
    expect(s.stack.holder).toMatchObject({ thread: "003" });
    expect(notices(s, CC)).toEqual(["The stack lock is yours for thread 003."]);
    void evs;
  });

  test("main.thread.md shows the holder and the queue", () => {
    const s = base();
    expect(renderMain(s)).toContain("Stack: free");
    exec(s, acquire("001"), coord("001"));
    exec(s, acquire("002"), coord("002"));
    const md = renderMain(s);
    expect(md).toContain("## Stack");
    expect(md).toContain("Held by thread 001");
    expect(md).toContain("Queue: 002");
  });
});
