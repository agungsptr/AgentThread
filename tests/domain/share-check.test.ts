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

test("the root written from the home directory (~/...) is a hit", () => {
  const h = { root: "/Users/me/work/acme", thread: "004", banned: [], home: "/Users/me" };
  expect(shareCheckHits("see ~/work/acme/src/a.ts", h)).toEqual([{ line: 1, match: "~/work/acme" }]);
  expect(shareCheckHits("see ~/other/a.ts", h)).toEqual([]);
});

test("thread and ticket ids are hits whatever the spacing, a # or a colon", () => {
  expect(shareCheckHits("Thread #004, thread  004, Ticket: T4, ticket #T5", o).map((h) => h.match)).toEqual(["Thread #004", "thread  004", "Ticket: T4", "ticket #T5"]);
});

test("the root's other spellings (its realpath) are hits too", () => {
  const h = { root: "/tmp/ws", thread: "004", banned: [], rootAliases: ["/private/tmp/ws"] };
  expect(shareCheckHits("at /private/tmp/ws/api", h).map((x) => x.match)).toEqual(["/private/tmp/ws"]);
});

test("a short root matches only as a whole path, not inside a URL or a longer name", () => {
  const h = { root: "/app", thread: "004", banned: [] };
  expect(shareCheckHits("see https://www.app.io/apple and /apple/x", h)).toEqual([]);
  expect(shareCheckHits("see /app/src/a.ts and /app.", h).map((x) => x.match)).toEqual(["/app", "/app"]);
});
