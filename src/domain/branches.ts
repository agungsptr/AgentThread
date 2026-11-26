import { type CodeThreadType, isDocType, type ThreadType } from "./types.ts";

/** The branch prefix a thread type squashes onto when the config does not say otherwise. */
export const DEFAULT_BRANCH_PREFIX: Record<CodeThreadType, string> = { feature: "feat", bug: "fix", chore: "chore" };

/** `workflow.branch_prefix`: an override per thread type. */
export type BranchPrefixes = Partial<Record<CodeThreadType, string>>;

/** The coordinator's squash branch of a task thread: `<prefix>/<task>`, the prefix following the thread type (feature by default). */
export function squashBranch(type: CodeThreadType | undefined, task: string, overrides?: BranchPrefixes): string {
  const t = type ?? "feature";
  return `${overrides?.[t] ?? DEFAULT_BRANCH_PREFIX[t]}/${task}`;
}

/** A thread type as a code type, for the squash branch; a doc type has none (undefined). */
export const asCodeType = (type: ThreadType | undefined): CodeThreadType | undefined => (isDocType(type) ? undefined : (type as CodeThreadType | undefined));
