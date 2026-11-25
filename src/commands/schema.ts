import { z } from "zod";
import { AGENT_KINDS, ROLES, SESSION_SIGNALS, STAGE_STATES, THREAD_STATUSES, THREAD_TYPES } from "../domain/types.ts";

const threadId = z.string().regex(/^\d{3,}$/, "thread id must be numeric, like 002");
const ticketId = z.string().regex(/^T\d+$/, "ticket id must look like T1");
/** `<thread>/<ticket>`, each part as threadId and ticketId accept it. */
const ticketTarget = z.string().refine((v) => {
  const [thread, ticket, ...rest] = v.split("/");
  return rest.length === 0 && threadId.safeParse(thread).success && ticketId.safeParse(ticket).success;
}, "target must be <thread>, main or <thread>/<ticket>");
const herdrId = z.string().regex(/^[\w-]+(:[\w-]+)?$/, "invalid herdr id");
const sessionId = z.string().uuid("session must be a UUID");
const text = z.string().trim().min(1);
const tierName = z.string().regex(/^[a-z][a-z0-9_-]*$/, "tier name must match /^[a-z][a-z0-9_-]*$/");

export const CommandSchema = z.discriminatedUnion("cmd", [
  z.object({
    cmd: z.literal("thread.new"),
    title: text,
    type: z.enum(THREAD_TYPES),
    goal: z.string().default(""),
    criteria: z.array(text).default([]),
    dependsOn: z.array(threadId).default([]),
    maxWorkers: z.number().int().min(1).max(16).optional(),
    /** The task name (the thread directory's name); validated by the handler, defaults to the title's slug. */
    task: z.string().optional(),
    tier: tierName.optional(),
    reason: z.string().trim().optional(),
    now: z.boolean().optional(),
    /** The user asked for a browser check (stage 8) or manual validation. */
    browserCheck: z.boolean().optional(),
  }),
  z.object({ cmd: z.literal("thread.choose"), thread: threadId, tier: tierName, auto: z.boolean().optional() }),
  z.object({ cmd: z.literal("thread.cancel"), thread: threadId, reason: text.optional() }),
  z.object({ cmd: z.literal("thread.waiting"), thread: threadId, what: text }),
  z.object({ cmd: z.literal("thread.browser_check"), thread: threadId }),
  z.object({ cmd: z.literal("thread.cleanup"), thread: threadId }),
  /** Internal: the background cleanup job's outcome, reported by the daemon itself. */
  z.object({
    cmd: z.literal("thread.cleanup_report"),
    thread: threadId,
    ok: z.boolean(),
    repos: z.array(text).optional(),
    repo: text.optional(),
    error: z.string().optional(),
    /** A failed job: the repos it had already removed. */
    removed: z.array(text).optional(),
  }),
  z.object({ cmd: z.literal("thread.status"), thread: threadId, status: z.enum(THREAD_STATUSES), reason: z.string().optional() }),
  z.object({
    cmd: z.literal("ticket.add"),
    thread: threadId,
    title: text,
    /** A legacy thread's scope paths; a task thread's scope is its files. */
    scope: z.array(text).default([]),
    repo: text.optional(),
    files: z.array(z.string()).optional(),
    doc: text.optional(),
  }),
  z.object({ cmd: z.literal("ticket.files"), thread: threadId, ticket: ticketId, add: z.array(z.string()).optional(), remove: z.array(z.string()).optional() }),
  z.object({ cmd: z.literal("ticket.claim"), thread: threadId, ticket: ticketId }),
  z.object({ cmd: z.literal("ticket.done"), thread: threadId, ticket: ticketId, summary: text }),
  z.object({ cmd: z.literal("ticket.block"), thread: threadId, ticket: ticketId, reason: text }),
  z.object({ cmd: z.literal("ticket.reopen"), thread: threadId, ticket: ticketId }),
  z.object({ cmd: z.literal("ticket.accept"), thread: threadId, ticket: ticketId }),
  z.object({ cmd: z.literal("ticket.return"), thread: threadId, ticket: ticketId, note: text }),
  z.object({
    cmd: z.literal("stage"),
    thread: threadId,
    stage: z.number().int().min(1).max(10),
    state: z.enum(STAGE_STATES),
    reason: z.string().trim().optional(),
    by: z.literal("user").optional(),
  }),
  z.object({ cmd: z.literal("stack.acquire"), thread: threadId, for: z.literal("e2e4").optional() }),
  z.object({ cmd: z.literal("stack.release"), thread: threadId }),
  z.object({ cmd: z.literal("stack.status") }),
  z.object({ cmd: z.literal("log"), thread: threadId, message: text }),
  z.object({ cmd: z.literal("decide"), thread: threadId, message: text }),
  z.object({ cmd: z.literal("note"), thread: threadId, message: text }),
  z.object({ cmd: z.literal("progress"), thread: threadId, message: text }),
  z.object({ cmd: z.literal("question"), thread: threadId, message: text }),
  z.object({ cmd: z.literal("answer"), thread: threadId, question: z.string().regex(/^Q\d+$/), message: text }),
  z.object({ cmd: z.literal("handoff"), thread: threadId, content: text }),
  z.object({
    cmd: z.literal("layout.register"),
    workspace: herdrId,
    mainTab: herdrId,
    managerPane: herdrId,
    loggerPane: herdrId,
    herdrBin: text,
    herdrSocket: z.string().optional(),
  }),
  z.object({ cmd: z.literal("layout.reconcile") }),
  z.object({ cmd: z.literal("worktree.add"), thread: threadId, repo: text, from: text.optional() }),
  /** Internal: the background worktree job's outcome, reported by the daemon itself. */
  z.object({ cmd: z.literal("worktree.report"), thread: threadId, repo: text, ok: z.boolean(), error: z.string().optional() }),
  z.object({ cmd: z.literal("worker.spawn"), thread: threadId, ticket: ticketId, agent: z.enum(AGENT_KINDS).optional() }),
  z.object({ cmd: z.literal("tell"), target: z.union([threadId, z.literal("main"), ticketTarget]), message: text }),
  z.object({
    cmd: z.literal("session.signal"),
    session: sessionId.optional(),
    pane: herdrId.optional(),
    signal: z.enum(SESSION_SIGNALS),
    contextTokens: z.number().int().min(0).optional(),
    source: z.string().max(32).optional(),
  }),
  z.object({ cmd: z.literal("session.attached"), session: sessionId, pane: herdrId, pending: text.optional() }),
  z.object({ cmd: z.literal("session.failed"), session: sessionId, reason: text }),
  z.object({ cmd: z.literal("session.open_main"), session: sessionId, pane: herdrId, profile: z.string().regex(/^[a-z][a-z0-9-]*$/).optional() }),
  /** A rate_limit failure on a Claude profile (the StopFailure hook): the profile counts as exhausted for a while. */
  z.object({ cmd: z.literal("profile.limit"), profile: z.string().regex(/^[a-z][a-z0-9-]*$/) }),
  /** `agt start`: which profile main launches on (recorded when it changes); the result is {profile, config_dir} or null. */
  z.object({ cmd: z.literal("profile.choose") }),
]);

export type Command = z.infer<typeof CommandSchema>;
export type CommandName = Command["cmd"];

export const ActorSchema = z.object({
  role: z.enum(ROLES),
  thread: z.string().optional(),
  session: z.string().optional(),
  ticket: z.string().optional(),
  agent: z.enum(AGENT_KINDS).optional(),
});
