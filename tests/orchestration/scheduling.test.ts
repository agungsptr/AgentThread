import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { handle, type HandleResult } from "../../src/commands/handler.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import type { Actor, EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { applyEvent, isLive, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, taskThreadCreated } from "../helpers.ts";

const COORD: Actor = { role: "coordinator", thread: "001", session: "c" };
let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

/** Applies `bodies` to `state` as stored events. */
function apply(state: State, bodies: EventBody[], actor: Actor = COORD): StoredEvent[] {
  return bodies.map((b) => {
    const ev = { ...b, seq: state.lastSeq + 1, ts: "t", actor } as StoredEvent;
    applyEvent(state, ev);
    return ev;
  });
}

/** Runs a command, applies its events, and lets the reactor react (applying what it emits) until it settles. */
function exec(state: State, cmd: unknown, config = DEFAULT_CONFIG): HandleResult {
  const r = handle(state, CommandSchema.parse(cmd), COORD, { root: "/repo", config, newId });
  if (r.ok) settle(state, apply(state, r.events), config);
  return r;
}
function settle(state: State, evs: StoredEvent[], config = DEFAULT_CONFIG) {
  while (evs.length) {
    const out = react(state, evs, { root: "/repo", config, newId });
    evs = apply(state, out.events, USER);
  }
}
const spawnedFor = (r: HandleResult) => (r.ok ? r.effects.filter((e) => e.kind === "agent.spawn").length : -1);
const liveTickets = (s: State) => [...s.sessions.values()].filter((x) => x.role === "worker" && isLive(x)).map((x) => x.ticket).sort();

