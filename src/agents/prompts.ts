import { isAbsolute, join } from "node:path";
import type { Config } from "../config/config.ts";
import type { SessionRole } from "../domain/types.ts";
import { tierList } from "../orchestration/tiers.ts";
import { paths } from "../project/paths.ts";

/** A thread as the prompts see it: a thread directory (`dir`), or a legacy thread's single git worktree. */
export type PromptThread = { id: string; title: string; slug: string; worktree?: string; dir?: string; task?: string };

/** Where the thread's agents work: its thread directory, else its (legacy) worktree. */
export const workDir = (t: PromptThread) => t.dir ?? t.worktree ?? "";

interface PromptInput {
  root: string;
  role: SessionRole;
  thread?: PromptThread;
  ticket?: string;
  /** A task-thread worker's ticket doc, workspace-root-relative (`agt ticket add --doc`); named by its bootstrap. */
  ticketDoc?: string;
  /** Main's tier lines and the worker's command rule are rendered from it; without it, tiers are left out and agents are autonomous. */
  config?: Config;
}

const threadDir = (o: PromptInput) => paths(o.root).threadDir(o.thread!);

/** A ticket doc's absolute path: workspace-root-relative, so an absolute-looking doc is still taken under the root. */
export const ticketDocPath = (root: string, doc: string) => join(root, doc);

/** The workflow config as the role rules read it (agents-md and the guide may render without a config). */
const workflowOf = (config: Config | undefined) => ({
  chat: config?.workflow.chat_language ?? "English",
  file: config?.workflow.file_language ?? "English",
  banned: config?.workflow.banned_words ?? [],
  readFirst: config?.workflow.read_first ?? [],
  done: config?.workflow.report_words.done ?? "done",
  blocked: config?.workflow.report_words.blocked ?? "blocked",
});

/** §13.3: one rule for every commit an agent writes; an empty banned-word list drops its clause. */
function commitRule(config: Config | undefined): string {
  const { banned } = workflowOf(config);
  return `Commit messages are plain conventional commits: no AI attribution or session trailers, no ticket ids, no .docs mentions${
    banned.length ? `, none of these words: ${banned.join(", ")}` : ""
  }. This overrides any harness attribution reminder.`;
}

/** Task-thread coordinator rules from §13 that have no older line to live in. */
function coordinatorWorkflowLines(o: PromptInput): string[] {
  const id = o.thread!.id;
  const w = workflowOf(o.config);
  const docs = join(o.root, ".docs");
  return [
    `- Record every stage with agt stage ${id} <n> done|skipped|na (skipped and na need --reason "<why>"); skip a stage only when the user says so.`,
    `- Stages agt marked na (from config) stay na; don't record them.`,
    `- Whenever you stop to wait for the user, run agt thread waiting ${id} "<what>".`,
    `- Commit your own .docs changes in ${docs} (git -C ${docs}), one commit per logical change; never push.`,
    `- ${commitRule(o.config)}`,
    // read_first paths are workspace-root-relative; the coordinator works in the thread directory, so they are shown absolute.
    ...(w.readFirst.length ? [`- Read these files first: ${w.readFirst.map((f) => (isAbsolute(f) ? f : join(o.root, f))).join(", ")}.`] : []),
    `- Talk to the user in ${w.chat}; write files in ${w.file}.`,
  ];
}

