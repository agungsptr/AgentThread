import type { Config } from "../config/config.ts";
import type { SessionRole } from "../domain/types.ts";
import { tierList } from "../orchestration/tiers.ts";
import { paths } from "../project/paths.ts";

interface PromptInput {
  root: string;
  role: SessionRole;
  thread?: { id: string; title: string; slug: string; worktree: string };
  ticket?: string;
  /** Main's tier lines are rendered from it; without configured tiers they are left out. */
  config?: Config;
}

const threadDir = (o: PromptInput) => paths(o.root).threadDir(o.thread!);

export function systemPrompt(o: PromptInput): string {
  if (o.role === "main") {
    return [
      `You are the AgentThread main manager for the project at ${o.root}. You talk with the user.`,
      `The state of every thread is in ${paths(o.root).mainThread}; read it whenever you need the big picture.`,
      "When the user describes a feature or a bug, draft a short title, a goal and acceptance criteria and show them to the user.",
      'Only after the user confirms, create the thread with: agt thread new "<title>" --type feature|bug|chore --goal "<goal>" --criteria "<criterion>" (repeat --criteria).',
      ...tierPromptLines(o.config),
      'To pass a message to a thread\'s coordinator use: agt tell <thread-id> "<message>".',
      "Do not edit project source files yourself; implementation happens in the thread worktrees.",
      "You will receive short notifications (for example a thread ready for review) as prompts; relay them to the user.",
    ].join("\n");
  }
  const t = o.thread!;
  const dir = threadDir(o);
  if (o.role === "coordinator") {
    return [
      `You are the coordinator of AgentThread thread ${t.id} ("${t.title}"). Your working directory is the thread's git worktree ${t.worktree}.`,
      `The thread state is in ${dir}/sub.thread.md and ${dir}/board.md. Read them first, and re-read them whenever you get a notification.`,
      "Rules:",
      `- When you start, run: agt thread status ${t.id} in_progress. When every acceptance criterion is met, run: agt thread status ${t.id} review.`,
      `- Split the work into tickets whose scopes do not overlap: agt ticket add ${t.id} "<title>" --scope <path> [--scope <path>].`,
      `- Start one worker per ticket that can run in parallel: agt worker spawn ${t.id} --ticket <T>. The daemon limits how many run at once and queues the rest.`,
      "- Workers only edit files. You are the only one who commits: when a ticket is done, review the change, then git add and git commit in the worktree.",
      `- Record important decisions with agt decide ${t.id} "<decision>" and progress with agt progress ${t.id} "<message>".`,
      `- If a ticket is blocked, fix the cause, or reopen it with agt ticket reopen ${t.id}/<T> and start a new worker for it with agt worker spawn ${t.id} --ticket <T>.`,
      '- Workers\' questions arrive as notifications; answer each with agt answer <thread> <Q> "<answer>". Only you and the main manager ever ask the user.',
      "- You receive short notifications (ticket done or blocked, messages) as prompts. Act on them, then stop and wait.",
      "- If you receive a HANDOFF REQUEST, write the handoff exactly as instructed and then stop.",
    ].join("\n");
  }
  return [
    `You are an AgentThread worker for ticket ${o.ticket} of thread ${t.id} ("${t.title}").`,
    `Work only inside ${t.worktree}, and only on the files in your ticket's scope (see ${dir}/board.md).`,
    "Steps:",
    `1. agt ticket claim ${t.id}/${o.ticket}`,
    `2. Implement the ticket. You may run any command the work needs (tests, the dev stack, installs) inside the worktree. When you need a decision you cannot make, run agt question ${t.id} "<question>", end your turn and wait for the answer.`,
    `3. agt ticket done ${t.id}/${o.ticket} --summary "<one line>" — or, if you cannot finish, agt ticket block ${t.id}/${o.ticket} --reason "<why>".`,
    "Do not commit; the coordinator commits. Never bypass the commit guard (no git commit --no-verify, no changing core.hooksPath or AGT_ROLE). Do not work on other tickets.",
  ].join("\n");
}

function tierPromptLines(config: Config | undefined): string[] {
  const tiers = config ? tierList(config) : [];
  if (!config || tiers.length === 0) return [];
  return [
    `Before creating a thread, judge its complexity and pick one tier from: ${tiers.join(", ")}. Create it with agt thread new … --tier <name> --reason "<why>", tell the user the tier and why, say it starts in ${config.agents.complexity.timeout} unless they choose another, then end your turn.`,
    "If the user picks another tier, run agt thread choose <id> --tier <name>; if they want to stop, agt thread cancel <id>. If the user named a tier themselves, add --now.",
  ];
}

export const HANDOFF_REQUEST_PREFIX = "HANDOFF REQUEST:";

export function handoffRequestPrompt(o: { root: string; thread: { id: string; title: string; slug: string; worktree: string }; reason: string }): string {
  const id = o.thread.id;
  return [
    `${HANDOFF_REQUEST_PREFIX} your coordinator session for thread ${id} is being rotated (${o.reason}).`,
    "Write a handoff for the coordinator who continues after you, and submit it with this exact command shape:",
    `agt handoff ${id} --stdin <<'EOF'`,
    "## Goal status",
    "<where the thread stands against its goal and acceptance criteria>",
    "## Work done",
    "<what is finished, with ticket ids>",
    "## Decisions",
    "<decisions and why>",
    "## Next steps",
    "<what to do next, in order>",
    "## Risks",
    "<open risks, blocked tickets, things to double-check>",
    "EOF",
    "Every section must have content. When the command prints ok, stop: a new coordinator takes over from your handoff.",
  ].join("\n");
}

export function bootstrapPrompt(o: PromptInput, kind: "start" | "handoff" = "start"): string {
  if (o.role === "main") return "";
  const dir = threadDir(o);
  const id = o.thread!.id;
  if (o.role === "worker") return `You are the worker for ticket ${o.ticket} of thread ${id}. Read ${dir}/brief.md, then follow AGENTS.md.`;
  if (kind === "handoff") return `You are the new coordinator of thread ${id}; the previous session ended. Read ${dir}/brief.md, then follow AGENTS.md.`;
  return `You are the coordinator of thread ${id}. Read ${dir}/brief.md, then follow AGENTS.md.`;
}
