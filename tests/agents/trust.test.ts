import { expect, test } from "bun:test";
import { CLAUDE_TRUST_PROMPT, answerTrustDialog, isTrustDialog, trustChoiceSelected, trustDialogLive, trustDialogMaybe } from "../../src/agents/trust.ts";
import { P8_DIALOG, P8_EXITED, P8_FOOTER, P8_SHELL } from "../fixtures/trust-screens.ts";

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
  // No marker at all, or no "Yes" option after the "No" one: never confirmed.
  expect(trustChoiceSelected("No, exit\nYes, I trust this folder", CLAUDE_TRUST_PROMPT)).toBe(false);
  expect(trustChoiceSelected(" ❯ Yes, I trust this folder\n   No, exit", CLAUDE_TRUST_PROMPT)).toBe(false);
});

// heavy rerun 3, main's pane: the shell prompt (starship's `❯`) with the command that started agt stays above the
// inline dialog, and a shell prompt may follow it once Claude exits.
const SHELL = "❯ cd '/tmp/agt-e2e-repo' && env XDG_CONFIG_HOME='/tmp/xdg' bun agt start\nmain manager session 18b9e136";

test("a shell prompt drawn with the same marker above or below the dialog is not an option: only the dialog's lines count", () => {
  for (const [screen, yes] of [
    [`${SHELL}\n${dialog(false)}`, false],
    [`${SHELL}\n${dialog(true)}`, true],
    [`${dialog(false)}\n\nfys2sqmn6pd9/T/agt-e2e-repo\n❯ `, false],
    [`${dialog(true)}\n\nfys2sqmn6pd9/T/agt-e2e-repo\n❯ `, true],
    [`${SHELL}\n${dialog(true)}\n❯ `, true],
  ] as const) {
    expect(trustChoiceSelected(screen, CLAUDE_TRUST_PROMPT)).toBe(yes);
  }
});

test("'Yes' must be seen selected on two reads in a row: a single flicker of it is not confirmed", async () => {
  // Reads after each key: Yes (a redraw midway), then No again, then Yes for good.
  const reads = [dialog(true), dialog(false), dialog(true), dialog(true)];
  const keys: string[] = [];
  const io = { read: async () => reads.shift() ?? dialog(true), send: async (k: string) => void keys.push(k), sleep: async () => {} };
  expect((await answerTrustDialog(io, CLAUDE_TRUST_PROMPT, `${SHELL}\n${dialog(false)}`)).answered).toBe(true);
  // down → Yes (1st), re-read → No: down again → Yes (1st), re-read → Yes (2nd): enter.
  expect(keys).toEqual(["down", "down", "enter"]);
});

/** A dialog whose cursor ignores the first `deaf` moves, then moves to Yes (or never, `stuck`). */
function fake(o: { deaf?: number; stuck?: boolean; yes?: boolean }) {
  let deaf = o.deaf ?? 0;
  let yes = o.yes ?? false;
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
  const f = fake({ yes: true });
  expect((await answerTrustDialog(f.io, CLAUDE_TRUST_PROMPT, dialog(true))).answered).toBe(true);
  expect(f.keys).toEqual(["enter"]);
  const g = fake({});
  expect((await answerTrustDialog(g.io, CLAUDE_TRUST_PROMPT, "Welcome to Claude Code\n❯ ")).answered).toBe(false);
  expect(g.keys).toEqual([]);
});

// ---------- Plan 13 Task 8: the dialog in a pane narrower than its lines ----------

/** Pane w1:p5 of heavy rerun 4 (ws-cleanup), about 27 columns: the footer is wrapped. */
const narrow = (yes: boolean) =>
  [
    " Quick safety check: Is",
    " this a project you",
    " created or one you trust?",
    "",
    " Claude Code'll be able to",
    " read, edit, and execute",
    " files here.",
    "",
    " Security guide",
    "",
    ` ${yes ? " " : "❯"} No, exit`,
    ` ${yes ? "❯" : " "} Yes, I trust this folder`,
    "",
    " Enter to confirm · Esc to",
    " cancel",
  ].join("\n");