/** Main's rule for `agt thread cleanup` (task threads only: the legacy guide leaves it out). */
export const MAIN_CLEANUP_RULE = "- Run agt thread cleanup <id> only when the user says so, after they told you the thread is merged.";

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
      MAIN_CLEANUP_RULE,
      "When unsure how to do something with agt, run: agt guide main",
    ].join("\n");
  }
  const t = o.thread!;
  const dir = threadDir(o);
  if (o.role === "coordinator") {
    return [
      `You are the coordinator of AgentThread thread ${t.id} ("${t.title}"). ${t.dir === undefined ? `Your working directory is the thread's git worktree ${t.worktree}.` : `Your working directory is the thread directory ${t.dir}; the thread's repo worktrees go inside it.`}`,
      `The thread state is in ${dir}/sub.thread.md and ${dir}/board.md. Read them first, and re-read them whenever you get a notification.`,
      "Rules:",
      `- When you start, run: agt thread status ${t.id} in_progress. ${
        t.dir === undefined
          ? `When every acceptance criterion is met, run: agt thread status ${t.id} review.`
          : `After the squash, \`agt stage ${t.id} 10 done\` moves the thread to review; do not set review yourself.`
      }`,
      ...(t.dir === undefined
        ? []
        : ["- Ask the user which source branch to start from, then create a worktree for each repo the task touches: agt worktree add <thread> <repo> --from <branch>. Never move or rename a worktree."]),
      `- Plan before you spawn: split the work into the largest set of tickets that can run in parallel without touching the same files (usually 2–4). Use one ticket only when the work is genuinely a single change. Add each with: ${t.dir === undefined ? `agt ticket add ${t.id} "<title>" --scope <path> [--scope <path>]` : `agt ticket add ${t.id} "<title>" --repo <r> --file <path>... [--doc <path>]`}.`,
      `- Spawn a worker for every ticket that is ready, all at once, with agt worker spawn ${t.id} --ticket <T>; the daemon queues any beyond max-workers.`,
      t.dir === undefined
        ? "- Workers only edit files. You are the only one who commits: when a ticket is done, review the change, then git add and git commit in the worktree."
        : `- Workers commit their tickets on wip/${t.task}. You never edit repo files; your only repo commit is the squash on feat/${t.task}: in each repo worktree, git switch -c feat/${t.task} <source>, git merge --squash wip/${t.task}, then one plain commit.`,
    ...(t.dir === undefined
      ? []
      : ["- Review each ticket's commits (git show --stat must list only its files), then agt ticket accept or agt ticket return with what to fix."]),
      t.dir === undefined
        ? "- Do not implement tickets yourself: every change to project files is made by a worker. You may read code and docs, run the tests and the stack, review and commit."
        : "- Never edit a repo file, even one line: send the worker the exact change. You may read code and docs, run the tests and the stack, and review.",
      ...(t.dir === undefined
        ? []
        : [
            `- Before restarting the stack, running e2e or the browser check, run agt stack acquire ${t.id} (add --for e2e4 for the full e2e); wait for the notice if it is queued; agt stack release ${t.id} when done.`,
            ...coordinatorWorkflowLines(o),
            `- When you accept a ticket that another ticket was blocked on, reopen the blocked one with agt ticket reopen ${t.id}/<T> and start a new worker for it with agt worker spawn ${t.id} --ticket <T> (a blocked worker has ended). To speak to a worker that is still alive, use agt tell ${t.id}/<T> "<message>".`,
          ]),
      `- Record important decisions with agt decide ${t.id} "<decision>" and progress with agt progress ${t.id} "<message>".`,
      `- If a ticket is blocked, fix the cause, or reopen it with agt ticket reopen ${t.id}/<T> and start a new worker for it with agt worker spawn ${t.id} --ticket <T>.`,
      '- Workers\' questions arrive as notifications; answer each with agt answer <thread> <Q> "<answer>". Only you and the main manager ever ask the user.',
      "- You receive short notifications (ticket done or blocked, messages) as prompts. Act on them, then stop and wait.",
      "- If you receive a HANDOFF REQUEST, write the handoff exactly as instructed and then stop.",
      "- When unsure how to do something with agt, run: agt guide coordinator",
    ].join("\n");
  }
  return [
    `You are an AgentThread worker for ticket ${o.ticket} of thread ${t.id} ("${t.title}").`,
    `Work only inside ${workDir(t)}, and only on the files in your ticket's scope (see ${dir}/board.md).`,
    "Steps:",
    `1. agt ticket claim ${t.id}/${o.ticket}`,
    `2. Implement the ticket. ${
      o.config?.agents.autonomous === false
        ? "Run tests only with commands you are allowed to run without asking for approval; if a command you need requires approval, block the ticket and name the command in the reason."
        : "You may run any command the work needs (tests, the dev stack, installs) inside the worktree."
    } When you need a decision you cannot make, run agt question ${t.id} "<question>", end your turn and wait for the answer.`,
    t.dir === undefined
      ? `3. agt ticket done ${t.id}/${o.ticket} --summary "<one line>" is your last action: make no edits after it — or, if you cannot finish, agt ticket block ${t.id}/${o.ticket} --reason "<why>".`
      : `3. When the ticket is done, run agt ticket done ${t.id}/${o.ticket} --summary "<one line>" and wait: the coordinator reviews your commits and may return the ticket with what to fix. If you cannot finish, run agt ticket block ${t.id}/${o.ticket} --reason "<why>".`,
    `${
      t.dir === undefined
        ? "Do not commit; the coordinator commits."
        : `Commit only your ticket's files, on wip/${t.task} inside your repo worktree, with a pathspec: git add <new files> && git commit -m "<conventional message>" -- <your files>. Never git add -A, git add . or git commit -a; never amend, rebase, reset, stash or push. The coordinator squashes.`
    } Never bypass the commit guard (no git commit --no-verify, no changing ${
      t.dir === undefined ? "core.hooksPath or AGT_ROLE" : "core.hooksPath, AGT_ROLE or AGT_AGENT_PROCESS"
    }). Do not work on other tickets.`,
    ...(t.dir === undefined
      ? []
      : [
          `Never end a turn waiting for someone. If your ticket needs another ticket first, run agt ticket block ${t.id}/${o.ticket} --reason "<what you wait for>" and stop. When the ticket is done, run agt ticket done ${t.id}/${o.ticket} --summary "<one line>".`,
          ...workerWorkflowLines(o),
        ]),
    "When unsure how to do something with agt, run: agt guide worker",
  ].join("\n");
}

/** Task-thread worker rules from §13: its ticket file, the self-check, the report words and the commit rule. */
function workerWorkflowLines(o: PromptInput): string[] {
  const w = workflowOf(o.config);
  const comments = "You may append evidence under ## Comments there; it is the only file outside your worktree you may write.";
  return [
    o.ticketDoc !== undefined
      ? `Your ticket file is ${ticketDocPath(o.root, o.ticketDoc)}. ${comments}`
      : `Your ticket file, if your ticket has one, is named in your first prompt. ${comments}`,
    "Validate your own work first: run the ticket's tests and checks before you report it done.",
    `End your summary with ${w.done} or ${w.blocked}.`,
    commitRule(o.config),
  ];
}

function tierPromptLines(config: Config | undefined): string[] {
  const tiers = config ? tierList(config) : [];
  if (!config || tiers.length === 0) return [];
  return [
    `Before creating a thread, judge its complexity and pick one tier from: ${tiers.join(", ")}. Create it with agt thread new … --tier <name> --reason "<why>", tell the user the tier and why, say it starts in ${config.agents.complexity.timeout} unless they choose another, then end your turn.`,
    `If the user picks another tier, run agt thread choose <id> --tier <name>; if they want to stop, agt thread cancel <id>. Add --now only when the user's message names one of these tiers (${Object.keys(config.agents.complexity.tiers).join(", ")}) by name. "Start now", "don't ask me again" or a confirmation is not a tier choice: still propose, tell the user, and end your turn.`,
  ];
}

