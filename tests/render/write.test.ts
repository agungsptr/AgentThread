import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBoard } from "../../src/render/markdown.ts";
import { renderBrief } from "../../src/render/brief.ts";
import { writeAll } from "../../src/render/write.ts";
import { INIT, stateOf, taskThreadCreated, threadCreated } from "../helpers.ts";

const taskState = () =>
  stateOf(
    INIT,
    taskThreadCreated("001", "pay-1"),
    { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "Lock", scope: ["src/a.ts", "src/b.ts"], repo: "api", files: ["src/a.ts", "src/b.ts"], doc: "d.md" } },
  );

test("writeAll writes tickets/<T>.files, one path per line, for a task thread", () => {
  const root = mkdtempSync(join(tmpdir(), "agt-w-"));
  writeAll(root, taskState(), undefined, () => undefined);
  expect(readFileSync(join(root, ".agentthread", "threads", "001-thread-001", "tickets", "T1.files"), "utf8")).toBe("src/a.ts\nsrc/b.ts\n");
});

test("a legacy thread gets no tickets folder", () => {
  const root = mkdtempSync(join(tmpdir(), "agt-w-"));
  const s = stateOf(INIT, threadCreated("001"), { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "x", scope: ["a"] } });
  writeAll(root, s, undefined, () => undefined);
  expect(existsSync(join(root, ".agentthread", "threads", "001-thread-001", "tickets"))).toBe(false);
});

test("the board and the brief show [repo] files", () => {
  const s = taskState();
  const t = s.threads.get("001")!;
  expect(renderBoard(t)).toContain("[api] src/a.ts, src/b.ts");
  expect(renderBrief({ thread: t, sessions: [] })).toContain("[api] src/a.ts, src/b.ts");
});
