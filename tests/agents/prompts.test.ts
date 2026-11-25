import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentsMd } from "../../src/agents/agents-md.ts";
import { guide } from "../../src/agents/guide.ts";
import { bootstrapPrompt, systemPrompt } from "../../src/agents/prompts.ts";
import { type Config, DEFAULT_CONFIG } from "../../src/config/config.ts";

const TASK = { id: "007", title: "PAY reject", slug: "pay-reject", dir: "/ws/.worktrees/pay-reject", task: "pay-reject" };
const LEGACY = { id: "002", title: "Fix race", slug: "fix-race", worktree: "/repo/.worktrees/002-fix-race" };

const workflow = (w: Partial<Config["workflow"]>): Config => ({ ...DEFAULT_CONFIG, workflow: { ...DEFAULT_CONFIG.workflow, ...w } });
const ZENTRO = workflow({
  chat_language: "Bahasa Indonesia",
  file_language: "English",
  banned_words: ["Claude", "Anthropic"],
  read_first: [".docs/shared/notes/product-decisions.md", "/ws/.docs/shared/notes/glossary.md"],
  report_words: { done: "SELESAI", blocked: "TERHALANG" },
});
const nonAuto = (c: Config): Config => ({ ...c, agents: { ...c.agents, autonomous: false } });

const coordinator = (config: Config) => systemPrompt({ root: "/ws", role: "coordinator", thread: TASK, config });
const worker = (config: Config, ticketDoc?: string) =>
  systemPrompt({ root: "/ws", role: "worker", thread: TASK, ticket: "T2", config, ...(ticketDoc !== undefined ? { ticketDoc } : {}) });

const COMMIT_RULE =
  "- Commit messages are plain conventional commits: no AI attribution or session trailers, no ticket ids, no .docs mentions, none of these words: Claude, Anthropic. This overrides any harness attribution reminder.";

describe("task-thread coordinator rules (§13)", () => {
  test("carry each feature-workflow rule, with the config values substituted", () => {
    const p = coordinator(ZENTRO);
    for (const line of [
      "- Never edit a repo file, even one line: send the worker the exact change. You may read code and docs, run the tests and the stack, and review.",
      "- Ask the user which source branch to start from, then create a worktree for each repo the task touches: agt worktree add <thread> <repo> --from <branch>. Never move or rename a worktree.",
      '- Record every stage with agt stage 007 <n> done|skipped|na (skipped and na need --reason "<why>"); skip a stage only when the user says so.',
      "- Stages agt marked na (from config) stay na; don't record them.",
      "- Before restarting the stack, running e2e or the browser check, run agt stack acquire 007 (add --for e2e4 for the full e2e); wait for the notice if it is queued; agt stack release 007 when done.",
      '- Whenever you stop to wait for the user, run agt thread waiting 007 "<what>".',
      "- Commit your own .docs changes in /ws/.docs (git -C /ws/.docs), one commit per logical change; never push.",
      COMMIT_RULE,
      "- Read these files first: /ws/.docs/shared/notes/product-decisions.md, /ws/.docs/shared/notes/glossary.md.",
      "Write every message to the user — replies, questions, reports, progress and notices — in Bahasa Indonesia. Files, code, commits and agt commands stay in English.",
    ]) {
      expect(p.split("\n")).toContain(line);
    }
  });

  test("no 'review and commit' bullet, and no rule twice", () => {
    for (const config of [DEFAULT_CONFIG, ZENTRO, nonAuto(ZENTRO)]) {
      const lines = coordinator(config).split("\n");
      expect(lines.join("\n")).not.toContain("review and commit");
      expect(new Set(lines).size).toBe(lines.length);
      expect(lines.filter((l) => l.includes("agt worktree add"))).toHaveLength(1);
      expect(lines.filter((l) => l.includes("agt stack acquire"))).toHaveLength(1);
    }
  });

  test("an empty banned-word or read-first list drops its clause or line; the default languages are English", () => {
    const p = coordinator(DEFAULT_CONFIG);
    expect(p).toContain(
      "- Commit messages are plain conventional commits: no AI attribution or session trailers, no ticket ids, no .docs mentions. This overrides any harness attribution reminder.",
    );
    expect(p).not.toContain("none of these words");
    expect(p).not.toContain("Read these files first");
    expect(p).toContain("Write every message to the user — replies, questions, reports, progress and notices — in English. Files, code, commits and agt commands stay in English.");
    expect(p).not.toContain("Talk to the user in");
  });

  test("the guide carries the new rules (it is built from the prompt)", () => {
    const g = guide({ role: "coordinator", root: "/ws", config: ZENTRO });
    expect(g).toContain(COMMIT_RULE);
    expect(g).toContain('agt thread waiting <thread> "<what>"');
    expect(g).toContain("Write every message to the user — replies, questions, reports, progress and notices — in Bahasa Indonesia. Files, code, commits and agt commands stay in English.");
    expect(g).toContain("agt stage <thread> <1-10>");
    expect(g).toContain("agt stack acquire <thread>");
    // a legacy guide has no stages or stack lock
    const legacy = guide({ role: "coordinator", root: "/ws", config: ZENTRO, legacy: true });
    expect(legacy).not.toContain("agt stage");
    expect(legacy).not.toContain("agt stack");
  });
});

