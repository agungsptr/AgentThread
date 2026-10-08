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
