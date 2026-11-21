import { describe, expect, test } from "bun:test";
import { handle, type HandleResult } from "../../src/commands/handler.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import { ConfigSchema } from "../../src/config/config.ts";
import type { Actor, StoredEvent } from "../../src/domain/types.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const taskBase = () => stateOf(INIT, taskThreadCreated("001", "pay-1"), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
const add = (extra: Record<string, unknown> = {}) => ({ cmd: "ticket.add", thread: "001", title: "Lock", repo: "api", files: ["src/a.ts", "src/b.ts"], ...extra });

describe("ticket.add on a task thread", () => {
  test("records repo, files and doc; scope is the files", () => {
    const s = taskBase();
    expect(errorOf(exec(s, add({ doc: ".docs/shared/issues/pay/01-api.md" })))).toBe("accepted");
    expect(s.threads.get("001")!.tickets[0]).toMatchObject({ id: "T1", repo: "api", files: ["src/a.ts", "src/b.ts"], doc: ".docs/shared/issues/pay/01-api.md", scope: ["src/a.ts", "src/b.ts"] });
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

describe("ticket.files --add/--remove", () => {
  const files = (s: State) => s.threads.get("001")!.tickets[0]!.files;
  const change = (extra: Record<string, unknown>) => ({ cmd: "ticket.files", thread: "001", ticket: "T1", ...extra });
  const WORKER: Actor = { role: "worker", thread: "001", ticket: "T1", session: "w1" };

  test("adds and removes, deduped, and emits ticket.files_changed", () => {
    const s = taskBase();
    exec(s, add());
    const r = exec(s, change({ add: ["./src/c.ts", "src/c.ts", "src/a.ts"], remove: ["src/b.ts"] }));
    expect(r.ok && r.events.map((e) => e.type)).toEqual(["ticket.files_changed"]);
    expect(r.ok && r.events[0]!.payload).toMatchObject({ files: ["src/a.ts", "src/c.ts"], added: ["src/c.ts"], removed: ["src/b.ts"] });
    expect(files(s)).toEqual(["src/a.ts", "src/c.ts"]);
    expect(s.threads.get("001")!.tickets[0]!.scope).toEqual(["src/a.ts", "src/c.ts"]);
  });

  test("a no-op emits nothing", () => {
    const s = taskBase();
    exec(s, add());
    const r = run(s, change({ add: ["src/a.ts"] }));
    expect(r.ok && r.events).toEqual([]);
  });

  test("rejects workers, legacy threads, done tickets, the last file, bad paths and unknown removals", () => {
    const s = taskBase();
    exec(s, add());
    expect(errorOf(run(s, change({ add: ["x.ts"] }), WORKER))).toContain("only the coordinator");
    expect(errorOf(run(s, change({ remove: ["src/a.ts", "src/b.ts"] })))).toBe("ticket T1 must keep at least one file");
    expect(errorOf(run(s, change({ remove: ["nope.ts"] })))).toBe("nope.ts is not one of ticket T1's files");
    expect(errorOf(run(s, change({ add: ["../x.ts"] })))).toBe("file paths are relative to the repo: ../x.ts");
    expect(errorOf(run(s, change({ add: ["src/"] })))).toBe("--file takes a file, not a directory: src/");
    const done = taskBase();
    exec(done, add());
    exec(done, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, WORKER);
    exec(done, { cmd: "ticket.done", thread: "001", ticket: "T1", summary: "s" }, WORKER);
    expect(errorOf(run(done, change({ add: ["x.ts"] })))).toBe("accepted");
    exec(done, { cmd: "ticket.accept", thread: "001", ticket: "T1" });
    expect(errorOf(run(done, change({ add: ["x.ts"] })))).toBe("ticket T1 is done; its files cannot change");
    const legacy = stateOf(INIT, threadCreated("001"));
    exec(legacy, { cmd: "ticket.add", thread: "001", title: "A", scope: ["a"] });
    expect(errorOf(run(legacy, change({ add: ["x.ts"] })))).toContain("task threads");
  });

  test("main and user may change the list; reading still works for a worker", () => {
    const s = taskBase();
    exec(s, add());
    expect(errorOf(run(s, change({ add: ["x.ts"] }), USER))).toBe("accepted");
    const r = run(s, change({}), WORKER);
    expect(r.ok && r.result).toEqual({ files: ["src/a.ts", "src/b.ts"] });
  });
});

describe("ticket.add title that holds file paths", () => {
  test("rejects a title word that is a file in the repo, but not normal words", () => {
    const root = mkdtempSync(join(tmpdir(), "agt-title-"));
    mkdirSync(join(root, "api", "src"), { recursive: true });
    writeFileSync(join(root, "api", "src", "z.ts"), "");
    writeFileSync(join(root, "api", "README.md"), "");
    const go = (title: string) => errorOf(handle(taskBase(), CommandSchema.parse(add({ title })), COORD, { root, config }));
    expect(go("Fix src/z.ts too")).toBe('"src/z.ts" looks like a file path in the title; repeat --file for every path: --file a --file b');
    expect(go("Fix login/logout flow")).toBe("accepted");
    expect(go("Update docs wording")).toBe("accepted");
    expect(go("Fix src/missing.ts")).toBe("accepted");
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
    applyEvent(s, { type: "worktree.added", thread: "001", payload: { repo: "api", path: "/repo/.worktrees/pay-1/api", branch: "wip/pay-1", source: "main" }, seq: 99, ts: "2026-10-09T11:00:00.000Z", actor: USER } as StoredEvent);
    const r = run(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" });
    expect(r.ok && r.effects[0]).toMatchObject({ kind: "agent.spawn", cwd: "/repo/.worktrees/pay-1/api" });
  });
});
