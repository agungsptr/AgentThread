import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { initProject } from "../../src/project/init.ts";
import { FAKE_HERDR, fakeHerdrState, isolatedConfigHome, tempRepo } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");
let root: string;
let fake: ReturnType<typeof fakeHerdrState>;
let xdg: string;

function agt(args: string[], extra: Record<string, string> = {}) {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: "/nonexistent",
      XDG_CONFIG_HOME: xdg,
      AGT_ROOT: root,
      FAKE_HERDR_STATE: fake.file,
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t0",
      HERDR_PANE_ID: "w1:p0",
      HERDR_BIN_PATH: FAKE_HERDR,
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`agt ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const tabOf = (dir: string) =>
  parse(readFileSync(join(root, ".agentthread/threads", dir, "sub.thread.md"), "utf8").split("---\n")[1]!).tab as string | null;
const coord = (thread: string) => ({ AGT_ROLE: "coordinator", AGT_THREAD: thread, AGT_SESSION: `c${thread}` });

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
    // daemon may never have started
  }
});

test("start → tabs per thread → manual close recovered → done closes tab", () => {
  agt(["start", "--no-manager"]);
  agt(["thread", "new", "OAuth login", "--type", "feature"]);
  agt(["thread", "new", "Fix session race", "--type", "bug", "--depends", "001"]);
  expect(tabOf("001-oauth-login")).toBe("w1:t2");
  expect(tabOf("002-fix-session-race")).toBe("w1:t3");

  // The user closes 002's tab by hand; the next start reopens exactly that one.
  const s = fake.read();
  writeFileSync(fake.file, JSON.stringify({ ...s, tabs: s.tabs.filter((t) => t !== "w1:t3") }));
  expect(agt(["start", "--no-manager"]).split("\n")).toEqual([
    "layout already set up (main tab w1:t0)",
    "subthread tabs reconciled (2 open threads)",
  ]);
  expect(tabOf("002-fix-session-race")).toBe("w1:t4");
  expect(fake.read().tabs.sort()).toEqual(["w1:t0", "w1:t2", "w1:t4"]);

  for (const status of ["in_progress", "review"]) agt(["thread", "status", "001", status], coord("001"));
  agt(["thread", "status", "001", "done"]);
  expect(tabOf("001-oauth-login")).toBeNull();
  expect(fake.read().tabs.sort()).toEqual(["w1:t0", "w1:t4"]);
  expect(readFileSync(join(root, ".agentthread/threads/001-oauth-login/log.md"), "utf8")).toContain("herdr tab w1:t2 closed");
});
