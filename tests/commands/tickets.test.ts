import { describe, expect, test } from "bun:test";
import { handle, type HandleResult } from "../../src/commands/handler.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import { ConfigSchema } from "../../src/config/config.ts";
import type { Actor, StoredEvent } from "../../src/domain/types.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, taskThreadCreated, threadCreated } from "../helpers.ts";

const COORD: Actor = { role: "coordinator", thread: "001", session: "c1" };
const config = ConfigSchema.parse({ workspace: { repos: { api: { path: "api" }, web: { path: "web" } } } });
const run = (state: State, cmd: unknown, actor: Actor = COORD): HandleResult => handle(state, CommandSchema.parse(cmd), actor, { root: "/repo", config });
const exec = (state: State, cmd: unknown, actor: Actor = COORD): HandleResult => {
  const r = run(state, cmd, actor);
  if (r.ok) for (const body of r.events) applyEvent(state, { ...body, seq: state.lastSeq + 1, ts: "2026-10-09T11:00:00.000Z", actor } as StoredEvent);
  return r;
};
const errorOf = (r: HandleResult) => (r.ok ? "accepted" : r.error);
const taskBase = () => stateOf(INIT, taskThreadCreated("001", "kyc-1"), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
const add = (extra: Record<string, unknown> = {}) => ({ cmd: "ticket.add", thread: "001", title: "Lock", repo: "api", files: ["src/a.ts", "src/b.ts"], ...extra });

describe("ticket.add on a task thread", () => {
  test("records repo, files and doc; scope is the files", () => {
    const s = taskBase();
    expect(errorOf(exec(s, add({ doc: ".docs/shared/issues/kyc/01-api.md" })))).toBe("accepted");
    expect(s.threads.get("001")!.tickets[0]).toMatchObject({ id: "T1", repo: "api", files: ["src/a.ts", "src/b.ts"], doc: ".docs/shared/issues/kyc/01-api.md", scope: ["src/a.ts", "src/b.ts"] });
  });

  // The doc becomes the worker's only write rule outside its worktree: one plain file under .docs/, never a glob.
  test.each([
    "/ws/.docs/a.md", ".docs/../x.md", ".docs/a/../../x.md", "..", ".docs\\a.md", ".docs/*.md", ".docs/a?.md", ".docs/[a].md", ".docs/a].md",
    "docs/lock.md", ".docs", ".docs/", "./.docs/a.md", ".docs//a.md", ".docs/./a.md", ".docs/a/",
  ])("rejects the doc %p", (p) => {
    expect(errorOf(run(taskBase(), add({ doc: p })))).toBe(`--doc must be a path under .docs/: ${p}`);
  });

  test("needs a repo and at least one file", () => {
    expect(errorOf(run(taskBase(), add({ repo: undefined })))).toBe("a task thread's ticket needs --repo <repo> and at least one --file <path>");
    expect(errorOf(run(taskBase(), add({ files: undefined })))).toBe("a task thread's ticket needs --repo <repo> and at least one --file <path>");
  });

  test("rejects an unknown repo", () => {
    expect(errorOf(run(taskBase(), add({ repo: "nope" })))).toBe("unknown repo nope");
  });

  test.each(["/etc/passwd", "../x.ts", "a/../../x.ts", "a/../b.ts", "./", ""])("rejects the path %p", (p) => {
    expect(errorOf(run(taskBase(), add({ files: ["src/ok.ts", p] })))).toBe(`file paths are relative to the repo: ${p}`);
  });

  test.each(["src/", "src/lib/", "src/lib//"])("rejects the directory %p", (p) => {
    expect(errorOf(run(taskBase(), add({ files: ["src/ok.ts", p] })))).toBe(`--file takes a file, not a directory: ${p}`);
  });

  // git quotes such paths in its output, so the commit hook could never match them
  test.each(['src/a"b.ts', "src\\a.ts", "src/a\tb.ts", "src/a\nb.ts"])("rejects the path %p with a character git quotes", (p) => {
    expect(errorOf(run(taskBase(), add({ files: ["src/ok.ts", p] })))).toBe(`file paths may not contain a quote, backslash, tab or newline: ${p}`);
  });

  test("normalises ./a//b.ts and accepts a repo with no worktree yet", () => {
    const s = taskBase();
    expect(errorOf(exec(s, add({ files: ["./src//a.ts"] })))).toBe("accepted");
    expect(s.threads.get("001")!.tickets[0]!.files).toEqual(["src/a.ts"]);
  });

  test("a legacy thread's --scope is unchanged", () => {
    const s = stateOf(INIT, threadCreated("001"));
    expect(errorOf(exec(s, { cmd: "ticket.add", thread: "001", title: "Lock", scope: ["src/x"] }))).toBe("accepted");
    expect(s.threads.get("001")!.tickets[0]).toEqual({ id: "T1", title: "Lock", scope: ["src/x"], status: "open" });
    expect(errorOf(run(s, { cmd: "ticket.add", thread: "001", title: "No scope" }))).toBe("ticket add needs at least one --scope <path>");
  });
});

describe("ticket.claim on a task thread", () => {
  test("overlap is checked within the same repo only", () => {
    const s = taskBase();
    exec(s, add({ title: "A", repo: "api", files: ["src/a.ts"] }));
    exec(s, add({ title: "B", repo: "web", files: ["src/a.ts"] }));
    exec(s, add({ title: "C", repo: "api", files: ["src/a.ts"] }));
    const w = (t: string): Actor => ({ role: "worker", thread: "001", session: `w${t}`, ticket: t });
    expect(errorOf(exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, w("T1")))).toBe("accepted");
    expect(errorOf(exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T2" }, w("T2")))).toBe("accepted");
    expect(errorOf(run(s, { cmd: "ticket.claim", thread: "001", ticket: "T3" }, w("T3")))).toBe("scope of T3 overlaps in-progress ticket T1");
  });
});

describe("ticket.claim from a status other than open", () => {
  const w = (t: string): Actor => ({ role: "worker", thread: "001", session: `w${t}`, ticket: t });
  test("a worker cannot pull its ticket back out of review", () => {
    const s = taskBase();
    exec(s, add({ files: ["src/a.ts"] }));
    exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, w("T1"));
    expect(errorOf(exec(s, { cmd: "ticket.done", thread: "001", ticket: "T1", summary: "ok" }, w("T1")))).toBe("accepted");
    expect(errorOf(run(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, w("T1")))).toBe("ticket T1 cannot go review → in_progress");
    expect(s.threads.get("001")!.tickets[0]!.status).toBe("review");
  });

  test("the assignee's claim of its in_progress ticket is still a no-op", () => {
    const s = taskBase();
    exec(s, add({ files: ["src/a.ts"] }));
    exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, w("T1"));
    expect(run(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, w("T1"))).toMatchObject({ ok: true, events: [] });
  });

  test("a ticket in review still holds its files against a claim", () => {
    const s = taskBase();
    exec(s, add({ title: "A", files: ["src/a.ts"] }));
    exec(s, add({ title: "B", files: ["src/a.ts"] }));
    exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, w("T1"));
    exec(s, { cmd: "ticket.done", thread: "001", ticket: "T1", summary: "ok" }, w("T1"));
    expect(errorOf(run(s, { cmd: "ticket.claim", thread: "001", ticket: "T2" }, w("T2")))).toBe("scope of T2 overlaps ticket T1 in review");
  });
});

describe("ticket.files", () => {
  test("returns the file list", () => {
    const s = taskBase();
    exec(s, add());
    const r = run(s, { cmd: "ticket.files", thread: "001", ticket: "T1" }, USER);
    expect(r.ok && r.result).toEqual({ files: ["src/a.ts", "src/b.ts"] });
  });
});

describe("worker.spawn on a task thread", () => {
  test("rejects when the ticket's repo has no worktree", () => {
    const s = taskBase();
    exec(s, add());
    expect(errorOf(run(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" }))).toBe("ticket T1 needs a worktree for api; create it with agt worktree add 001 api");
  });

  test("starts the worker in the repo's worktree", () => {
    const s = taskBase();
    exec(s, add());
    applyEvent(s, { type: "worktree.added", thread: "001", payload: { repo: "api", path: "/repo/.worktrees/kyc-1/api", branch: "wip/kyc-1", source: "main" }, seq: 99, ts: "2026-10-09T11:00:00.000Z", actor: USER } as StoredEvent);
    const r = run(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" });
    expect(r.ok && r.effects[0]).toMatchObject({ kind: "agent.spawn", cwd: "/repo/.worktrees/kyc-1/api" });
  });
});