function world(maxWorkers = 5): State {
  ids = 0;
  const s = stateOf(INIT, taskThreadCreated("001", "pay-1", { maxWorkers }), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
  apply(s, [
    ...["api", "fe"].map((repo): EventBody => ({ type: "worktree.added", thread: "001", payload: { repo, path: `/repo/.worktrees/pay-1/${repo}`, branch: "wip/pay-1", source: "main" } })),
  ]);
  return s;
}
const ticket = (s: State, id: string, repo: string, files: string[]) =>
  apply(s, [{ type: "ticket.created", thread: "001", payload: { ticket: id, title: id, scope: files, repo, files } }]);
const spawn = (s: State, t: string, config = DEFAULT_CONFIG) => exec(s, { cmd: "worker.spawn", thread: "001", ticket: t }, config);

describe("tickets sharing files in one repo", () => {
  test("the second queues with waitingFor, and starts once the first is accepted", () => {
    const s = world();
    ticket(s, "T1", "api", ["src/a.ts"]);
    ticket(s, "T2", "api", ["src/a.ts", "src/b.ts"]);
    const r1 = spawn(s, "T1");
    expect(spawnedFor(r1)).toBe(1);
    const r2 = spawn(s, "T2");
    expect(r2.ok && r2.result).toEqual({ queued: true, waitingFor: "T1" });
    expect(spawnedFor(r2)).toBe(0);
    expect(s.threads.get("001")!.workerQueue).toEqual(["T2"]);
    const w1 = [...s.sessions.values()].find((x) => x.ticket === "T1")!;
    // T1's worker claims, then finishes: the waiting ticket starts.
    const claim = handle(s, CommandSchema.parse({ cmd: "ticket.claim", thread: "001", ticket: "T1" }), { role: "worker", thread: "001", session: w1.id, ticket: "T1" } as Actor, { root: "/repo", config: DEFAULT_CONFIG, newId });
    expect(claim.ok).toBe(true);
    apply(s, claim.ok ? claim.events : []);
    expect(liveTickets(s)).toEqual(["T1"]);
    const done = handle(s, CommandSchema.parse({ cmd: "ticket.done", thread: "001", ticket: "T1", summary: "ok" }), { role: "worker", thread: "001", session: w1.id, ticket: "T1" } as Actor, { root: "/repo", config: DEFAULT_CONFIG, newId });
    settle(s, apply(s, done.ok ? done.events : []));
    // T1 waits in review and still holds its files; accepting T1 starts T2.
    expect(liveTickets(s)).toEqual(["T1"]);
    expect(exec(s, { cmd: "ticket.accept", thread: "001", ticket: "T1" }).ok).toBe(true);
    expect(liveTickets(s)).toEqual(["T1", "T2"]);
    expect(s.threads.get("001")!.workerQueue).toEqual([]);
  });

  test("a blocked first ticket also releases the waiting one", () => {
    const s = world();
    ticket(s, "T1", "api", ["src/a.ts"]);
    ticket(s, "T2", "api", ["src/a.ts"]);
    spawn(s, "T1");
    spawn(s, "T2");
    expect(liveTickets(s)).toEqual(["T1"]);
    // the coordinator pulls T1 back to blocked (open -> blocked is allowed), freeing its files
    settle(s, apply(s, [{ type: "ticket.blocked", thread: "001", payload: { ticket: "T1", reason: "x" } }]));
    expect(liveTickets(s)).toEqual(["T1", "T2"]);
  });

  test("same relative path in different repos runs in parallel", () => {
    const s = world();
    ticket(s, "T1", "api", ["src/a.ts"]);
    ticket(s, "T3", "fe", ["src/a.ts"]);
    expect(spawn(s, "T1").ok && spawnedFor(spawn(s, "T3"))).toBe(1);
    expect(liveTickets(s)).toEqual(["T1", "T3"]);
  });

  test("disjoint files in one repo both start", () => {
    const s = world();
    ticket(s, "T1", "api", ["src/a.ts"]);
    ticket(s, "T2", "api", ["src/b.ts"]);
    spawn(s, "T1");
    const r2 = spawn(s, "T2");
    expect(r2.ok && r2.result).toMatchObject({ queued: false });
    expect(liveTickets(s)).toEqual(["T1", "T2"]);
  });

  test("max_workers is still respected", () => {
    const s = world(1);
    ticket(s, "T1", "api", ["src/a.ts"]);
    ticket(s, "T2", "api", ["src/b.ts"]);
    spawn(s, "T1");
    const r2 = spawn(s, "T2");
    expect(r2.ok && r2.result).toEqual({ queued: true });
    expect(liveTickets(s)).toEqual(["T1"]);
  });

  test("queued tickets that clash with each other start one at a time", () => {
    const s = world(1);
    ticket(s, "T1", "api", ["src/z.ts"]);
    ticket(s, "T2", "api", ["src/a.ts"]);
    ticket(s, "T3", "api", ["src/a.ts"]);
    spawn(s, "T1");
    spawn(s, "T2");
    spawn(s, "T3");
    const w1 = [...s.sessions.values()].find((x) => x.ticket === "T1")!;
    settle(s, apply(s, [{ type: "session.ended", thread: "001", payload: { session: w1.id } }]));
    expect(liveTickets(s)).toEqual(["T2"]);
  });
  test("a queued ticket starts once the ticket it waits for is released (its worker lost)", () => {
    const s = world();
    ticket(s, "T1", "api", ["src/a.ts"]);
    ticket(s, "T2", "api", ["src/a.ts"]);
    spawn(s, "T1");
    const w1 = [...s.sessions.values()].find((x) => x.ticket === "T1")!;
    const claim = handle(s, CommandSchema.parse({ cmd: "ticket.claim", thread: "001", ticket: "T1" }), { role: "worker", thread: "001", session: w1.id, ticket: "T1" } as Actor, { root: "/repo", config: DEFAULT_CONFIG, newId });
    apply(s, claim.ok ? claim.events : []);
    expect(spawn(s, "T2").ok).toBe(true);
    expect(s.threads.get("001")!.workerQueue).toEqual(["T2"]);
    settle(s, apply(s, [{ type: "session.lost", thread: "001", payload: { session: w1.id, reason: "gone" } }]));
    expect(s.threads.get("001")!.tickets.find((k) => k.id === "T1")!.status).toBe("open");
    expect(liveTickets(s)).toEqual(["T2"]);
    expect(s.threads.get("001")!.workerQueue).toEqual([]);
  });

  test("with free slots, queued tickets that clash with each other start one at a time in one pass", () => {
    const s = world(3);
    ticket(s, "T1", "api", ["src/a.ts"]);
    ticket(s, "T2", "api", ["src/a.ts", "src/b.ts"]);
    ticket(s, "T3", "api", ["src/b.ts"]);
    ticket(s, "T4", "api", ["src/c.ts"]);
    spawn(s, "T1");
    spawn(s, "T2"); // waits for T1
    spawn(s, "T4");
    // T3 shares nothing with a running ticket: it would start, so queue it by hand behind T2
    apply(s, [{ type: "worker.queued", thread: "001", payload: { ticket: "T3" } }]);
    expect(s.threads.get("001")!.workerQueue).toEqual(["T2", "T3"]);
    const w1 = [...s.sessions.values()].find((x) => x.ticket === "T1")!;
    // T1's worker ends before claiming: its slot frees, T2 starts, and T3 (which clashes with T2) keeps waiting
    settle(s, apply(s, [{ type: "session.ended", thread: "001", payload: { session: w1.id } }]));
    expect(liveTickets(s)).toEqual(["T2", "T4"]);
    expect(s.threads.get("001")!.workerQueue).toEqual(["T3"]);
  });

  test("a ticket whose repo has no worktree is rejected at once, even when it would queue", () => {
    const s = world(1);
    ticket(s, "T1", "api", ["src/a.ts"]);
    ticket(s, "T3", "web", ["src/x.ts"]);
    spawn(s, "T1");
    // T3: max_workers would queue it; it is told about the missing worktree instead
    expect(spawn(s, "T3")).toMatchObject({ ok: false, error: "ticket T3 needs a worktree for web; create it with agt worktree add 001 web" });
  });
});
