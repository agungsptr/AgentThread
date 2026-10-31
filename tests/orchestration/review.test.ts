import { describe, expect, test } from "bun:test";
import { bootstrapPrompt } from "../../src/agents/prompts.ts";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { handle, type Effect, type HandleResult } from "../../src/commands/handler.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import type { Actor, EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { sweep } from "../../src/orchestration/sweep.ts";
import { applyEvent, isLive, type Session, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, taskThreadCreated, threadCreated } from "../helpers.ts";

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const COORD: Actor = { role: "coordinator", thread: "001", session: C };
let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
let clock = 0;
const T0 = Date.parse("2026-11-01T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

/** Applies `bodies` to `state` as stored events. */
function apply(state: State, bodies: EventBody[], actor: Actor = USER): StoredEvent[] {
  return bodies.map((b) => {
    const ev = { ...b, seq: state.lastSeq + 1, ts: at(clock++), actor } as StoredEvent;
    applyEvent(state, ev);
    return ev;
  });
}

/** Every effect the reactor produced while settling, in order. */
let effects: Effect[] = [];
function settle(state: State, evs: StoredEvent[]) {
  while (evs.length) {
    const out = react(state, evs, { root: "/repo", config: DEFAULT_CONFIG, newId });
    effects.push(...out.effects);
    evs = apply(state, out.events);
  }
}
/** Runs a command as `actor`, applies its events, and settles the reactor. */
function exec(state: State, cmd: unknown, actor: Actor = COORD): HandleResult {
  const r = handle(state, CommandSchema.parse(cmd), actor, { root: "/repo", config: DEFAULT_CONFIG, newId });
  if (r.ok) {
    effects.push(...r.effects);
    settle(state, apply(state, r.events, r.actor ?? actor));
  }
  return r;
}
const signal = (s: State, session: string, type: "agent.idle" | "session.active" | "session.ended") =>
  settle(s, apply(s, [{ type, thread: "001", payload: { session } }]));

function world(maxWorkers = 5, legacy = false): State {
  ids = 0;
  clock = 0;
  effects = [];
  const s = stateOf(
    INIT,
    legacy ? threadCreated("001", { status: "in_progress", maxWorkers }) : taskThreadCreated("001", "kyc-1", { status: "in_progress", maxWorkers }),
    { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } },
  );
  apply(s, [
    { type: "worktree.added", thread: "001", payload: { repo: "api", path: "/repo/.worktrees/kyc-1/api", branch: "wip/kyc-1", source: "main" } },
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    { type: "session.started", thread: "001", payload: { session: C } },
  ]);
  return s;
}
const addTicket = (s: State, id: string, files: string[], legacy = false) =>
  apply(s, [{ type: "ticket.created", thread: "001", payload: legacy ? { ticket: id, title: id, scope: files } : { ticket: id, title: id, scope: files, repo: "api", files } }]);
const workerOf = (s: State, ticket: string): Session => [...s.sessions.values()].filter((x) => x.role === "worker" && x.ticket === ticket).at(-1)!;
const asWorker = (w: Session): Actor => ({ role: "worker", thread: "001", session: w.id, ticket: w.ticket });
const ticketOf = (s: State, id: string) => s.threads.get("001")!.tickets.find((k) => k.id === id)!;
const coordNotices = (s: State) => s.sessions.get(C)!.notices;

const REVIEW = 'Ticket T1 is ready for review: added a. Review its commits, then agt ticket accept 001/T1 or agt ticket return 001/T1 "<what to fix>".';
const RETURN = 'Ticket T1 was returned: add the missing test. Fix it in a new commit, then run agt ticket done 001/T1 --summary "<one line>" again.';