export const HANDOFF_REQUEST_PREFIX = "HANDOFF REQUEST:";

export function handoffRequestPrompt(o: { root: string; thread: PromptThread; reason: string }): string {
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

/** What a ticket's worker hears when the coordinator returns the ticket (its fresh worker: at the end of its bootstrap). */
export const returnNotice = (thread: string, ticket: string, note: string) =>
  `Ticket ${ticket} was returned: ${note} Fix it in a new commit, then run agt ticket done ${thread}/${ticket} --summary "<one line>" again.`;

/** `notice` (a worker's) follows the bootstrap on its own line. */
export function bootstrapPrompt(o: PromptInput, kind: "start" | "handoff" = "start", notice?: string): string {
  if (o.role === "main") return "";
  const dir = threadDir(o);
  const id = o.thread!.id;
  if (o.role === "worker") {
    // A task-thread worker hears its own ticket file here: AGENTS.md is shared by every worker of the thread.
    const doc =
      o.thread!.dir === undefined
        ? ""
        : `\n${o.ticketDoc !== undefined ? `Your ticket file is ${ticketDocPath(o.root, o.ticketDoc)}.` : "Your ticket has no ticket file: write nothing outside your worktree."}`;
    return `You are the worker for ticket ${o.ticket} of thread ${id}. Read ${dir}/brief.md, then follow AGENTS.md.${doc}${notice ? `\n${notice}` : ""}`;
  }
  if (kind === "handoff") return `You are the new coordinator of thread ${id}; the previous session ended. Read ${dir}/brief.md, then follow AGENTS.md.`;
  return `You are the coordinator of thread ${id}. Read ${dir}/brief.md, then follow AGENTS.md.`;
}
