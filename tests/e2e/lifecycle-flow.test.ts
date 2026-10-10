import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { claudeSessionFile } from "../../src/agents/claude.ts";
import { initProject } from "../../src/project/init.ts";
import { FAKE_CLAUDE, FAKE_HERDR, fakeHerdrState, isolatedConfigHome, tempRepo, waitFor } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");
let root: string;
let fake: ReturnType<typeof fakeHerdrState>;
let xdg: string;
let claudeDir: string;

function agt(args: string[], extra: Record<string, string> = {}, stdin?: string) {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "", HOME: "/nonexistent", XDG_CONFIG_HOME: xdg, AGT_ROOT: root, FAKE_HERDR_STATE: fake.file,
      HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t0", HERDR_PANE_ID: "w1:p0", HERDR_BIN_PATH: FAKE_HERDR,
      AGT_CLAUDE_BIN: FAKE_CLAUDE, CLAUDE_CONFIG_DIR: claudeDir, ...extra,
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
const hook = (signal: string, id: string) => agt(["event", signal], { AGT_ROLE: "coordinator", AGT_THREAD: "001" }, JSON.stringify({ session_id: id }));
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

test("rotation on precompact, then recovery by resume", async () => {
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
  expect(prompts().some((p) => p.startsWith("Continue coordinating thread 001 as its new coordinator."))).toBe(true);
  expect(readFileSync(join(root, ".agentthread/threads/001-login/sub.thread.md"), "utf8")).toContain("Goal status written by the coordinator");

  // the agent in c2's pane disappears; its transcript exists → agt start resumes it with --resume
  const s = fake.read();
  writeFileSync(fake.file, JSON.stringify({ ...s, agentPanes: (s.agentPanes ?? []).filter((p) => p !== c2.pane) }));
  const file = claudeSessionFile({ configDir: claudeDir, cwd: join(root, ".worktrees", "001-login"), session: c2.id });
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "{}\n");
  const before = fake.read().calls.length;
  agt(["start", "--no-manager"]);
  const resumed = await waitFor(() => {
    const calls = fake.read().calls.slice(before);
    return calls.find((x) => x[0] === "agent" && x[1] === "start" && x.includes("--resume"));
  }, 10_000);
  expect(resumed).toContain(c2.id);
  expect(resumed[resumed.indexOf("--pane") + 1]).toBe(c2.pane);
});
