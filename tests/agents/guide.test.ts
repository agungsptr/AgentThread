import { describe, expect, test } from "bun:test";
import { guide } from "../../src/agents/guide.ts";
import { rulesOf } from "../../src/agents/agents-md.ts";
import { LANGUAGE_RULE_START, MAIN_CLEANUP_RULE, MAIN_DRAFT_RULES, systemPrompt } from "../../src/agents/prompts.ts";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { USAGE } from "../../src/cli/usage.ts";

const base = { root: "/repo", config: DEFAULT_CONFIG };
const T = { id: "002", title: "Fix race", slug: "fix-race", worktree: "/repo/wt" };
const usage = (needle: string) => USAGE.split("\n").find((l) => l.trim().startsWith(needle))!.trim();

describe("guide", () => {
  test("task threads: what to do on a return notice, and with a ticket in review", () => {
    const worker = "- A return notice arrives: fix it in a new commit, then run agt ticket done again.";
    const coordinator = "- A ticket is in review with no notice: review it, then accept or return it.";
    expect(guide({ role: "worker", ...base })).toContain(worker);
    expect(guide({ role: "coordinator", ...base })).toContain(coordinator);
    expect(guide({ role: "worker", ...base, legacy: true })).not.toContain(worker);
    expect(guide({ role: "coordinator", ...base, legacy: true })).not.toContain(coordinator);
  });

  test("each role lists its USAGE command lines verbatim", () => {
    const want = {
      main: ["thread new", "thread choose", "thread cancel", "tell"],
      coordinator: ["thread status", "ticket add", "ticket claim|reopen", "worker spawn", "decide", "note", "progress", "question", "answer", "handoff", "tell"],
      worker: ["ticket claim|reopen", "ticket done", "ticket block", "note", "progress", "question"],
    } as const;
    for (const role of ["main", "coordinator", "worker"] as const) {
      const g = guide({ role, ...base });
      for (const c of want[role]) {
        // the worker only claims: its guide says so instead of the shared claim|reopen line
        if (role === "worker" && c === "ticket claim|reopen") expect(g).toContain("agt ticket claim <thread>/<ticket>");
        else expect(g).toContain(usage(c));
      }
    }
    expect(guide({ role: "worker", ...base })).not.toContain("claim|reopen");
    expect(guide({ role: "main", ...base })).toContain("[--tier <name> --reason <why> [--now]]");
  });

  test("the placeholder thread is a thread directory, or a worktree with legacy", () => {
    expect(guide({ role: "worker", ...base })).toContain("Work only inside <root>/.worktrees/<task>,");
    const legacy = guide({ role: "worker", ...base, legacy: true });
    expect(legacy).toContain("Work only inside <worktree>,");
    expect(legacy).not.toContain("<root>/.worktrees/<task>");
  });

  test("each role's rules are included, without the identity line", () => {
    for (const role of ["main", "coordinator", "worker"] as const) {
      const g = guide({ role, ...base, thread: T });
      // T is a legacy thread: main's cleanup and language rules (task threads only) are left out of its guide.
      const rules = rulesOf(systemPrompt({ root: "/repo", role, thread: T, ticket: "<ticket>", config: DEFAULT_CONFIG })).filter((l) => l && !l.includes("When unsure how to do something with agt") && l !== MAIN_CLEANUP_RULE && !MAIN_DRAFT_RULES.includes(l) && !l.startsWith(LANGUAGE_RULE_START));
      for (const r of rules) expect(g).toContain(r);
      expect(g).not.toContain("When unsure how to do something with agt");
      expect(g).not.toContain("You are the coordinator of AgentThread");
    }
    expect(guide({ role: "coordinator", ...base })).toContain("agt thread status <thread> in_progress");
    expect(guide({ role: "main", ...base })).toContain(MAIN_CLEANUP_RULE);
    expect(guide({ role: "main", ...base })).toContain("agt thread cleanup <id>");
    expect(guide({ role: "main", ...base, thread: T })).not.toContain("thread cleanup");
  });

  test("failure handling and state location", () => {
    const c = guide({ role: "coordinator", ...base });
    for (const s of ["HANDOFF REQUEST", "agt handoff <thread> --stdin", "CHECKPOINT", "agt progress", "agt answer", "in_progress", "agt worker spawn", "never push; never commit on wip/<task>; never bypass the commit guard", "brief.md", "sub.thread.md", "board.md", ".agentthread"]) {
      expect(c.toLowerCase()).toContain(s.toLowerCase());
    }
  });

  test("I1: a task thread's worker guide does not forbid its commits; a legacy guide keeps the old line", () => {
    const LEGACY = "- Never push; never commit as a worker; never bypass the commit guard.";
    const TASK = "- Never push; commit only your ticket's files, on wip/<task>; never bypass the commit guard.";
    expect(guide({ role: "worker", ...base })).toContain(TASK);
    expect(guide({ role: "worker", ...base })).not.toContain(LEGACY);
    expect(guide({ role: "coordinator", ...base })).toContain("- Never push; never commit on wip/<task>; never bypass the commit guard.");
    for (const role of ["worker", "coordinator"] as const) expect(guide({ role, ...base, legacy: true })).toContain(LEGACY);
    const all = guide({ role: "all", ...base });
    expect(all).not.toContain("undefined");
    expect(all).toContain("Commit only your ticket's files, on wip/<task> inside your repo worktree");
  });

  test("all has the three headings", () => {
    const g = guide({ role: "all", ...base });
    for (const h of ["## Main", "## Coordinator", "## Worker"]) expect(g).toContain(h);
  });

  test("the worker guide uses <ticket>, never <T>", () => {
    const g = guide({ role: "worker", ...base });
    expect(g).toContain("agt ticket claim <thread>/<ticket>");
    expect(g).not.toContain("<T>");
  });

  test("every role prompt ends with the guide line: a bullet only for the coordinator", () => {
    for (const role of ["main", "coordinator", "worker"] as const) {
      const p = systemPrompt({ root: "/repo", role, thread: T, ticket: "T1", config: DEFAULT_CONFIG });
      const bullet = role === "coordinator" ? "- " : "";
      expect(p.split("\n").at(-1)).toBe(`${bullet}When unsure how to do something with agt, run: agt guide ${role}`);
    }
  });
});

test("main's task-thread guide stops a thread with cancel and a reason; a legacy guide stays as it was", () => {
  const task = guide({ role: "main", root: "/repo", config: DEFAULT_CONFIG });
  expect(task).toContain("agt thread cancel <id> [--reason <text>]");
  expect(task).toContain("run `agt thread cancel <id> --reason \"<why>\"`; never park it with `agt thread status <id> blocked`");
  const legacy = guide({ role: "main", root: "/repo", config: DEFAULT_CONFIG, legacy: true });
  expect(legacy).toContain("agt thread cancel <id>\n");
  expect(legacy).not.toContain("--reason <text>]   stop a thread");
  expect(legacy).not.toContain("never park it");
});
