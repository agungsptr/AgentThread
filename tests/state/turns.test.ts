import { expect, test } from "bun:test";
import type { EventBody, StoredEvent } from "../../src/domain/types.ts";
import { diffAgentStatus } from "../../src/daemon/poller.ts";
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

const EV = { idle: "agent.idle", active: "session.active", started: "session.started", blocked: "agent.blocked", ended: "session.ended" } as const;

/** A tiny daemon: applies hook events (actor = the session) and polls (actor user) through the real poller. */
function rig(agent: "claude-code" | "opencode" = "claude-code") {
  const s = stateOf(INIT, threadCreated("001"), { type: "session.created", thread: "001", payload: { session: S, role: "coordinator", agent, name: "c" } });
  const log: StoredEvent[] = [];
  const send = (type: keyof typeof EV, actor: StoredEvent["actor"]) => {
    const ev = { type: EV[type], thread: "001", payload: { session: S }, seq: s.lastSeq + 1, ts: "t", actor } as StoredEvent;
    applyEvent(s, ev);
    log.push(ev);
  };
  s.sessions.get(S)!.pane = "p1";
  const hook = (type: keyof typeof EV) => send(type, { role: "coordinator", session: S } as StoredEvent["actor"]);
  const misses = new Map<string, number>();
  const poll = (status: string) => {
    for (const d of diffAgentStatus({ sessions: [...s.sessions.values()], listed: [{ pane: "p1", status: status as "idle" }], misses, hooks: (x) => x.agent === "claude-code" && !!x.hooksSeen })) send(d.signal, { role: "user" });
  };
  return { s, x: () => s.sessions.get(S)!, hook, poll, log };
}

test("a hook idle, a lagging polled working and a polled idle count one turn", () => {
  const r = rig();
  r.poll("idle"); // polled start
  r.hook("active");
  r.hook("idle"); // Stop hook
  r.poll("working"); // the poller lags behind
  r.poll("idle");
  expect(r.x().turns).toBe(1);
});

test("a claude-code session with no hook events still gets polled active and idle", () => {
  const r = rig();
  r.poll("idle");
  r.poll("working");
  r.poll("idle");
  expect(r.x()).toMatchObject({ turns: 1 });
  expect(r.x().hooksSeen).toBeUndefined();
});

test("hooksSeen is set by a session-actor active or idle, replays the same, and stops the polled ones", () => {
  const r = rig();
  r.poll("idle");
  r.hook("active");
  expect(r.x().hooksSeen).toBe(true);
  r.hook("idle");
  r.poll("working");
  r.poll("idle");
  expect(r.x().turns).toBe(1);
  const replay = stateOf(INIT, threadCreated("001"), { type: "session.created", thread: "001", payload: { session: S, role: "coordinator", agent: "claude-code", name: "c" } });
  for (const ev of r.log) applyEvent(replay, { ...ev, seq: replay.lastSeq + 1 });
  expect(replay.sessions.get(S)!.hooksSeen).toBe(true);
  expect(replay.sessions.get(S)!.turns).toBe(1);
});

test("hooked session: blocked, working, blocked raises two blocked marks and adds no turn", () => {
  const r = rig();
  r.hook("active");
  r.hook("idle");
  r.hook("active");
  r.poll("blocked");
  expect(r.x().blockedNotified).toBe(true);
  const first = r.x().blockedSeq;
  r.poll("blocked"); // still blocked: nothing new
  expect(r.x().blockedSeq).toBe(first);
  expect(r.log.filter((e) => e.type === "agent.blocked")).toHaveLength(1);
  r.poll("working"); // resumed after approval
  expect(r.x().blockedNotified).toBeUndefined();
  r.poll("blocked");
  expect(r.x().blockedNotified).toBe(true);
  expect(r.x().blockedSeq).not.toBe(first);
  expect(r.log.filter((e) => e.type === "agent.blocked")).toHaveLength(2);
  expect(r.x().turns).toBe(1);
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