describe("task-thread worker rules (§13)", () => {
  test("name its ticket file, the self-check, the report words and the commit rule", () => {
    const p = worker(ZENTRO, ".docs/shared/issues/pay-reject/02-api.md").split("\n");
    for (const line of [
      "Your ticket file is /ws/.docs/shared/issues/pay-reject/02-api.md. You may append evidence under ## Comments there; it is the only file outside your worktree you may write.",
      "Validate your own work first: run the ticket's tests and checks before you report it done.",
      'End your summary with SELESAI or TERHALANG.',
      COMMIT_RULE.slice(2),
    ]) {
      expect(p).toContain(line);
    }
  });

  test("defaults: report words done/blocked; a ticket without a doc may write nothing outside its worktree", () => {
    const p = worker(DEFAULT_CONFIG);
    expect(p).toContain("End your summary with done or blocked.");
    const boot = bootstrapPrompt({ root: "/ws", role: "worker", thread: TASK, ticket: "T2" });
    expect(boot.split("\n").at(-1)).toBe("Your ticket has no ticket file: write nothing outside your worktree.");
    expect(p).not.toContain("none of these words");
    expect(p).not.toContain(".docs/**");
  });

  test("AGENTS.md (shared by every worker) says where the ticket file is named; the bootstrap names it", () => {
    const md = agentsMd({ root: "/ws", thread: TASK, config: ZENTRO });
    expect(md).toContain("Your ticket file, if your ticket has one, is named in your first prompt. You may append evidence under ## Comments there; it is the only file outside your worktree you may write.");
    const boot = bootstrapPrompt({ root: "/ws", role: "worker", thread: TASK, ticket: "T2", ticketDoc: ".docs/shared/issues/pay-reject/02-api.md" });
    expect(boot).toBe(
      "You are the worker for ticket T2 of thread 007. Read /ws/.agentthread/threads/007-pay-reject/brief.md, then follow AGENTS.md.\nYour ticket file is /ws/.docs/shared/issues/pay-reject/02-api.md.",
    );
    const withNotice = bootstrapPrompt({ root: "/ws", role: "worker", thread: TASK, ticket: "T2", ticketDoc: "x.md" }, "start", "Ticket T2 was returned.");
    expect(withNotice.split("\n")).toEqual([expect.stringContaining("follow AGENTS.md."), "Your ticket file is /ws/x.md.", "Ticket T2 was returned."]);
  });
});

test("a task coordinator's only repo commit is the squash", () => {
  const p = coordinator(DEFAULT_CONFIG);
  expect(p).toContain("- Workers commit their tickets on wip/pay-reject. You never edit repo files; your only repo commit is the squash on feat/pay-reject: in each repo worktree,");
  expect(p).not.toContain("You never edit or commit repo files");
});

test("a task coordinator does not set review itself: stage 10 done does", () => {
  for (const config of [DEFAULT_CONFIG, ZENTRO]) {
    const p = coordinator(config);
    expect(p.split("\n")).toContain(
      "- When you start, run: agt thread status 007 in_progress. After the squash, `agt stage 007 10 done` moves the thread to review; do not set review yourself.",
    );
    expect(p).not.toContain("agt thread status 007 review");
  }
});

