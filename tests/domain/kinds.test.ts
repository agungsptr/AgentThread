import { expect, test } from "bun:test";
import { isDocType, stageNames, THREAD_TYPES, type ThreadType, workflowKind } from "../../src/domain/types.ts";

test("review and report are doc threads; the rest and undefined are code", () => {
  expect(THREAD_TYPES).toEqual(["feature", "bug", "chore", "review", "report"]);
  expect((["review", "report"] as ThreadType[]).map((t) => workflowKind(t))).toEqual(["doc", "doc"]);
  expect((["feature", "bug", "chore", undefined] as (ThreadType | undefined)[]).map((t) => workflowKind(t))).toEqual(["code", "code", "code", "code"]);
  expect(isDocType("review")).toBe(true);
  expect(isDocType(undefined)).toBe(false);
});

test("stageNames follows the kind", () => {
  expect(stageNames("report")).toEqual(["scope", "investigation", "draft", "approval"]);
  expect(stageNames("bug")).toHaveLength(10);
  expect(stageNames(undefined)[9]).toBe("release and squash");
});