/** T1's worker spawned, attached, idle, then claims it, works, and runs `ticket done`. */
function toReview(s: State, files = ["src/a.ts"]): Session {
  if (!s.threads.get("001")!.tickets.some((k) => k.id === "T1")) addTicket(s, "T1", files);
  expect(exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" }).ok).toBe(true);
  const w = workerOf(s, "T1");
  apply(s, [
    { type: "session.attached", thread: "001", payload: { session: w.id, pane: "w1:p3" } },
    { type: "session.started", thread: "001", payload: { session: w.id } },
  ]);
  expect(exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, asWorker(w)).ok).toBe(true);
  signal(s, w.id, "session.active");
  const done = exec(s, { cmd: "ticket.done", thread: "001", ticket: "T1", summary: "added a" }, asWorker(w));
  expect(done.ok).toBe(true);
  return w;
}

describe("ticket done on a task thread", () => {
  test("puts the ticket in review; the coordinator hears it after the worker's idle, once; the worker stays live", () => {
    const s = world();
    const w = toReview(s);
    expect(ticketOf(s, "T1").status).toBe("review");
    expect(coordNotices(s)).toEqual([]);
    signal(s, w.id, "agent.idle");
    expect(coordNotices(s)).toEqual([REVIEW]);
    expect(isLive(s.sessions.get(w.id)!)).toBe(true);
    expect(effects.some((e) => e.kind === "pane.close")).toBe(false);
    // a later turn of the waiting worker does not repeat it
    signal(s, w.id, "session.active");
    signal(s, w.id, "agent.idle");
    expect(coordNotices(s)).toEqual([REVIEW]);
  });

  test("emits ticket.reviewed with the summary", () => {
    const s = world();
    addTicket(s, "T1", ["src/a.ts"]);
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" });
    const w = workerOf(s, "T1");
    exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, asWorker(w));
    const r = handle(s, CommandSchema.parse({ cmd: "ticket.done", thread: "001", ticket: "T1", summary: "added a" }), asWorker(w), { root: "/repo", config: DEFAULT_CONFIG, newId });
    expect(r.ok && r.events).toEqual([{ type: "ticket.reviewed", thread: "001", payload: { ticket: "T1", summary: "added a" } }]);
  });

  test("a worker that ends before its idle still gets the coordinator the review notice, once", () => {
    const s = world();
    const w = toReview(s);
    signal(s, w.id, "session.ended");
    expect(coordNotices(s)).toEqual([REVIEW]);
    expect(ticketOf(s, "T1").status).toBe("review"); // not released: it waits for review
  });

  test("a ticket in review keeps its files: a queued ticket sharing them waits", () => {
    const s = world();
    addTicket(s, "T1", ["src/a.ts"]);
    addTicket(s, "T2", ["src/a.ts"]);
    const w = toReview(s);
    const r = exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T2" });
    expect(r.ok && r.result).toEqual({ queued: true, waitingFor: "T1" });
    signal(s, w.id, "agent.idle");
    expect(workerOf(s, "T2")).toBeUndefined();
  });
});

describe("a worker whose recorded status is already idle (polled, no hooks)", () => {
  test("runs ticket done itself: the coordinator gets the exact notice at once", () => {
    const s = world();
    addTicket(s, "T1", ["src/a.ts"]);
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" });
    const w = workerOf(s, "T1");
    apply(s, [
      { type: "session.attached", thread: "001", payload: { session: w.id, pane: "w1:p3" } },
      { type: "session.started", thread: "001", payload: { session: w.id } },
    ]);
    expect(s.sessions.get(w.id)!.status).toBe("idle");
    exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, asWorker(w));
    exec(s, { cmd: "ticket.done", thread: "001", ticket: "T1", summary: "added a" }, asWorker(w));
    expect(coordNotices(s)).toEqual([REVIEW]);
    // its next idle does not repeat it
    signal(s, w.id, "agent.idle");
    expect(coordNotices(s)).toEqual([REVIEW]);
  });
});