test("a task worker may not change AGT_AGENT_PROCESS either", () => {
  expect(worker(DEFAULT_CONFIG)).toContain("Never bypass the commit guard (no git commit --no-verify, no changing core.hooksPath, AGT_ROLE or AGT_AGENT_PROCESS).");
});

describe("legacy threads keep every old prompt byte for byte", () => {
  const want = JSON.parse(readFileSync(join(import.meta.dir, "__legacy__", "prompts.json"), "utf8")) as Record<string, string>;
  test("coordinator, worker, AGENTS.md, bootstrap and guide, whatever the workflow config", () => {
    for (const cfg of [DEFAULT_CONFIG, ZENTRO]) {
      const auto = cfg;
      const ask = nonAuto(cfg);
      for (const [n, c] of [["default", auto], ["nonAuto", ask]] as const) {
        expect(systemPrompt({ root: "/repo", role: "coordinator", thread: LEGACY, config: c })).toBe(want[`coordinator.${n}`]!);
        expect(systemPrompt({ root: "/repo", role: "worker", thread: LEGACY, ticket: "T1", config: c, ticketDoc: "x.md" })).toBe(want[`worker.${n}`]!);
        expect(agentsMd({ root: "/repo", thread: LEGACY, config: c })).toBe(want[`agentsMd.${n}`]!);
      }
      expect(guide({ role: "all", root: "/repo", config: cfg, legacy: true })).toBe(want["guide.all"]!);
    }
    expect(systemPrompt({ root: "/repo", role: "worker", thread: LEGACY, ticket: "T1" })).toBe(want["worker.noConfig"]!);
    expect(bootstrapPrompt({ root: "/repo", role: "worker", thread: LEGACY, ticket: "T1", ticketDoc: "x.md" })).toBe(want["bootstrap.worker"]!);
  });
});

describe("idle and unblock rules (task threads only)", () => {
  const WORKER_RULE =
    'Never end a turn waiting for someone. If your ticket needs another ticket first, run agt ticket block 007/T2 --reason "<what you wait for>" and stop. When the ticket is done, run agt ticket done 007/T2 --summary "<one line>".';
  const COORD_RULE =
    "- When you accept a ticket that another ticket was blocked on, reopen the blocked one with agt ticket reopen 007/<T> and start a new worker for it with agt worker spawn 007 --ticket <T> (a blocked worker has ended). To speak to a worker that is still alive, use agt tell 007/<T> \"<message>\".";

  test("the worker blocks instead of waiting; the coordinator reopens a ticket whose dependency was accepted", () => {
    expect(worker(DEFAULT_CONFIG).split("\n")).toContain(WORKER_RULE);
    expect(coordinator(DEFAULT_CONFIG).split("\n")).toContain(COORD_RULE);
  });

  test("a task coordinator's guide lists the ticket form of agt tell", () => {
    expect(guide({ role: "coordinator", root: "/ws", config: DEFAULT_CONFIG, thread: TASK })).toContain("agt tell <thread>/<ticket> <message...>");
  });

  test("legacy threads do not get them", () => {
    expect(systemPrompt({ root: "/repo", role: "worker", thread: LEGACY, ticket: "T1" })).not.toContain("Never end a turn waiting");
    expect(systemPrompt({ root: "/repo", role: "coordinator", thread: LEGACY })).not.toContain("was blocked on");
  });
});

describe("stack restart rule", () => {
  const withServices = { ...DEFAULT_CONFIG, workspace: { ...DEFAULT_CONFIG.workspace, repos: { a: { path: "a" } }, services: { web: { repo: "a", dir: ".", start: "x", enabled: true } } } } as unknown as Config;
  test("a task coordinator is told agt stack restart --task <task> when services exist", () => {
    expect(coordinator(withServices)).toContain("agt stack restart --task pay-reject");
    expect(coordinator(withServices)).toContain("then agt stack wait: it blocks until every service passes agt's health check");
    expect(coordinator(withServices)).toContain("Never write your own readiness check");
    expect(coordinator(DEFAULT_CONFIG)).not.toContain("agt stack restart");
  });
});

