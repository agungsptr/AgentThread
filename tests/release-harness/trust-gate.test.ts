import { expect, test } from "bun:test";
import { agtTrustedFolders, answerTrustIn, say, watchTrustDialogs, type Herdr } from "../release/harness.ts";
import { P8_DIALOG } from "../fixtures/trust-screens.ts";

const TRUST_SCREEN = "Quick safety check: Is this a project you created or one you trust?\n ❯ 1. No, exit\n   2. Yes, I trust this folder";
const YES_SCREEN = "Quick safety check: Is this a project you created or one you trust?\n   1. No, exit\n ❯ 2. Yes, I trust this folder";

/**
 * A fake Herdr and clock: `screens(t)` says which panes show the trust dialog at time t (ms). Each poll advances the
 * clock by 1.5s; the watch stops itself at `endMs`.
 */
function fake(screens: (t: number) => Record<string, boolean>, endMs: number, cursor: { deaf?: number; stuck?: boolean } = {}) {
  let t = 0;
  const keys: string[] = [];
  const moved = new Set<string>(); // panes whose cursor is on "Yes"
  let deaf = cursor.deaf ?? 0;
  const foreign: { pane: string; at: number }[] = [];
  const log: string[] = [];
  let w!: ReturnType<typeof watchTrustDialogs>;
  const herdr = {
    agents: async () => Object.keys(screens(t)).map((pane_id) => ({ pane_id, agent: "claude", agent_status: screens(t)[pane_id] ? "blocked" : "idle" })),
    run: async (args: string[]) => {
      if (args[1] === "send-keys") keys.push(`${args[2]} ${args[3]}`);
      if (args[1] === "send-keys" && args[3] === "down" && !cursor.stuck && deaf-- <= 0) moved.add(args[2]!);
      return { exitCode: 0, stdout: args[1] === "read" && screens(t)[args[2]!] ? (moved.has(args[2]!) ? YES_SCREEN : TRUST_SCREEN) : "", stderr: "" };
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
  expect(f.log).toContain("Claude Code workspace-trust dialog cleared in w1:p2");
});

test("a dialog missing from one poll only (a flicker) keeps its grace clock: past 30s in all it still fails the row", async () => {
  // Polls are 1.5s apart: the dialog is missed at t=15s only.
  const f = fake((t) => ({ "w1:p2": t !== 15_000 }), 90_000);
  await f.done();
  expect(f.log.filter((m) => m.includes("cleared"))).toEqual([]);
  expect(f.foreign.map((x) => x.pane)).toEqual(["w1:p2"]);
  expect(f.foreign[0]!.at).toBeLessThan(33_000);
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

test("main's dialog whose first down is ignored gets a second down, and enter only once 'Yes' is selected", async () => {
  const f = fake((t) => ({ main: t < 1_000 }), 10_000, { deaf: 1 });
  await f.done();
  expect(f.keys).toEqual(["main down", "main down", "main enter"]);
});

test("main's dialog stuck on 'No, exit' never gets enter: the screen is logged once and the dialog left to the user", async () => {
  const f = fake(() => ({ main: true }), 30_000, { stuck: true });
  await f.done();
  expect(f.keys).toEqual(Array(5).fill("main down"));
  expect(f.log.filter((m) => m.includes("left it to the user"))).toEqual([
    `the Claude Code workspace-trust dialog in main did not show "Yes" selected after 5 downs; left it to the user. Its screen:\n${TRUST_SCREEN}`,
  ]);
});

test("answerTrustIn confirms the choice the same way: enter only on 'Yes', never on 'No, exit'", async () => {
  for (const [cursor, keys, answered] of [
    [{ deaf: 2 }, ["down", "down", "down", "enter"], true],
    [{ stuck: true }, ["down", "down", "down", "down", "down"], false],
  ] as const) {
    let deaf = (cursor as { deaf?: number }).deaf ?? 0;
    let yes = false;
    const sent: string[] = [];
    const log: string[] = [];
    const herdr = {
      run: async (args: string[]) => {
        if (args[1] === "send-keys") {
          sent.push(args[3]!);
          if (args[3] === "down" && !(cursor as { stuck?: boolean }).stuck && deaf-- <= 0) yes = true;
        }
        return { exitCode: 0, stdout: args[1] === "read" ? (yes ? YES_SCREEN : TRUST_SCREEN) : "", stderr: "" };
      },
    } as unknown as Herdr;
    let t = 0;
    expect(await answerTrustIn(herdr, "main", 60_000, (m) => void log.push(m), { now: () => t, sleep: async (ms) => void (t += ms) })).toBe(answered);
    expect(sent).toEqual([...keys]);
    if (!answered) expect(log[0]).toStartWith('the Claude Code workspace-trust dialog in main did not show "Yes" selected after 5 downs');
  }
});

test("the folders agt trusted are read from its daemon log lines", () => {
  const log = [
    "agt __spawn: trusted /private/var/x/.worktrees/001-task for Claude Code (a folder agt created)",
    "something else",
    "agt __spawn: trusted /r/.worktrees/002 b for Claude Code (a folder agt created)",
  ].join("\n");
  expect(agtTrustedFolders(log)).toEqual(["/private/var/x/.worktrees/001-task", "/r/.worktrees/002 b"]);
});

test("heavy rerun 4: a worker Herdr lists idle at a wrapped trust dialog is seen too; still showing after 30s it fails the row", async () => {
  // Pane w1:p5's footer is wrapped, so Herdr's blocked rule misses it and lists the agent idle. The idle pane w1:p4 runs.
  const narrow = " ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to\n cancel";
  let t = 0;
  const foreign: string[] = [];
  let w!: ReturnType<typeof watchTrustDialogs>;
  const herdr = {
    agents: async () => ["w1:p4", "w1:p5"].map((pane_id) => ({ pane_id, agent: "claude", agent_status: "idle" })),
    run: async (args: string[]) => ({ exitCode: 0, stdout: args[2] === "w1:p5" ? narrow : "Welcome to Claude Code\n❯ ", stderr: "" }),
  } as unknown as Parameters<typeof watchTrustDialogs>[0];
  w = watchTrustDialogs(herdr, () => "main", () => {}, (pane) => void foreign.push(pane), {
    now: () => t,
    sleep: async (ms) => void ((t += ms) >= 60_000 && w.stop()),
  });
  await w.done;
  expect(foreign).toEqual(["w1:p5"]);
});

test("a worker Herdr lists idle at a dialog chopped beyond reading (4-column pane) fails the row after the grace", async () => {
  let t = 0;
  const foreign: string[] = [];
  let w!: ReturnType<typeof watchTrustDialogs>;
  const herdr = {
    agents: async () => [{ pane_id: "w1:p8", agent: "claude", agent_status: "idle" }],
    run: async () => ({ exitCode: 0, stdout: P8_DIALOG, stderr: "" }),
  } as unknown as Parameters<typeof watchTrustDialogs>[0];
  w = watchTrustDialogs(herdr, () => "main", () => {}, (pane) => void foreign.push(pane), {
    now: () => t,
    sleep: async (ms) => void ((t += ms) >= 60_000 && w.stop()),
  });
  await w.done;
  expect(foreign).toEqual(["w1:p8"]);
});

test("say never types into a pane that may show a trust dialog: it waits for it to go, and gives up with the screen", async () => {
  const fakeHerdr = (screens: string[]) => {
    const typed: string[] = [];
    const herdr = {
      run: async () => ({ exitCode: 0, stdout: screens.length > 1 ? screens.shift()! : screens[0]!, stderr: "" }),
      ok: async (args: string[]) => void typed.push(args.join(" ")),
    } as unknown as Herdr;
    return { herdr, typed };
  };
  let t = 0;
  const clock = { now: () => t, sleep: async (ms: number) => void (t += ms), waitMs: 5_000 };
  const gone = fakeHerdr([P8_DIALOG, P8_DIALOG, "Welcome to Claude Code\n❯ "]);
  await say(gone.herdr, "w1:p3", "go on", clock);
  expect(gone.typed).toEqual(["agent prompt w1:p3 go on"]);
  t = 0;
  const stuck = fakeHerdr([P8_DIALOG]);
  await expect(say(stuck.herdr, "w1:p3", "go on", clock)).rejects.toThrow("not typing into pane w1:p3: it still shows a trust dialog after 5s");
  expect(stuck.typed).toEqual([]);
});
