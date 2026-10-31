import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle, type HandleResult } from "../../src/commands/handler.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import type { Actor, StoredEvent } from "../../src/domain/types.ts";
import { renderBrief } from "../../src/render/brief.ts";
import { renderMain, renderSub } from "../../src/render/markdown.ts";
import { writeAll } from "../../src/render/write.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, taskThreadCreated, threadCreated } from "../helpers.ts";

const COORD: Actor = { role: "coordinator", thread: "001", session: "c1" };
const run = (state: State, cmd: unknown, actor: Actor = COORD): HandleResult => handle(state, CommandSchema.parse(cmd), actor, { root: "/repo" });
const exec = (state: State, cmd: unknown, actor: Actor = COORD): HandleResult => {
  const r = run(state, cmd, actor);
  if (r.ok) for (const body of r.events) applyEvent(state, { ...body, seq: state.lastSeq + 1, ts: "2026-10-09T11:00:00.000Z", actor } as StoredEvent);
  return r;
};
const errorOf = (r: HandleResult) => (r.ok ? "accepted" : r.error);
const base = () => stateOf(INIT, taskThreadCreated("001", "kyc-1"));
const stage = (n: number, state: string, extra: Record<string, unknown> = {}) => ({ cmd: "stage", thread: "001", stage: n, state, ...extra });
const thread = (s: State) => s.threads.get("001")!;

describe("agt stage", () => {
  test("stages 1-3 done make the current stage 4 delegation, in the brief, sub.thread.md and main", () => {
    const s = base();
    expect(renderBrief({ thread: thread(s), sessions: [] })).toContain("Stage: 1 discussion");
    for (const n of [1, 2, 3]) expect(errorOf(exec(s, stage(n, "done")))).toBe("accepted");
    expect(renderBrief({ thread: thread(s), sessions: [] })).toContain("Stage: 4 delegation");
    expect(renderSub(thread(s), [])).toContain("Stage: 4 delegation");
    expect(renderMain(s)).toContain("| 4 delegation |");
  });

  test("records the event with stage, state, by and reason", () => {
    const r = run(base(), stage(2, "skipped", { reason: "tiny fix", by: "user" }), USER);
    expect(r.ok && r.events).toEqual([{ type: "stage.recorded", thread: "001", payload: { stage: 2, state: "skipped", by: "user", reason: "tiny fix" } }]);
  });

  test("na and skipped with a reason count as passed; without one they are rejected", () => {
    const s = base();
    expect(errorOf(run(s, stage(1, "na")))).toBe("stage 1 na needs --reason <why>");
    expect(errorOf(run(s, stage(1, "skipped", { by: "user" }), USER))).toBe("stage 1 skipped needs --reason <why>");
    exec(s, stage(1, "na", { reason: "no discussion needed" }));
    exec(s, stage(2, "skipped", { reason: "small", by: "user" }), USER);
    expect(renderBrief({ thread: thread(s), sessions: [] })).toContain("Stage: 3 tickets");
  });

  test("recording a stage again replaces the earlier record", () => {
    const s = base();
    exec(s, stage(8, "na", { reason: "oops" }));
    exec(s, stage(8, "done"));
    expect(thread(s).stages[8]).toMatchObject({ state: "done", by: "coordinator" });
    expect(thread(s).stages[8]!.reason).toBeUndefined();
  });

  test("approve is for stage 7 only and needs --by user", () => {
    const s = base();
    expect(errorOf(run(s, stage(6, "approve", { by: "user" }), USER))).toBe("only stage 7 (e2e) is approved");
    expect(errorOf(run(s, stage(7, "approve")))).toBe("approving stage 7 needs --by user");
    expect(errorOf(exec(s, stage(7, "approve", { by: "user" }), USER))).toBe("accepted");
    expect(thread(s).stage7Approved).toBe(true);
    expect(thread(s).stages[7]).toBeUndefined();
  });

  test("a coordinator cannot skip a stage without --by user", () => {
    expect(errorOf(run(base(), stage(3, "skipped", { reason: "meh" })))).toBe("only the user skips a stage; record it with --by user");
  });

  test("--by user is allowed with skipped only (besides approve)", () => {
    const s = base();
    expect(errorOf(run(s, stage(3, "done", { by: "user" }), USER))).toBe("--by user is only for approve and skipped");
    expect(errorOf(exec(s, stage(3, "skipped", { by: "user", reason: "user said so" }), USER))).toBe("accepted");
    expect(thread(s).stages[3]).toMatchObject({ state: "skipped", by: "user", reason: "user said so" });
  });

  test("rejects a stage outside 1-10", () => {
    expect(() => CommandSchema.parse(stage(0, "done"))).toThrow();
    expect(() => CommandSchema.parse(stage(11, "done"))).toThrow();
  });

  test("only the thread's coordinator and the user may record", () => {
    const s = base();
    expect(errorOf(run(s, stage(1, "done"), USER))).toBe("accepted");
    expect(errorOf(run(s, stage(1, "done"), { role: "worker", thread: "001", session: "w1", ticket: "T1" }))).toBe("role worker may not run stage");
    expect(errorOf(run(s, stage(1, "done"), { role: "main" }))).toBe("role main may not run stage");
    expect(errorOf(run(s, stage(1, "done"), { role: "coordinator", thread: "002", session: "c2" }))).toBe("coordinator is bound to thread 002");
  });

  test("a legacy thread rejects stages and shows none", () => {
    const s = stateOf(INIT, threadCreated("001"));
    expect(errorOf(run(s, stage(1, "done")))).toBe("stages apply to task threads");
    expect(renderBrief({ thread: thread(s), sessions: [] })).not.toContain("Stage:");
    expect(renderMain(s)).toContain("| 0/3 | - |");
  });
});

describe("the stage8 file", () => {
  const file = (root: string) => join(root, ".agentthread", "threads", "001-thread-001", "stage8");
  test("exists only while stage 8 is done, na or skipped", () => {
    const root = mkdtempSync(join(tmpdir(), "agt-s8-"));
    const s = base();
    writeAll(root, s, undefined, () => undefined);
    expect(existsSync(file(root))).toBe(false);
    exec(s, stage(8, "skipped", { reason: "x", by: "user" }), USER);
    writeAll(root, s, undefined, () => undefined);
    expect(readFileSync(file(root), "utf8")).toBe("skipped\n");
    exec(s, stage(8, "done"));
    writeAll(root, s, undefined, () => undefined);
    expect(readFileSync(file(root), "utf8")).toBe("done\n");
    exec(s, stage(8, "na", { reason: "no UI" }));
    writeAll(root, s, undefined, () => undefined);
    expect(readFileSync(file(root), "utf8")).toBe("na\n");
  });

  test("a legacy thread gets none", () => {
    const root = mkdtempSync(join(tmpdir(), "agt-s8-"));
    writeAll(root, stateOf(INIT, threadCreated("001")), undefined, () => undefined);
    expect(existsSync(file(root))).toBe(false);
  });
});