describe("language rule (chat_language) comes first", () => {
  const RULE = "Write every message to the user — replies, questions, reports, progress and notices — in Bahasa Indonesia. Files, code, commits and agt commands stay in English.";
  const lines = (p: string) => p.split("\n");

  test("main: the line after its identity line; the coordinator and worker likewise; none of them twice", () => {
    for (const p of [systemPrompt({ root: "/ws", role: "main", config: ZENTRO }), coordinator(ZENTRO), worker(ZENTRO)]) {
      expect(lines(p)[1]).toBe(RULE);
      expect(lines(p).filter((l) => l.startsWith("Write every message to the user"))).toHaveLength(1);
      expect(p).not.toContain("Talk to the user in");
    }
  });

  test("a rotated coordinator's bootstrap starts with it; a first bootstrap and a legacy thread do not", () => {
    const boot = bootstrapPrompt({ root: "/ws", role: "coordinator", thread: TASK, config: ZENTRO }, "handoff");
    expect(boot).toBe(`${RULE}\nYou are the new coordinator of thread 007; the previous session ended. Read /ws/.agentthread/threads/007-pay-reject/brief.md, then follow AGENTS.md.`);
    expect(bootstrapPrompt({ root: "/ws", role: "coordinator", thread: LEGACY, config: ZENTRO }, "handoff")).toBe(bootstrapPrompt({ root: "/ws", role: "coordinator", thread: LEGACY }, "handoff"));
  });

  test("AGENTS.md carries it for the coordinator and the worker; the legacy coordinator, worker and guide do not", () => {
    expect(agentsMd({ root: "/ws", thread: TASK, config: ZENTRO }).split(RULE).length - 1).toBe(2);
    expect(systemPrompt({ root: "/repo", role: "coordinator", thread: LEGACY, config: ZENTRO })).not.toContain("Write every message");
    expect(systemPrompt({ root: "/repo", role: "worker", thread: LEGACY, ticket: "T1", config: ZENTRO })).not.toContain("Write every message");
    expect(guide({ role: "main", root: "/repo", config: ZENTRO, legacy: true })).not.toContain("Write every message");
  });

  test("no config: no rule", () => {
    expect(systemPrompt({ root: "/ws", role: "main" })).not.toContain("Write every message");
  });
});

describe("main drafting restraint and the task-thread guide", () => {
  const main = systemPrompt({ root: "/ws", role: "main", config: DEFAULT_CONFIG }).split("\n");

  test("main keeps criteria to what the user said, asks at most one question, maps words to --type", () => {
    expect(main).toContain("- When you create a thread, keep the goal and criteria to what the user said: at most 3 short criteria, no invented detail; the coordinator refines them in stage 1.");
    expect(main).toContain("- Ask at most one clarifying question, and only when the thread's type or its repos are unclear.");
    expect(main).toContain("- Map the user's words to --type: bug, fix or hotfix is bug; feature or feat is feature; chore, refactor or docs is chore.");
  });

  test("a task thread's main guide lists the post-merge commands; a legacy one has none of the new rules", () => {
    const g = guide({ role: "main", root: "/ws", config: DEFAULT_CONFIG, thread: TASK });
    for (const c of ["agt thread status <id> <status>", "agt stack restart [--task <slug>|--main]", "agt thread cleanup <id>"]) expect(g).toContain(c);
    const legacy = guide({ role: "main", root: "/ws", config: DEFAULT_CONFIG, legacy: true });
    expect(legacy).not.toContain("at most 3 short criteria");
    expect(legacy).not.toContain("agt stack restart");
  });
});

describe("browser check only on request", () => {
  test("a task coordinator is told to skip stage 8 unless asked; main adds --browser-check on request; legacy has neither", () => {
    expect(coordinator(DEFAULT_CONFIG)).toContain('Stage 8 (browser check) runs only on request: when agt recorded it skipped ("not requested")');
    const main = systemPrompt({ root: "/repo", role: "main", config: DEFAULT_CONFIG });
    expect(main).toContain("add --browser-check to agt thread new");
    expect(systemPrompt({ root: "/repo", role: "coordinator", thread: LEGACY })).not.toContain("browser check");
  });
});
