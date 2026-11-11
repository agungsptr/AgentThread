import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import type { Actor, EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { applyEvent, project, type State } from "../../src/state/projection.ts";
import { INIT, USER, stored, threadCreated } from "../helpers.ts";

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const W = "11111111-1111-4111-8111-111111111111";
const ctx = () => ({ root: "/repo", config: DEFAULT_CONFIG, newId: () => "00000000-0000-4000-8000-000000000001" });
const WA: Actor = { role: "worker", thread: "001", ticket: "T1", session: W };
let log: StoredEvent[] = [];
const apply = (s: State, actor: Actor, ...bodies: EventBody[]): StoredEvent[] =>
  bodies.map((b) => {
    const ev = { ...b, seq: s.lastSeq + 1, ts: "2026-10-24T10:00:00.000Z", actor } as StoredEvent;
    applyEvent(s, ev);
    log.push(ev);
    return ev;
  });

/** A worker that claimed T1 (so it ran an agt command: the stall watchdog is not involved). */
function base(): State {
  log = stored([INIT, threadCreated("001", { status: "in_progress" }), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } }]);
  const s = project(log);
  apply(
    s,
    USER,
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    { type: "session.created", thread: "001", payload: { session: W, role: "worker", agent: "claude-code", name: "w", ticket: "T1" } },
    { type: "session.attached", thread: "001", payload: { session: W, pane: "w1:p3" } },
    { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "t", scope: [] } },
  );
  apply(s, WA, { type: "ticket.claimed", thread: "001", payload: { ticket: "T1", assignee: W } });
  return s;
}
const active = (s: State) => apply(s, WA, { type: "session.active", thread: "001", payload: { session: W } });
const idle = (s: State) => apply(s, WA, { type: "agent.idle", thread: "001", payload: { session: W } });
const idleNotices = (events: EventBody[]) => events.filter((e) => e.type === "notice.queued" && e.payload.text.includes("went idle without reporting"));
const text = (events: EventBody[]) => events.flatMap((e) => (e.type === "notice.queued" ? [e.payload.text] : []));
const NOTICE = (last: string) =>
  `The worker for ticket T1 went idle without reporting: ${last}. Tell it what to do with agt tell 001/T1 "<text>", or return or block the ticket.`;

test("a worker that goes idle with its ticket in_progress is reported once per idle stretch", () => {
  const s = base();
  active(s);
  apply(s, WA, { type: "note.recorded", thread: "001", payload: { message: "committed; waiting for T3" } });
  const first = idle(s);
  expect(idleNotices(react(s, first, ctx()).events)).toEqual([{ type: "notice.queued", thread: "001", payload: { session: C, text: NOTICE("committed; waiting for T3") } }]);
  // a second idle with no activity in between: the same stretch
  expect(idleNotices(react(s, idle(s), ctx()).events)).toEqual([]);
  // a replay of the whole log reports the same single notice
  const replayed = project(log);
  expect(idleNotices(react(replayed, log.filter((e) => e.type === "agent.idle"), ctx()).events)).toHaveLength(1);
});

test("the notice fires again after the worker was active and idle again; the latest progress wins", () => {
  const s = base();
  active(s);
  expect(idleNotices(react(s, idle(s), ctx()).events)).toEqual([{ type: "notice.queued", thread: "001", payload: { session: C, text: expect.stringContaining("went idle without reporting. Tell it") } }]);
  active(s);
  apply(s, WA, { type: "progress.recorded", thread: "001", payload: { message: "tests green" } });
  const again = idleNotices(react(s, idle(s), ctx()).events);
  expect(again).toEqual([{ type: "notice.queued", thread: "001", payload: { session: C, text: NOTICE("tests green") } }]);
});

test("no notice once the ticket is in review, blocked or done, or on a first turn with no agt command", () => {
  for (const to of [
    { type: "ticket.completed", thread: "001", payload: { ticket: "T1", summary: "s" } },
    { type: "ticket.blocked", thread: "001", payload: { ticket: "T1", reason: "r" } },
  ] as EventBody[]) {
    const s = base();
    active(s);
    apply(s, WA, to);
    expect(idleNotices(react(s, idle(s), ctx()).events)).toEqual([]);
  }
  const s = base();
  apply(s, WA, { type: "ticket.completed", thread: "001", payload: { ticket: "T1", summary: "s" } });
  apply(s, WA, { type: "ticket.reviewed", thread: "001", payload: { ticket: "T1" } } as EventBody);
  expect(idleNotices(react(s, idle(s), ctx()).events)).toEqual([]);
  // first turn that ran no agt command (the stall watchdog's case)
  const f = base();
  f.sessions.get(W)!.authored = false;
  active(f);
  expect(idleNotices(react(f, idle(f), ctx()).events)).toEqual([]);
});

test("a delivered notice starts a turn: the next idle opens a new stretch and is reported", () => {
  const s = base();
  active(s);
  expect(idleNotices(react(s, idle(s), ctx()).events)).toHaveLength(1);
  expect(s.sessions.get(W)!.idleSeq).toBeDefined();
  apply(s, USER, { type: "notice.queued", thread: "001", payload: { session: W, text: "go on" } }, { type: "notice.delivered", thread: "001", payload: { session: W, count: 1 } });
  expect(s.sessions.get(W)!.idleSeq).toBeUndefined();
  expect(idleNotices(react(s, idle(s), ctx()).events)).toHaveLength(1);
});

test("the spliced last message is one line of at most 200 characters, with no doubled punctuation", () => {
  const s = base();
  active(s);
  apply(s, WA, { type: "note.recorded", thread: "001", payload: { message: `is it done?\nsecond line ${"x".repeat(300)}` } });
  const [n] = text(idleNotices(react(s, idle(s), ctx()).events));
  expect(n!).toBe(`The worker for ticket T1 went idle without reporting: is it done. Tell it what to do with agt tell 001/T1 "<text>", or return or block the ticket.`);
  active(s);
  apply(s, WA, { type: "note.recorded", thread: "001", payload: { message: "y".repeat(300) } });
  const [m] = text(idleNotices(react(s, idle(s), ctx()).events));
  expect(m!).toContain(`reporting: ${"y".repeat(199)}…. Tell it`);
});
