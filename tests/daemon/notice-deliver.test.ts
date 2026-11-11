import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { createEffectRunner, type EffectBridge } from "../../src/daemon/effects.ts";
import type { EventBody } from "../../src/domain/types.ts";
import { P8_DIALOG } from "../fixtures/trust-screens.ts";

const LAYOUT = { workspace: "w", mainTab: "t", managerPane: "p0", loggerPane: "p1", herdrBin: "/nonexistent/herdr" };
const DELIVER = { kind: "notice.deliver", session: "s-1", thread: "001", agent: "claude-code", pane: "w1:p5", text: "Start ticket T2 now.", count: 1 } as const;
const HELD = (reason: string): EventBody[] => [{ type: "notice.held", thread: "001", payload: { session: "s-1", reason } }];
const DIALOG = "pane w1:p5 shows a trust dialog";

/** A fake Herdr whose pane w1:p5 shows `screen`; `agentPrompt` records what it would type (the text, then Enter). */
function runner(screen: string | (() => Promise<string>), noticeReadMs?: number, typeFails = false) {
  const prompts: string[] = [];
  const logs: string[] = [];
  const bridge = {
    agentPrompt: (pane: string, text: string) => {
      if (typeFails) throw new Error("herdr agent prompt: pane busy");
      prompts.push(`${pane} ${text}`);
    },
    paneRead: typeof screen === "string" ? async () => screen : screen,
  } as unknown as EffectBridge;
  const run = createEffectRunner({ root: "/repo", config: DEFAULT_CONFIG, layout: () => LAYOUT, thread: () => undefined, bridge: () => bridge, log: (m) => void logs.push(m), ...(noticeReadMs !== undefined ? { noticeReadMs } : {}) });
  return { run, prompts, logs };
}

// Heavy rerun 4's pane w1:p5: Herdr listed this agent idle (the wrapped footer hid the dialog from it).
const NARROW_DIALOG = " ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to\n cancel";

test("a notice is not typed into a pane showing the trust dialog: its Enter would pick 'No, exit'; it stays queued", async () => {
  const r = runner(NARROW_DIALOG);
  expect(await r.run(DELIVER)).toEqual(HELD(DIALOG));
  expect(r.prompts).toEqual([]);
  expect(r.logs).toEqual(["notice delivery to session s-1 held: pane w1:p5 shows a trust dialog; agt retries it shortly"]);
});

test("a pane without the dialog, or one whose screen cannot be read, gets the notice as before", async () => {
  for (const screen of ["Welcome to Claude Code\n❯ ", async () => Promise.reject(new Error("pane busy"))]) {
    const r = runner(screen);
    expect(await r.run(DELIVER)).toEqual([{ type: "notice.delivered", thread: "001", payload: { session: "s-1", count: 1 } }]);
    expect(r.prompts).toEqual(["w1:p5 Start ticket T2 now."]);
  }
});

// ---------- fix round 1 ----------

test("a dialog chopped beyond reading holds the notice while only Herdr's poll says the agent started; once confirmed it goes", async () => {
  const unconfirmed = runner(P8_DIALOG);
  expect(await unconfirmed.run({ ...DELIVER, unconfirmed: true })).toEqual(HELD(DIALOG));
  expect(unconfirmed.prompts).toEqual([]);
  expect(unconfirmed.logs).toEqual(["notice delivery to session s-1 held: pane w1:p5 shows a trust dialog; agt retries it shortly"]);
  // The agent's own hook (or a finished turn) says it started: fragments left on its screen are not a dialog it waits at.
  const confirmed = runner(P8_DIALOG);
  expect(await confirmed.run(DELIVER)).toEqual([{ type: "notice.delivered", thread: "001", payload: { session: "s-1", count: 1 } }]);
});

test("a screen not read within the time limit holds the notice for the next trigger", async () => {
  const r = runner(() => new Promise<string>(() => {}), 20);
  expect(await r.run(DELIVER)).toEqual(HELD("pane w1:p5's screen was not read within 20ms"));
  expect(r.prompts).toEqual([]);
  expect(r.logs).toEqual(["notice delivery to session s-1 held: pane w1:p5's screen was not read within 20ms; agt retries it shortly"]);
});

// ---------- final review 2 ----------

test("a delivery Herdr fails is recorded as held too, so the sweep retries it", async () => {
  const r = runner("Welcome to Claude Code\n❯ ", undefined, true);
  expect(await r.run(DELIVER)).toEqual(HELD("delivery failed: herdr agent prompt: pane busy"));
});

test("only the session's own agent's trust dialog holds a notice: an agent without one is typed into without a read", async () => {
  let reads = 0;
  const r = runner(async () => {
    reads++;
    return NARROW_DIALOG;
  });
  expect(await r.run({ ...DELIVER, agent: "opencode", unconfirmed: true })).toEqual([{ type: "notice.delivered", thread: "001", payload: { session: "s-1", count: 1 } }]);
  expect(reads).toBe(0);
  expect(r.prompts).toEqual(["w1:p5 Start ticket T2 now."]);
  // a Claude Code session in the same state is held
  expect(await r.run({ ...DELIVER, unconfirmed: true })).toEqual(HELD(DIALOG));
});
