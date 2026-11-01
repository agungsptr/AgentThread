import { expect, test } from "bun:test";
import { AGENT_KINDS } from "../../src/domain/types.ts";
import { allScenarios, listRows } from "../release/scenarios/index.ts";
import { commitMessageProblems, commitsOutsideTickets } from "../release/scenarios/workspace.ts";

const ids = () => allScenarios().map((s) => s.id);

test("--list includes the workspace rows", () => {
  const lines = listRows();
  for (const id of ["ws-smoke-worktrees", "ws-happy-claude-code", "ws-happy-worker-opencode", "ws-happy-worker-codex", "ws-happy-worker-omp"]) {
    expect(lines.some((l) => l.startsWith(`${id} `))).toBe(true);
  }
  expect(lines).toHaveLength(allScenarios().length);
});

test("row ids are unique", () => {
  expect(new Set(ids()).size).toBe(ids().length);
});

test("workspace rows are flagged, the others are not", () => {
  const ws = allScenarios().filter((s) => s.id.startsWith("ws-"));
  expect(ws.length).toBeGreaterThan(0);
  expect(ws.every((s) => s.workspace === true)).toBe(true);
  expect(allScenarios().filter((s) => !s.id.startsWith("ws-")).every((s) => s.workspace === undefined)).toBe(true);
});

test("the smoke row runs without a manager", () => {
  const smoke = allScenarios().find((s) => s.id === "ws-smoke-worktrees")!;
  expect(smoke.manager).toBe(false);
});

test("the per-worker expansion keeps the coordinator on Claude Code and drops the duplicate of ws-happy-claude-code", () => {
  const all = allScenarios();
  const cc = all.find((s) => s.id === "ws-happy-claude-code")!;
  expect(cc.agents).toEqual({ main: "claude-code", coordinator: "claude-code", worker: "claude-code" });
  expect(ids()).not.toContain("ws-happy-worker-claude-code");
  const workers = all.filter((s) => s.id.startsWith("ws-happy-worker-"));
  expect(workers.map((s) => s.agents.worker).sort()).toEqual(AGENT_KINDS.filter((k) => k !== "claude-code").sort());
  for (const s of workers) {
    expect(s.id).toBe(`ws-happy-worker-${s.agents.worker}`);
    expect(s.agents.main).toBe("claude-code");
    expect(s.agents.coordinator).toBe("claude-code");
  }
  const key = (s: (typeof all)[number]) => `${s.agents.main}/${s.agents.coordinator}/${s.agents.worker}`;
  const happy = all.filter((s) => s.id.startsWith("ws-happy-"));
  expect(new Set(happy.map(key)).size).toBe(happy.length);
});

test("commitMessageProblems names each banned marker", () => {
  expect(commitMessageProblems("feat: add slugify to api\n\nUsed by the title view.")).toEqual([]);
  expect(commitMessageProblems("feat: x\n\nCo-Authored-By: Someone <a@b.c>")).toEqual(["Co-Authored-By"]);
  expect(commitMessageProblems("feat: x\n\nco-authored-by: Someone <a@b.c>")).toEqual(["Co-Authored-By"]);
  expect(commitMessageProblems("feat: x\n\n🤖 Generated with [Claude Code]")).toEqual(["Generated with"]);
  expect(commitMessageProblems("feat: x, see .docs/specs/kyc.md")).toEqual([".docs/"]);
  expect(commitMessageProblems("feat: x (T1, T12)")).toEqual(["T<n>"]);
  expect(commitMessageProblems("feat: x for T1234")).toEqual(["T<n>"]);
  // Not a ticket id: a longer number, part of a word, or a lower-case t.
  expect(commitMessageProblems("feat: x T12345 AT1 T1a t1")).toEqual([]);
  expect(commitMessageProblems("T2: x\n\nGenerated with y\nCo-Authored-By: z\n.docs/a")).toEqual(["Co-Authored-By", "Generated with", ".docs/", "T<n>"]);
});

test("commitsOutsideTickets accepts commits inside one ticket's files and names the others", () => {
  const tickets = [
    { ticket: "T1", repo: "api", files: ["src/slugify.ts", "tests/slugify.test.ts", "src/index.ts"] },
    { ticket: "T2", repo: "web", files: ["src/title.ts", "tests/title.test.ts"] },
    { ticket: "T3", repo: "api", files: ["README.md"] },
  ];
  expect(commitsOutsideTickets("api", [{ sha: "a1", files: ["src/slugify.ts", "tests/slugify.test.ts"] }, { sha: "a2", files: ["README.md"] }], tickets)).toEqual([]);
  // A file no api ticket lists, or another repo's ticket's file.
  expect(commitsOutsideTickets("api", [{ sha: "a3", files: ["src/slugify.ts", "src/other.ts"] }], tickets)).toEqual(["a3: src/other.ts"]);
  expect(commitsOutsideTickets("api", [{ sha: "a4", files: ["src/title.ts"] }], tickets)).toEqual(["a4: src/title.ts"]);
  // Two tickets' files in one commit: each commit belongs to a single ticket.
  expect(commitsOutsideTickets("api", [{ sha: "a5", files: ["src/slugify.ts", "README.md"] }], tickets)).toEqual(["a5: spans more than one ticket (src/slugify.ts, README.md)"]);
  // A repo without tickets: any commit is outside.
  expect(commitsOutsideTickets("web", [{ sha: "w1", files: ["src/title.ts"] }], [])).toEqual(["w1: src/title.ts"]);
  // A commit with no files (an empty commit) touches nothing.
  expect(commitsOutsideTickets("api", [{ sha: "a6", files: [] }], tickets)).toEqual([]);
});
