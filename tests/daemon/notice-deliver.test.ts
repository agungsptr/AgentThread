import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { createEffectRunner, type EffectBridge } from "../../src/daemon/effects.ts";

const LAYOUT = { workspace: "w", mainTab: "t", managerPane: "p0", loggerPane: "p1", herdrBin: "/nonexistent/herdr" };
const DELIVER = { kind: "notice.deliver", session: "s-1", thread: "001", pane: "w1:p5", text: "Start ticket T2 now.", count: 1 } as const;

/** A fake Herdr whose pane w1:p5 shows `screen`; `agentPrompt` records what it would type (the text, then Enter). */
function runner(screen: string | (() => Promise<string>)) {
  const prompts: string[] = [];
  const logs: string[] = [];
  const bridge = {
    agentPrompt: (pane: string, text: string) => void prompts.push(`${pane} ${text}`),
    paneRead: typeof screen === "string" ? async () => screen : screen,
  } as unknown as EffectBridge;
  const run = createEffectRunner({ root: "/repo", config: DEFAULT_CONFIG, layout: () => LAYOUT, thread: () => undefined, bridge: () => bridge, log: (m) => void logs.push(m) });
  return { run, prompts, logs };
}

// Heavy rerun 4's pane w1:p5: Herdr listed this agent idle (the wrapped footer hid the dialog from it).
const NARROW_DIALOG = " ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to\n cancel";

test("a notice is not typed into a pane showing the trust dialog: its Enter would pick 'No, exit'; it stays queued", async () => {
  const r = runner(NARROW_DIALOG);
  expect(await r.run(DELIVER)).toEqual([]);
  expect(r.prompts).toEqual([]);
  expect(r.logs).toEqual(["notice delivery to session s-1 held: pane w1:p5 shows a trust dialog; it goes at the agent's next idle"]);
});

test("a pane without the dialog, or one whose screen cannot be read, gets the notice as before", async () => {
  for (const screen of ["Welcome to Claude Code\n❯ ", async () => Promise.reject(new Error("pane busy"))]) {
    const r = runner(screen);
    expect(await r.run(DELIVER)).toEqual([{ type: "notice.delivered", thread: "001", payload: { session: "s-1", count: 1 } }]);
    expect(r.prompts).toEqual(["w1:p5 Start ticket T2 now."]);
  }
});
