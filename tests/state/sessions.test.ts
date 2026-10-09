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
    id: S1, role: "coordinator", agent: "claude-code", name: "n-1111", thread: "001", pane: "w1:p2", status: "active", notices: ["b"],
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

test("notice.delivered starts a turn for live sessions only", () => {
  const s = stateOf(
    INIT,
    threadCreated("001"),
    created(S1, "coordinator"),
    { type: "agent.idle", thread: "001", payload: { session: S1 } },
    { type: "notice.queued", thread: "001", payload: { session: S1, text: "a" } },
    { type: "notice.delivered", thread: "001", payload: { session: S1, count: 1 } },
    created(S2, "worker", "T1"),
    { type: "session.ended", thread: "001", payload: { session: S2 } },
    { type: "notice.delivered", thread: "001", payload: { session: S2, count: 0 } },
  );
  expect(s.sessions.get(S1)!.status).toBe("active");
  expect(s.sessions.get(S2)!.status).toBe("ended");
});

test("ended does not overwrite failed", () => {
  const s = stateOf(
    INIT,
    threadCreated("001"),
    created(S1, "coordinator"),
    { type: "session.failed", thread: "001", payload: { session: S1, reason: "boom" } },
    { type: "session.ended", thread: "001", payload: { session: S1 } },
  );
  expect(s.sessions.get(S1)!.status).toBe("failed");
});
