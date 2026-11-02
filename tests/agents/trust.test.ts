import { expect, test } from "bun:test";
import { CLAUDE_TRUST_PROMPT, answerTrustDialog, trustChoiceSelected } from "../../src/agents/trust.ts";

// As Claude Code draws it (heavy rerun 3's pane screens); the `❯` marks the selected option.
const dialog = (yes: boolean) =>
  [
    " Quick safety check: Is this a project you created or one you trust?",
    "",
    ` ${yes ? " " : "❯"} No, exit`,
    ` ${yes ? "❯" : " "} Yes, I trust this folder`,
    "",
    " Enter to confirm · Esc to cancel",
  ].join("\n");

test("the selected line decides: only 'Yes, I trust this folder' under the marker is the trusting choice", () => {
  expect(trustChoiceSelected(dialog(false), CLAUDE_TRUST_PROMPT)).toBe(false);
  expect(trustChoiceSelected(dialog(true), CLAUDE_TRUST_PROMPT)).toBe(true);
  expect(trustChoiceSelected(" ❯ 1. No, exit\n   2. Yes, I trust this folder", CLAUDE_TRUST_PROMPT)).toBe(false);
  expect(trustChoiceSelected("   1. No, exit\n ❯ 2. Yes, I trust this folder", CLAUDE_TRUST_PROMPT)).toBe(true);
  // No marker at all, or a second marked line (a shell prompt drawn with the same glyph): never confirmed.
  expect(trustChoiceSelected("No, exit\nYes, I trust this folder", CLAUDE_TRUST_PROMPT)).toBe(false);
  expect(trustChoiceSelected(`${dialog(true)}\n❯ `, CLAUDE_TRUST_PROMPT)).toBe(false);
});

/** A dialog whose cursor ignores the first `deaf` moves, then moves to Yes (or never, `stuck`). */
function fake(o: { deaf?: number; stuck?: boolean }) {
  let deaf = o.deaf ?? 0;
  let yes = false;
  const keys: string[] = [];
  return {
    keys,
    io: {
      read: async () => dialog(yes),
      send: async (k: string) => {
        keys.push(k);
        if (k === "down" && !o.stuck && deaf-- <= 0) yes = true;
      },
      sleep: async () => {},
    },
  };
}

test("a move that lands before the dialog takes input is repeated; enter only once Yes is selected", async () => {
  const f = fake({ deaf: 2 });
  expect(await answerTrustDialog(f.io, CLAUDE_TRUST_PROMPT, dialog(false))).toEqual({ answered: true, screen: dialog(true) });
  expect(f.keys).toEqual(["down", "down", "down", "enter"]);
});

test("'No, exit' still selected after 5 moves: enter is never pressed and the last screen is returned", async () => {
  const f = fake({ stuck: true });
  expect(await answerTrustDialog(f.io, CLAUDE_TRUST_PROMPT, dialog(false))).toEqual({ answered: false, screen: dialog(false) });
  expect(f.keys).toEqual(["down", "down", "down", "down", "down"]);
});

test("Yes already selected is confirmed without a move; a dialog gone from the screen gets no keys", async () => {
  const f = fake({});
  expect((await answerTrustDialog(f.io, CLAUDE_TRUST_PROMPT, dialog(true))).answered).toBe(true);
  expect(f.keys).toEqual(["enter"]);
  const g = fake({});
  expect((await answerTrustDialog(g.io, CLAUDE_TRUST_PROMPT, "Welcome to Claude Code\n❯ ")).answered).toBe(false);
  expect(g.keys).toEqual([]);
});
