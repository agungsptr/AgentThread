/**
 * The share check of a review or report thread's report: the file is shared with people outside the workspace, so it
 * must not point at anything private. A guard against slips, not a proof: the prompts still state the rule.
 */
export type ShareHit = { line: number; match: string };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Opts = {
  root: string;
  thread: string;
  banned: string[];
  /** The user's home: the root written as ~/… is a hit too. */
  home?: string;
  /** Other spellings of the root (its realpath, a symlinked path). */
  rootAliases?: string[];
};

/**
 * A path matched as a whole at its end (not `<root>-old`). A one-segment root (`/app`) is also matched as a whole at its
 * start, so it is not found inside a URL (`https://www.app.io/apple`); a longer one is found anywhere, also inside a
 * `file:///…` or editor link.
 */
const wholePath = (p: string) => {
  const path = p.replace(/\/+$/, "");
  const start = path.split("/").filter(Boolean).length <= 1 ? "(?<![\\w.~/-])" : "";
  return new RegExp(`${start}${escape(path)}(?=$|/|[^\\w.-]|\\.(?![\\w-]))`, "gi");
};

function patterns(o: Opts): RegExp[] {
  const id = escape(o.thread);
  const home = o.home?.replace(/\/+$/, "");
  const tilde = home && o.root.startsWith(`${home}/`) ? `~${o.root.slice(home.length)}` : undefined;
  const banned = o.banned.map((w) => w.trim()).filter((w) => w !== "");
  return [
    /\.docs\b/gi,
    /\.agentthread\b/gi,
    /\.worktrees\b/gi,
    ...[o.root, ...(o.rootAliases ?? [])].filter((r, i, all) => r && all.indexOf(r) === i).map(wholePath),
    ...(tilde ? [wholePath(tilde)] : []),
    new RegExp(`\\bthread\\s*[#:]?\\s*${id}\\b`, "gi"),
    new RegExp(`\\b${id}/T\\d+\\b`, "gi"),
    /\bticket\s*[#:]?\s*T\d+\b/gi,
    // Whole words, like the commit-msg hook's grep -w.
    ...banned.map((w) => new RegExp(`(?<![\\w])${escape(w)}(?![\\w])`, "gi")),
  ];
}

/** Every private mention in `text`, by 1-based line, in reading order. */
export function shareCheckHits(text: string, o: Opts): ShareHit[] {
  const res = patterns(o);
  const hits: ShareHit[] = [];
  text.split("\n").forEach((line, i) => {
    const found: { at: number; match: string }[] = [];
    for (const re of res) for (const m of line.matchAll(re)) found.push({ at: m.index ?? 0, match: m[0] });
    // One place is one hit: a match inside a longer one (the root inside its realpath) is left out.
    found.sort((a, b) => a.at - b.at || b.match.length - a.match.length);
    let end = -1;
    for (const f of found) {
      if (f.at + f.match.length <= end) continue;
      end = Math.max(end, f.at + f.match.length);
      hits.push({ line: i + 1, match: f.match });
    }
  });
  return hits;
}

export function formatHits(path: string, hits: ShareHit[]): string {
  return `report ${path} mentions private things: ${hits.map((h) => `line ${h.line} "${h.match}"`).join(", ")}`;
}
