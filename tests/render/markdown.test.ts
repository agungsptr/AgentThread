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

test("top-level handoff headings are clamped below the section level", () => {
  const s = stateOf(
    INIT,
    threadCreated("001"),
    { type: "handoff.submitted", thread: "001", payload: { content: "# Summary\nok", generated: false } },
  );
  const md = renderSub(s.threads.get("001")!);
  expect(md).toContain("### Summary");
  expect(md.match(/^## /gm)).toHaveLength(4);
});

test("goal headings are clamped so they cannot inject sections", () => {
  const s = stateOf(INIT, threadCreated("001", { goal: "Do it\n## Injected" }));
  const md = renderSub(s.threads.get("001")!);
  expect(md).toContain("### Injected");
  expect(md.match(/^## /gm)).toHaveLength(4);
});

test("CommonMark h1/h2 forms (indented, tab, bare) are clamped", () => {
  const s = stateOf(INIT, threadCreated("001", { goal: "Do it\n   ## Indented\n##\ttab\n##" }));
  const md = renderSub(s.threads.get("001")!);
  expect(md.match(/^## /gm)).toHaveLength(4);
  expect(md).toContain("### Indented");
  expect(md).toContain("###\ttab");
  expect(md).toMatch(/^###$/m);
});

test("an unclosed code fence in the goal cannot swallow later sections", () => {
  const s = stateOf(INIT, threadCreated("001", { goal: "Do it\n```js\ncode" }));
  const md = renderSub(s.threads.get("001")!);
  expect(md.split("\n").filter((l) => /^```/.test(l)).length % 2).toBe(0);
  expect(md.match(/^## /gm)).toHaveLength(4);
  expect(md.indexOf("```", md.indexOf("code"))).toBeLessThan(md.indexOf("## Acceptance criteria"));
});

test("sub thread frontmatter carries the herdr tab", () => {
  const withTab = stateOf(
    INIT,
    threadCreated("001"),
    { type: "thread.tab_opened", thread: "001", payload: { tab: "w7:t3", rootPane: "w7:p5" } },
  ).threads.get("001")!;
  expect(parse(renderSub(withTab).split("---\n")[1]!)).toMatchObject({ tab: "w7:t3" });
  expect(parse(renderSub(stateOf(INIT, threadCreated("002")).threads.get("002")!).split("---\n")[1]!)).toMatchObject({ tab: null });
});

test("sessions and worker capacity are rendered", () => {
  const S = "33333333-3333-4333-8333-333333333333";
  const s = stateOf(
    INIT,
    threadCreated("001", { maxWorkers: 2 }),
    { type: "session.created", thread: "001", payload: { session: S, role: "coordinator", agent: "claude-code", name: "c" } },
    { type: "session.attached", thread: "001", payload: { session: S, pane: "w1:p2" } },
    { type: "agent.idle", thread: "001", payload: { session: S } },
  );
  const t = s.threads.get("001")!;
  const fm = parse(renderSub(t, [...s.sessions.values()]).split("---\n")[1]!);
  expect(fm).toMatchObject({
    max_workers: 2,
    sessions: [{ id: S, role: "coordinator", agent: "claude-code", status: "idle", pane: "w1:p2" }],
  });
  expect(renderMain(s)).toContain("| idle | 0/2 |");
});
