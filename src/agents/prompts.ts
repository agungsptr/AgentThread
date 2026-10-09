import type { SessionRole } from "../domain/types.ts";
import { paths } from "../project/paths.ts";

interface PromptInput {
  root: string;
  role: SessionRole;
  thread?: { id: string; title: string; slug: string; worktree: string };
  ticket?: string;
}

const threadDir = (o: PromptInput) => paths(o.root).threadDir(o.thread!);

export function systemPrompt(o: PromptInput): string {
  if (o.role === "main") {
    return [
      `You are the AgentThread main manager for the project at ${o.root}. You talk with the user.`,
      `The state of every thread is in ${paths(o.root).mainThread}; read it whenever you need the big picture.`,
      "When the user describes a feature or a bug, draft a short title, a goal and acceptance criteria and show them to the user.",
      'Only after the user confirms, create the thread with: agt thread new "<title>" --type feature|bug|chore --goal "<goal>" --criteria "<criterion>" (repeat --criteria).',
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
      `- Record important decisions with agt decide ${t.id} "<decision>" and progress with agt log ${t.id} "<message>".`,
      `- If a ticket is blocked, fix the cause or reopen it with agt ticket reopen ${t.id}/<T>.`,
      "- You receive short notifications (ticket done or blocked, messages) as prompts. Act on them, then stop and wait.",
    ].join("\n");
  }
  return [
    `You are an AgentThread worker for ticket ${o.ticket} of thread ${t.id} ("${t.title}").`,
    `Work only inside ${t.worktree}, and only on the files in your ticket's scope (see ${dir}/board.md).`,
    "Steps:",
    `1. agt ticket claim ${t.id}/${o.ticket}`,
    "2. Implement the ticket and run the relevant tests.",
    `3. agt ticket done ${t.id}/${o.ticket} --summary "<one line>" — or, if you cannot finish, agt ticket block ${t.id}/${o.ticket} --reason "<why>".`,
    "Do not commit; the coordinator commits. Do not work on other tickets.",
  ].join("\n");
}

export function bootstrapPrompt(o: PromptInput): string {
  if (o.role === "main") return "";
  const dir = threadDir(o);
  if (o.role === "coordinator") return `Start coordinating thread ${o.thread!.id}. Read ${dir}/sub.thread.md and ${dir}/board.md now.`;
  return `Start ticket ${o.ticket} of thread ${o.thread!.id} now.`;
}
