import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { renderBrief } from "../../src/render/brief.ts";
import { writeAll } from "../../src/render/write.ts";
import { project } from "../../src/state/projection.ts";
import { INIT, stateOf, stored, threadCreated } from "../helpers.ts";

const full = () =>
  stateOf(
    INIT,
    threadCreated("001", { title: "OAuth", goal: "# Big\nLog in", criteria: ["Google works"] }),
    { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "Button", scope: ["src/ui", "src/auth"] } },
    { type: "ticket.claimed", thread: "001", payload: { ticket: "T1", assignee: "abcdef123456" } },
    { type: "note.recorded", thread: "001", payload: { message: "found a bug" } },
    { type: "question.recorded", thread: "001", payload: { message: "which scope?" } },
    { type: "decision.recorded", thread: "001", payload: { message: "use PKCE" } },
    { type: "progress.recorded", thread: "001", payload: { message: "half way" } },
    { type: "handoff.submitted", thread: "001", payload: { content: "## Risks\nnone", generated: false } },
  );

test("brief has the sections in order", () => {
  const t = full().threads.get("001")!;
  const md = renderBrief({ thread: t, sessions: [], trail: { commits: ["abc1234 add a"], diffStat: "1 file changed", untracked: 2 }, dir: "/d" });
  const heads = md.match(/^#{1,2} .*$/gm)!;
  expect(heads).toEqual([
    "# Brief — thread 001: OAuth",
    "## Where things stand",
    "## Goal",
    "## Acceptance criteria",
    "## Board",
    "## Findings",
    "## Open questions",
    "## Decisions",
    "## Handoff",
    "## Git trail",
    "## How to continue",
  ]);
  expect(md).toContain("half way");
  expect(md).toContain("- T1 [in_progress] Button — scope: src/ui, src/auth (assignee: abcdef12)");
  expect(md).toContain("### Big");
  expect(md).toContain("### Risks");
  expect(md).toContain("- abc1234 add a");
  expect(md).toContain("Uncommitted: 1 file changed");
  expect(md).toContain("Untracked files: 2");
  expect(md).toContain('3. Record progress with agt progress 001 "<…>", findings with agt note 001, doubts with agt question 001.');
  expect(md).not.toContain("<id>");
});

test("brief fallbacks", () => {
  const t = stateOf(INIT, threadCreated("002")).threads.get("002")!;
  const md = renderBrief({ thread: t, sessions: [], dir: "/d" });
  expect(md).toContain("No progress recorded yet.");
  expect(md).toContain("None yet.");
  expect(md).toContain("Git trail unavailable.");
  expect(md).not.toContain("Uncommitted:");
  const withTrail = renderBrief({ thread: t, sessions: [], trail: { commits: [], diffStat: "", untracked: 0 }, dir: "/d" });
  expect(withTrail).toContain("No commits on this thread yet.");
  const done = stateOf(INIT, threadCreated("003", { status: "done" })).threads.get("003")!;
  expect(renderBrief({ thread: done, sessions: [], dir: "/d" })).toContain("No commits on this thread yet.");
});

test("brief truncates findings to 20 and commits to 20", () => {
  const notes = Array.from({ length: 30 }, (_, i) => ({ type: "note.recorded" as const, thread: "001", payload: { message: `finding-${i}` } }));
  const t = stateOf(INIT, threadCreated("001"), ...notes).threads.get("001")!;
  const commits = Array.from({ length: 30 }, (_, i) => `c${i} msg`);
  const md = renderBrief({ thread: t, sessions: [], trail: { commits, diffStat: "", untracked: 0 }, dir: "/d" });
  expect(md).not.toContain("finding-9\n");
  expect(md).toContain("finding-10");
  expect(md).toContain("finding-29");
  expect(md).toContain("c19 msg");
  expect(md).not.toContain("c20 msg");
});

test("writeAll writes brief.md using the injected trail", () => {
  const root = mkdtempSync(join(tmpdir(), "agt-w-"));
  const state = full();
  writeAll(root, state, undefined, () => ({ commits: ["zzz9999 stub"], diffStat: "", untracked: 0 }));
  const f = join(root, ".agentthread", "threads", "001-thread-001", "brief.md");
  expect(existsSync(f)).toBe(true);
  expect(readFileSync(f, "utf8")).toContain("zzz9999 stub");
});

test("brief stays under 16 KiB with oversized inputs", () => {
  const big = "x".repeat(5000);
  const bodies = [
    INIT,
    threadCreated("001", { goal: big, criteria: Array.from({ length: 50 }, () => big) }),
    ...Array.from({ length: 200 }, (_, i) => ({ type: "ticket.created" as const, thread: "001", payload: { ticket: `T${i}`, title: big, scope: [big] } })),
    ...Array.from({ length: 100 }, () => ({ type: "note.recorded" as const, thread: "001", payload: { message: big } })),
    ...Array.from({ length: 100 }, () => ({ type: "question.recorded" as const, thread: "001", payload: { message: big } })),
    ...Array.from({ length: 100 }, () => ({ type: "decision.recorded" as const, thread: "001", payload: { message: big } })),
    { type: "progress.recorded" as const, thread: "001", payload: { message: "PROGRESS-MARK" } },
    { type: "handoff.submitted" as const, thread: "001", payload: { content: big.repeat(10), generated: false } },
  ];
  const evs = stored([...bodies, ...Array.from({ length: 200 }, (_, i) => ({ type: "progress.recorded" as const, thread: "001", payload: { message: big } }))]);
  for (const [i, e] of evs.slice(bodies.length).entries()) e.actor = { role: "worker", thread: "001", session: `w${i}`, ticket: `T${i}` };
  const t = project(evs).threads.get("001")!;
  expect(Object.keys(t.workerProgress)).toHaveLength(200);
  const commits = Array.from({ length: 20 }, () => big);
  const md = renderBrief({ thread: t, sessions: [], trail: { commits, diffStat: "d", untracked: 0 }, dir: "/d" });
  expect(Buffer.byteLength(md)).toBeLessThan(16384);
  expect(md).toContain("PROGRESS-MARK");
  expect(md).toContain("## Open questions");
  expect(md).toContain("## How to continue");
  expect(md).toContain("(truncated — see sub.thread.md)");
});

test("brief: latest progress is the coordinator's position; each worker's latest is under its ticket", () => {
  const evs = stored([
    INIT,
    threadCreated("001"),
    { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "Button", scope: ["src/ui"] } },
    { type: "ticket.created", thread: "001", payload: { ticket: "T2", title: "API", scope: ["src/api"] } },
    { type: "progress.recorded", thread: "001", payload: { message: "plan made" } },
    { type: "progress.recorded", thread: "001", payload: { message: "button drawn" } },
  ]);
  evs[4]!.actor = { role: "coordinator", thread: "001" };
  evs[5]!.actor = { role: "worker", thread: "001", session: "w1", ticket: "T1" };
  const md = renderBrief({ thread: project(evs).threads.get("001")!, sessions: [], dir: "/d" });
  expect(md).toMatch(/Latest progress: \S+ \(coordinator\) plan made/);
  expect(md).toMatch(/- T1 \[open\] Button — scope: src\/ui\n  - progress \S+ \(worker T1\) button drawn\n- T2 \[open\] API/);
  expect(md).not.toMatch(/Latest progress: .*button drawn/);
});

