import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCommand, prefill, stackPrefill } from "../../src/project/prefill.ts";

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

test("installCommand follows the lockfile and honours overrides", () => {
  const d = mkdtempSync(join(tmpdir(), "inst-"));
  expect(installCommand(d)).toBeNull();
  writeFileSync(join(d, "package.json"), "{}");
  expect(installCommand(d)).toBeNull();
  writeFileSync(join(d, "package.json"), JSON.stringify({ dependencies: {}, devDependencies: {} }));
  expect(installCommand(d)).toBeNull();
  writeFileSync(join(d, "package.json"), JSON.stringify({ devDependencies: { x: "1" } }));
  expect(installCommand(d)).toBe("npm install");
  writeFileSync(join(d, "package-lock.json"), "{}");
  expect(installCommand(d)).toBe("npm ci");
  rmSync(join(d, "package-lock.json"));
  writeFileSync(join(d, "npm-shrinkwrap.json"), "{}");
  expect(installCommand(d)).toBe("npm ci");
  writeFileSync(join(d, "pnpm-lock.yaml"), "");
  expect(installCommand(d)).toBe("pnpm install --frozen-lockfile");
  writeFileSync(join(d, "yarn.lock"), "");
  expect(installCommand(d)).toBe("yarn install --frozen-lockfile");
  writeFileSync(join(d, "bun.lock"), "");
  expect(installCommand(d)).toBe("bun install");
  expect(installCommand(d, "")).toBeNull();
  expect(installCommand(d, "make deps")).toBe("make deps");
});
