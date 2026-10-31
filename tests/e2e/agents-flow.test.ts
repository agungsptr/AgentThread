import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { initProject } from "../../src/project/init.ts";
import { FAKE_CLAUDE, FAKE_HERDR, fakeHerdrState, isolatedConfigHome, repoName, tempRepo, waitFor, waitWorktreeAdded, SPAWN_REPORT_ENV } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");
let root: string;
let fake: ReturnType<typeof fakeHerdrState>;
let xdg: string;

function agt(args: string[], extra: Record<string, string> = {}, stdin?: string) {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "", HOME: "/nonexistent", XDG_CONFIG_HOME: xdg, AGT_ROOT: root, FAKE_HERDR_STATE: fake.file, ...SPAWN_REPORT_ENV,
      HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t0", HERDR_PANE_ID: "w1:p0", HERDR_BIN_PATH: FAKE_HERDR,
      AGT_CLAUDE_BIN: FAKE_CLAUDE, AGT_OPENCODE_BIN: "/nonexistent/opencode", AGT_CODEX_BIN: "/nonexistent/codex", AGT_OMP_BIN: "/nonexistent/omp", ...extra,
    },
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`agt ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

type Fm = { sessions: { id: string; role: string; ticket?: string; status: string; pane?: string }[] };
const fm = () => parse(readFileSync(join(root, ".agentthread/threads/001-login/sub.thread.md"), "utf8").split("---\n")[1]!) as Fm;
const session = (role: string, ticket?: string) => fm().sessions.find((s) => s.role === role && (ticket === undefined || s.ticket === ticket));
const spawned = (role: string, ticket?: string) => {
  const s = session(role, ticket);
  return s?.pane ? s : undefined;
};
const hook = (signal: string, id: string, env: Record<string, string> = {}) => agt(["event", signal], { ...env, AGT_SESSION: id }, JSON.stringify({ session_id: "vendor-id" }));
const coordEnv = { AGT_ROLE: "coordinator", AGT_THREAD: "001" };

beforeAll(() => {
  root = tempRepo();
  initProject(root, "shop");
  fake = fakeHerdrState({ tabs: ["w1:t0"], panes: ["w1:p0"] });
  xdg = isolatedConfigHome();
});

afterAll(() => {
  try {
    agt(["daemon", "stop"]);
  } catch {
    // never started
  }
});

test("coordinator spawns, workers queue and rotate, notices reach the idle coordinator", async () => {
  agt(["start", "--no-manager"]);
  agt(["thread", "new", "Login", "--type", "feature", "--max-workers", "1"]);

  const c = await waitFor(() => spawned("coordinator"), 10_000);
  expect(c.pane).toBe("w1:p2");
  hook("started", c.id, coordEnv);
  agt(["thread", "status", "001", "in_progress"], coordEnv);
  agt(["worktree", "add", "001", repoName(root), "--from", "main"], coordEnv);
  await waitWorktreeAdded(root);
  agt(["ticket", "add", "001", "API", "--repo", repoName(root), "--file", "src/api"], coordEnv);
  agt(["ticket", "add", "001", "UI", "--repo", repoName(root), "--file", "src/ui"], coordEnv);
  agt(["worker", "spawn", "001", "--ticket", "T1"], coordEnv);
  expect(agt(["worker", "spawn", "001", "--ticket", "T2"], coordEnv)).toBe('{"queued":true}');
  hook("idle", c.id, coordEnv);

  const w1 = await waitFor(() => spawned("worker", "T1"), 10_000);
  const w1Env = { AGT_ROLE: "worker", AGT_THREAD: "001", AGT_SESSION: w1.id, AGT_TICKET: "T1" };
  hook("started", w1.id, w1Env);
  agt(["ticket", "claim", "001/T1"], w1Env);
  agt(["ticket", "done", "001/T1", "--summary", "endpoint added"], w1Env);
  hook("idle", w1.id, w1Env);
  // in review the worker waits; accepting the ticket ends it and frees the slot
  expect(fm().sessions.find((s) => s.id === w1.id)!.status).toBe("idle");
  agt(["ticket", "accept", "001/T1"], coordEnv);

  expect(fake.read().calls.some((x) => x.join(" ") === `pane close ${w1.pane}`)).toBe(true);
  expect(fm().sessions.find((s) => s.id === w1.id)!.status).toBe("ended");
  const w2 = await waitFor(() => spawned("worker", "T2"), 10_000);
  expect(w2.pane).not.toBe(w1.pane);

  const prompts = fake.read().calls.filter((x) => x[0] === "agent" && x[1] === "prompt" && x[2] === "w1:p2").map((x) => x[3]);
  expect(prompts).toContain('Ticket T1 is ready for review: endpoint added. Review its commits, then agt ticket accept 001/T1 or agt ticket return 001/T1 "<what to fix>".');
});

test("every role starts through its own agent kind", async () => {
  agt(["daemon", "stop"]);
  root = tempRepo();
  initProject(root, "mixed");
  writeFileSync(join(root, ".agentthread", "config.yaml"), "agents:\n  roles:\n    coordinator: { agent: opencode, model: p/m }\n    worker: { agent: codex, effort: high }\n");
  fake = fakeHerdrState({ tabs: ["w1:t0"], panes: ["w1:p0"] });
  try {
    agt(["start", "--no-manager"]);
    agt(["thread", "new", "Login", "--type", "feature"]);
    const c = await waitFor(() => spawned("coordinator"), 10_000);
    expect(fake.read().kinds).toEqual({ [c.pane!]: "opencode" });
    agt(["worktree", "add", "001", repoName(root), "--from", "main"], coordEnv);
    await waitWorktreeAdded(root);
    agt(["ticket", "add", "001", "API", "--repo", repoName(root), "--file", "src/api"], coordEnv);
    agt(["worker", "spawn", "001", "--ticket", "T1"], coordEnv);
    const w = await waitFor(() => spawned("worker", "T1"), 10_000);
    expect(fake.read().kinds).toEqual({ [c.pane!]: "opencode", [w.pane!]: "codex" });
    const start = fake.read().calls.find((x) => x[0] === "agent" && x[1] === "start" && x[x.indexOf("--pane") + 1] === w.pane)!;
    expect(start).toContain('model_reasoning_effort="high"');
    const tab = fake.read().calls.find((x) => x[0] === "tab" && x[1] === "create")!;
    expect(tab).toContain("AGT_AGENT=opencode");
  } finally {
    agt(["daemon", "stop"]);
  }
}, 30_000);
