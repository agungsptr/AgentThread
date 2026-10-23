import { z } from "zod";
import { AGENT_KINDS, ROLES, SESSION_SIGNALS, THREAD_STATUSES, THREAD_TYPES } from "../domain/types.ts";

const threadId = z.string().regex(/^\d{3,}$/, "thread id must be numeric, like 002");
const ticketId = z.string().regex(/^T\d+$/, "ticket id must look like T1");
const herdrId = z.string().regex(/^[\w-]+(:[\w-]+)?$/, "invalid herdr id");
const sessionId = z.string().uuid("session must be a UUID");
const text = z.string().trim().min(1);

export const CommandSchema = z.discriminatedUnion("cmd", [
  z.object({
    cmd: z.literal("thread.new"),
    title: text,
    type: z.enum(THREAD_TYPES),
    goal: z.string().default(""),
    criteria: z.array(text).default([]),
    dependsOn: z.array(threadId).default([]),
    maxWorkers: z.number().int().min(1).max(16).optional(),
  }),
  z.object({ cmd: z.literal("thread.status"), thread: threadId, status: z.enum(THREAD_STATUSES), reason: z.string().optional() }),
  z.object({ cmd: z.literal("ticket.add"), thread: threadId, title: text, scope: z.array(text).min(1) }),
  z.object({ cmd: z.literal("ticket.claim"), thread: threadId, ticket: ticketId }),
  z.object({ cmd: z.literal("ticket.done"), thread: threadId, ticket: ticketId, summary: text }),
  z.object({ cmd: z.literal("ticket.block"), thread: threadId, ticket: ticketId, reason: text }),
  z.object({ cmd: z.literal("ticket.reopen"), thread: threadId, ticket: ticketId }),
  z.object({ cmd: z.literal("log"), thread: threadId, message: text }),
  z.object({ cmd: z.literal("decide"), thread: threadId, message: text }),
  z.object({ cmd: z.literal("note"), thread: threadId, message: text }),
  z.object({ cmd: z.literal("progress"), thread: threadId, message: text }),
  z.object({ cmd: z.literal("question"), thread: threadId, message: text }),
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
  z.object({ cmd: z.literal("worker.spawn"), thread: threadId, ticket: ticketId }),
  z.object({ cmd: z.literal("tell"), target: z.union([threadId, z.literal("main")]), message: text }),
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
  z.object({ cmd: z.literal("session.open_main"), session: sessionId, pane: herdrId }),
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
