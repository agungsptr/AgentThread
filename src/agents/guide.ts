import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Config } from "../config/config.ts";
import type { SessionRole } from "../domain/types.ts";
import { usageLines } from "../cli/usage.ts";
import { paths } from "../project/paths.ts";
import { rulesOf } from "./agents-md.ts";
import { systemPrompt, type PromptThread } from "./prompts.ts";

type ThreadRef = PromptThread;

interface GuideInput {
  role: SessionRole | "all";
  root: string;
  config: Config;
  thread?: ThreadRef;
  /** The current thread ($AGT_THREAD) is a legacy one: the rules name its worktree, not a thread directory. */
  legacy?: boolean;
}

const PLACEHOLDER: ThreadRef = { id: "<thread>", title: "<title>", slug: "<slug>", dir: "<root>/.worktrees/<task>", task: "<task>" };
const LEGACY_PLACEHOLDER: ThreadRef = { id: "<thread>", title: "<title>", slug: "<slug>", worktree: "<worktree>" };

/**
 * True when thread `id` of the project at `root` is a legacy thread (its sub.thread.md names a worktree and no
 * thread directory). Synchronous: CLI paths only. False when it cannot tell.
 */
export function isLegacyThread(root: string, id: string): boolean {
  try {
    const name = readdirSync(paths(root).threadsDir).find((n) => n.startsWith(`${id}-`));
    if (!name) return false;
    const fm = readFileSync(join(paths(root).threadsDir, name, "sub.thread.md"), "utf8").split("---\n")[1] ?? "";
    const data = (parse(fm) ?? {}) as Record<string, unknown>;
    return data.worktree !== undefined && data.dir === undefined;
  } catch {
    return false;
  }
}

/** The USAGE commands each role runs, by their leading words. */
const COMMANDS: Record<SessionRole, string[]> = {
  main: ["thread new", "thread choose", "thread cancel", "tell"],
  coordinator: ["thread status", "ticket add", "ticket claim|reopen", "ticket accept", "ticket return", "worker spawn", "worktree add", "decide", "note", "progress", "question", "answer", "handoff", "tell"],
  worker: ["ticket claim|reopen", "ticket done", "ticket block", "note", "progress", "question"],
};

/** Task threads only: the stage, stack-lock and waiting commands their coordinator runs (§13). */
const COMMANDS_TASK: Partial<Record<SessionRole, string[]>> = {
  coordinator: ["stage", "stack acquire", "stack release", "thread waiting"],
};

/** Where a role's command line differs from the shared USAGE line, keyed by the prefix in COMMANDS. */
const COMMAND_OVERRIDES: Partial<Record<SessionRole, Record<string, string>>> = {
  worker: { "ticket claim|reopen": "ticket claim <thread>/<ticket>" },
};

const NEVER_LEGACY = "- Never push; never commit as a worker; never bypass the commit guard.";

const WRONG: Record<SessionRole, string[]> = {
  main: [
    "- A thread waits for the user's tier choice: relay the choice with `agt thread choose`, or stop it with `agt thread cancel`.",
    "- A notification arrives from a thread: relay it to the user; use `agt tell` to pass their answer on to the coordinator.",
  ],
  coordinator: [
    "- A HANDOFF REQUEST arrives: write the handoff with `agt handoff <thread> --stdin`, using the sections it names, then stop.",
    "- A CHECKPOINT reminder arrives: run `agt progress <thread> \"<where I am>\"`.",
    "- A worker asks a question: answer it with `agt answer <thread> <Q> \"<answer>\"`.",
    "- A worker is blocked: read the reason, then check the cause or replace the worker (`agt ticket reopen`, then `agt worker spawn`).",
    "- A ticket is left `in_progress` with no worker: reopen it with `agt ticket reopen <thread>/<ticket>` and spawn a worker for it.",
    NEVER_LEGACY,
  ],
  worker: [
    "- A CHECKPOINT reminder arrives: run `agt progress <thread> \"<where I am>\"`.",
    "- You need a decision you cannot make: run `agt question <thread> \"<question>\"`, end your turn and wait for the answer.",
    "- You cannot finish: run `agt ticket block <thread>/<ticket> --reason \"<why>\"`.",
    NEVER_LEGACY,
  ],
};

/** Task threads only: what to do in the review loop, listed before the commit rule. */
const WRONG_TASK: Partial<Record<SessionRole, string[]>> = {
  coordinator: ["- A ticket is in review with no notice: review it, then accept or return it."],
  worker: ["- A return notice arrives: fix it in a new commit, then run agt ticket done again."],
};

/** A task thread's workers commit on wip/<task> (the coordinator only squashes); in a legacy thread only the coordinator commits. */
const NEVER_TASK: Partial<Record<SessionRole, string>> = {
  coordinator: "- Never push; never commit on wip/<task>; never bypass the commit guard.",
  worker: "- Never push; commit only your ticket's files, on wip/<task>; never bypass the commit guard.",
};

const TITLES: Record<SessionRole, string> = { main: "Main", coordinator: "Coordinator", worker: "Worker" };

function roleGuide(role: SessionRole, o: GuideInput, level: "#" | "##"): string {
  const t = o.thread ?? (o.legacy ? LEGACY_PLACEHOLDER : PLACEHOLDER);
  const rules = rulesOf(systemPrompt({ root: o.root, role, thread: t, ticket: "<ticket>", config: o.config })).filter(
    (l) => l !== "" && !l.includes("When unsure how to do something with agt, run: agt guide"),
  );
  const dir = paths(o.root).threadDir(t);
  const h = level === "#" ? "##" : "###";
  const state =
    role === "main"
      ? `${paths(o.root).mainThread} lists every thread; each thread's state lives under ${paths(o.root).threadDir(PLACEHOLDER)}.`
      : `${dir}/ holds brief.md (the context pack: read it first), sub.thread.md and board.md.`;
  return [
    `${level} ${TITLES[role]}`,
    "",
    `${h} Rules`,
    "",
    ...rules,
    "",
    `${h} Commands`,
    "",
    "```",
    ...[...COMMANDS[role], ...(t.dir !== undefined ? (COMMANDS_TASK[role] ?? []) : [])].flatMap((c) => (COMMAND_OVERRIDES[role]?.[c] ? [COMMAND_OVERRIDES[role][c]!] : usageLines(c)).map((l, i) => (i === 0 ? `agt ${l}` : `    ${l}`))),
    "```",
    "",
    `${h} When things go wrong`,
    "",
    ...WRONG[role].flatMap((l) => (l === NEVER_LEGACY && t.dir !== undefined ? [...(WRONG_TASK[role] ?? []), NEVER_TASK[role] ?? l] : [l])),
    "",
    `${h} Where state lives`,
    "",
    state,
    "",
  ].join("\n");
}

/** The vendor-neutral how-to for a role, printed by `agt guide` and reused for the generated skill. */
export function guide(o: GuideInput): string {
  if (o.role !== "all") return roleGuide(o.role, o, "#");
  return (["main", "coordinator", "worker"] as const).map((r) => roleGuide(r, o, "##")).join("\n");
}
