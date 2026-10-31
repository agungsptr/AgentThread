import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedConfigHome, repoName, tempRepo } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");
let root: string;
let xdg: string;

function agt(args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", XDG_CONFIG_HOME: xdg, AGT_ROOT: root, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`agt ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const read = (rel: string) => readFileSync(join(root, ".agentthread", rel), "utf8");
const coord = (thread: string) => ({ AGT_ROLE: "coordinator", AGT_THREAD: thread, AGT_SESSION: `c${thread}` });
const worker = (thread: string, session: string) => ({ AGT_ROLE: "worker", AGT_THREAD: thread, AGT_SESSION: session });

beforeAll(() => {
  xdg = isolatedConfigHome();
  root = tempRepo();
  agt(["init", "--name", "shop"]);
  agt(["daemon", "start"]);
});

afterAll(() => {
  agt(["daemon", "stop"]);
});

test("feature → dependent bugfix → review → done unblocks dependent", () => {
  agt(["thread", "new", "OAuth login", "--type", "feature", "--goal", "Google login", "--criteria", "login works"], {
    AGT_ROLE: "main",
  });
  agt(["thread", "new", "Fix session race", "--type", "bug", "--depends", "001"]);
  expect(read("main.thread.md")).toContain("| 002 | Fix session race | bug | blocked | 0/0 | 001 |");

  agt(["thread", "status", "001", "in_progress"], coord("001"));
  agt(["ticket", "add", "001", "Backend", "--repo", repoName(root), "--file", "src/auth"], coord("001"));
  agt(["ticket", "add", "001", "Button", "--repo", repoName(root), "--file", "src/ui/login.tsx"], coord("001"));
  agt(["ticket", "claim", "001/T1"], worker("001", "w1"));
  agt(["ticket", "claim", "001/T2"], worker("001", "w2"));
  agt(["ticket", "done", "001/T1", "--summary", "ok"], worker("001", "w1"));
  agt(["ticket", "done", "001/T2", "--summary", "ok"], worker("001", "w2"));
  agt(["decide", "001", "use PKCE"], coord("001"));

  const handoff = join(root, "h.md");
  writeFileSync(handoff, "## Goal status\ndone\n## Work done\nT1, T2\n## Decisions\nPKCE\n## Next steps\nreview\n## Risks\nnone");
  agt(["handoff", "001", "--file", handoff], coord("001"));
  agt(["thread", "status", "001", "review"], coord("001"));
  expect(read("main.thread.md")).toContain("- 001: awaiting review");

  agt(["thread", "status", "001", "done"]);
  expect(read("main.thread.md")).toContain("| 001 | OAuth login | feature | done | 2/2 | - |");
  expect(read("main.thread.md")).toContain("| 002 | Fix session race | bug | open | 0/0 | 001 |");

  const sub = read("threads/001-oauth-login/sub.thread.md");
  expect(sub).toContain("- [ ] login works");
  expect(sub).toContain("### Decisions");
  expect(read("threads/001-oauth-login/board.md")).toContain(`| T2 | Button | [${repoName(root)}] src/ui/login.tsx | done | w2 |`);
  expect(read("threads/001-oauth-login/log.md")).toContain("[coordinator:c001] decision: use PKCE");
});
