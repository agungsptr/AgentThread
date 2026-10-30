import { expect, test } from "bun:test";
import type { EventBody, StoredEvent } from "../../src/domain/types.ts";
import { applyEvent } from "../../src/state/projection.ts";
import { INIT, stateOf, threadCreated } from "../helpers.ts";

const S = "11111111-1111-4111-8111-111111111111";
const idle: EventBody = { type: "agent.idle", thread: "001", payload: { session: S } };
const active: EventBody = { type: "session.active", thread: "001", payload: { session: S } };

test("turns count only active to idle transitions", () => {
  const s = stateOf(INIT, threadCreated("001"), { type: "session.created", thread: "001", payload: { session: S, role: "coordinator", agent: "claude-code", name: "c" } });
  const x = () => s.sessions.get(S)!;
  expect(x()).toMatchObject({ turns: 0, turnsSinceProgress: 0 });
  expect(typeof x().createdAt).toBe("string");
  const send = (...bodies: EventBody[]) => {
    for (const b of bodies) applyEvent(s, { ...b, seq: s.lastSeq + 1, ts: "t", actor: { role: "user" } } as StoredEvent);
  };
  send(idle); // starting -> idle: no turn
  expect(x()).toMatchObject({ turns: 0, turnsSinceProgress: 0 });
  send(active, idle); // a real turn
  expect(x()).toMatchObject({ turns: 1, turnsSinceProgress: 1 });
  send(idle, idle); // flaps
  expect(x()).toMatchObject({ turns: 1, turnsSinceProgress: 1 });
  send(active, idle, active, idle);
  expect(x()).toMatchObject({ turns: 3, turnsSinceProgress: 3 });
});

test("a hook idle, a polled working and a polled idle count one turn when the poller stays out", () => {
  const s = stateOf(INIT, threadCreated("001"), { type: "session.created", thread: "001", payload: { session: S, role: "coordinator", agent: "claude-code", name: "c" } });
  const send = (...bodies: EventBody[]) => {
    for (const b of bodies) applyEvent(s, { ...b, seq: s.lastSeq + 1, ts: "t", actor: { role: "user" } } as StoredEvent);
  };
  send(idle); // start
  send(active, idle); // the hooks' turn; the poller emits nothing for claude-code
  expect(s.sessions.get(S)!.turns).toBe(1);
});

test("blockedNotified is set by agent.blocked and cleared by active, idle and start", () => {
  const s = stateOf(INIT, threadCreated("001"), { type: "session.created", thread: "001", payload: { session: S, role: "coordinator", agent: "claude-code", name: "c" } });
  const send = (b: EventBody) => applyEvent(s, { ...b, seq: s.lastSeq + 1, ts: "t", actor: { role: "user" } } as StoredEvent);
  const blocked: EventBody = { type: "agent.blocked", thread: "001", payload: { session: S } };
  const started: EventBody = { type: "session.started", thread: "001", payload: { session: S } };
  for (const clear of [active, idle, started]) {
    send(blocked);
    expect(s.sessions.get(S)!.blockedNotified).toBe(true);
    send(clear);
    expect(s.sessions.get(S)!.blockedNotified).toBeUndefined();
  }
});
