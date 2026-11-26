import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle, type HandleResult } from "../../src/commands/handler.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import type { Actor, StoredEvent } from "../../src/domain/types.ts";
import { renderBrief } from "../../src/render/brief.ts";
import { renderMain, renderSub } from "../../src/render/markdown.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, stateOf, taskThreadCreated } from "../helpers.ts";

const COORD: Actor = { role: "coordinator", thread: "001", session: "c1" };
const root = realpathSync(mkdtempSync(join(tmpdir(), "agt-report-")));
mkdirSync(join(root, ".docs", "shared", "reports"), { recursive: true });
const run = (s: State, cmd: unknown, actor: Actor = COORD): HandleResult => handle(s, CommandSchema.parse(cmd), actor, { root });
const exec = (s: State, cmd: unknown, actor: Actor = COORD): HandleResult => {
  const r = run(s, cmd, actor);
  if (r.ok) for (const body of r.events) applyEvent(s, { ...body, seq: s.lastSeq + 1, ts: "2026-11-27T10:00:00.000Z", actor } as StoredEvent);
  return r;
};
const errorOf = (r: HandleResult) => (r.ok ? "accepted" : r.error);
const doc = () => stateOf(INIT, taskThreadCreated("001", "r-1", { threadType: "report" }));
const PATH = ".docs/shared/reports/2026-11-27-auth.md";

describe("agt thread report", () => {
  test("a doc thread records its report path", () => {
    const s = doc();
    expect(exec(s, { cmd: "thread.report", thread: "001", path: PATH })).toMatchObject({ ok: true, result: { path: PATH } });
    expect(s.threads.get("001")!.report).toBe(PATH);
  });

  test("rejects a path outside .docs, with .., absolute, or not .md", () => {
    for (const p of ["docs/x.md", ".docs/../x.md", "/tmp/x.md", ".docs/x.txt", ".docs/a/../../x.md"]) {
      expect(errorOf(run(doc(), { cmd: "thread.report", thread: "001", path: p }))).toBe("report path must be a .md file under .docs/ (workspace-root-relative)");
    }
  });

  test("a code thread has no report", () => {
    const s = stateOf(INIT, taskThreadCreated("001", "f-1"));
    expect(errorOf(run(s, { cmd: "thread.report", thread: "001", path: ".docs/a.md" }))).toBe("thread 001 is a feature thread; only review and report threads have a report");
  });

  test("a done thread's report cannot change", () => {
    const s = stateOf(INIT, taskThreadCreated("001", "r-1", { threadType: "report", status: "done" }));
    expect(errorOf(run(s, { cmd: "thread.report", thread: "001", path: PATH }))).toBe("thread 001 is done");
  });

  test("--check reads the recorded file and lists the hits", () => {
    const s = doc();
    exec(s, { cmd: "thread.report", thread: "001", path: PATH });
    writeFileSync(join(root, PATH), "# Auth\nsee .docs/x\n");
    expect(run(s, { cmd: "thread.report", thread: "001", check: true })).toMatchObject({ ok: true, events: [], result: { path: PATH, ok: false, hits: [{ line: 2, match: ".docs" }] } });
    writeFileSync(join(root, PATH), "# Auth\nAll clear.\n");
    expect(run(s, { cmd: "thread.report", thread: "001", check: true })).toMatchObject({ ok: true, result: { path: PATH, ok: true, hits: [] } });
  });

  test("--check without a recorded path is rejected", () => {
    expect(errorOf(run(doc(), { cmd: "thread.report", thread: "001", check: true }))).toBe("no report recorded: agt thread report 001 <path>");
  });

  test("--check on a missing file is rejected", () => {
    const s = doc();
    exec(s, { cmd: "thread.report", thread: "001", path: ".docs/shared/reports/none.md" });
    expect(errorOf(run(s, { cmd: "thread.report", thread: "001", check: true }))).toBe("report .docs/shared/reports/none.md is missing");
  });

  test("neither a path nor --check is rejected", () => {
    expect(errorOf(run(doc(), { cmd: "thread.report", thread: "001" }))).toBe("thread report needs <path> or --check");
  });

  test("the report path shows in main.thread.md, sub.thread.md and the brief", () => {
    const s = doc();
    exec(s, { cmd: "thread.report", thread: "001", path: PATH });
    const t = s.threads.get("001")!;
    expect(renderMain(s)).toContain(`report: ${PATH}`);
    expect(renderSub(t, [])).toContain(`Report: ${PATH}`);
    expect(renderBrief({ thread: t, sessions: [] })).toContain(`Report: ${PATH}`);
  });
});
