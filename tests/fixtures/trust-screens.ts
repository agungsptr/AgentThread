/**
 * Claude Code's trust dialog in heavy rerun 4's narrowest panes (ws-cleanup, panes w1:p7–p9, about 4 columns; report
 * .agentthread/e2e-reports/2026-11-02T12-54-03-463Z.json). The report keeps each pane's last 40 lines only.
 */

/** The dialog's chopped footer, as the report has it for p8 (p7 and p9 are the same). */
export const P8_FOOTER = [" tei", " r s", " to", " c f", " ono", " fil", " rmd", " · e", " E r", " sc", "", " to", "", " ca", " nc", " el"];

/** The shell prompt below it once Claude exited ("took 4s"), as the report has it for p8. */
export const P8_SHELL = ["", "web", "on ", " wip", "/add", "-slu", "gify", "-to-", "api-", "and-", "show", "-tit", "le-s", "lug-", "i vi", "a ", "v24.", "19.0", " too", "k 4s", "", "❯", ""];

/**
 * The options above the footer are not in the report. Constructed: a 4-column pane hard-wraps them mid-word, so no
 * line holds "No, exit" or "Yes, I trust this folder".
 */
export const CHOPPED_OPTIONS = ["", " ❯ N", "o, e", "xit", "  Ye", "s, I", " tru", "st t", "his ", "fold", "er", ""];

/** The dialog waiting in a p8-wide pane: the constructed options over the report's footer. */
export const P8_DIALOG = [...CHOPPED_OPTIONS, ...P8_FOOTER].join("\n");

/** The same after Claude exited on "No, exit": the report's shell prompt below. */
export const P8_EXITED = [...CHOPPED_OPTIONS, ...P8_FOOTER, ...P8_SHELL].join("\n");
