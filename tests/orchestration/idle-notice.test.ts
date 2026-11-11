import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import type { Actor, EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { sweep } from "../../src/orchestration/sweep.ts";
import { applyEvent, project, type State } from "../../src/state/projection.ts";
import { INIT, USER, stored, threadCreated } from "../helpers.ts";

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const W = "11111111-1111-4111-8111-111111111111";
const ctx = () => ({ root: "/repo", config: DEFAULT_CONFIG, newId: () => "00000000-0000-4000-8000-000000000001" });
const WA: Actor = { role: "worker", thread: "001", ticket: "T1", session: W };
const T0 = Date.parse("2026-10-24T10:00:00.000Z");
/** The clock events are stored at (ms after T0); tests move it. */
let clock = 0;
const at = (ms: number) => new Date(T0 + ms).toISOString();
let log: StoredEvent[] = [];
const apply = (s: State, actor: Actor, ...bodies: EventBody[]): StoredEvent[] =>
  bodies.map((b) => {
    const ev = { ...b, seq: s.lastSeq + 1, ts: at(clock), actor } as StoredEvent;
    applyEvent(s, ev);
    log.push(ev);
    return ev;
  });

/** A worker that claimed T1 (so it ran an agt command: the stall watchdog is not involved). */
function base(): State {
  clock = 0;
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
/** A turn start and end; `hooks` false: Herdr's poll (the user actor) reports them, as for a hookless agent. */
const active = (s: State, hooks = true) => apply(s, hooks ? WA : USER, { type: "session.active", thread: "001", payload: { session: W } });
const idle = (s: State, hooks = true) => apply(s, hooks ? WA : USER, { type: "agent.idle", thread: "001", payload: { session: W } });
/** Runs the sweep `ms` after the clock and applies its events (as the daemon does); returns the coordinator notices it queued. */
const tick = (s: State, ms: number): string[] => {
  clock += ms;
  const r = sweep(s, at(clock), ctx());
  apply(s, USER, ...r.events);
  return r.events.flatMap((e) => (e.type === "notice.queued" && e.payload.session === C ? [e.payload.text] : []));
};
const NOTICE = (last: string) =>
  `The worker for ticket T1 went idle without reporting${last ? `: ${last}` : ""}. Tell it what to do with agt tell 001/T1 "<text>", or return or block the ticket.`;
const CAP = "The worker for ticket T1 keeps stopping without reporting; return or block the ticket.";

test("the idle event itself sends nothing: the reactor leaves the idle notice to the sweep", () => {
  const s = base();
  active(s);
  const ev = idle(s);
  expect(react(s, ev, ctx()).events.filter((e) => e.type === "notice.queued")).toEqual([]);
});

test("hook-driven: a worker idle for 20s with its ticket in_progress is reported once per idle stretch", () => {
  const s = base();
  active(s);
  apply(s, WA, { type: "note.recorded", thread: "001", payload: { message: "committed; waiting for T3" } });
  idle(s);
  expect(tick(s, 15_000)).toEqual([]);
  expect(tick(s, 10_000)).toEqual([NOTICE("committed; waiting for T3")]);
  // a second idle with no activity in between, and later sweeps: the same stretch
  idle(s);
  expect(tick(s, 30_000)).toEqual([]);
  // a replay of the whole log keeps the stretch reported
  const replayed = project(log);
  expect(replayed.sessions.get(W)!.idleReported).toBe(true);
  expect(sweep(replayed, at(clock + 60_000), ctx()).events.filter((e) => e.type === "notice.queued")).toEqual([]);
});

test("hookless: poll flickers to idle mid-turn send nothing; an idle that lasts is reported", () => {
  const s = base();
  for (let i = 0; i < 4; i++) {
    active(s, false);
    clock += 5_000;
    idle(s, false);
    expect(tick(s, 15_000)).toEqual([]); // the next poll sees it working again
  }
  expect(tick(s, 10_000)).toEqual([NOTICE("")]);
});

test("the notice fires again after the worker was active and idle again; the latest progress wins", () => {
  const s = base();
  active(s);
  idle(s);
  expect(tick(s, 25_000)).toEqual([NOTICE("")]);
  active(s);
  apply(s, WA, { type: "progress.recorded", thread: "001", payload: { message: "tests green" } });
  idle(s);
  expect(tick(s, 25_000)).toEqual([NOTICE("tests green")]);
});

test("at most 3 idle notices per ticket, then the cap notice once, then nothing", () => {
  const s = base();
  const sent: string[] = [];
  for (let i = 0; i < 6; i++) {
    active(s);
    idle(s);
    sent.push(...tick(s, 25_000));
  }
  expect(sent).toEqual([NOTICE(""), NOTICE(""), NOTICE(""), CAP]);
  expect(s.threads.get("001")!.tickets[0]!.idleNotices).toBe(4);
});

test("no notice while the worker waits for an answer to its question; once answered it is reported", () => {
  const s = base();
  active(s);
  apply(s, WA, { type: "question.recorded", thread: "001", payload: { message: "which file?", id: "Q1" } });
  idle(s);
  expect(tick(s, 60_000)).toEqual([]);
  apply(s, { role: "coordinator", thread: "001", session: C }, { type: "question.answered", thread: "001", payload: { question: "Q1", answer: "a.ts" } });
  expect(tick(s, 1_000)).toEqual([NOTICE("")]);
});

test("no notice while a notice for the worker is queued, nor once the ticket is in review, blocked or done, nor on a first turn with no agt command", () => {
  const q = base();
  active(q);
  idle(q);
  apply(q, USER, { type: "notice.queued", thread: "001", payload: { session: W, text: "go on" } });
  expect(tick(q, 25_000)).toEqual([]);
  for (const to of [
    { type: "ticket.completed", thread: "001", payload: { ticket: "T1", summary: "s" } },
    { type: "ticket.blocked", thread: "001", payload: { ticket: "T1", reason: "r" } },
  ] as EventBody[]) {
    const s = base();
    active(s);
    apply(s, WA, to);
    idle(s);
    expect(tick(s, 25_000)).toEqual([]);
  }
  const f = base();
  f.sessions.get(W)!.authored = false;
  active(f);
  idle(f);
  expect(tick(f, 25_000)).toEqual([]);
});

test("a delivered notice starts a turn: the next idle opens a new stretch and is reported", () => {
  const s = base();
  active(s);
  idle(s);
  expect(tick(s, 25_000)).toHaveLength(1);
  expect(s.sessions.get(W)!.idleSeq).toBeDefined();
  apply(s, USER, { type: "notice.queued", thread: "001", payload: { session: W, text: "go on" } }, { type: "notice.delivered", thread: "001", payload: { session: W, count: 1 } });
  expect(s.sessions.get(W)!.idleSeq).toBeUndefined();
  expect(s.sessions.get(W)!.idleReported).toBeUndefined();
  idle(s);
  expect(tick(s, 25_000)).toHaveLength(1);
});

test("the spliced last message is one line of at most 200 characters, with no doubled punctuation", () => {
  const s = base();
  active(s);
  apply(s, WA, { type: "note.recorded", thread: "001", payload: { message: `is it done?\nsecond line ${"x".repeat(300)}` } });
  idle(s);
  expect(tick(s, 25_000)).toEqual([`The worker for ticket T1 went idle without reporting: is it done. Tell it what to do with agt tell 001/T1 "<text>", or return or block the ticket.`]);
  active(s);
  apply(s, WA, { type: "note.recorded", thread: "001", payload: { message: "y".repeat(300) } });
  idle(s);
  const [m] = tick(s, 25_000);
  expect(m!).toContain(`reporting: ${"y".repeat(199)}…. Tell it`);
});
