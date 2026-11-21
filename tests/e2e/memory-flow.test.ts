import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { initProject } from "../../src/project/init.ts";
import { FAKE_CLAUDE, FAKE_HERDR, fakeHerdrState, isolatedConfigHome, tempRepo, waitFor, waitWorktreeAdded, SPAWN_TEST_ENV } from "../helpers.ts";

// No hook signals anywhere in this file: session state comes only from the polled (fake) Herdr status (claude-code with no hook seen: the poller drives its turns).
const BIN = join(import.meta.dir, "../../bin/agt");
let root: string;
let fake: ReturnType<typeof fakeHerdrState>;
let xdg: string;

function agt(args: string[], extra: Record<string, string> = {}) {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "", HOME: "/nonexistent", XDG_CONFIG_HOME: xdg, AGT_ROOT: root, FAKE_HERDR_STATE: fake.file, ...SPAWN_TEST_ENV,
      HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t0", HERDR_PANE_ID: "w1:p0", HERDR_BIN_PATH: FAKE_HERDR,
      AGT_CLAUDE_BIN: FAKE_CLAUDE, AGT_OPENCODE_BIN: "/nonexistent/opencode", AGT_CODEX_BIN: "/nonexistent/codex", AGT_OMP_BIN: "/nonexistent/omp", AGT_AGY_BIN: "/nonexistent/agy", ...extra,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`agt ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

type Sess = { id: string; role: string; ticket?: string; status: string; pane?: string };
const threadFile = () => join(root, ".agentthread/threads/001-login/sub.thread.md");
const fm = () => parse(readFileSync(threadFile(), "utf8").split("---\n")[1]!) as { dir: string; sessions: Sess[] };
const DEAD = ["rotated", "lost", "ended", "failed"];
const liveCoordinators = () => fm().sessions.filter((s) => s.role === "coordinator" && s.pane && !DEAD.includes(s.status));
const worker = () => fm().sessions.find((s) => s.role === "worker" && s.ticket === "T1" && s.pane);
const coordEnv = { AGT_ROLE: "coordinator", AGT_THREAD: "001" };
const prompts = (pane?: string) =>
  readState().calls.filter((x) => x[0] === "agent" && x[1] === "prompt" && (!pane || x[2] === pane)).map((x) => x[3] ?? "");
// The fake herdr and fake.update share a lock and write atomically, so edits are never lost and reads never torn.
const readState = () => fake.read();
const setStatus = async (pane: string, st: string) => fake.update((s) => ({ status: { ...s.status, [pane]: st } }));
const dropPane = async (pane: string) => fake.update((s) => ({ agentPanes: (s.agentPanes ?? []).filter((p) => p !== pane) }));

beforeAll(() => {
  root = tempRepo();
  initProject(root, "shop");
  // a repo of the workspace, for the task worktree the coordinator adds below
  mkdirSync(join(root, "api"));
  for (const a of [["init", "-q", "-b", "main"], ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"]]) {
    Bun.spawnSync(["git", "-C", join(root, "api"), ...a]);
  }
  writeFileSync(join(root, ".agentthread", "config.yaml"), "herdr:\n  poll_interval: 100ms\nworkspace:\n  repos:\n    api:\n      path: api\n");
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

test("memory survives a lost coordinator; worker flow runs without hooks", async () => {
  agt(["start", "--no-manager"]);
  agt(["thread", "new", "Login", "--type", "feature", "--max-workers", "1"]);
  const c1 = await waitFor(() => liveCoordinators()[0], 10_000);
  await setStatus(c1.pane!, "idle");
  await waitFor(() => fm().sessions.find((s) => s.id === c1.id)!.status === "idle", 10_000);

  agt(["worktree", "add", "001", "api", "--from", "main"], coordEnv);
  await waitWorktreeAdded(root);
  agt(["ticket", "add", "001", "T1", "--repo", "api", "--file", "src"], coordEnv);
  agt(["worker", "spawn", "001", "--ticket", "T1"], coordEnv);
  agt(["note", "001", "root cause in auth.ts:42"], coordEnv);
  agt(["question", "001", "retry 3 or 5?"], coordEnv);
  agt(["progress", "001", "T1 running; next: review"], coordEnv);

  // A thread directory has no git trail of its own; the per-repo trail comes with agt worktree add (Plan 10 Task 5).
  const wt = fm().dir;
  expect(wt).toBe(join(root, ".worktrees", "login"));

  // kill the coordinator: its pane drops out of the agent list, and the daemon replaces it on its own (no agt start)
  const before = readState().calls.length;
  await dropPane(c1.pane!);
  const c2 = await waitFor(() => {
    const l = liveCoordinators();
    return l.length === 1 && l[0]!.id !== c1.id ? l[0] : undefined;
  }, 10_000);
  expect(fm().sessions.find((x) => x.id === c1.id)!.status).toBe("ended");

  expect(liveCoordinators().map((x) => x.id)).toEqual([c2.id]);
  expect(c2.pane).not.toBe(c1.pane);
  const calls = readState().calls.slice(before);
  const started = calls.find((x) => x[0] === "agent" && x[1] === "start")!;
  expect(started).toBeDefined();
  expect(started.join(" ")).not.toMatch(/--resume|--session-id/);
  expect(calls.some((x) => x[0] === "pane" && x[1] === "split")).toBe(true);
  const dir = join(root, ".agentthread/threads/001-login");
  await waitFor(() => prompts().some((p) => p.startsWith("You are the new coordinator of thread 001;")), 10_000);
  expect(prompts()).toContain(`You are the new coordinator of thread 001; the previous session ended. Read ${dir}/brief.md, then follow AGENTS.md.`);

  // a later reconcile (agt start) sees the live replacement and starts nothing more
  const beforeStart = readState().calls.filter((x) => x[0] === "agent" && x[1] === "start").length;
  agt(["start", "--no-manager"]);
  await Bun.sleep(500);
  expect(liveCoordinators().map((x) => x.id)).toEqual([c2.id]);
  expect(readState().calls.filter((x) => x[0] === "agent" && x[1] === "start").length).toBe(beforeStart);

  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  expect(brief).toContain("T1 running; next: review");
  expect(brief).toContain("root cause in auth.ts:42");
  expect(brief).toContain("retry 3 or 5?");
  expect(brief).toContain("## How to continue");
  expect(brief).toMatch(/## Handoff\n\n(?!None)\S/);
  expect(brief).toContain("> Generated by the daemon.");
  expect(brief).toMatch(/Written \S+ by generated/);
  expect(brief).toMatch(/Latest progress: \S+ \(coordinator\) T1 running; next: review/);

  expect(existsSync(join(wt, "AGENTS.md"))).toBe(true);
  expect(lstatSync(join(wt, "CLAUDE.md")).isSymbolicLink()).toBe(true);
  expect(existsSync(join(wt, ".git"))).toBe(false);

  // the coordinator adds a task worktree, waits (a worker commits on wip/<task>; the guard refuses the coordinator there) for the ready notice, and commits in it: brief.md shows the commit under that repo
  const apiWt = join(wt, "api");
  await waitFor(() => prompts().some((p) => p.includes(`Worktree for api is ready at ${apiWt}`)), 10_000);
  writeFileSync(join(apiWt, "retry.ts"), "export const retries = 3;\n");
  // the pre-commit hook admits a worker only the files of its ticket
  mkdirSync(join(dir, "tickets"), { recursive: true });
  writeFileSync(join(dir, "tickets", "T1.files"), "retry.ts\n");
  for (const a of [["add", "retry.ts"], ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "add retry"]]) {
    const g = Bun.spawnSync(["git", "-C", apiWt, ...a], { env: { ...process.env, AGT_ROOT: root, AGT_ROLE: "worker", AGT_THREAD: "001", AGT_TICKET: "T1", AGT_TASK: "login" }, stderr: "pipe" });
    if (g.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${g.stderr.toString()}`);
  }
  // briefs re-render on events and trails are cached for 3s: the next event after the cache expires shows the commit
  await Bun.sleep(3200);
  agt(["note", "001", "committed in api"], coordEnv);
  await waitFor(() => /## Git trail\n\n### api\n\n- \S+ add retry/.test(readFileSync(join(dir, "brief.md"), "utf8")), 15_000);
  expect(readFileSync(join(dir, "brief.md"), "utf8")).toContain(`- api: ${apiWt} on wip/login (from main)`);

  // worker flow, polled status only
  const w = await waitFor(() => worker(), 10_000);
  await setStatus(w.pane!, "working");
  await waitFor(() => fm().sessions.find((x) => x.id === w.id)!.status === "active", 10_000);
  const wEnv = { AGT_ROLE: "worker", AGT_THREAD: "001", AGT_SESSION: w.id, AGT_TICKET: "T1" };
  agt(["ticket", "claim", "001/T1"], wEnv);
  agt(["ticket", "done", "001/T1", "--summary", "retries added"], wEnv);
  await setStatus(w.pane!, "idle");
  await waitFor(() => fm().sessions.find((x) => x.id === w.id)!.status === "idle", 10_000);

  await setStatus(c2.pane!, "working");
  await waitFor(() => fm().sessions.find((x) => x.id === c2.id)!.status === "active", 10_000);
  await setStatus(c2.pane!, "idle");
  await waitFor(() => prompts(c2.pane).includes('Ticket T1 is ready for review: retries added. Review its commits, then agt ticket accept 001/T1 or agt ticket return 001/T1 "<what to fix>".'), 10_000);
  // accepting the reviewed ticket ends its waiting worker
  agt(["ticket", "accept", "001/T1"], coordEnv);
  await waitFor(() => readState().calls.some((x) => x.join(" ") === `pane close ${w.pane}`), 10_000);
  await waitFor(() => fm().sessions.find((x) => x.id === w.id)!.status === "ended", 10_000);

  // no hooks ran: every session signal came from the poller (actor "user", no AGT_SESSION), none from `agt event`
  const signals = agt(["logs", "--all"]).split("\n").map((l) => l.split(" ")).filter((f) => ["session.started", "session.active", "agent.idle", "session.ended", "agent.blocked"].includes(f[3]!));
  expect(signals.length).toBeGreaterThan(5);
  // (the worker's end is the follow-up of the coordinator's `agt ticket accept`, stored under that command's actor)
  expect(signals.filter((f) => f[2] !== "user" && !(f[3] === "session.ended" && f[2] === "coordinator"))).toEqual([]);
}, 60_000);
