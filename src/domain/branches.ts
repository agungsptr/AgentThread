import type { ThreadType } from "./types.ts";

/** The branch prefix a thread type squashes onto when the config does not say otherwise. */
export const DEFAULT_BRANCH_PREFIX: Record<ThreadType, string> = { feature: "feat", bug: "fix", chore: "chore" };

/** `workflow.branch_prefix`: an override per thread type. */
export type BranchPrefixes = Partial<Record<ThreadType, string>>;

/** The coordinator's squash branch of a task thread: `<prefix>/<task>`, the prefix following the thread type (feature by default). */
export function squashBranch(type: ThreadType | undefined, task: string, overrides?: BranchPrefixes): string {
  const t = type ?? "feature";
  return `${overrides?.[t] ?? DEFAULT_BRANCH_PREFIX[t]}/${task}`;
}
