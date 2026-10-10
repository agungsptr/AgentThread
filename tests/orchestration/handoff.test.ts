import { expect, test } from "bun:test";
import { validateHandoff } from "../../src/domain/rules.ts";
import { generateHandoff } from "../../src/orchestration/handoff.ts";
import { HANDOFF_REQUEST_PREFIX, handoffRequestPrompt, bootstrapPrompt } from "../../src/agents/prompts.ts";
import { INIT, stateOf, threadCreated } from "../helpers.ts";

const T = { id: "002", title: "Fix race", slug: "fix-race", worktree: "/repo/.worktrees/002-fix-race" };
const DIR = "/repo/.agentthread/threads/002-fix-race";

test("generated handoff is valid and summarizes the board", () => {
  const s = stateOf(
    INIT,
    threadCreated("002", { title: "Fix race", goal: "no double charge", criteria: ["test passes"], status: "in_progress" }),
    { type: "ticket.created", thread: "002", payload: { ticket: "T1", title: "Repro", scope: ["a"] } },
    { type: "ticket.created", thread: "002", payload: { ticket: "T2", title: "Fix", scope: ["b"] } },
    { type: "ticket.claimed", thread: "002", payload: { ticket: "T1", assignee: "w" } },
    { type: "ticket.completed", thread: "002", payload: { ticket: "T1" } },
    { type: "ticket.claimed", thread: "002", payload: { ticket: "T2", assignee: "w2" } },
    { type: "ticket.blocked", thread: "002", payload: { ticket: "T2", reason: "no key" } },
    { type: "decision.recorded", thread: "002", payload: { message: "use a mutex" } },
  );
  const md = generateHandoff(s.threads.get("002")!, "the coordinator did not answer");
  expect(validateHandoff(md)).toEqual({ ok: true });
  for (const line of [
    'Thread 002 ("Fix race") is in_progress.',
    "Goal: no double charge.",
    "- test passes",
    "- T1 Repro",
    "- use a mutex",
    "- T2 Fix (blocked)",
    "because the coordinator did not answer",
    "- T2 is blocked.",
  ]) {
    expect(md).toContain(line);
  }
});

test("empty thread still yields every section", () => {
  const md = generateHandoff(stateOf(INIT, threadCreated("001")).threads.get("001")!, "x");
  expect(validateHandoff(md)).toEqual({ ok: true });
  expect(md).toContain("No ticket is done yet.");
  expect(md).toContain("- none recorded");
});

test("handoff request and bootstrap kinds", () => {
  const p = handoffRequestPrompt({ root: "/repo", thread: T, reason: "precompact" });
  expect(p.startsWith(`${HANDOFF_REQUEST_PREFIX} your coordinator session for thread 002 is being rotated (precompact).`)).toBe(true);
  for (const s of ["agt handoff 002 --stdin <<'EOF'", "## Goal status", "## Work done", "## Decisions", "## Next steps", "## Risks", "EOF"]) expect(p).toContain(s);
  const o = { root: "/repo", role: "coordinator" as const, thread: T };
  expect(bootstrapPrompt(o)).toBe(`Start coordinating thread 002. Read ${DIR}/sub.thread.md and ${DIR}/board.md now.`);
  expect(bootstrapPrompt(o, "handoff")).toBe(
    `Continue coordinating thread 002 as its new coordinator. Read the Handoff section of ${DIR}/sub.thread.md first, then ${DIR}/board.md.`,
  );
  expect(bootstrapPrompt(o, "resume")).toBe(
    `You were resumed after an interruption. Re-read ${DIR}/sub.thread.md and ${DIR}/board.md, then continue coordinating thread 002.`,
  );
});

test("the handoff request's heredoc template, filled in, passes validateHandoff", () => {
  const lines = handoffRequestPrompt({ root: "/repo", thread: T, reason: "context" }).split("\n");
  const start = lines.findIndex((l) => l.startsWith("agt handoff 002 --stdin <<'EOF'"));
  const end = lines.indexOf("EOF", start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const body = lines
    .slice(start + 1, end)
    .map((l) => l.replace(/<[^>]+>/g, "filled in"))
    .join("\n");
  expect(body).not.toContain("<");
  expect(validateHandoff(body)).toEqual({ ok: true });
});
