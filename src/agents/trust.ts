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
  move: "down",
  confirm: "enter",
};

/** How many times the selection is moved before the answer gives up and leaves the dialog to the user. */
export const TRUST_TRIES = 5;
/** Between a key and the next read, so the dialog has redrawn its cursor. */
export const TRUST_KEY_GAP_MS = 300;

export const isTrustDialog = (screen: string, prompt: TrustPrompt): boolean => prompt.screen.every((re) => re.test(screen));

/**
 * Whether the dialog on `screen` has the trusting option selected: some marked line is that option and no other marked
 * line is something else (a shell prompt using the same marker, say), so `confirm` can never pick "No, exit".
 */
export function trustChoiceSelected(screen: string, prompt: TrustPrompt): boolean {
  const marked = screen
    .split("\n")
    .map((line) => line.trimStart())
    .filter((line) => line.startsWith(prompt.marker))
    .map((line) => line.slice(prompt.marker.length).trim());
  return marked.length > 0 && marked.every((line) => prompt.choice.test(line));
}

/**
 * Answers the trust dialog on `screen` with confirmation: `confirm` is sent only once a read shows the trusting option
 * selected; until then `move` is sent and the screen read again, at most `tries` times. A blind `move` can land before
 * the dialog takes input, so the cursor is checked, never assumed. Gives up, sending nothing more, when the tries run
 * out or the dialog is gone; `screen` is the last one read.
 */
export async function answerTrustDialog(
  io: { read(): Promise<string>; send(key: string): Promise<void>; sleep(ms: number): Promise<void> },
  prompt: TrustPrompt,
  screen: string,
  o: { tries?: number; gapMs?: number } = {},
): Promise<{ answered: boolean; screen: string }> {
  const tries = o.tries ?? TRUST_TRIES;
  for (let i = 0; ; i++) {
    if (!isTrustDialog(screen, prompt)) return { answered: false, screen };
    if (trustChoiceSelected(screen, prompt)) {
      await io.send(prompt.confirm);
      return { answered: true, screen };
    }
    if (i === tries) return { answered: false, screen };
    await io.send(prompt.move);
    await io.sleep(o.gapMs ?? TRUST_KEY_GAP_MS);
    screen = await io.read();
  }
}
