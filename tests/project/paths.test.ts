import { expect, test } from "bun:test";
import { paths } from "../../src/project/paths.ts";

test("layout under .agentthread", () => {
  const p = paths("/repo");
  expect(p.db).toBe("/repo/.agentthread/state.db");
  expect(p.mainThread).toBe("/repo/.agentthread/main.thread.md");
  expect(p.threadDir({ id: "002", slug: "fix-race" })).toBe("/repo/.agentthread/threads/002-fix-race");
});

test("socket path stays short for deep project roots", () => {
  const deep = `/Users/someone/${"very-long-directory-name/".repeat(8)}project`;
  expect(Buffer.byteLength(paths(deep).socket)).toBeLessThan(104);
});

test("socket path is stable per root and distinct across roots", () => {
  expect(paths("/a").socket).toBe(paths("/a").socket);
  expect(paths("/a").socket).not.toBe(paths("/b").socket);
});
