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
  expect(s.sessions.get(C)).toMatchObject({ status: "starting" });
  expect(s.sessions.get(C)!.pane).toBeUndefined();
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

test("a pending rotation survives lost and resuming", () => {
  const s = stateOf(
    INIT, threadCreated("001"), coord, at("w1:p2"),
    { type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "context" } },
    { type: "session.lost", thread: "001", payload: { session: C, reason: "no agent in pane w1:p2" } },
    { type: "session.resuming", thread: "001", payload: { session: C } },
  );
  const c = s.sessions.get(C)!;
  // resuming restarts the handoff clock and records when the resume began
  expect(c.rotation).toEqual({ reason: "context", requestedAt: "2026-10-09T10:00:06.000Z" });
  expect(c.resumingAt).toBe("2026-10-09T10:00:06.000Z");
  expect(displayStatus(c)).toBe("rotating");
});