describe("ticket accept", () => {
  test("marks it done, ends the worker and closes its pane, and starts the waiting ticket; no second notice", () => {
    const s = world();
    addTicket(s, "T1", ["src/a.ts"]);
    addTicket(s, "T2", ["src/a.ts"]);
    const w = toReview(s);
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T2" });
    signal(s, w.id, "agent.idle");
    effects = [];
    const r = exec(s, { cmd: "ticket.accept", thread: "001", ticket: "T1" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.events).toEqual([{ type: "ticket.accepted", thread: "001", payload: { ticket: "T1" } }]);
    expect(ticketOf(s, "T1").status).toBe("done");
    expect(s.sessions.get(w.id)!.status).toBe("ended");
    expect(effects).toContainEqual({ kind: "pane.close", pane: "w1:p3" });
    expect(workerOf(s, "T2")).toBeDefined();
    expect(isLive(workerOf(s, "T2"))).toBe(true);
    // not split from T1's pane, which is closing
    expect(effects.find((e) => e.kind === "agent.spawn" && e.ticket === "T2")).toMatchObject({ splitFrom: "w1:p2", direction: "right" });
    expect(coordNotices(s)).toEqual([REVIEW]);
  });

  test("with max_workers 1, accepting frees the slot for the next queued ticket", () => {
    const s = world(1);
    addTicket(s, "T1", ["src/a.ts"]);
    addTicket(s, "T2", ["src/b.ts"]);
    const w = toReview(s);
    expect(exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T2" }).ok).toBe(true);
    signal(s, w.id, "agent.idle");
    expect(workerOf(s, "T2")).toBeUndefined();
    exec(s, { cmd: "ticket.accept", thread: "001", ticket: "T1" });
    expect(isLive(workerOf(s, "T2"))).toBe(true);
  });
});

describe("ticket return", () => {
  test("with a live worker: the same worker gets the exact notice; the ticket is in_progress", () => {
    const s = world();
    const w = toReview(s);
    signal(s, w.id, "agent.idle");
    effects = [];
    const r = exec(s, { cmd: "ticket.return", thread: "001", ticket: "T1", note: "add the missing test." });
    expect(r.ok && r.events).toEqual([{ type: "ticket.returned", thread: "001", payload: { ticket: "T1", note: "add the missing test." } }]);
    expect(ticketOf(s, "T1").status).toBe("in_progress");
    expect(ticketOf(s, "T1").assignee).toBe(w.id);
    expect(effects.find((e) => e.kind === "notice.deliver" && e.session === w.id)).toMatchObject({ text: RETURN });
    expect(effects.some((e) => e.kind === "agent.spawn")).toBe(false);
    // the same worker finishes again: back to review, and the coordinator hears it after its idle
    signal(s, w.id, "session.active");
    expect(exec(s, { cmd: "ticket.done", thread: "001", ticket: "T1", summary: "added a" }, asWorker(w)).ok).toBe(true);
    expect(ticketOf(s, "T1").status).toBe("review");
    signal(s, w.id, "agent.idle");
    expect(coordNotices(s)).toEqual([REVIEW, REVIEW]);
  });

  test("after the worker ended: a fresh worker in the repo worktree, with the note in its bootstrap, owns the ticket", () => {
    const s = world();
    const w = toReview(s);
    signal(s, w.id, "session.ended");
    effects = [];
    expect(exec(s, { cmd: "ticket.return", thread: "001", ticket: "T1", note: "add the missing test." }).ok).toBe(true);
    const fresh = workerOf(s, "T1");
    expect(fresh.id).not.toBe(w.id);
    expect(isLive(fresh)).toBe(true);
    const spawn = effects.find((e) => e.kind === "agent.spawn");
    expect(spawn).toMatchObject({ session: fresh.id, ticket: "T1", cwd: "/repo/.worktrees/kyc-1/api", notice: RETURN });
    expect(ticketOf(s, "T1")).toMatchObject({ status: "in_progress", assignee: fresh.id });
    // its bootstrap is the normal worker bootstrap followed by the notice
    const thread = s.threads.get("001")!;
    const plain = bootstrapPrompt({ root: "/repo", role: "worker", thread, ticket: "T1" });
    expect(bootstrapPrompt({ root: "/repo", role: "worker", thread, ticket: "T1" }, "start", RETURN)).toBe(`${plain}\n${RETURN}`);
    // its claim (AGENTS.md step 1) is accepted, and it can finish the ticket
    expect(exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, asWorker(fresh)).ok).toBe(true);
    expect(exec(s, { cmd: "ticket.done", thread: "001", ticket: "T1", summary: "added a" }, asWorker(fresh)).ok).toBe(true);
    expect(ticketOf(s, "T1").status).toBe("review");
  });

  test("after the worker was lost: a fresh worker spawns", () => {
    const s = world();
    const w = toReview(s);
    settle(s, apply(s, [{ type: "session.lost", thread: "001", payload: { session: w.id, reason: "gone" } }]));
    expect(ticketOf(s, "T1").status).toBe("review");
    exec(s, { cmd: "ticket.return", thread: "001", ticket: "T1", note: "add the missing test." });
    expect(workerOf(s, "T1").id).not.toBe(w.id);
    expect(ticketOf(s, "T1").assignee).toBe(workerOf(s, "T1").id);
  });

  for (const how of ["lost", "ended"] as const) {
    test(`its worker ${how} while fixing: a fresh worker takes the ticket over, with the note`, () => {
      const s = world();
      const w = toReview(s);
      signal(s, w.id, "agent.idle");
      exec(s, { cmd: "ticket.return", thread: "001", ticket: "T1", note: "add the missing test." });
      expect(ticketOf(s, "T1").assignee).toBe(w.id);
      effects = [];
      settle(s, apply(s, [how === "lost" ? { type: "session.lost", thread: "001", payload: { session: w.id, reason: "gone" } } : { type: "session.ended", thread: "001", payload: { session: w.id } }]));
      const fresh = workerOf(s, "T1");
      expect(fresh.id).not.toBe(w.id);
      expect(ticketOf(s, "T1")).toMatchObject({ status: "in_progress", assignee: fresh.id });
      expect(effects.find((e) => e.kind === "agent.spawn")).toMatchObject({ session: fresh.id, cwd: "/repo/.worktrees/kyc-1/api", notice: RETURN });
    });
  }

  test("its worker ended while fixing at max_workers: the fresh worker waits for a slot", () => {
    const s = world(1);
    addTicket(s, "T1", ["src/a.ts"]);
    addTicket(s, "T2", ["src/b.ts"]);
    const w = toReview(s);
    signal(s, w.id, "agent.idle");
    exec(s, { cmd: "ticket.return", thread: "001", ticket: "T1", note: "add the missing test." });
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T2" }); // queued: T1's worker holds the slot
    settle(s, apply(s, [{ type: "session.ended", thread: "001", payload: { session: w.id } }]));
    // the returned ticket goes first
    const fresh = workerOf(s, "T1");
    expect(fresh.id).not.toBe(w.id);
    expect(workerOf(s, "T2")).toBeUndefined();
    expect(ticketOf(s, "T1")).toMatchObject({ status: "in_progress", assignee: fresh.id });
  });

  test("its worker fails after it ran: released with reason worker session failed", () => {
    const s = world();
    const w = toReview(s);
    signal(s, w.id, "agent.idle");
    exec(s, { cmd: "ticket.return", thread: "001", ticket: "T1", note: "add the missing test." });
    const out = react(s, apply(s, [{ type: "session.failed", thread: "001", payload: { session: w.id, reason: "boom" } }]), { root: "/repo", config: DEFAULT_CONFIG, newId });
    expect(out.events).toContainEqual({ type: "ticket.released", thread: "001", payload: { ticket: "T1", reason: "worker session failed" } });
  });

  test("at max_workers the fresh worker queues and starts later, still carrying the note", () => {
    const s = world(1);
    addTicket(s, "T1", ["src/a.ts"]);
    addTicket(s, "T2", ["src/b.ts"]);
    const w = toReview(s);
    signal(s, w.id, "session.ended");
    // T2 takes the only slot
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T2" });
    const w2 = workerOf(s, "T2");
    effects = [];
    expect(exec(s, { cmd: "ticket.return", thread: "001", ticket: "T1", note: "add the missing test." }).ok).toBe(true);
    expect(effects.some((e) => e.kind === "agent.spawn")).toBe(false);
    expect(ticketOf(s, "T1").status).toBe("in_progress");
    signal(s, w2.id, "session.ended");
    const fresh = workerOf(s, "T1");
    expect(fresh.id).not.toBe(w.id);
    expect(effects.find((e) => e.kind === "agent.spawn" && e.session === fresh.id)).toMatchObject({ notice: RETURN });
    expect(ticketOf(s, "T1").assignee).toBe(fresh.id);
  });

  for (const how of ["lost", "ended"] as const) {
    test(`fresh workers that keep exiting (${how}): two respawns, then the ticket is released to the coordinator`, () => {
      const s = world();
      const w = toReview(s);
      signal(s, w.id, "agent.idle");
      exec(s, { cmd: "ticket.return", thread: "001", ticket: "T1", note: "add the missing test." });
      const exit = (id: string) =>
        settle(s, apply(s, [how === "lost" ? { type: "session.lost", thread: "001", payload: { session: id, reason: "gone" } } : { type: "session.ended", thread: "001", payload: { session: id } }]));
      const spawns = () => effects.filter((e) => e.kind === "agent.spawn").length;
      effects = [];
      exit(w.id);
      const fresh1 = workerOf(s, "T1");
      expect(fresh1.id).not.toBe(w.id);
      exit(fresh1.id);
      const fresh2 = workerOf(s, "T1");
      expect(fresh2.id).not.toBe(fresh1.id);
      expect(spawns()).toBe(2);
      const before = coordNotices(s).length;
      exit(fresh2.id);
      expect(spawns()).toBe(2);
      expect(ticketOf(s, "T1").status).toBe("open");
      expect(ticketOf(s, "T1").assignee).toBeUndefined();
      const lead = how === "lost" ? "Worker for T1 was lost" : "Worker for T1 ended";
      expect(coordNotices(s).slice(before)).toEqual([`${lead}; the returned ticket's workers keep exiting, so the ticket is open again.`]);
    });
  }

  test("the fresh-worker count starts over at the next return", () => {
    const s = world();
    const w = toReview(s);
    signal(s, w.id, "agent.idle");
    exec(s, { cmd: "ticket.return", thread: "001", ticket: "T1", note: "add the missing test." });
    signal(s, w.id, "session.ended");
    const fresh1 = workerOf(s, "T1");
    signal(s, fresh1.id, "session.ended");
    const fresh2 = workerOf(s, "T1");
    // fresh2 finishes; the ticket goes back to review and is returned again: the count starts over
    apply(s, [{ type: "session.attached", thread: "001", payload: { session: fresh2.id, pane: "w1:p9" } }]);
    expect(exec(s, { cmd: "ticket.done", thread: "001", ticket: "T1", summary: "added a" }, asWorker(fresh2)).ok).toBe(true);
    exec(s, { cmd: "ticket.return", thread: "001", ticket: "T1", note: "add the missing test." });
    signal(s, fresh2.id, "session.ended");
    expect(ticketOf(s, "T1").status).toBe("in_progress");
    expect(workerOf(s, "T1").id).not.toBe(fresh2.id);
  });

  test("a fresh worker whose spawn fails leaves the ticket open, not stranded in in_progress", () => {
    const s = world();
    const w = toReview(s);
    signal(s, w.id, "session.ended");
    exec(s, { cmd: "ticket.return", thread: "001", ticket: "T1", note: "add the missing test." });
    const fresh = workerOf(s, "T1");
    settle(s, apply(s, [{ type: "session.failed", thread: "001", payload: { session: fresh.id, reason: "herdr: boom" } }]));
    expect(ticketOf(s, "T1").status).toBe("open");
    // a worker the coordinator spawns for it still gets the note
    effects = [];
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" });
    expect(effects.find((e) => e.kind === "agent.spawn")).toMatchObject({ notice: RETURN });
  });
});

describe("rejections", () => {
  test("accept or return on a ticket not in review", () => {
    const s = world();
    addTicket(s, "T1", ["src/a.ts"]);
    for (const cmd of [{ cmd: "ticket.accept" }, { cmd: "ticket.return", note: "x" }]) {
      const r = handle(s, CommandSchema.parse({ ...cmd, thread: "001", ticket: "T1" }), COORD, { root: "/repo", config: DEFAULT_CONFIG, newId });
      expect(r).toEqual({ ok: false, error: "ticket T1 is open, not in review" });
    }
  });

  test("a worker cannot accept or return", () => {
    const s = world();
    const w = toReview(s);
    for (const cmd of [{ cmd: "ticket.accept" }, { cmd: "ticket.return", note: "x" }]) {
      const r = handle(s, CommandSchema.parse({ ...cmd, thread: "001", ticket: "T1" }), asWorker(w), { root: "/repo", config: DEFAULT_CONFIG, newId });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe(`role worker may not run ${cmd.cmd}`);
    }
  });

  test("return needs a note", () => {
    expect(CommandSchema.safeParse({ cmd: "ticket.return", thread: "001", ticket: "T1", note: " " }).success).toBe(false);
  });
});

describe("legacy threads", () => {
  test("ticket done completes the ticket, the idle ends the worker, and the coordinator hears it is done", () => {
    const s = world(5, true);
    addTicket(s, "T1", ["src"], true);
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" });
    const w = workerOf(s, "T1");
    apply(s, [
      { type: "session.attached", thread: "001", payload: { session: w.id, pane: "w1:p3" } },
      { type: "session.started", thread: "001", payload: { session: w.id } },
    ]);
    exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, asWorker(w));
    signal(s, w.id, "session.active");
    const r = exec(s, { cmd: "ticket.done", thread: "001", ticket: "T1", summary: "ok" }, asWorker(w));
    expect(r.ok && r.events).toEqual([{ type: "ticket.completed", thread: "001", payload: { ticket: "T1", summary: "ok" } }]);
    expect(ticketOf(s, "T1").status).toBe("done");
    signal(s, w.id, "agent.idle");
    expect(s.sessions.get(w.id)!.status).toBe("ended");
    expect(coordNotices(s)).toEqual(["Ticket T1 is done: ok."]);
  });
});

describe("the finished-worker grace sweep", () => {
  const grace = 5 * 60_000;

  test("ignores a ticket in review, however long its worker waits", () => {
    const s = world();
    const w = toReview(s);
    signal(s, w.id, "agent.idle");
    expect(sweep(s, at(clock + grace * 10), { root: "/repo", config: DEFAULT_CONFIG, newId }).events.filter((e) => e.type === "session.ended")).toEqual([]);
  });

  test("closes an accepted ticket's worker that lingers past the grace", () => {
    const s = world();
    const w = toReview(s);
    // accepted while the worker is still busy: its idle never comes
    signal(s, w.id, "session.active");
    exec(s, { cmd: "ticket.accept", thread: "001", ticket: "T1" });
    expect(isLive(s.sessions.get(w.id)!)).toBe(true);
    const r = sweep(s, at(clock + grace + 1000), { root: "/repo", config: DEFAULT_CONFIG, newId });
    expect(r.events).toContainEqual({ type: "session.ended", thread: "001", payload: { session: w.id } });
    expect(r.effects).toContainEqual({ kind: "pane.close", pane: "w1:p3" });
  });
});
