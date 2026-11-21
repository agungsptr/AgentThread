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
    id: S1, role: "coordinator", agent: "claude-code", name: "n-1111", thread: "001", pane: "w1:p2", status: "active", notices: ["b"], turns: 0, turnsSinceProgress: 0, createdAt: "2026-10-09T10:00:02.000Z", lastActiveAt: "2026-10-09T10:00:08.000Z",
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

test("a first session.started makes any role idle; a later one (compact/resume) makes it active", () => {
  const M = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const s = stateOf(
    INIT,
    threadCreated("001"),
    { type: "session.created", payload: { session: M, role: "main", agent: "claude-code", name: "m" } },
    { type: "session.started", payload: { session: M } },
    created(S1, "coordinator"),
    { type: "session.started", thread: "001", payload: { session: S1 } },
    created(S2, "worker", "T1"),
    { type: "session.started", thread: "001", payload: { session: S2 } },
  );
  for (const id of [M, S1, S2]) expect(s.sessions.get(id)!.status).toBe("idle");
  const s2 = stateOf(
    INIT,
    threadCreated("001"),
    created(S1, "coordinator"),
    { type: "session.started", thread: "001", payload: { session: S1 } },
    { type: "session.active", thread: "001", payload: { session: S1 } },
    { type: "session.started", thread: "001", payload: { session: S1 } },
  );
  expect(s2.sessions.get(S1)!.status).toBe("active");
  const s3 = stateOf(
    INIT,
    threadCreated("001"),
    created(S1, "coordinator"),
    { type: "session.started", thread: "001", payload: { session: S1 } },
    { type: "agent.idle", thread: "001", payload: { session: S1 } },
    { type: "session.started", thread: "001", payload: { session: S1 } },
  );
  expect(s3.sessions.get(S1)!.status).toBe("active");
});

test("a first start seen by the poller and then by the agent's hook stays idle; a start after real work is a resume", () => {
  const twice = stateOf(
    INIT,
    threadCreated("001"),
    created(S1, "coordinator"),
    { type: "session.started", thread: "001", payload: { session: S1, source: "poll" } },
    { type: "session.started", thread: "001", payload: { session: S1 } },
  );
  expect(twice.sessions.get(S1)!.status).toBe("idle");
  const resumed = stateOf(
    INIT,
    threadCreated("001"),
    created(S1, "coordinator"),
    { type: "session.started", thread: "001", payload: { session: S1, source: "poll" } },
    { type: "session.active", thread: "001", payload: { session: S1 } },
    { type: "agent.idle", thread: "001", payload: { session: S1 } },
    { type: "session.started", thread: "001", payload: { session: S1 } },
  );
  expect(resumed.sessions.get(S1)!.status).toBe("active");
});

test("notice.delivered with texts removes the delivered notices, not a handoff request queued meanwhile", () => {
  const H = "HANDOFF REQUEST: write the handoff";
  const base: EventBody[] = [
    INIT,
    threadCreated("001"),
    created(S1, "coordinator"),
    { type: "session.attached", thread: "001", payload: { session: S1, pane: "w1:p2" } },
    { type: "session.started", thread: "001", payload: { session: S1 } },
    { type: "agent.idle", thread: "001", payload: { session: S1 } },
    { type: "notice.queued", thread: "001", payload: { session: S1, text: "A" } },
    { type: "notice.queued", thread: "001", payload: { session: S1, text: "B" } },
    { type: "session.rotation_requested", thread: "001", payload: { session: S1, reason: "context" } },
    { type: "notice.queued", thread: "001", payload: { session: S1, text: H } },
    { type: "notice.delivered", thread: "001", payload: { session: S1, count: 2, texts: ["A", "B"] } },
  ];
  const s = stateOf(...base).sessions.get(S1)!;
  expect(s.notices).toEqual([H]);
  expect(s.rotation?.deliveredAt).toBeUndefined();
  const s2 = stateOf(...base, { type: "notice.delivered", thread: "001", payload: { session: S1, count: 1, texts: [H] } }).sessions.get(S1)!;
  expect(s2.notices).toEqual([]);
  expect(s2.rotation?.deliveredAt).toBeDefined();
});
