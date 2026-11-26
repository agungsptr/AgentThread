import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../../src/config/config.ts";
import { handle, type HandleResult } from "../../src/commands/handler.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import type { Actor, StoredEvent } from "../../src/domain/types.ts";
import { renderBrief } from "../../src/render/brief.ts";
import { renderMain } from "../../src/render/markdown.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, taskThreadCreated } from "../helpers.ts";

const COORD: Actor = { role: "coordinator", thread: "001", session: "c1" };
const root = realpathSync(mkdtempSync(join(tmpdir(), "agt-docstage-")));
mkdirSync(join(root, ".docs", "shared", "reviews"), { recursive: true });
// e2e and browser configured: a code thread would get no na stages, so a doc thread's empty start is its own.
const config: Config = {
  ...DEFAULT_CONFIG,
  workflow: { ...DEFAULT_CONFIG.workflow, banned_words: ["claude"], stack: { restart: "make up" }, browser: { urls: ["http://x"] }, e2e: { stage2: "e2e" } },
};
const run = (s: State, cmd: unknown, actor: Actor = COORD): HandleResult => handle(s, CommandSchema.parse(cmd), actor, { root, config });
const exec = (s: State, cmd: unknown, actor: Actor = COORD): HandleResult => {
  const r = run(s, cmd, actor);
  if (r.ok) for (const body of r.events) applyEvent(s, { ...body, seq: s.lastSeq + 1, ts: "2026-11-27T10:00:00.000Z", actor } as StoredEvent);
  return r;
};
const errorOf = (r: HandleResult) => (r.ok ? "accepted" : r.error);
const stage = (n: number, state: string, extra: Record<string, unknown> = {}) => ({ cmd: "stage", thread: "001", stage: n, state, ...extra });
const doc = (status: "open" | "in_progress" = "in_progress") => stateOf(INIT, taskThreadCreated("001", "rv-1", { threadType: "review", status }));
const REPORT = ".docs/shared/reviews/r.md";
const withReport = (text: string | undefined) => {
  const s = doc();
  exec(s, { cmd: "thread.report", thread: "001", path: REPORT });
  if (text !== undefined) writeFileSync(join(root, REPORT), text);
  return s;
};

describe("doc thread stages", () => {
  test("a doc thread starts at 1 scope with no stage recorded by agt", () => {
    const s = stateOf(INIT);
    const r = exec(s, { cmd: "thread.new", title: "Review PR 12", type: "review" }, USER);
    expect(r.ok && r.events.filter((e) => e.type === "stage.recorded")).toEqual([]);
    expect(renderBrief({ thread: s.threads.get("001")!, sessions: [] })).toContain("Stage: 1 scope");
    expect(renderMain(s)).toContain("| 1 scope |");
  });

  test("stages 1-3 done make the current stage 4 approval", () => {
    const s = doc();
    for (const n of [1, 2, 3]) expect(errorOf(exec(s, stage(n, "done")))).toBe("accepted");
    expect(renderBrief({ thread: s.threads.get("001")!, sessions: [] })).toContain("Stage: 4 approval");
  });

  test("stage numbers beyond 4 are rejected on a doc thread", () => {
    expect(errorOf(run(doc(), stage(5, "done")))).toBe("a review thread has stages 1-4");
  });

  test("approve is a code-thread state", () => {
    expect(errorOf(run(doc(), stage(4, "approve", { by: "user" }), USER))).toBe("only stage 7 (e2e) of a code thread is approved");
  });

  test("stage 4 cannot be skipped or na", () => {
    const msg = "stage 4 (approval) cannot be skipped or na: it runs the share check";
    expect(errorOf(run(doc(), stage(4, "skipped", { by: "user", reason: "x" }), USER))).toBe(msg);
    expect(errorOf(run(doc(), stage(4, "na", { reason: "x" })))).toBe(msg);
  });

  test("stage 4 done needs a recorded, readable, clean report", () => {
    expect(errorOf(run(doc(), stage(4, "done")))).toBe("no report recorded: agt thread report 001 <path>");
    expect(errorOf(run(withReport(undefined), stage(4, "done")))).toBe(`report ${REPORT} is missing`);
    expect(errorOf(run(withReport("  \n"), stage(4, "done")))).toBe(`report ${REPORT} is empty`);
    expect(errorOf(run(withReport("see .docs/x\nby Claude\n"), stage(4, "done")))).toBe(`report ${REPORT} mentions private things: line 1 ".docs", line 2 "Claude"`);
  });

  test("stage 4 done on a clean report moves an in-progress doc thread to review", () => {
    const s = withReport("# Review\nAll clear.\n");
    const r = exec(s, stage(4, "done"));
    expect(r.ok && r.events.map((e) => e.type)).toEqual(["stage.recorded", "thread.status_changed"]);
    expect(s.threads.get("001")!.status).toBe("review");
  });

  test("browser-check and e2e4 are code-thread only", () => {
    expect(errorOf(run(doc(), { cmd: "thread.browser_check", thread: "001" }))).toBe("the browser check applies to code threads");
    expect(errorOf(run(doc(), { cmd: "stack.acquire", thread: "001", for: "e2e4" }))).toBe("e2e stage 4 applies to code threads");
  });

  test("a doc coordinator closing its thread is pointed at main with the report wording", () => {
    expect(errorOf(run(doc(), { cmd: "thread.status", thread: "001", status: "done" }))).toBe('only main or the user close a thread: agt tell main "001: report approved: <report path>"');
  });

  test("a code thread keeps its ten stages", () => {
    const s = stateOf(INIT, taskThreadCreated("001", "f-1", { status: "in_progress" }));
    expect(errorOf(run(s, stage(5, "done")))).toBe("accepted");
    expect(errorOf(run(s, stage(4, "na", { reason: "x" })))).toBe("accepted");
  });
});
