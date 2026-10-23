import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { initProject } from "../../src/project/init.ts";
import { FAKE_CLAUDE, FAKE_HERDR, fakeHerdrState, isolatedConfigHome, tempRepo, waitFor } from "../helpers.ts";

// No hook signals anywhere in this file: session state comes only from the polled (fake) Herdr status.
const BIN = join(import.meta.dir, "../../bin/agt");
let root: string;
let fake: ReturnType<typeof fakeHerdrState>;
let xdg: string;

function agt(args: string[], extra: Record<string, string> = {}) {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "", HOME: "/nonexistent", XDG_CONFIG_HOME: xdg, AGT_ROOT: root, FAKE_HERDR_STATE: fake.file,
      HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t0", HERDR_PANE_ID: "w1:p0", HERDR_BIN_PATH: FAKE_HERDR,
      AGT_CLAUDE_BIN: FAKE_CLAUDE, ...extra,
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
const fm = () => parse(readFileSync(threadFile(), "utf8").split("---\n")[1]!) as { worktree: string; sessions: Sess[] };
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
const git = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
};

beforeAll(() => {
  root = tempRepo();
  initProject(root, "shop");
  writeFileSync(join(root, ".agentthread", "config.yaml"), "herdr:\n  poll_interval: 100ms\n");
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

  agt(["ticket", "add", "001", "T1", "--scope", "src"], coordEnv);
  agt(["worker", "spawn", "001", "--ticket", "T1"], coordEnv);
  agt(["note", "001", "root cause in auth.ts:42"], coordEnv);
  agt(["question", "001", "retry 3 or 5?"], coordEnv);
  agt(["progress", "001", "T1 running; next: review"], coordEnv);

  const wt = fm().worktree;
  writeFileSync(join(wt, "auth.ts"), "export const retries = 3;\n");
  git(wt, "add", "auth.ts");
  git(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add auth retries");

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
  expect(brief).toContain("add auth retries");
  expect(brief).toContain("## How to continue");
  expect(brief).toMatch(/## Handoff\n\n(?!None)\S/);
  expect(brief).toContain("> Generated by the daemon.");
  expect(brief).toMatch(/Written \S+ by generated/);
  expect(brief).toMatch(/Latest progress: \S+ \(coordinator\) T1 running; next: review/);

  expect(existsSync(join(wt, "AGENTS.md"))).toBe(true);
  expect(lstatSync(join(wt, "CLAUDE.md")).isSymbolicLink()).toBe(true);
  expect(git(wt, "status", "--porcelain")).not.toMatch(/AGENTS\.md|CLAUDE\.md/);

  // worker flow, polled status only
  const w = await waitFor(() => worker(), 10_000);
  await setStatus(w.pane!, "working");
  await waitFor(() => fm().sessions.find((x) => x.id === w.id)!.status === "active", 10_000);
  const wEnv = { AGT_ROLE: "worker", AGT_THREAD: "001", AGT_SESSION: w.id, AGT_TICKET: "T1" };
  agt(["ticket", "claim", "001/T1"], wEnv);
  agt(["ticket", "done", "001/T1", "--summary", "retries added"], wEnv);
  await setStatus(w.pane!, "idle");
  await waitFor(() => readState().calls.some((x) => x.join(" ") === `pane close ${w.pane}`), 10_000);
  await waitFor(() => fm().sessions.find((x) => x.id === w.id)!.status === "ended", 10_000);

  await setStatus(c2.pane!, "working");
  await waitFor(() => fm().sessions.find((x) => x.id === c2.id)!.status === "active", 10_000);
  await setStatus(c2.pane!, "idle");
  await waitFor(() => prompts(c2.pane).includes("Ticket T1 is done: retries added."), 10_000);

  // no hooks ran: every session signal came from the poller (actor "user", no AGT_SESSION), none from `agt event`
  const signals = agt(["logs"]).split("\n").map((l) => l.split(" ")).filter((f) => ["session.started", "session.active", "agent.idle", "session.ended", "agent.blocked"].includes(f[2]!));
  expect(signals.length).toBeGreaterThan(5);
  expect(signals.filter((f) => f[4] !== "user")).toEqual([]);
}, 60_000);
