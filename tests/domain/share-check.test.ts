import { expect, test } from "bun:test";
import { formatHits, shareCheckHits } from "../../src/domain/share-check.ts";

const o = { root: "/work/acme", thread: "004", banned: ["claude", "ai"] };

test("clean text has no hits", () => {
  expect(shareCheckHits("# Review\nAll good in src/a.ts:12.\n", o)).toEqual([]);
});

test("each private mention is a hit with its line", () => {
  const text = ["See .docs/shared/notes.md", "path /work/acme/.worktrees/x", "as thread 004 found", "in 004/T2 and ticket T3", "made by Claude"].join("\n");
  expect(shareCheckHits(text, o).map((h) => `${h.line}:${h.match.toLowerCase()}`)).toEqual([
    "1:.docs",
    "2:/work/acme",
    "2:.worktrees",
    "3:thread 004",
    "4:004/t2",
    "4:ticket t3",
    "5:claude",
  ]);
});

test("banned words match whole words only", () => {
  expect(shareCheckHits("We maintain it.", o)).toEqual([]);
  expect(shareCheckHits("Built with AI help.", o)).toEqual([{ line: 1, match: "AI" }]);
});

test(".agentthread is a hit", () => {
  expect(shareCheckHits("cfg in .agentthread/config.yaml", o)[0]!.match).toBe(".agentthread");
});

test("another thread's id or a bare number is not a hit", () => {
  expect(shareCheckHits("thread 005 and 004 items, T3 alone", o)).toEqual([]);
});

test("formatHits names the path and each hit", () => {
  expect(formatHits(".docs/r.md", [{ line: 3, match: ".docs" }, { line: 9, match: "thread 004" }])).toBe(
    'report .docs/r.md mentions private things: line 3 ".docs", line 9 "thread 004"',
  );
});