test("brief: only worker progress so far means no position yet", () => {
  const evs = stored([INIT, threadCreated("001"), { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "B", scope: ["a"] } }, { type: "progress.recorded", thread: "001", payload: { message: "w" } }]);
  evs[3]!.actor = { role: "worker", thread: "001", session: "w1", ticket: "T1" };
  const md = renderBrief({ thread: project(evs).threads.get("001")!, sessions: [], dir: "/d" });
  expect(md).toContain("No progress recorded yet.");
  expect(md).toContain("  - progress ");
});

test("brief handoff says when it was written and by whom", () => {
  const coord = stored([INIT, threadCreated("001"), { type: "handoff.submitted", thread: "001", payload: { content: "## Risks\nnone", generated: false } }]);
  coord[2]!.actor = { role: "coordinator", thread: "001" };
  const md = renderBrief({ thread: project(coord).threads.get("001")!, sessions: [], dir: "/d" });
  expect(md).toContain(`## Handoff\n\nWritten ${coord[2]!.ts} by coordinator\n`);
  expect(md).not.toContain("Generated by the daemon");
  const gen = stored([INIT, threadCreated("001"), { type: "handoff.submitted", thread: "001", payload: { content: "## Risks\nnone", generated: true } }]);
  const g = renderBrief({ thread: project(gen).threads.get("001")!, sessions: [], dir: "/d" });
  expect(g).toContain(`## Handoff\n\n> Generated by the daemon.\n\nWritten ${gen[2]!.ts} by generated\n`);
});

test("brief: an open question starts with its id, so truncation never drops it", () => {
  const long = "why ".repeat(200);
  const s = stateOf(INIT, threadCreated("001"), { type: "question.recorded", thread: "001", payload: { message: long, id: "Q1" } });
  const line = renderBrief({ thread: s.threads.get("001")! }).split("\n").find((l) => l.includes("(Q1)"));
  expect(line).toMatch(/^- \S+ \(Q1\) why why/);
});
