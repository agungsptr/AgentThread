import { describe, expect, test } from "bun:test";
import {
  canTransitionThread,
  canTransitionTicket,
  pathsOverlap,
  scopesOverlap,
  slugify,
  validateHandoff,
} from "../../src/domain/rules.ts";

describe("slugify", () => {
  test("lowercases and joins words with dashes", () => {
    expect(slugify("Fix race in Checkout!")).toBe("fix-race-in-checkout");
  });
  test("caps at 40 chars without a trailing dash", () => {
    const s = slugify(`${"a".repeat(39)} bbbb`);
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith("-")).toBe(false);
  });
  test("falls back to 'thread' when nothing is left", () => {
    expect(slugify("!!!")).toBe("thread");
  });
});

describe("scope overlap", () => {
  test("same path overlaps", () => expect(pathsOverlap("src/a.ts", "src/a.ts")).toBe(true));
  test("parent and child overlap", () => expect(pathsOverlap("src/checkout", "src/checkout/lock.ts")).toBe(true));
  test("sibling with shared prefix does not overlap", () => expect(pathsOverlap("src/a", "src/ab")).toBe(false));
  test("normalizes ./ and trailing slashes", () => expect(pathsOverlap("./src/", "src/x.ts")).toBe(true));
  test("'.' overlaps everything", () => expect(pathsOverlap(".", "docs/x.md")).toBe(true));
  test("lists overlap when any pair overlaps", () => {
    expect(scopesOverlap(["docs/"], ["src/a", "docs/readme.md"])).toBe(true);
    expect(scopesOverlap(["docs/"], ["src/a"])).toBe(false);
  });
});

describe("transitions", () => {
  test("thread", () => {
    expect(canTransitionThread("open", "in_progress")).toBe(true);
    expect(canTransitionThread("in_progress", "review")).toBe(true);
    expect(canTransitionThread("review", "in_progress")).toBe(true);
    expect(canTransitionThread("blocked", "open")).toBe(true);
    expect(canTransitionThread("open", "done")).toBe(false);
    expect(canTransitionThread("done", "open")).toBe(false);
  });
  test("ticket", () => {
    expect(canTransitionTicket("open", "in_progress")).toBe(true);
    expect(canTransitionTicket("in_progress", "blocked")).toBe(true);
    expect(canTransitionTicket("blocked", "open")).toBe(true);
    expect(canTransitionTicket("open", "done")).toBe(false);
    expect(canTransitionTicket("done", "open")).toBe(false);
  });
});

describe("validateHandoff", () => {
  const sections = (overrides: Record<string, string> = {}) =>
    ["Goal status", "Work done", "Decisions", "Next steps", "Risks"]
      .map((name) => `## ${name}\n${overrides[name] ?? `${name} text`}`)
      .join("\n");

  test("accepts a complete handoff", () => {
    expect(validateHandoff(sections())).toEqual({ ok: true });
  });
  test("reports a missing section", () => {
    const md = sections().replace(/## Risks\nRisks text/, "");
    expect(validateHandoff(md)).toEqual({ ok: false, missing: ["Risks"] });
  });
  test("treats an empty section as missing", () => {
    expect(validateHandoff(sections({ Decisions: "   " }))).toEqual({ ok: false, missing: ["Decisions"] });
  });
  test("matches headings case-insensitively", () => {
    expect(validateHandoff(sections().replace("## Work done", "## work DONE"))).toEqual({ ok: true });
  });
});
