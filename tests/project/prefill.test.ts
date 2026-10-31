import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prefill, stackPrefill } from "../../src/project/prefill.ts";

const dir = (files: Record<string, string>): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "agt-prefill-")));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(d, f, ".."), { recursive: true });
    writeFileSync(join(d, f), c);
  }
  return d;
};

test("bun lock with test and typecheck scripts", () => {
  const d = dir({ "package.json": JSON.stringify({ scripts: { test: "x", typecheck: "y", "test:e2e": "z" } }), "bun.lock": "" });
  expect(prefill(d)).toEqual({ unit: "bun run test", typecheck: "bun run typecheck", e2e: "bun run test:e2e", makeTargets: [] });
});

test("npm with only test; tsc script is the typecheck fallback; pnpm and yarn locks", () => {
  expect(prefill(dir({ "package.json": JSON.stringify({ scripts: { test: "x" } }) }))).toEqual({ unit: "npm run test", makeTargets: [] });
  expect(prefill(dir({ "package.json": JSON.stringify({ scripts: { tsc: "x", e2e: "y" } }), "pnpm-lock.yaml": "" }))).toEqual({
    typecheck: "pnpm run tsc",
    e2e: "pnpm run e2e",
    makeTargets: [],
  });
  expect(prefill(dir({ "package.json": JSON.stringify({ scripts: { test: "x" } }), "yarn.lock": "" })).unit).toBe("yarn run test");
});

test("gradle", () => {
  expect(prefill(dir({ "build.gradle.kts": "" }))).toEqual({ unit: "./gradlew test", makeTargets: [] });
});

test("makefile targets skip .PHONY, dot-targets and := assignments", () => {
  const d = dir({ Makefile: ".PHONY: wt-new restart\nCC := gcc\nVAR:=1\nwt-new:\n\techo\nrestart: wt-new\n\techo\n.hidden:\nrestart:\n" });
  expect(prefill(d).makeTargets).toEqual(["wt-new", "restart"]);
});

test("nothing to read, or a broken package.json, suggests nothing", () => {
  expect(prefill(dir({}))).toEqual({ makeTargets: [] });
  expect(prefill(dir({ "package.json": "{nope" }))).toEqual({ makeTargets: [] });
});

test("stackPrefill picks the first restart and status target", () => {
  expect(stackPrefill(["up", "restart", "ps", "status"])).toEqual({ restart: "make restart TASK={task}", status: "make status" });
  expect(stackPrefill(["up", "ps"])).toEqual({ restart: "make up TASK={task}", status: "make ps" });
  expect(stackPrefill(["build"])).toEqual({});
});
