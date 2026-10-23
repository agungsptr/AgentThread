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