/** Pane w1:p6, about 13 columns: the trusting option itself is wrapped over four lines. */
const narrower = (yes: boolean) =>
  [
    " Claude",
    " Code'll be",
    " able to",
    " read,",
    " edit, and",
    " execute",
    " files",
    " here.",
    "",
    " Security",
    " guide",
    "",
    ` ${yes ? " " : "❯"} No, exit`,
    ` ${yes ? "❯" : " "} Yes, I`,
    "   trust",
    "   this",
    "   folder",
    " Enter to",
    " confirm ·",
    " Esc to",
    " cancel",
  ].join("\n");

test("a dialog wrapped by a narrow pane is still the dialog, and its selected option is still read", () => {
  for (const draw of [narrow, narrower]) {
    expect(isTrustDialog(draw(false), CLAUDE_TRUST_PROMPT)).toBe(true);
    expect(trustChoiceSelected(draw(false), CLAUDE_TRUST_PROMPT)).toBe(false);
    expect(trustChoiceSelected(draw(true), CLAUDE_TRUST_PROMPT)).toBe(true);
  }
});

test("the dialog is live only while its footer is the last thing on screen: an exited Claude's leftover dialog is not", () => {
  for (const draw of [dialog, narrow, narrower]) {
    expect(trustDialogLive(`${draw(false)}\n\n`, CLAUDE_TRUST_PROMPT)).toBe(true);
    // heavy rerun 4: Claude exited on "No, exit"; its dialog stays above the shell's prompt.
    expect(trustDialogLive(`${draw(false)}\n\nweb on  wip/add-slugify-to\nvia  v24.19.0 took 5s\n❯`, CLAUDE_TRUST_PROMPT)).toBe(false);
  }
  expect(trustDialogLive("Welcome to Claude Code\n❯ ", CLAUDE_TRUST_PROMPT)).toBe(false);
  // The footer alone (another form) is not the trust dialog.
  expect(trustDialogLive("Allow this tool?\n❯ Yes\n  No\n\n Enter to confirm · Esc to cancel", CLAUDE_TRUST_PROMPT)).toBe(false);
});

test("a wrapped dialog is answered as a whole one is: down until 'Yes' shows selected, then enter", async () => {
  let yes = false;
  const keys: string[] = [];
  const io = { read: async () => narrower(yes), send: async (k: string) => void (keys.push(k), k === "down" && (yes = true)), sleep: async () => {} };
  expect((await answerTrustDialog(io, CLAUDE_TRUST_PROMPT, narrower(false))).answered).toBe(true);
  expect(keys).toEqual(["down", "enter"]);
});

// ---------- Plan 13 Task 8 fix round 1: a dialog chopped beyond reading (panes about 4 columns wide) ----------

test("a dialog chopped mid-word by a 4-column pane is not read whole, but its fragments say it may be there", () => {
  for (const screen of [P8_DIALOG, P8_EXITED]) {
    expect(isTrustDialog(screen, CLAUDE_TRUST_PROMPT)).toBe(false);
    expect(trustDialogLive(screen, CLAUDE_TRUST_PROMPT)).toBe(false); // never answered from fragments
    expect(trustChoiceSelected(screen, CLAUDE_TRUST_PROMPT)).toBe(false);
    expect(trustDialogMaybe(screen, CLAUDE_TRUST_PROMPT)).toBe(true);
  }
  // Every dialog read whole is a possible one too, also a dead one above a shell prompt.
  for (const draw of [dialog, narrow, narrower]) {
    expect(trustDialogMaybe(draw(false), CLAUDE_TRUST_PROMPT)).toBe(true);
    expect(trustDialogMaybe(`${draw(false)}\n\n❯ `, CLAUDE_TRUST_PROMPT)).toBe(true);
  }
  expect(trustDialogMaybe("Welcome to Claude Code\n\n❯ ", CLAUDE_TRUST_PROMPT)).toBe(false);
  expect(trustDialogMaybe("Allow this tool?\n❯ Yes\n  No\n\n Enter to confirm · Esc to cancel", CLAUDE_TRUST_PROMPT)).toBe(false);
});

test("the report's 40 lines of p8 alone hold none of the dialog's fragments: the footer is chopped past them", () => {
  // The lines above (the options) were cut off by the report, so the check cannot be shown on this dump alone.
  expect(trustDialogMaybe([...P8_FOOTER, ...P8_SHELL].join("\n"), CLAUDE_TRUST_PROMPT)).toBe(false);
});
