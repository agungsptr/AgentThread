import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import type { Actor, EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { applyEvent, project, type State } from "../../src/state/projection.ts";
import { INIT, USER, stored, threadCreated } from "../helpers.ts";

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const W = "11111111-1111-4111-8111-111111111111";
const WA: Actor = { role: "worker", thread: "001", ticket: "T1", session: W };
const ctx = () => ({ root: "/repo", config: DEFAULT_CONFIG, newId: () => "00000000-0000-4000-8000-000000000001" });
let log: StoredEvent[] = [];
let sec = 0;
const apply = (s: State, actor: Actor, ...bodies: EventBody[]): StoredEvent[] =>
  bodies.map((b) => {
    const ev = { ...b, seq: s.lastSeq + 1, ts: new Date(Date.parse("2026-10-24T10:00:00.000Z") + 1000 * sec++).toISOString(), actor } as StoredEvent;
    applyEvent(s, ev);
    log.push(ev);
    return ev;
  });

function base(agent: "claude-code" | "opencode" = "claude-code"): State {
  sec = 0;
  log = stored([INIT, threadCreated("001", { status: "in_progress" }), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } }]);
  const s = project(log);
  apply(
    s,
    USER,
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    { type: "session.created", thread: "001", payload: { session: W, role: "worker", agent, name: "w", ticket: "T1" } },
    { type: "session.attached", thread: "001", payload: { session: W, pane: "w1:p3" } },
    { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "t", scope: [] } },
  );
  apply(s, WA, { type: "ticket.claimed", thread: "001", payload: { ticket: "T1", assignee: W } });
  return s;
}
const idle = (s: State, tokens: number, session = W, actor = WA) => react(s, apply(s, actor, { type: "agent.idle", thread: "001", payload: { session, contextTokens: tokens } }), ctx());
const notices = (r: { events: EventBody[] }) => r.events.flatMap((e) => (e.type === "notice.queued" ? [e.payload.text] : []));
const NOTICE = (n: number) => `The worker for ticket T1 is at ${n}% of its context. If it keeps going, return the ticket so a fresh worker continues: agt ticket return 001/T1 "<what is left>".`;

test("a worker at the context threshold tells its coordinator once per ticket; below it nothing", () => {
  const s = base();
  expect(notices(idle(s, 100_000))).toEqual([]);
  const r = idle(s, 150_000);
  expect(notices(r)).toEqual([NOTICE(75)]);
  expect(r.events.some((e) => e.type === "worker.context_reported")).toBe(true);
  apply(s, USER, ...r.events);
  expect(s.threads.get("001")!.tickets[0]!.contextReported).toBe(true);
  expect(notices(idle(s, 180_000))).toEqual([]);
  // never rotated
  expect(r.events.some((e) => e.type === "session.rotation_requested")).toBe(false);
});

test("the flag survives a replay of the log", () => {
  const s = base();
  apply(s, USER, ...idle(s, 150_000).events);
  const replayed = project(log);
  expect(replayed.threads.get("001")!.tickets[0]!.contextReported).toBe(true);
  expect(notices(idle(replayed, 190_000))).toEqual([]);
});

test("a worker whose agent reports no context size is not watched", () => {
  const s = base("opencode");
  expect(notices(idle(s, 190_000))).toEqual([]);
});

test("a coordinator still rotates on context and gets no worker notice", () => {
  const s = base();
  const r = idle(s, 150_000, C, { role: "coordinator", thread: "001", session: C });
  expect(r.events).toEqual([{ type: "session.rotation_requested", thread: "001", payload: { session: C, reason: "context" } }]);
});

test("a returned ticket's fresh worker that also grows large is reported again", () => {
  const s = base();
  apply(s, USER, ...idle(s, 150_000).events);
  expect(s.threads.get("001")!.tickets[0]!.contextReported).toBe(true);
  const W2 = "22222222-2222-4222-8222-222222222222";
  const WA2: Actor = { role: "worker", thread: "001", ticket: "T1", session: W2 };
  apply(s, { role: "coordinator", thread: "001", session: C } as Actor, { type: "ticket.returned", thread: "001", payload: { ticket: "T1", note: "rest" } });
  expect(s.threads.get("001")!.tickets[0]!.contextReported).toBeUndefined();
  apply(
    s,
    USER,
    { type: "session.created", thread: "001", payload: { session: W2, role: "worker", agent: "claude-code", name: "w2", ticket: "T1" } },
    { type: "session.attached", thread: "001", payload: { session: W2, pane: "w1:p4" } },
  );
  apply(s, WA2, { type: "ticket.claimed", thread: "001", payload: { ticket: "T1", assignee: W2 } });
  const again = idle(s, 150_000, W2, WA2);
  expect(notices(again)).toEqual([NOTICE(75)]);
  apply(s, USER, ...again.events);
  expect(project(log).threads.get("001")!.tickets[0]!.contextReported).toBe(true);
});
