import { expect, test } from "bun:test";
import { HANDOFF_REQUEST_PREFIX } from "../../src/agents/prompts.ts";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import type { EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, threadCreated } from "../helpers.ts";

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const W = "11111111-1111-4111-8111-111111111111";
let n = 0;
const ctx = () => ({ root: "/repo", config: DEFAULT_CONFIG, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` });
const apply = (s: State, ...bodies: EventBody[]): StoredEvent[] =>
  bodies.map((b) => {
    const ev = { ...b, seq: s.lastSeq + 1, ts: "2026-10-11T10:00:00.000Z", actor: USER } as StoredEvent;
    applyEvent(s, ev);
    return ev;
  });

function base(): State {
  n = 0;
  const s = stateOf(INIT, threadCreated("001", { status: "in_progress" }), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
  apply(
    s,
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "agt-ab12-c001" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "a", scope: ["a"] } },
    { type: "ticket.created", thread: "001", payload: { ticket: "T2", title: "b", scope: ["b"] } },
    { type: "session.created", thread: "001", payload: { session: W, role: "worker", agent: "claude-code", name: "w", ticket: "T1" } },
    { type: "session.attached", thread: "001", payload: { session: W, pane: "w1:p3" } },
    { type: "ticket.claimed", thread: "001", payload: { ticket: "T1", assignee: W } },
  );
  return s;
}

test("lost coordinator is replaced by a fresh split from the root pane, with a generated handoff", () => {
  const s = base();
  const r = react(s, apply(s, { type: "session.lost", thread: "001", payload: { session: C, reason: "no agent in pane w1:p2" } }), ctx());
  expect(r.events.map((e) => e.type)).toEqual(["handoff.submitted", "session.created"]);
  expect(r.events[0]).toMatchObject({ payload: { generated: true, content: expect.stringContaining("the previous coordinator session was lost") } });
  const created = r.events[1]!;
  const newId = created.type === "session.created" ? created.payload.session : "";
  expect(newId).not.toBe(C);
  expect(created).toMatchObject({ payload: { role: "coordinator", replaces: C, retirePane: "w1:p2" } });
  expect(r.effects).toEqual([
    { kind: "agent.spawn", session: newId, role: "coordinator", run: { agent: "claude-code" }, name: expect.any(String), thread: "001", cwd: "/repo/.worktrees/001-thread-001", splitFrom: "w1:p2", splitFallbacks: ["w1:p3"], direction: "right", bootstrap: "handoff" },
  ]);
  expect(r.effects[0]).not.toHaveProperty("resume");
  expect(r.effects[0]).not.toHaveProperty("pane");
  // with an existing handoff, none is generated
  const s2 = base();
  apply(s2, { type: "handoff.submitted", thread: "001", payload: { content: "x", generated: false } });
  expect(react(s2, apply(s2, { type: "session.lost", thread: "001", payload: { session: C, reason: "x" } }), ctx()).events.map((e) => e.type)).toEqual(["session.created"]);
});

test("a stored session.resume_failed event (old logs) produces no reaction", () => {
  const s = base();
  apply(s, { type: "session.lost", thread: "001", payload: { session: C, reason: "x" } }, { type: "session.resuming", thread: "001", payload: { session: C } });
  const r = react(s, apply(s, { type: "session.resume_failed", thread: "001", payload: { session: C, reason: "no saved Claude session" } }), ctx());
  expect(r).toEqual({ events: [], effects: [] });
  expect(s.sessions.get(C)!.status).toBe("lost");
});

test("lost worker releases its ticket, tells the coordinator, frees its slot", () => {
  const s = base();
  apply(s, { type: "worker.queued", thread: "001", payload: { ticket: "T2" } });
  const r = react(s, apply(s, { type: "session.lost", thread: "001", payload: { session: W, reason: "no agent in pane w1:p3" } }), ctx());
  expect(r.events).toEqual([
    { type: "ticket.released", thread: "001", payload: { ticket: "T1", reason: "worker session lost" } },
    { type: "notice.queued", thread: "001", payload: { session: C, text: "Worker for T1 was lost; the ticket is open again." } },
    expect.objectContaining({ type: "session.created", payload: expect.objectContaining({ ticket: "T2" }) }),
  ]);
});

test("tab reopened with a stale coordinator: loses it and its workers, no fresh spawn", () => {
  const s = base();
  const r = react(s, apply(s, { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t9", rootPane: "w1:p9" } }), ctx());
  expect(r.events).toEqual([
    { type: "session.lost", thread: "001", payload: { session: C, reason: "tab was reopened" } },
    { type: "session.lost", thread: "001", payload: { session: W, reason: "tab was reopened" } },
  ]);
  expect(r.effects).toEqual([]);
});

test("tab reopened in the same batch as a probe loss: one replacement, no fresh coordinator", () => {
  const s = base();
  const evs = apply(
    s,
    { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t9", rootPane: "w1:p9" } },
    { type: "session.lost", thread: "001", payload: { session: C, reason: "no agent in pane w1:p2" } },
  );
  const r = react(s, evs, ctx());
  const created = r.events.filter((e) => e.type === "session.created");
  expect(created).toEqual([expect.objectContaining({ payload: expect.objectContaining({ replaces: C, retirePane: "w1:p9" }) })]);
  expect(r.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", splitFrom: "w1:p9", bootstrap: "handoff" })]);
  expect(r.effects[0]).not.toHaveProperty("resume");
  // the replacement attaching retires the new tab's root pane (the lost session's old pane is gone with its tab)
  const newId = created[0]!.type === "session.created" ? created[0]!.payload.session : "";
  apply(s, ...r.events);
  const a = react(s, apply(s, { type: "session.attached", thread: "001", payload: { session: newId, pane: "w1:p10" } }), ctx());
  expect(a.effects).toEqual([{ kind: "pane.close", pane: "w1:p9" }]);
});

const COORD = { role: "coordinator" as const, thread: "001", session: C };

test("a rotation pending at loss: the replacement does not inherit the handoff request", () => {
  const s = base();
  const req = react(s, apply(s, { type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "context" } }), ctx());
  apply(s, ...req.events); // the HANDOFF REQUEST notice, not yet delivered
  const r = react(s, apply(s, { type: "session.lost", thread: "001", payload: { session: C, reason: "no agent in pane w1:p2" } }), ctx());
  expect(r.events.map((e) => e.type)).toEqual(["handoff.submitted", "session.created"]);
  const back = react(s, apply(s, ...r.events), ctx());
  expect(back.events.filter((e) => e.type === "session.rotated" || e.type === "session.created")).toEqual([]);
});

test("coordinator and worker lost in one batch: ticket released and the notice is queued to the replacement", () => {
  const s = base();
  const r = react(
    s,
    apply(
      s,
      { type: "session.lost", thread: "001", payload: { session: C, reason: "no agent in pane w1:p2" } },
      { type: "session.lost", thread: "001", payload: { session: W, reason: "no agent in pane w1:p3" } },
    ),
    ctx(),
  );
  const newId = (r.events.find((e) => e.type === "session.created") as { payload: { session: string } }).payload.session;
  expect(r.events).toEqual([
    expect.objectContaining({ type: "handoff.submitted" }),
    expect.objectContaining({ type: "session.created", payload: expect.objectContaining({ replaces: C }) }),
    { type: "ticket.released", thread: "001", payload: { ticket: "T1", reason: "worker session lost" } },
    { type: "notice.queued", thread: "001", payload: { session: newId, text: "Worker for T1 was lost; the ticket is open again." } },
  ]);
});

test("tab reopened path: the follow-up losses replace C and queue the worker notice to the replacement", () => {
  const s = base();
  const first = react(s, apply(s, { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t9", rootPane: "w1:p9" } }), ctx());
  const r = react(s, apply(s, ...first.events), ctx());
  const newId = (r.events.find((e) => e.type === "session.created") as { payload: { session: string } }).payload.session;
  expect(r.events).toEqual([
    expect.objectContaining({ type: "handoff.submitted" }),
    expect.objectContaining({ type: "session.created", payload: expect.objectContaining({ replaces: C, retirePane: "w1:p9" }) }),
    { type: "ticket.released", thread: "001", payload: { ticket: "T1", reason: "worker session lost" } },
    { type: "notice.queued", thread: "001", payload: { session: newId, text: "Worker for T1 was lost; the ticket is open again." } },
  ]);
  expect(r.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", session: newId, splitFrom: "w1:p9", bootstrap: "handoff" })]);
  apply(s, ...r.events);
  expect(s.sessions.get(newId)!.notices).toEqual(["Worker for T1 was lost; the ticket is open again."]);
});

test("lost coordinator: notices queued later in the same call go to the replacement; feeding its events back does not rotate", () => {
  const s = base();
  apply(s, { type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "context" } });
  const r = react(
    s,
    apply(
      s,
      { type: "session.lost", thread: "001", payload: { session: C, reason: "x" } },
      { type: "ticket.blocked", thread: "001", payload: { ticket: "T2", reason: "needs input" } },
    ),
    ctx(),
  );
  const created = r.events.find((e) => e.type === "session.created");
  const newId = created?.type === "session.created" ? created.payload.session : "";
  expect(r.events.find((e) => e.type === "notice.queued")).toMatchObject({ payload: { session: newId, text: "Ticket T2 is blocked: needs input." } });
  const back = react(s, apply(s, ...r.events), ctx());
  expect(back.events.filter((e) => e.type === "session.rotated" || e.type === "session.created")).toEqual([]);
});

test("worker lost whose ticket is not in progress and assigned to it: no release, plain notice", () => {
  const s = base();
  apply(s, { type: "ticket.completed", thread: "001", payload: { ticket: "T1" } });
  const r = react(s, apply(s, { type: "session.lost", thread: "001", payload: { session: W, reason: "x" } }), ctx());
  // a ticket done by the lost worker: its done notice was waiting for the worker's turn to end
  expect(r.events).toEqual([
    { type: "notice.queued", thread: "001", payload: { session: C, text: "Ticket T1 is done." } },
    { type: "notice.queued", thread: "001", payload: { session: C, text: "Worker for T1 was lost." } },
  ]);
});

test("a loss of an ended session is ignored", () => {
  const s = base();
  apply(s, { type: "session.ended", thread: "001", payload: { session: W } });
  const r = react(s, apply(s, { type: "session.lost", thread: "001", payload: { session: W, reason: "x" } }), ctx());
  expect(r.events.filter((e) => e.type !== "session.created")).toEqual([]);
});

test("lost coordinator's replacement attaching in its own split retires the old root pane", () => {
  const s = base();
  const r = react(s, apply(s, { type: "session.lost", thread: "001", payload: { session: C, reason: "x" } }), ctx());
  const created = r.events.find((e) => e.type === "session.created");
  expect(created).toMatchObject({ payload: { replaces: C, retirePane: "w1:p2" } });
  const newId = created?.type === "session.created" ? created.payload.session : "";
  apply(s, ...r.events);
  expect(s.sessions.get(newId)!.retirePane).toBe("w1:p2");
  const a = react(s, apply(s, { type: "session.attached", thread: "001", payload: { session: newId, pane: "w1:p8" } }), ctx());
  expect(a.effects).toEqual([{ kind: "pane.close", pane: "w1:p2" }]);
  expect(a.events).toEqual([{ type: "thread.root_pane_changed", thread: "001", payload: { pane: "w1:p8" } }]);
});

test("a lost coordinator of a done thread is not replaced", () => {
  const s = base();
  s.threads.get("001")!.status = "done";
  expect(react(s, apply(s, { type: "session.lost", thread: "001", payload: { session: C, reason: "x" } }), ctx())).toEqual({ events: [], effects: [] });
});

test("a worker that ends with its ticket in progress releases it and tells the coordinator", () => {
  const s = base();
  apply(s, { type: "worker.queued", thread: "001", payload: { ticket: "T2" } });
  const r = react(s, apply(s, { type: "session.ended", thread: "001", payload: { session: W } }), ctx());
  expect(r.events).toEqual([
    { type: "ticket.released", thread: "001", payload: { ticket: "T1", reason: "worker session ended" } },
    { type: "notice.queued", thread: "001", payload: { session: C, text: "Worker for T1 ended; the ticket is open again." } },
    expect.objectContaining({ type: "session.created", payload: expect.objectContaining({ ticket: "T2" }) }),
  ]);
});

test("a worker ended after its ticket is done releases nothing", () => {
  const s = base();
  apply(s, { type: "ticket.completed", thread: "001", payload: { ticket: "T1" } });
  const r = react(s, apply(s, { type: "session.ended", thread: "001", payload: { session: W } }), ctx());
  expect(r.events.filter((e) => e.type === "ticket.released")).toEqual([]);
  // the done notice that waited for the worker's turn to end is sent now
  expect(r.events.filter((e) => e.type === "notice.queued")).toEqual([{ type: "notice.queued", thread: "001", payload: { session: C, text: "Ticket T1 is done." } }]);
});

test("with no live or lost coordinator, notices go to the latest non-rotated one (e.g. failed)", () => {
  const s = base();
  apply(s, { type: "session.failed", thread: "001", payload: { session: C, reason: "spawn failed" } });
  const r = react(s, apply(s, { type: "ticket.blocked", thread: "001", payload: { ticket: "T2", reason: "needs input" } }), ctx());
  expect(r.events).toEqual([{ type: "notice.queued", thread: "001", payload: { session: C, text: "Ticket T2 is blocked: needs input." } }]);
});

test("a repeated loss of an already-replaced coordinator spawns no second replacement", () => {
  const s = base();
  const r = react(s, apply(s, { type: "session.lost", thread: "001", payload: { session: C, reason: "x" } }), ctx());
  apply(s, ...r.events);
  expect(react(s, apply(s, { type: "session.lost", thread: "001", payload: { session: C, reason: "again" } }), ctx())).toEqual({ events: [], effects: [] });
});

test("a handoff older than the lost coordinator is replaced by a generated one; a newer one is kept", () => {
  const at = (s: State, ts: string, ...bodies: EventBody[]): StoredEvent[] =>
    bodies.map((b) => {
      const ev = { ...b, seq: s.lastSeq + 1, ts, actor: USER } as StoredEvent;
      applyEvent(s, ev);
      return ev;
    });
  const R = "rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr";
  const setup = (handoffTs: string) => {
    n = 0;
    const s = stateOf(INIT, threadCreated("001", { status: "in_progress" }), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
    at(s, "2026-10-11T09:00:00.000Z", { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } });
    at(s, handoffTs, { type: "handoff.submitted", thread: "001", payload: { content: "old", generated: false } });
    at(
      s,
      "2026-10-11T10:00:00.000Z",
      { type: "session.rotated", thread: "001", payload: { session: C, reason: "context" } },
      { type: "session.created", thread: "001", payload: { session: R, role: "coordinator", agent: "claude-code", name: "r", replaces: C } },
      { type: "session.attached", thread: "001", payload: { session: R, pane: "w1:p5" } },
    );
    return s;
  };
  const stale = setup("2026-10-11T09:30:00.000Z");
  const r = react(stale, at(stale, "2026-10-11T12:00:00.000Z", { type: "session.lost", thread: "001", payload: { session: R, reason: "x" } }), ctx());
  expect(r.events.map((e) => e.type)).toEqual(["handoff.submitted", "session.created"]);
  expect(r.events[0]).toMatchObject({ payload: { generated: true } });
  // written at the same time as the replacement was created (the rotation that consumed it): still current
  const same = setup("2026-10-11T10:00:00.000Z");
  expect(react(same, at(same, "2026-10-11T12:00:00.000Z", { type: "session.lost", thread: "001", payload: { session: R, reason: "x" } }), ctx()).events.map((e) => e.type)).toEqual(["session.created"]);
});

const M = "mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm";
const withMain = (s: State) => {
  apply(s, { type: "session.created", payload: { session: M, role: "main", agent: "claude-code", name: "m" } }, { type: "session.attached", payload: { session: M, pane: "w1:p0" } });
  return s;
};
const EXITED = "Coordinator for thread 001 exited; a fresh coordinator is starting from brief.md.";

test("an exited coordinator is replaced like a lost one: generated handoff, fresh split from the root pane, main told", () => {
  const s = withMain(base());
  const r = react(s, apply(s, { type: "session.ended", thread: "001", payload: { session: C } }), ctx());
  expect(r.events.map((e) => e.type)).toEqual(["handoff.submitted", "session.created", "notice.queued"]);
  expect(r.events[0]).toMatchObject({ payload: { generated: true, content: expect.stringContaining("exited") } });
  const created = r.events[1]!;
  const newId = created.type === "session.created" ? created.payload.session : "";
  expect(created).toMatchObject({ payload: { role: "coordinator", replaces: C, retirePane: "w1:p2" } });
  expect(r.events[2]).toEqual({ type: "notice.queued", payload: { session: M, text: EXITED } });
  expect(r.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", session: newId, splitFrom: "w1:p2", bootstrap: "handoff" })]);
  // fed back, nothing more happens; a later reconcile sees a live coordinator and leaves the thread alone
  apply(s, ...r.events);
  const again = react(s, apply(s, { type: "session.ended", thread: "001", payload: { session: C } }), ctx());
  expect(again.events.filter((e) => e.type === "session.created" || e.type === "handoff.submitted")).toEqual([]);
});

test("repeated ended or lost events for one coordinator in one batch replace it once", () => {
  for (const second of ["session.ended", "session.lost"] as const) {
    const s = withMain(base());
    const evs = apply(
      s,
      { type: "session.ended", thread: "001", payload: { session: C } },
      second === "session.ended" ? { type: "session.ended", thread: "001", payload: { session: C } } : { type: "session.lost", thread: "001", payload: { session: C, reason: "x" } },
    );
    const r = react(s, evs, ctx());
    expect(r.events.filter((e) => e.type === "session.created")).toHaveLength(1);
    expect(r.effects.filter((e) => e.kind === "agent.spawn")).toHaveLength(1);
  }
  const s = base();
  const r = react(s, apply(s, { type: "session.lost", thread: "001", payload: { session: C, reason: "a" } }, { type: "session.lost", thread: "001", payload: { session: C, reason: "b" } }), ctx());
  expect(r.events.filter((e) => e.type === "session.created")).toHaveLength(1);
});

test("an exited coordinator is not replaced when the thread is done, has no tab, or has another live coordinator", () => {
  const done = withMain(base());
  done.threads.get("001")!.status = "done";
  expect(react(done, apply(done, { type: "session.ended", thread: "001", payload: { session: C } }), ctx()).events).toEqual([]);
  const tabless = withMain(base());
  delete tabless.threads.get("001")!.rootPane;
  expect(react(tabless, apply(tabless, { type: "session.ended", thread: "001", payload: { session: C } }), ctx()).events).toEqual([]);
  const other = withMain(base());
  const O = "oooooooo-oooo-4ooo-8ooo-oooooooooooo";
  apply(other, { type: "session.created", thread: "001", payload: { session: O, role: "coordinator", agent: "claude-code", name: "o" } });
  expect(react(other, apply(other, { type: "session.ended", thread: "001", payload: { session: C } }), ctx()).events).toEqual([]);
});

test("a thread finishing ends its coordinator without replacing it", () => {
  const s = withMain(base());
  const r = react(s, apply(s, { type: "thread.status_changed", thread: "001", payload: { from: "in_progress", to: "done" } }), ctx());
  const ended = r.events.filter((e) => e.type === "session.ended");
  expect(ended.length).toBeGreaterThan(0);
  expect(react(s, apply(s, ...ended), ctx()).events.filter((e) => e.type === "session.created")).toEqual([]);
});

test("an exiting coordinator is not replaced a 4th time within 10 minutes; main is told once; a reconcile loss still replaces", () => {
  const at = (s: State, ts: string, ...bodies: EventBody[]): StoredEvent[] =>
    bodies.map((b) => {
      const ev = { ...b, seq: s.lastSeq + 1, ts, actor: USER } as StoredEvent;
      applyEvent(s, ev);
      return ev;
    });
  const ids = ["11111111-aaaa-4aaa-8aaa-000000000001", "11111111-aaaa-4aaa-8aaa-000000000002", "11111111-aaaa-4aaa-8aaa-000000000003"];
  /** C, then three replacements; the first one created at `firstTs`. The last one is live in pane w1:p9. */
  const setup = (firstTs: string) => {
    const s = withMain(base());
    let prev = C;
    ids.forEach((id, i) => {
      const ts = i === 0 ? firstTs : `2026-10-11T10:0${i}:00.000Z`;
      at(
        s,
        ts,
        { type: "session.ended", thread: "001", payload: { session: prev } },
        { type: "session.created", thread: "001", payload: { session: id, role: "coordinator", agent: "claude-code", name: `r${i}`, replaces: prev } },
        { type: "session.attached", thread: "001", payload: { session: id, pane: `w1:p${7 + i}` } },
      );
      prev = id;
    });
    return s;
  };
  const last = ids[2]!;
  const KEEPS = "Coordinator for thread 001 keeps exiting (3 replacements in 10m); not replacing. Fix the cause, then run agt start.";

  const s = setup("2026-10-11T10:00:00.000Z");
  const evs = at(s, "2026-10-11T10:05:00.000Z", { type: "session.ended", thread: "001", payload: { session: last } }, { type: "session.ended", thread: "001", payload: { session: last } });
  const r = react(s, evs, ctx());
  expect(r.events).toEqual([{ type: "notice.queued", payload: { session: M, text: KEEPS } }]);
  expect(r.effects).toEqual([]);

  // the user's explicit retry: agt start reports the exited coordinator lost, and that still replaces it
  const retry = react(s, at(s, "2026-10-11T10:06:00.000Z", { type: "session.lost", thread: "001", payload: { session: last, reason: "coordinator exited" } }), ctx());
  expect(retry.events.filter((e) => e.type === "session.created")).toEqual([expect.objectContaining({ payload: expect.objectContaining({ replaces: last }) })]);

  // replacements older than 10 minutes do not count
  const old = setup("2026-10-11T09:50:00.000Z");
  const ok = react(old, at(old, "2026-10-11T10:05:00.000Z", { type: "session.ended", thread: "001", payload: { session: last } }), ctx());
  expect(ok.events.filter((e) => e.type === "session.created")).toHaveLength(1);
  expect(ok.events.some((e) => e.type === "notice.queued" && e.payload.text === KEEPS)).toBe(false);
});

test("a coordinator replacement can split from a live worker pane when the root pane is gone with the old coordinator", () => {
  // Real Herdr: closing the coordinator's root pane removes it, so a split from it fails; a worker pane in the tab remains.
  const s = withMain(base());
  const r = react(s, apply(s, { type: "session.ended", thread: "001", payload: { session: C } }), ctx());
  expect(r.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", splitFrom: "w1:p2", splitFallbacks: ["w1:p3"] })]);
  // without another live pane in the thread there is nothing to fall back to
  const s2 = withMain(base());
  apply(s2, { type: "session.ended", thread: "001", payload: { session: W } });
  const r2 = react(s2, apply(s2, { type: "session.ended", thread: "001", payload: { session: C } }), ctx());
  expect(r2.effects.find((e) => e.kind === "agent.spawn")).not.toHaveProperty("splitFallbacks");
});

const TAB_RECREATED = "Thread 001 lost its tab pane; reopening its tab with a fresh coordinator.";
/** withMain(base()) whose coordinator C exited and was replaced by R (a split from the root pane, not attached yet). */
const replaced = () => {
  const s = withMain(base());
  const r = react(s, apply(s, { type: "session.ended", thread: "001", payload: { session: C } }), ctx());
  apply(s, ...r.events);
  const created = r.events.find((e) => e.type === "session.created")!;
  return { s, R: created.type === "session.created" ? created.payload.session : "" };
};

test("a coordinator replacement whose root pane is gone closes the old tab, opens a fresh one and tells main", () => {
  for (const reason of ["pane_not_found", "herdr pane split: pane not found", "herdr pane split: pane w1:p2 not found", "herdr agent start: agent target pane w1:p2 not found"]) {
    const { s, R } = replaced();
    const r = react(s, apply(s, { type: "session.failed", thread: "001", payload: { session: R, reason } }), ctx());
    expect(r.events).toEqual([{ type: "notice.queued", payload: { session: M, text: TAB_RECREATED } }]);
    expect(r.effects).toEqual([
      { kind: "herdr.tab.close", thread: "001", tab: "w1:t2" },
      expect.objectContaining({ kind: "herdr.tab.ensure", thread: "001", cwd: "/repo/.worktrees/001-thread-001" }),
    ]);
    expect(r.effects[1]).not.toHaveProperty("tab");
    // the effects' events: the old tab closes, the fresh one opens, and tab_opened spawns exactly one coordinator in it
    apply(s, ...r.events);
    const opened = react(
      s,
      apply(s, { type: "thread.tab_closed", thread: "001", payload: { tab: "w1:t2" } }, { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t5", rootPane: "w1:p5" } }),
      ctx(),
    );
    const spawned = opened.events.filter((e) => e.type === "session.created");
    // F replaces R (the brake counts it), in the fresh root pane, from the handoff generated for R
    expect(spawned).toEqual([expect.objectContaining({ payload: expect.objectContaining({ role: "coordinator", replaces: R }) })]);
    expect(opened.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", role: "coordinator", pane: "w1:p5", bootstrap: "handoff" })]);
    expect(opened.effects[0]).not.toHaveProperty("splitFrom");
    apply(s, ...opened.events);
    expect([...s.sessions.values()].filter((x) => x.role === "coordinator" && ["starting", "active", "idle"].includes(x.status))).toHaveLength(1);
  }
});

test("a root-pane failure without a tab id only opens a fresh tab", () => {
  const { s, R } = replaced();
  delete s.threads.get("001")!.tab;
  const r = react(s, apply(s, { type: "session.failed", thread: "001", payload: { session: R, reason: "pane_not_found" } }), ctx());
  expect(r.effects).toEqual([expect.objectContaining({ kind: "herdr.tab.ensure", thread: "001" })]);
  expect(r.events).toEqual([{ type: "notice.queued", payload: { session: M, text: TAB_RECREATED } }]);
});

test("a root-pane failure at the brake reopens nothing and main gets the brake notice", () => {
  const at = (s: State, ts: string, ...bodies: EventBody[]): StoredEvent[] =>
    bodies.map((b) => {
      const ev = { ...b, seq: s.lastSeq + 1, ts, actor: USER } as StoredEvent;
      applyEvent(s, ev);
      return ev;
    });
  const s = withMain(base());
  const ids = ["11111111-aaaa-4aaa-8aaa-000000000001", "11111111-aaaa-4aaa-8aaa-000000000002", "11111111-aaaa-4aaa-8aaa-000000000003"];
  let prev = C;
  ids.forEach((id, i) => {
    at(
      s,
      `2026-10-11T10:0${i}:00.000Z`,
      { type: "session.ended", thread: "001", payload: { session: prev } },
      { type: "session.created", thread: "001", payload: { session: id, role: "coordinator", agent: "claude-code", name: `r${i}`, replaces: prev } },
    );
    prev = id;
  });
  const r = react(s, at(s, "2026-10-11T10:05:00.000Z", { type: "session.failed", thread: "001", payload: { session: ids[2]!, reason: "herdr pane split: pane w1:p2 not found" } }), ctx());
  expect(r.effects).toEqual([]);
  expect(r.events).toEqual([
    { type: "notice.queued", payload: { session: M, text: "Coordinator for thread 001 failed: herdr pane split: pane w1:p2 not found." } },
    { type: "notice.queued", payload: { session: M, text: "Coordinator for thread 001 could not be replaced (too many recent replacements); run agt start after fixing the cause." } },
  ]);
});

test("a coordinator failure for any other reason, or with a live coordinator, or of a done thread, keeps today's behaviour", () => {
  const { s, R } = replaced();
  const other = react(s, apply(s, { type: "session.failed", thread: "001", payload: { session: R, reason: "herdr agent start: timed out after 10000ms" } }), ctx());
  expect(other.effects).toEqual([]);
  expect(other.events).toEqual([{ type: "notice.queued", payload: { session: M, text: "Coordinator for thread 001 failed: herdr agent start: timed out after 10000ms." } }]);
  // another coordinator is live
  const live = replaced();
  apply(live.s, { type: "session.created", thread: "001", payload: { session: "22222222-2222-4222-8222-222222222222", role: "coordinator", agent: "claude-code", name: "x" } });
  const withLive = react(live.s, apply(live.s, { type: "session.failed", thread: "001", payload: { session: live.R, reason: "pane_not_found" } }), ctx());
  expect(withLive.effects).toEqual([]);
  expect(withLive.events).toEqual([{ type: "notice.queued", payload: { session: M, text: "Coordinator for thread 001 failed: pane_not_found." } }]);
  // a done thread
  const done = replaced();
  done.s.threads.get("001")!.status = "done";
  expect(react(done.s, apply(done.s, { type: "session.failed", thread: "001", payload: { session: done.R, reason: "pane_not_found" } }), ctx()).effects).toEqual([]);
});

test("the fresh tab's coordinator replaces the failed one: it gets the notices queued to it, never the handoff request", () => {
  const { s, R } = replaced();
  apply(
    s,
    { type: "notice.queued", thread: "001", payload: { session: R, text: "Ticket T1 is blocked: x." } },
    { type: "notice.queued", thread: "001", payload: { session: R, text: `${HANDOFF_REQUEST_PREFIX} now.` } },
  );
  const r = react(s, apply(s, { type: "session.failed", thread: "001", payload: { session: R, reason: "pane_not_found" } }), ctx());
  // nothing else is spawned into the tab that is going away
  expect(r.effects.map((e) => e.kind)).toEqual(["herdr.tab.close", "herdr.tab.ensure"]);
  apply(s, ...r.events);
  const opened = react(
    s,
    apply(s, { type: "thread.tab_closed", thread: "001", payload: { tab: "w1:t2" } }, { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t5", rootPane: "w1:p5" } }),
    ctx(),
  );
  const created = opened.events.find((e) => e.type === "session.created")!;
  const F = created.type === "session.created" ? created.payload.session : "";
  expect(opened.events).toContainEqual({ type: "notice.queued", thread: "001", payload: { session: F, text: "Ticket T1 is blocked: x." } });
  expect(opened.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", session: F, pane: "w1:p5", bootstrap: "handoff" })]);
  // a first coordinator (no earlier session) still starts from the brief
  const first = stateOf(INIT, threadCreated("002", { status: "in_progress" }));
  const r1 = react(first, apply(first, { type: "thread.tab_opened", thread: "002", payload: { tab: "w1:t3", rootPane: "w1:p3" } }), ctx());
  expect(r1.events).toEqual([expect.objectContaining({ type: "session.created", payload: expect.not.objectContaining({ replaces: expect.anything() }) })]);
});

test("a reason that names something else not found (a cwd) does not reopen the tab", () => {
  const { s, R } = replaced();
  const r = react(s, apply(s, { type: "session.failed", thread: "001", payload: { session: R, reason: "herdr pane split: cwd /x not found" } }), ctx());
  expect(r.effects.filter((e) => e.kind.startsWith("herdr.tab"))).toEqual([]);
  expect(r.events).toEqual([{ type: "notice.queued", payload: { session: M, text: "Coordinator for thread 001 failed: herdr pane split: cwd /x not found." } }]);
});

test("a first coordinator (no replaces) whose root pane is gone reopens its tab too", () => {
  const s = withMain(base());
  const r = react(s, apply(s, { type: "session.failed", thread: "001", payload: { session: C, reason: "pane_not_found" } }), ctx());
  expect(r.events).toEqual([{ type: "notice.queued", payload: { session: M, text: TAB_RECREATED } }]);
  expect(r.effects.map((e) => e.kind)).toEqual(["herdr.tab.close", "herdr.tab.ensure"]);
});

test("the reopen loop for a first coordinator stops at the brake", () => {
  const at = (s: State, ts: string, ...bodies: EventBody[]): StoredEvent[] =>
    bodies.map((b) => {
      const ev = { ...b, seq: s.lastSeq + 1, ts, actor: USER } as StoredEvent;
      applyEvent(s, ev);
      return ev;
    });
  const s = withMain(base());
  let failing = C;
  let reopens = 0;
  for (let i = 0; i < 6; i++) {
    const ts = `2026-10-11T10:0${i}:00.000Z`;
    const r = react(s, at(s, ts, { type: "session.failed", thread: "001", payload: { session: failing, reason: "pane_not_found" } }), ctx());
    if (!r.effects.some((e) => e.kind === "herdr.tab.ensure")) break;
    reopens++;
    at(s, ts, ...r.events);
    // the fresh tab's tab_opened spawns a coordinator that replaces the failed one
    const opened = react(s, at(s, ts, { type: "thread.tab_closed", thread: "001", payload: { tab: "w1:t2" } }, { type: "thread.tab_opened", thread: "001", payload: { tab: `w1:t${10 + i}`, rootPane: `w1:p${10 + i}` } }), ctx());
    const created = opened.events.find((e) => e.type === "session.created");
    expect(created).toEqual(expect.objectContaining({ payload: expect.objectContaining({ replaces: failing }) }));
    at(s, ts, ...opened.events);
    failing = created?.type === "session.created" ? created.payload.session : "";
  }
  expect(reopens).toBe(3);
});

test("tab_opened does not spawn a second coordinator for a failed one already replaced in the same batch", () => {
  const s = withMain(base());
  const evs = apply(
    s,
    { type: "session.ended", thread: "001", payload: { session: C } },
    { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t5", rootPane: "w1:p5" } },
  );
  const r = react(s, evs, ctx());
  expect(r.events.filter((e) => e.type === "session.created")).toHaveLength(1);
});

/**
 * agt start after Herdr lost the tabs: layout.reconcile records a recovery coordinator split from the old root pane, and
 * its tab.ensure reopens the tab in the same batch. A coordinator still starting without a pane when a tab opens can
 * only target the old tab (a spawn into this tab follows its tab_opened), so it is replaced in the fresh root pane.
 */
test("a tab reopened while a recovery coordinator is still starting replaces it in the fresh root pane", () => {
  n = 0;
  const F = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const R = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const s = stateOf(INIT, threadCreated("002", { status: "open" }), { type: "thread.tab_opened", thread: "002", payload: { tab: "wC:t9", rootPane: "wC:pQ" } });
  apply(
    s,
    { type: "session.created", thread: "002", payload: { session: F, role: "coordinator", agent: "claude-code", name: "c" } },
    { type: "session.failed", thread: "002", payload: { session: F, reason: "herdr agent start: input contains a 1481-byte line" } },
  );
  const batch = apply(
    s,
    { type: "session.created", thread: "002", payload: { session: R, role: "coordinator", agent: "claude-code", name: "r", replaces: F, retirePane: "wC:pQ" } },
    { type: "notice.queued", thread: "002", payload: { session: R, text: "carried" } },
    { type: "thread.tab_opened", thread: "002", payload: { tab: "wD:t1", rootPane: "wD:p1" } },
  );
  const r = react(s, batch, ctx());
  expect(r.events.find((e) => e.type === "session.lost")).toEqual({ type: "session.lost", thread: "002", payload: { session: R, reason: "tab was reopened" } });
  const created = r.events.filter((e) => e.type === "session.created");
  expect(created).toEqual([expect.objectContaining({ payload: expect.objectContaining({ role: "coordinator", replaces: R }) })]);
  expect(r.events).toContainEqual(expect.objectContaining({ type: "notice.queued", payload: expect.objectContaining({ text: "carried" }) }));
  expect(r.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", role: "coordinator", pane: "wD:p1", bootstrap: "start" })]);
  expect(r.effects[0]).not.toHaveProperty("splitFrom");
  // the loss is not replaced a second time, and the old split's failure later changes nothing
  apply(s, ...r.events);
  const next = react(s, apply(s, ...r.events.filter((e) => e.type === "session.lost")), ctx());
  expect(next.effects.filter((e) => e.kind === "agent.spawn")).toEqual([]);
  expect([...s.sessions.values()].filter((x) => x.role === "coordinator" && x.status === "starting")).toHaveLength(1);
});
