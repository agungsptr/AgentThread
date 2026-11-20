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
  NOT_IN_TICKET_LINE,
  OUT_OF_TICKET_HINT,
  outOfTicketOutcome,
  RESTART_LINE,
  RETURN_LINE,
  returnProblems,
  allRunning,
  inTaskWorktree,
  parseStackStatus,
  stackConfigPatch,
  stackLogProblems,
  stageNaByAgt,
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
    "ws-happy-worker-agy",
    "ws-edge-out-of-ticket",
    "ws-edge-return",
    "ws-edge-out-of-ticket-worker-opencode",
    "ws-edge-return-worker-opencode",
    "ws-edge-stage-gates",
    "ws-stack-lock",
    "ws-stack-runner",
    "ws-cleanup",
    "ws-tab-shell",
  ]) {
    expect(lines.some((l) => l.startsWith(`${id} `))).toBe(true);
  }
  expect(lines).toHaveLength(allScenarios().length);
});

test("the OpenCode-worker edge rows: Claude Code main and coordinator, opencode worker, same hint", () => {
  for (const id of ["ws-edge-return-worker-opencode", "ws-edge-out-of-ticket-worker-opencode"]) {
    expect(row(id).agents).toEqual({ main: "claude-code", coordinator: "claude-code", worker: "opencode" });
    expect(row(id).workspace).toBe(true);
    expect(row(id).manager).toBeUndefined();
  }
  expect(row("ws-edge-out-of-ticket-worker-opencode").wsHints).toEqual({ api: [OUT_OF_TICKET_HINT] });
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

test("the edge, lock, cleanup and tab-shell rows: Claude Code everywhere; only the no-agent rows run without a manager", () => {
  const cc = { main: "claude-code", coordinator: "claude-code", worker: "claude-code" } as const;
  for (const id of ["ws-edge-out-of-ticket", "ws-edge-return", "ws-edge-stage-gates", "ws-stack-lock", "ws-cleanup", "ws-tab-shell"]) {
    expect(row(id).agents).toEqual(cc);
    expect(row(id).workspace).toBe(true);
  }
  // Main answers Claude Code's trust dialog for the scratch root before any coordinator starts there.
  for (const id of ["ws-edge-out-of-ticket", "ws-edge-return", "ws-stack-lock", "ws-cleanup", "ws-tab-shell"]) expect(row(id).manager).toBeUndefined();
  // No agent runs in these two.
  expect(allScenarios().filter((s) => s.id.startsWith("ws-") && s.manager === false).map((s) => s.id).sort()).toEqual(["ws-edge-stage-gates", "ws-smoke-worktrees", "ws-stack-runner"]);
});

test("ws-edge-out-of-ticket keeps CHANGELOG.md out of the tickets in its task text", () => {
  expect(NOT_IN_TICKET_LINE).toBe("CHANGELOG.md is not part of this task; do not put it in any ticket.");
});

test("ws-edge-out-of-ticket puts the CHANGELOG hint in api's AGENTS.md only", () => {
  expect(OUT_OF_TICKET_HINT).toBe("Whenever you change src/slugify.ts, also add a line to CHANGELOG.md.");
  expect(row("ws-edge-out-of-ticket").wsHints).toEqual({ api: [OUT_OF_TICKET_HINT] });
  expect(allScenarios().filter((s) => s.wsHints).map((s) => s.id)).toEqual(["ws-edge-out-of-ticket", "ws-edge-out-of-ticket-worker-opencode"]);
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
  // The live worker ended after the return, then a new one took the ticket: legitimate.
  expect(returnProblems([worker("w1"), reviewed(), returned(), ev("session.lost", T, { session: "w1" }), worker("w2"), reviewed(), accepted()], T, "T1")).toEqual([]);
  expect(returnProblems([worker("w1"), reviewed(), returned(), ev("session.ended", T, { session: "w1" }), worker("w2"), reviewed(), accepted()], T, "T1")).toEqual([]);
  // A new session while the live worker still runs (it ends only later) is another session taking the ticket.
  expect(returnProblems([worker("w1"), reviewed(), returned(), worker("w2"), ev("session.ended", T, { session: "w1" }), reviewed(), accepted()], T, "T1")).toEqual([
    "worker w1 was still live, but another session took T1 after the return: w2",
  ]);
  // After a rotation, the replacement is the worker: a new session while it runs counts, after it ended does not.
  const w1b = () => ev("session.created", T, { session: "w1b", role: "worker", agent: "claude-code", name: "w1b", ticket: "T1", replaces: "w1" });
  expect(returnProblems([worker("w1"), reviewed(), returned(), ev("session.rotated", T, { session: "w1" }), w1b(), worker("w2"), reviewed(), accepted()], T, "T1")).toEqual([
    "worker w1b was still live, but another session took T1 after the return: w2",
  ]);
  expect(
    returnProblems([worker("w1"), reviewed(), returned(), ev("session.rotated", T, { session: "w1" }), w1b(), ev("session.ended", T, { session: "w1b" }), worker("w2"), reviewed(), accepted()], T, "T1"),
  ).toEqual([]);
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

test("stageNaByAgt: an agt na record with no later non-na record of that stage", () => {
  const T = "5";
  const st = (stage: number, state: string, by: string, thread = T) => ev("stage.recorded", thread, { stage, state, by });
  expect(stageNaByAgt([st(7, "na", "agt")], T, 7)).toBe(true);
  // A coordinator re-recording na is fine.
  expect(stageNaByAgt([st(7, "na", "agt"), st(7, "na", "coordinator")], T, 7)).toBe(true);
  // Another stage's or thread's records do not count.
  expect(stageNaByAgt([st(7, "na", "agt"), st(8, "done", "coordinator"), st(7, "done", "coordinator", "9")], T, 7)).toBe(true);
  // A later non-na state overrides it.
  expect(stageNaByAgt([st(7, "na", "agt"), st(7, "done", "coordinator")], T, 7)).toBe(false);
  // na only by someone else, or no record at all.
  expect(stageNaByAgt([st(7, "na", "coordinator")], T, 7)).toBe(false);
  expect(stageNaByAgt([], T, 7)).toBe(false);
  // A non-na before agt's na does not matter.
  expect(stageNaByAgt([st(7, "pending", "coordinator"), st(7, "na", "agt")], T, 7)).toBe(true);
});

test("ws-stack-runner runs without a manager", () => {
  expect(allScenarios().find((s) => s.id === "ws-stack-runner")!.manager).toBe(false);
});

test("stackConfigPatch: a service per repo, web after api, .env copied", () => {
  const p = stackConfigPatch({ api: 4001, web: 4002 }) as { workspace: { repos: Record<string, { copy: string[] }>; services: Record<string, { start: string; health: string; after?: string[] }> } };
  expect(p.workspace.repos.api!.copy).toEqual([".env"]);
  expect(p.workspace.services.api!.start).toBe("PORT=4001 bun serve.ts");
  expect(p.workspace.services.web!.health).toBe("http://127.0.0.1:4002/");
  expect(p.workspace.services.web!.after).toEqual(["api"]);
  expect(p.workspace.services.api!.after).toBeUndefined();
});

test("stack status helpers", () => {
  const rows = parseStackStatus(JSON.stringify({ services: [{ service: "api", state: "running", port: 1, pid: 10, cwd: ".worktrees/t/api" }, { service: "web", state: "stopped", port: 2, pid: null, cwd: null }], lock: null }));
  expect(rows.length).toBe(2);
  expect(parseStackStatus("nope")).toEqual([]);
  expect(allRunning(rows, ["api"])).toBe(true);
  expect(allRunning(rows, ["api", "web"])).toBe(false);
  expect(allRunning(rows, ["api"], { api: 10 })).toBe(false);
  expect(allRunning(rows, ["api"], { api: 9 })).toBe(true);
  expect(inTaskWorktree("/r", "t", "api", ".worktrees/t/api")).toBe(true);
  expect(inTaskWorktree("/r", "t", "api", "/r/.worktrees/t/api/sub")).toBe(true);
  expect(inTaskWorktree("/r", "t", "api", "api")).toBe(false);
  expect(inTaskWorktree("/r", "t", "api", null)).toBe(false);
});
