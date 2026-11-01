import { expect, test } from "bun:test";
import { AGENT_KINDS, type StoredEvent } from "../../src/domain/types.ts";
import { allScenarios, listRows } from "../release/scenarios/index.ts";
import {
  agtVarsFromEnv,
  agtVarsFromPs,
  commitMessageProblems,
  commitsOutsideTickets,
  featDiffProblems,
  maxHolders,
  OUT_OF_TICKET_HINT,
  outOfTicketOutcome,
  RESTART_LINE,
  RETURN_LINE,
  returnProblems,
  stackLogProblems,
  WS_ASK_MAIN,
  WS_TASK,
} from "../release/scenarios/workspace.ts";

const ids = () => allScenarios().map((s) => s.id);

test("--list includes the workspace rows", () => {
  const lines = listRows();
  for (const id of [
    "ws-smoke-worktrees",
    "ws-happy-claude-code",
    "ws-happy-worker-opencode",
    "ws-happy-worker-codex",
    "ws-happy-worker-omp",
    "ws-edge-out-of-ticket",
    "ws-edge-return",
    "ws-edge-stage-gates",
    "ws-stack-lock",
    "ws-cleanup",
    "ws-tab-shell",
  ]) {
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
  // The product guard's rule: the trailer needs its colon; .docs/ matches in any case.
  expect(commitMessageProblems("feat: drop the Co-Authored-By trailer from the template")).toEqual([]);
  expect(commitMessageProblems("feat: x, see .DOCS/specs")).toEqual([".docs/"]);
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

test("featDiffProblems: the feat diff must be non-empty and inside the repo's tickets' files", () => {
  const tickets = [
    { ticket: "T1", repo: "api", files: ["src/slugify.ts", "tests/slugify.test.ts"] },
    { ticket: "T2", repo: "api", files: ["src/index.ts"] },
    { ticket: "T3", repo: "web", files: ["src/title.ts"] },
  ];
  // Union across the repo's tickets: files of two tickets are fine in the squash.
  expect(featDiffProblems("api", ["src/slugify.ts", "src/index.ts"], tickets)).toEqual([]);
  expect(featDiffProblems("api", ["src/slugify.ts", "src/other.ts", "src/title.ts"], tickets)).toEqual(["outside the tickets: src/other.ts, src/title.ts"]);
  expect(featDiffProblems("api", [], tickets)).toEqual(["no changes"]);
  expect(featDiffProblems("web", ["src/title.ts"], [])).toEqual(["outside the tickets: src/title.ts"]);
});

test("the ask to main carries the task, the confirmation and the decide-yourself line", () => {
  expect(WS_ASK_MAIN.startsWith(WS_TASK)).toBe(true);
  expect(WS_ASK_MAIN).toContain("create the thread without asking me to confirm");
  expect(WS_ASK_MAIN).toContain("Decide details yourself with your recommendations; only stop for me if something is truly blocked.");
});

const row = (id: string) => allScenarios().find((s) => s.id === id)!;

test("the edge, lock, cleanup and tab-shell rows: Claude Code everywhere, the CLI-driven ones without a manager", () => {
  const cc = { main: "claude-code", coordinator: "claude-code", worker: "claude-code" } as const;
  for (const id of ["ws-edge-out-of-ticket", "ws-edge-return", "ws-edge-stage-gates", "ws-stack-lock", "ws-cleanup", "ws-tab-shell"]) {
    expect(row(id).agents).toEqual(cc);
    expect(row(id).workspace).toBe(true);
  }
  for (const id of ["ws-edge-out-of-ticket", "ws-edge-return", "ws-edge-stage-gates", "ws-stack-lock", "ws-tab-shell"]) expect(row(id).manager).toBe(false);
  // The cleanup row runs the happy flow through main.
  expect(row("ws-cleanup").manager).toBeUndefined();
});

test("ws-edge-out-of-ticket puts the CHANGELOG hint in api's AGENTS.md only", () => {
  expect(OUT_OF_TICKET_HINT).toBe("Whenever you change src/slugify.ts, also add a line to CHANGELOG.md.");
  expect(row("ws-edge-out-of-ticket").wsHints).toEqual({ api: [OUT_OF_TICKET_HINT] });
  expect(allScenarios().filter((s) => s.wsHints).map((s) => s.id)).toEqual(["ws-edge-out-of-ticket"]);
});

test("the return and restart lines are the brief's", () => {
  expect(RETURN_LINE).toBe("Return the first ticket once with 'add a test for an empty string' before accepting it.");
  expect(RESTART_LINE.toLowerCase()).toContain("restart the stack before testing");
});

test("ws-edge-stage-gates configures a browser URL, so stage 8 is not na by agt", () => {
  const c = row("ws-edge-stage-gates").config!;
  expect(c.workflow.browser.urls.length).toBeGreaterThan(0);
  // A proposed tier that waits an hour: no coordinator starts.
  expect(c.agents.complexity.timeout).toBe("1h");
});

let seq = 0;
const ev = (type: string, thread: string | undefined, payload: Record<string, unknown>): StoredEvent =>
  ({ seq: ++seq, ts: new Date(1_000 * seq).toISOString(), type, ...(thread ? { thread } : {}), actor: { role: "user" }, payload }) as unknown as StoredEvent;

test("maxHolders replays the stack events", () => {
  const acq = (t: string, purpose?: string) => ev("stack.acquired", t, { thread: t, ...(purpose ? { purpose } : {}) });
  const rel = (t: string, reason = "released") => ev("stack.released", t, { thread: t, reason });
  const q = (t: string) => ev("stack.queued", t, { thread: t });
  expect(maxHolders([])).toBe(0);
  // One after the other, and through the queue (the reactor's acquired for the next comes after the release).
  expect(maxHolders([acq("1"), rel("1"), acq("2"), rel("2")])).toBe(1);
  expect(maxHolders([acq("1"), q("2"), rel("1"), acq("2"), rel("2")])).toBe(1);
  // The holder recording a new purpose is still one holder; a queued thread leaving the queue frees nothing.
  expect(maxHolders([acq("1"), acq("1", "e2e4"), q("2"), rel("2", "left the queue"), acq("3")])).toBe(2);
  expect(maxHolders([acq("1"), acq("1", "e2e4"), q("2"), rel("2", "left the queue")])).toBe(1);
  // Two holders at once.
  expect(maxHolders([acq("1"), acq("2"), rel("1"), rel("2")])).toBe(2);
  // Other events are ignored.
  expect(maxHolders([ev("thread.waiting", "1", { what: "x" }), acq("1")])).toBe(1);
});

test("stackLogProblems: a restart per task, each at least 5s after the one before", () => {
  expect(stackLogProblems("a 100\nb 105\n", ["a", "b"])).toEqual([]);
  // Out of order in the file is sorted by time; more restarts are fine.
  expect(stackLogProblems("b 200\na 100\na 110\n", ["a", "b"])).toEqual([]);
  expect(stackLogProblems("a 100\nb 103\n", ["a", "b"])).toEqual(["b at 103 overlaps a at 100 (3s apart, a restart takes 5s)"]);
  expect(stackLogProblems("a 100\n", ["a", "b"])).toEqual(["no restart for b"]);
  expect(stackLogProblems("", ["a", "b"])).toEqual(["no restart for a", "no restart for b"]);
  // Lines that are not "<task> <epoch>" are named.
  expect(stackLogProblems("a 100\ngarbage\nb 110", ["a", "b"])).toEqual(["unreadable line: garbage"]);
});

test("returnProblems: returned once, reviewed again, by the live worker or a new one, then accepted", () => {
  const T = "7";
  const worker = (s: string) => ev("session.created", T, { session: s, role: "worker", agent: "claude-code", name: s, ticket: "T1" });
  const reviewed = () => ev("ticket.reviewed", T, { ticket: "T1", summary: "x" });
  const returned = () => ev("ticket.returned", T, { ticket: "T1", note: "add a test for an empty string" });
  const accepted = () => ev("ticket.accepted", T, { ticket: "T1" });
  // The same live worker took both.
  expect(returnProblems([worker("w1"), reviewed(), returned(), reviewed(), accepted()], T, "T1")).toEqual([]);
  // The first worker had ended: a new one after the return.
  expect(returnProblems([worker("w1"), reviewed(), ev("session.ended", T, { session: "w1" }), returned(), worker("w2"), reviewed(), accepted()], T, "T1")).toEqual([]);
  expect(returnProblems([worker("w1"), reviewed(), ev("session.ended", T, { session: "w1" }), returned(), reviewed(), accepted()], T, "T1")).toEqual([
    "the first worker had ended, but no new worker session for T1 started after the return",
  ]);
  expect(returnProblems([worker("w1"), reviewed(), returned(), worker("w2"), reviewed(), accepted()], T, "T1")).toEqual([
    "worker w1 was still live, but another session took T1 after the return: w2",
  ]);
  // A rotation of the live worker is the same worker, not another session.
  const rotated = ev("session.created", T, { session: "w1b", role: "worker", agent: "claude-code", name: "w1b", ticket: "T1", replaces: "w1" });
  expect(returnProblems([worker("w1"), reviewed(), returned(), rotated, reviewed(), accepted()], T, "T1")).toEqual([]);
  expect(returnProblems([worker("w1"), reviewed(), accepted()], T, "T1")).toEqual(["T1 was never returned"]);
  expect(returnProblems([worker("w1"), reviewed(), returned()], T, "T1")).toEqual(["no ticket.reviewed for T1 after the return", "T1 is not accepted after the return"]);
  expect(returnProblems([worker("w1"), returned(), reviewed(), accepted()], T, "T1")).toEqual(["T1 was returned before any review"]);
  // Another thread's events do not count.
  expect(returnProblems([worker("w1"), reviewed(), ev("ticket.returned", "8", { ticket: "T1", note: "x" })], T, "T1")).toEqual(["T1 was never returned"]);
});

test("outOfTicketOutcome: the api ticket with src/slugify.ts, reviewed or blocked", () => {
  const T = "3";
  const made = [
    ev("ticket.created", T, { ticket: "T1", title: "web", scope: [], repo: "web", files: ["src/title.ts"] }),
    ev("ticket.created", T, { ticket: "T2", title: "api", scope: [], repo: "api", files: ["src/slugify.ts", "tests/slugify.test.ts"] }),
  ];
  expect(outOfTicketOutcome(made, T)).toEqual({ ticket: "T2", files: ["src/slugify.ts", "tests/slugify.test.ts"] });
  expect(outOfTicketOutcome([...made, ev("ticket.reviewed", T, { ticket: "T1", summary: "x" })], T)).toEqual({ ticket: "T2", files: ["src/slugify.ts", "tests/slugify.test.ts"] });
  expect(outOfTicketOutcome([...made, ev("ticket.reviewed", T, { ticket: "T2", summary: "x" })], T)).toMatchObject({ ticket: "T2", outcome: "reviewed" });
  expect(outOfTicketOutcome([...made, ev("ticket.blocked", T, { ticket: "T2", reason: "needs CHANGELOG.md" })], T)).toMatchObject({ ticket: "T2", outcome: "blocked", detail: "needs CHANGELOG.md" });
  expect(outOfTicketOutcome([made[0]!], T)).toBeUndefined();
});

test("agtVarsFromPs and agtVarsFromEnv keep only AGT_ variables", () => {
  const ps = "/usr/local/bin/claude --model x AGT_ROLE=coordinator HOME=/Users/u AGT_THREAD=4 SECRET_TOKEN=abc AGT_AGENT_PROCESS=1 AGT_TASK=slugify";
  expect(agtVarsFromPs(ps)).toEqual({ AGT_ROLE: "coordinator", AGT_THREAD: "4", AGT_AGENT_PROCESS: "1", AGT_TASK: "slugify" });
  expect(agtVarsFromPs("zsh")).toEqual({});
  expect(agtVarsFromEnv("AGT_ROLE=coordinator\nAGT_ROOT=/tmp/a b\nPATH=/bin\n")).toEqual({ AGT_ROLE: "coordinator", AGT_ROOT: "/tmp/a b" });
  // /proc/<pid>/environ is NUL-separated.
  expect(agtVarsFromEnv("AGT_AGENT_PROCESS=1\0TOKEN=x\0AGT_THREAD=2\0")).toEqual({ AGT_AGENT_PROCESS: "1", AGT_THREAD: "2" });
  expect(agtVarsFromEnv("")).toEqual({});
});
