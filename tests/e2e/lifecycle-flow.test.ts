import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { initProject } from "../../src/project/init.ts";
import { FAKE_CLAUDE, FAKE_HERDR, fakeHerdrState, isolatedConfigHome, tempRepo, waitFor, SPAWN_TEST_ENV } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");
let root: string;
let fake: ReturnType<typeof fakeHerdrState>;
let xdg: string;
let claudeDir: string;

function agt(args: string[], extra: Record<string, string> = {}, stdin?: string) {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "", HOME: "/nonexistent", XDG_CONFIG_HOME: xdg, AGT_ROOT: root, FAKE_HERDR_STATE: fake.file, ...SPAWN_TEST_ENV,
      HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t0", HERDR_PANE_ID: "w1:p0", HERDR_BIN_PATH: FAKE_HERDR,
      AGT_CLAUDE_BIN: FAKE_CLAUDE, AGT_OPENCODE_BIN: "/nonexistent/opencode", AGT_CODEX_BIN: "/nonexistent/codex", AGT_OMP_BIN: "/nonexistent/omp", AGT_AGY_BIN: "/nonexistent/agy", CLAUDE_CONFIG_DIR: claudeDir, ...extra,
    },
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`agt ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

type Sess = { id: string; role: string; status: string; pane?: string };
const sessions = () =>
  (parse(readFileSync(join(root, ".agentthread/threads/001-login/sub.thread.md"), "utf8").split("---\n")[1]!) as { sessions: Sess[] }).sessions;
const liveCoordinator = () => sessions().find((s) => s.role === "coordinator" && s.pane && !["rotated", "lost", "ended", "failed"].includes(s.status));
/** `agtSession`: the AGT_SESSION a split-born (replacement) coordinator's pane carries; a tab's root pane has none. */
const hook = (signal: string, id: string, agtSession?: string) =>
  agt(["event", signal], { AGT_ROLE: "coordinator", AGT_THREAD: "001", AGT_SESSION: agtSession ?? id }, JSON.stringify({ session_id: "vendor-id" }));
const DEAD = ["rotated", "lost", "ended", "failed"];
const HANDOFF = ["Goal status", "Work done", "Decisions", "Next steps", "Risks"].map((s) => `## ${s}\n${s} written by the coordinator`).join("\n");

beforeAll(() => {
  root = tempRepo();
  initProject(root, "shop");
  fake = fakeHerdrState({ tabs: ["w1:t0"], panes: ["w1:p0"] });
  xdg = isolatedConfigHome();
  claudeDir = isolatedConfigHome();
});

afterAll(() => {
  try {
    agt(["daemon", "stop"]);
  } catch {
    // never started
  }
});

test("rotation on precompact, then recovery by replacement", async () => {
  agt(["start", "--no-manager"]);
  agt(["thread", "new", "Login", "--type", "feature"]);
  const c1 = await waitFor(() => liveCoordinator(), 10_000);
  hook("started", c1.id);

  // compaction → rotation requested → handoff request delivered at idle
  hook("compacting", c1.id);
  hook("idle", c1.id);
  const prompts = () => fake.read().calls.filter((x) => x[0] === "agent" && x[1] === "prompt").map((x) => x[3] ?? "");
  expect(prompts().some((p) => p.startsWith("HANDOFF REQUEST:") && p.includes("agt handoff 001 --stdin"))).toBe(true);
  expect(sessions().find((s) => s.id === c1.id)!.status).toBe("rotating");

  // the coordinator writes its handoff → replacement split from its pane, old pane closed
  agt(["handoff", "001", "--stdin"], { AGT_ROLE: "coordinator", AGT_THREAD: "001" }, HANDOFF);
  const c2 = await waitFor(() => {
    const c = liveCoordinator();
    return c && c.id !== c1.id ? c : undefined;
  }, 10_000);
  expect(sessions().find((s) => s.id === c1.id)!.status).toBe("rotated");
  expect(c2.pane).not.toBe(c1.pane);
  expect(fake.read().calls.some((x) => x.join(" ") === `pane close ${c1.pane}`)).toBe(true);
  expect(prompts().some((p) => p.startsWith("You are the new coordinator of thread 001;"))).toBe(true);
  expect(readFileSync(join(root, ".agentthread/threads/001-login/sub.thread.md"), "utf8")).toContain("Goal status written by the coordinator");

  // the agent in c2's pane disappears → agt start replaces it with a fresh coordinator in a new split (never --resume)
  fake.update((s) => ({ agentPanes: (s.agentPanes ?? []).filter((p) => p !== c2.pane) }));
  const before = fake.read().calls.length;
  agt(["start", "--no-manager"]);
  const started = await waitFor(() => {
    const calls = fake.read().calls.slice(before);
    return calls.find((x) => x[0] === "agent" && x[1] === "start");
  }, 10_000);
  expect(started).not.toContain("--resume");
  expect(started).not.toContain(c2.id);
  const c3 = await waitFor(() => {
    const c = liveCoordinator();
    return c && c.id !== c2.id ? c : undefined;
  }, 10_000);
  expect(c3.pane).not.toBe(c2.pane);
  expect(fake.read().calls.slice(before).some((x) => x[0] === "pane" && x[1] === "split" && x.includes(c2.pane!))).toBe(true);
  expect(sessions().find((x) => x.id === c2.id)!.status).toBe("lost");

  // the replacement got the replacement bootstrap, and its hooks (carrying its own AGT_SESSION) are accepted
  await waitFor(() => prompts().filter((p) => p.startsWith("You are the new coordinator of thread 001;")).length >= 2, 10_000);
  hook("started", c3.id, c3.id);
  expect(sessions().find((x) => x.id === c3.id)!.status).toBe("idle");
  hook("active", c3.id, c3.id);
  expect(sessions().find((x) => x.id === c3.id)!.status).toBe("active");

  // exactly one live coordinator for the thread: the replacement c3
  const live = sessions().filter((x) => x.role === "coordinator" && !DEAD.includes(x.status));
  expect(live.map((x) => x.id)).toEqual([c3.id]);
  expect(agt(["logs"]).split("\n").some((l) => l.split(" ")[2] === "session.resuming")).toBe(false);
});
