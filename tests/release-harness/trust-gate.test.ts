import { expect, test } from "bun:test";
import { agtTrustedFolders, watchTrustDialogs } from "../release/harness.ts";

const TRUST_SCREEN = "Quick safety check: Is this a project you created or one you trust?\n ❯ 1. No, exit\n   2. Yes, I trust this folder";

/**
 * A fake Herdr and clock: `screens(t)` says which panes show the trust dialog at time t (ms). Each poll advances the
 * clock by 1.5s; the watch stops itself at `endMs`.
 */
function fake(screens: (t: number) => Record<string, boolean>, endMs: number) {
  let t = 0;
  const keys: string[] = [];
  const foreign: { pane: string; at: number }[] = [];
  const log: string[] = [];
  let w!: ReturnType<typeof watchTrustDialogs>;
  const herdr = {
    agents: async () => Object.keys(screens(t)).map((pane_id) => ({ pane_id, agent: "claude", agent_status: screens(t)[pane_id] ? "blocked" : "idle" })),
    run: async (args: string[]) => {
      if (args[1] === "send-keys") keys.push(`${args[2]} ${args[3]}`);
      return { exitCode: 0, stdout: args[1] === "read" && screens(t)[args[2]!] ? TRUST_SCREEN : "", stderr: "" };
    },
  } as unknown as Parameters<typeof watchTrustDialogs>[0];
  w = watchTrustDialogs(herdr, () => "main", (m) => void log.push(m), (pane) => void foreign.push({ pane, at: t }), {
    now: () => t,
    pollMs: 1_500,
    sleep: async (ms) => {
      t += ms;
      if (t >= endMs) w.stop();
    },
  });
  return { done: () => w.done, keys, foreign, log };
}

test("a coordinator's trust dialog that goes away within 30s does not fail the row, and is noted as agt's answer", async () => {
  const f = fake((t) => ({ "w1:p2": t < 10_000 }), 60_000);
  await f.done();
  expect(f.foreign).toEqual([]);
  expect(f.keys).toEqual([]); // the harness never answers outside main's pane
  expect(f.log).toContain("agt answered the Claude Code workspace-trust dialog in w1:p2");
});

test("a coordinator's trust dialog still showing after 30s fails the row, once", async () => {
  const f = fake(() => ({ "w1:p2": true }), 90_000);
  await f.done();
  expect(f.foreign.map((x) => x.pane)).toEqual(["w1:p2"]);
  expect(f.foreign[0]!.at).toBeGreaterThanOrEqual(30_000);
  expect(f.foreign[0]!.at).toBeLessThan(33_000);
  expect(f.keys).toEqual([]);
});

test("main's trust dialog is still answered at once", async () => {
  const f = fake((t) => ({ main: t < 1_000 }), 10_000);
  await f.done();
  expect(f.keys).toEqual(["main down", "main enter"]);
  expect(f.foreign).toEqual([]);
});

test("the folders agt trusted are read from its daemon log lines", () => {
  const log = [
    "agt __spawn: trusted /private/var/x/.worktrees/001-task for Claude Code (a folder agt created)",
    "something else",
    "agt __spawn: trusted /r/.worktrees/002 b for Claude Code (a folder agt created)",
  ].join("\n");
  expect(agtTrustedFolders(log)).toEqual(["/private/var/x/.worktrees/001-task", "/r/.worktrees/002 b"]);
});
