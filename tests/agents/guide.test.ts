import { describe, expect, test } from "bun:test";
import { guide } from "../../src/agents/guide.ts";
import { rulesOf } from "../../src/agents/agents-md.ts";
import { systemPrompt } from "../../src/agents/prompts.ts";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { USAGE } from "../../src/cli/usage.ts";

const base = { root: "/repo", config: DEFAULT_CONFIG };
const T = { id: "002", title: "Fix race", slug: "fix-race", worktree: "/repo/wt" };
const usage = (needle: string) => USAGE.split("\n").find((l) => l.trim().startsWith(needle))!.trim();

describe("guide", () => {
  test("each role lists its USAGE command lines verbatim", () => {
    const want = {
      main: ["thread new", "thread choose", "thread cancel", "tell"],
      coordinator: ["thread status", "ticket add", "ticket claim|reopen", "worker spawn", "decide", "note", "progress", "question", "answer", "handoff", "tell"],
      worker: ["ticket claim|reopen", "ticket done", "ticket block", "note", "progress", "question"],
    } as const;
    for (const role of ["main", "coordinator", "worker"] as const) {
      const g = guide({ role, ...base });
      for (const c of want[role]) expect(g).toContain(usage(c));
    }
    expect(guide({ role: "main", ...base })).toContain("[--tier <name> --reason <why> [--now]]");
  });

  test("each role's rules are included, without the identity line", () => {
    for (const role of ["main", "coordinator", "worker"] as const) {
      const g = guide({ role, ...base, thread: T });
      const rules = rulesOf(systemPrompt({ root: "/repo", role, thread: T, ticket: "<T>", config: DEFAULT_CONFIG })).filter((l) => l);
      for (const r of rules) expect(g).toContain(r);
      expect(g).not.toContain("You are the coordinator of AgentThread");
    }
    expect(guide({ role: "coordinator", ...base })).toContain("agt thread status <thread> in_progress");
  });

  test("failure handling and state location", () => {
    const c = guide({ role: "coordinator", ...base });
    for (const s of ["HANDOFF REQUEST", "agt handoff <thread> --stdin", "CHECKPOINT", "agt progress", "agt answer", "in_progress", "agt worker spawn", "never push; never commit as a worker; never bypass the commit guard", "brief.md", "sub.thread.md", "board.md", ".agentthread"]) {
      expect(c.toLowerCase()).toContain(s.toLowerCase());
    }
  });

  test("all has the three headings", () => {
    const g = guide({ role: "all", ...base });
    for (const h of ["## Main", "## Coordinator", "## Worker"]) expect(g).toContain(h);
  });

  test("every role prompt ends with the guide line", () => {
    for (const role of ["main", "coordinator", "worker"] as const) {
      const p = systemPrompt({ root: "/repo", role, thread: T, ticket: "T1", config: DEFAULT_CONFIG });
      expect(p.split("\n").at(-1)).toBe(`- When unsure how to do something with agt, run: agt guide ${role}`);
    }
  });
});
