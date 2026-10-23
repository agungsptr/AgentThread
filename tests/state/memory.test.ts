import { expect, test } from "bun:test";
import { handle } from "../../src/commands/handler.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import type { Actor, EventBody } from "../../src/domain/types.ts";
import { renderSub } from "../../src/render/markdown.ts";
import { project } from "../../src/state/projection.ts";
import { INIT, stateOf, stored, threadCreated } from "../helpers.ts";

const COORD: Actor = { role: "coordinator", thread: "001", session: "c1" };

test("notes and questions keep order, progress is latest-wins, each writes a log line", () => {
  const t = stateOf(
    INIT,
    threadCreated("001"),
    { type: "note.recorded", thread: "001", payload: { message: "a" } },
    { type: "question.recorded", thread: "001", payload: { message: "q1" } },
    { type: "note.recorded", thread: "001", payload: { message: "b" } },
    { type: "progress.recorded", thread: "001", payload: { message: "p1" } },
    { type: "progress.recorded", thread: "001", payload: { message: "p2" } },
  ).threads.get("001")!;
  expect(t.findings.map((e) => e.message)).toEqual(["a", "b"]);
  expect(t.questions.map((e) => e.message)).toEqual(["q1"]);
  expect(t.progress).toMatchObject({ message: "p2" });
  expect(t.log.map((e) => e.message).slice(-5)).toEqual(["note: a", "question: q1", "note: b", "progress: p1", "progress: p2"]);
});

test("progress resets the checkpoint counters of the actor's session or live coordinator", () => {
  const bodies = [
    INIT,
    threadCreated("001"),
    { type: "session.created", thread: "001", payload: { session: "c1", role: "coordinator", agent: "claude-code", name: "n" } },
    { type: "session.created", thread: "001", payload: { session: "w1", role: "worker", agent: "claude-code", name: "m", ticket: "T1" } },
    { type: "progress.recorded", thread: "001", payload: { message: "p" } },
  ] as EventBody[];
  const run = (actor: Actor) => {
    const evs = stored(bodies);
    evs[4]!.actor = actor;
    return project(evs);
  };
  const viaSession = run({ role: "worker", thread: "001", session: "w1" });
  expect(viaSession.sessions.get("w1")!.turnsSinceProgress).toBe(0);
  expect(viaSession.sessions.get("w1")!.lastProgressAt).toBeDefined();
  expect(viaSession.sessions.get("c1")!.turnsSinceProgress).toBeUndefined();
  const viaRole = run({ role: "coordinator", thread: "001" });
  expect(viaRole.sessions.get("c1")!.turnsSinceProgress).toBe(0);
});

test("sub.thread.md renders Progress, Findings, Open questions after decisions", () => {
  const empty = renderSub(stateOf(INIT, threadCreated("001")).threads.get("001")!);
  expect(empty).toContain("## Progress\n\n_None yet._\n\n## Findings\n\n_None yet._\n\n## Open questions\n\n_None yet._\n\n## Handoff");
  const md = renderSub(
    stateOf(
      INIT,
      threadCreated("001"),
      { type: "decision.recorded", thread: "001", payload: { message: "d" } },
      { type: "note.recorded", thread: "001", payload: { message: "found it" } },
      { type: "question.recorded", thread: "001", payload: { message: "why?" } },
      { type: "progress.recorded", thread: "001", payload: { message: "half way" } },
    ).threads.get("001")!,
  );
  const at = (h: string) => md.indexOf(h);
  expect(at("## Context & decisions")).toBeLessThan(at("## Progress"));
  expect(at("## Progress")).toBeLessThan(at("## Findings"));
  expect(at("## Findings")).toBeLessThan(at("## Open questions"));
  expect(at("## Open questions")).toBeLessThan(at("## Handoff"));
  expect(md).toMatch(/## Progress\n\n\S+ half way/);
  expect(md).toMatch(/- \S+ found it/);
  expect(md).toMatch(/- \S+ why\?/);
});

test("ticket.done requires a non-empty summary", () => {
  expect(CommandSchema.safeParse({ cmd: "ticket.done", thread: "001", ticket: "T1" }).success).toBe(false);
  expect(CommandSchema.safeParse({ cmd: "ticket.done", thread: "001", ticket: "T1", summary: "  " }).success).toBe(false);
  expect(CommandSchema.safeParse({ cmd: "ticket.done", thread: "001", ticket: "T1", summary: "ok" }).success).toBe(true);
});

test("note, progress and question are open to all roles but bound to the actor's thread", () => {
  const s = stateOf(INIT, threadCreated("001"), threadCreated("002"));
  for (const cmd of ["note", "progress", "question"] as const) {
    const parsed = CommandSchema.parse({ cmd, thread: "001", message: "m" });
    expect(handle(s, parsed, COORD, { root: "/repo" })).toMatchObject({ ok: true });
    expect(handle(s, parsed, { role: "worker", thread: "001", session: "w1" }, { root: "/repo" })).toMatchObject({ ok: true });
    expect(handle(s, parsed, { role: "main" }, { root: "/repo" })).toMatchObject({ ok: true });
    expect(handle(s, parsed, { role: "worker", thread: "002", session: "w1" }, { root: "/repo" })).toMatchObject({ ok: false });
  }
});
