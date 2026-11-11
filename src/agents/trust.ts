/**
 * Answering an agent's one-time folder-trust dialog on screen, as the user would: pure helpers shared by agt's spawn
 * job (src/agents/spawn-job.ts) and the release e2e harness (tests/release/harness.ts).
 */

/** A select dialog that trusts the folder when `choice` is the selected option and `confirm` is pressed. */
export interface TrustPrompt {
  /** Every pattern matches the visible dialog: its question and its options, so a mere mention of trust is not taken for it. */
  screen: RegExp[];
  /** The selected option's line is the one with this marker. */
  marker: string;
  /** The option that trusts the folder. */
  choice: RegExp;
  /** The option that refuses it; the dialog's options start at its last line on screen. */
  refuse: RegExp;
  /** The dialog's last words, at the end of the screen while it waits for input (whitespace collapsed). */
  footer: RegExp;
  /** Moves the selection to the next option. */
  move: string;
  /** Picks the selected option. */
  confirm: string;
}

/** Claude Code's dialog: the cursor (`❯`) starts on "No, exit"; "Yes, I trust this folder" is the next option. */
export const CLAUDE_TRUST_PROMPT: TrustPrompt = {
  screen: [/trust this folder|Do you trust the files/i, /No, exit/i],
  marker: "❯",
  choice: /Yes, I trust this folder/i,
  refuse: /No, exit/i,
  footer: /Enter to confirm\W+Esc to cancel$/i,
  move: "down",
  confirm: "enter",
};

/** How many times the selection is moved before the answer gives up and leaves the dialog to the user. */
export const TRUST_TRIES = 5;
/** Between a key and the next read, so the dialog has redrawn its cursor. */
export const TRUST_KEY_GAP_MS = 300;

/** A screen's text with its line breaks and runs of spaces as single spaces: a narrow pane wraps the dialog's lines. */
const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** Whether `screen` shows the whole dialog, its question and its options, also when a narrow pane wrapped them. */
export const isTrustDialog = (screen: string, prompt: TrustPrompt): boolean => {
  const text = collapse(screen);
  return prompt.screen.every((re) => re.test(text));
};

/**
 * Whether the dialog is waiting on `screen`: shown whole, with its footer the last thing drawn. Herdr may list such an
 * agent idle (heavy rerun 4: in a pane narrower than the footer, "Esc to cancel" wraps and Herdr's blocked rule, a plain
 * substring test, misses it), so whatever types into a pane checks this first: a prompt's Enter would pick the
 * selected option, "No, exit". A dialog left above a shell prompt by an agent that has exited is not waiting.
 */
export const trustDialogLive = (screen: string, prompt: TrustPrompt): boolean => isTrustDialog(screen, prompt) && prompt.footer.test(collapse(screen));

/** `re` with its spaces removed, for a screen with all its whitespace removed. */
const squeezed = (re: RegExp) => new RegExp(re.source.replace(/\s+/g, ""), re.flags.replace("g", ""));

/**
 * Whether the dialog may be on `screen`, however it is drawn: the screen with all its whitespace removed holds a
 * fragment of the dialog (its question or an option) with its spaces removed. In a pane only a few columns wide the
 * dialog's words are chopped across lines ("No," / "exit"), and neither isTrustDialog nor trustDialogLive can read it.
 * Conservative: what types into a pane (a bootstrap, a notice, the e2e harness) holds while this is true and the agent
 * is not known to be past the dialog; answering still needs the dialog read whole (trustDialogLive, trustChoiceSelected).
 * A dialog left above a shell prompt by an agent that exited counts here too.
 */
export const trustDialogMaybe = (screen: string, prompt: TrustPrompt): boolean => {
  const text = screen.replace(/\s+/g, "");
  return [prompt.refuse, prompt.choice, ...prompt.screen].some((re) => squeezed(re).test(text));
};

/**
 * Whether the dialog on `screen` has the trusting option selected. Only the dialog's own option lines are judged: the
 * last `refuse` line on screen and the first `choice` line after it. The trusting line must carry the marker and the
 * refusing one must not. Other marked lines (a shell prompt drawn with the same glyph, above an inline dialog with the
 * command that started it, or below it) are not options and never count.
 */
export function trustChoiceSelected(screen: string, prompt: TrustPrompt): boolean {
  const lines = screen.split("\n");
  const no = lines.findLastIndex((line) => prompt.refuse.test(line));
  if (no < 0) return false;
  const marked = (line: string) => line.trimStart().startsWith(prompt.marker);
  let yes = lines.findIndex((line, i) => i > no && prompt.choice.test(line));
  // A pane narrower than the option wraps it: the option is the next line with its unmarked continuations, up to a
  // blank line, read as one.
  if (yes < 0) {
    const first = lines.findIndex((line, i) => i > no && line.trim() !== "");
    if (first < 0) return false;
    let end = first + 1;
    while (end < lines.length && lines[end]!.trim() !== "" && !marked(lines[end]!)) end++;
    if (!prompt.choice.test(collapse(lines.slice(first, end).join(" ")))) return false;
    yes = first;
  }
  return marked(lines[yes]!) && !marked(lines[no]!);
}

/**
 * Answers the trust dialog on `screen` with confirmation: `confirm` is sent only once two reads in a row show the
 * trusting option selected (one read may catch a redraw midway); until then `move` is sent and the screen read again,
 * at most `tries` moves. A blind `move` can land before the dialog takes input, so the cursor is checked, never
 * assumed. Gives up, sending nothing more, when the moves run out or the dialog is gone; `screen` is the last one read.
 */
export async function answerTrustDialog(
  io: { read(): Promise<string>; send(key: string): Promise<void>; sleep(ms: number): Promise<void> },
  prompt: TrustPrompt,
  screen: string,
  o: { tries?: number; gapMs?: number } = {},
): Promise<{ answered: boolean; screen: string }> {
  const tries = o.tries ?? TRUST_TRIES;
  const gapMs = o.gapMs ?? TRUST_KEY_GAP_MS;
  let moves = 0;
  let seen = 0; // consecutive reads with the trusting option selected
  for (;;) {
    if (!isTrustDialog(screen, prompt)) return { answered: false, screen };
    if (trustChoiceSelected(screen, prompt)) {
      if (++seen >= 2) {
        await io.send(prompt.confirm);
        return { answered: true, screen };
      }
    } else {
      seen = 0;
      if (moves === tries) return { answered: false, screen };
      await io.send(prompt.move);
      moves++;
    }
    await io.sleep(gapMs);
    screen = await io.read();
  }
}
