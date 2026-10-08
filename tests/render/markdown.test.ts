import { expect, test } from "bun:test";
import { parse } from "yaml";
import { renderBoard, renderLog, renderMain, renderSub } from "../../src/render/markdown.ts";
import { INIT, stateOf, threadCreated } from "../helpers.ts";

const state = () =>
  stateOf(
    INIT,
    threadCreated("001", { title: "OAuth | login", goal: "Users log in with Google", criteria: ["Google works"], status: "review" }),
    threadCreated("002", { title: "Fix race", dependsOn: ["001"], status: "blocked" }),
    { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "Add\nbutton", scope: ["src/ui", "src/auth"] } },
    { type: "ticket.claimed", thread: "001", payload: { ticket: "T1", assignee: "w1" } },
    { type: "decision.recorded", thread: "001", payload: { message: "use PKCE" } },
    { type: "handoff.submitted", thread: "001", payload: { content: "## Goal status\nok\n## Risks\nnone", generated: false } },
  );

test("main thread lists threads and what needs attention", () => {
  const md = renderMain(state());
  expect(md).toContain("# Main Thread — demo");
  expect(md).toContain("| 001 | OAuth \\| login | feature | review | 0/1 | - |");
  expect(md).toContain("| 002 | Fix race | feature | blocked | 0/0 | 001 |");
  expect(md).toContain("- 001: awaiting review");
  expect(md).toContain("- 002: blocked");
});

test("sub thread has parseable frontmatter and fixed sections", () => {
  const md = renderSub(state().threads.get("001")!);
  const fm = parse(md.split("---\n")[1]!);
  expect(fm).toMatchObject({ id: "001", title: "OAuth | login", status: "review", depends_on: [], sessions: [] });
  expect(md).toContain("## Goal\n\nUsers log in with Google");
  expect(md).toContain("- [ ] Google works");
  expect(md).toContain("use PKCE");
});

test("handoff headings are demoted so they cannot break sub.thread.md sections", () => {
  const md = renderSub(state().threads.get("001")!);
  expect(md).toContain("### Goal status");
  expect(md.match(/^## /gm)).toHaveLength(4);
});

test("board escapes newlines and pipes in cells", () => {
  const md = renderBoard(state().threads.get("001")!);
  expect(md).toContain("| T1 | Add button | src/ui, src/auth | in_progress | w1 |");
});

test("log has one line per entry", () => {
  const md = renderLog(state().threads.get("001")!);
  expect(md).toContain("[user] T1 claimed by w1");
  expect(md.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(5);
});
