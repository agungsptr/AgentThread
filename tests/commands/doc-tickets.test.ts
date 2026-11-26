import { describe, expect, test } from "bun:test";
import { handle, type HandleResult } from "../../src/commands/handler.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import { ConfigSchema } from "../../src/config/config.ts";
import type { Actor, StoredEvent } from "../../src/domain/types.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, stateOf, taskThreadCreated } from "../helpers.ts";

const COORD: Actor = { role: "coordinator", thread: "001", session: "c1" };
const config = ConfigSchema.parse({ workspace: { repos: { api: { path: "api" } } } });
const run = (s: State, cmd: unknown, actor: Actor = COORD): HandleResult => handle(s, CommandSchema.parse(cmd), actor, { root: "/repo", config });
const exec = (s: State, cmd: unknown, actor: Actor = COORD): HandleResult => {
  const r = run(s, cmd, actor);
  if (r.ok) for (const body of r.events) applyEvent(s, { ...body, seq: s.lastSeq + 1, ts: "2026-11-27T10:00:00.000Z", actor } as StoredEvent);
  return r;
};
const errorOf = (r: HandleResult) => (r.ok ? "accepted" : r.error);
const doc = () => stateOf(INIT, taskThreadCreated("001", "rv-1", { threadType: "review", status: "in_progress" }));
const worker = (session: string, ticket: string): Actor => ({ role: "worker", thread: "001", session, ticket });

describe("tickets on a doc thread", () => {
  test("a doc ticket needs --repo and takes no --file", () => {
    const s = doc();
    expect(errorOf(run(s, { cmd: "ticket.add", thread: "001", title: "Run auth tests" }))).toBe("a review thread's ticket needs --repo <repo>");
    expect(errorOf(run(s, { cmd: "ticket.add", thread: "001", title: "X", repo: "api", files: ["a.ts"] }))).toBe("a review thread's ticket takes no --file: its worker never commits");
    expect(errorOf(run(s, { cmd: "ticket.add", thread: "001", title: "X", repo: "nope" }))).toBe("unknown repo nope");
    expect(errorOf(run(s, { cmd: "ticket.add", thread: "001", title: "X", repo: "api", scope: ["src"] }))).toBe("a review thread's ticket takes no --scope: its worker never commits");
    expect(exec(s, { cmd: "ticket.add", thread: "001", title: "Run auth tests", repo: "api", doc: ".docs/shared/reviews/t1.md" })).toMatchObject({ ok: true, result: { ticket: "T1" } });
    const k = s.threads.get("001")!.tickets[0]!;
    expect(k).toMatchObject({ id: "T1", repo: "api", scope: [], doc: ".docs/shared/reviews/t1.md" });
    expect(k.files).toBeUndefined();
  });

  test("two doc tickets in one repo never block each other", () => {
    const s = doc();
    exec(s, { cmd: "ticket.add", thread: "001", title: "A", repo: "api" });
    exec(s, { cmd: "ticket.add", thread: "001", title: "B", repo: "api" });
    expect(errorOf(exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, worker("w1", "T1")))).toBe("accepted");
    expect(errorOf(exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T2" }, worker("w2", "T2")))).toBe("accepted");
  });

  test("ticket files cannot be changed on a doc thread", () => {
    const s = doc();
    exec(s, { cmd: "ticket.add", thread: "001", title: "A", repo: "api" });
    expect(errorOf(run(s, { cmd: "ticket.files", thread: "001", ticket: "T1", add: ["a.ts"] }))).toBe("a review thread's tickets have no files");
    expect(run(s, { cmd: "ticket.files", thread: "001", ticket: "T1" })).toMatchObject({ ok: true, result: { files: [] } });
  });
});
