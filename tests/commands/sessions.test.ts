import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { handle, type HandleResult } from "../../src/commands/handler.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import type { Actor, EventBody, StoredEvent } from "../../src/domain/types.ts";
import { agentName } from "../../src/orchestration/sessions.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, threadCreated } from "../helpers.ts";

const COORD: Actor = { role: "coordinator", thread: "001", session: "c" };
let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
const H = agentName("/repo", "main").slice(4, 8);

function exec(state: State, cmd: unknown, actor: Actor = USER, config = DEFAULT_CONFIG): HandleResult {
  const r = handle(state, CommandSchema.parse(cmd), actor, { root: "/repo", config, newId });
  if (r.ok) for (const b of r.events) applyEvent(state, { ...b, seq: state.lastSeq + 1, ts: "t", actor } as StoredEvent);
  return r;
}
const err = (r: HandleResult) => (r.ok ? "accepted" : r.error);

function threadWithTab(maxWorkers?: number): State {
  ids = 0;
  const bodies: EventBody[] = [
    INIT,
    threadCreated("001", maxWorkers ? { maxWorkers } : {}),
    { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } },
  ];
  const s = stateOf(...bodies);
  for (const title of ["A", "B", "C"]) exec(s, { cmd: "ticket.add", thread: "001", title, scope: [title.toLowerCase()] }, COORD);
  return s;
}

describe("agentName", () => {
  test("is herdr-safe and per role", () => {
    expect(agentName("/repo", "main")).toMatch(/^agt-[0-9a-f]{4}-main$/);
    expect(agentName("/repo", "coordinator", "001")).toBe(`agt-${H}-c001`);
    expect(agentName("/repo", "worker", "001", "T12", "ab-cd1234-ef")).toBe(`agt-${H}-w001-t12-abcd`);
    expect(agentName("/repo", "worker", "999", "T999", "ffffffff-ffff-4fff-8fff-ffffffffffff")).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });
});

describe("worker.spawn", () => {
  test("spawns into the coordinator pane first, then splits down from the last worker", () => {
    const s = threadWithTab(3);
    const first = exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" }, COORD);
    expect(first.ok && first.result).toEqual({ session: "00000000-0000-4000-8000-000000000001", queued: false });
    expect(first.ok && first.effects).toEqual([
      {
        kind: "agent.spawn", session: "00000000-0000-4000-8000-000000000001", role: "worker", run: { agent: "claude-code" }, name: `agt-${H}-w001-t1-0000`,
        thread: "001", ticket: "T1", cwd: "/repo/.worktrees/001-thread-001", splitFrom: "w1:p2", direction: "right",
      },
    ]);
    exec(s, { cmd: "session.attached", session: "00000000-0000-4000-8000-000000000001", pane: "w1:p3" });
    const second = exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T2" }, COORD);
    expect(second.ok && second.effects[0]).toMatchObject({ splitFrom: "w1:p3", direction: "down" });
  });

  test("queues beyond the per-thread limit", () => {
    const s = threadWithTab(1);
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" }, COORD);
    const r = exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T2" }, COORD);
    expect(r).toEqual({ ok: true, events: [{ type: "worker.queued", thread: "001", payload: { ticket: "T2" } }], effects: [], result: { queued: true }, actor: { ...COORD, via: "command" } });
    expect(s.threads.get("001")!.workerQueue).toEqual(["T2"]);
  });

  test("falls back to workers.max_workers from config", () => {
    const s = threadWithTab();
    const config = { ...DEFAULT_CONFIG, workers: { max_workers: 1 } };
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" }, COORD, config);
    expect(exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T2" }, COORD, config)).toMatchObject({ result: { queued: true } });
  });

  test("--agent overrides the worker role with that adapter's defaults; model and effort are not carried across", () => {
    const s = threadWithTab(1);
    const config = { ...DEFAULT_CONFIG, agents: { ...DEFAULT_CONFIG.agents, roles: { ...DEFAULT_CONFIG.agents.roles, worker: { agent: "claude-code" as const, model: "opus", effort: "high" } } } };
    const r = exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1", agent: "codex" }, COORD, config);
    expect(r.ok && r.effects[0]).toMatchObject({ kind: "agent.spawn", run: { agent: "codex" } });
    expect(r.ok && (r.effects[0] as { run: object }).run).toEqual({ agent: "codex" });
    expect(r.ok && r.events[0]).toMatchObject({ type: "session.created", payload: { agent: "codex" } });
    expect(r.ok && r.events[0]!.payload).not.toHaveProperty("model");
    // queued with an override: the override is kept until the ticket's worker is spawned
    const q = exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T2", agent: "omp" }, COORD, config);
    expect(q.ok && q.events).toEqual([{ type: "worker.queued", thread: "001", payload: { ticket: "T2", agent: "omp" } }]);
    expect(s.threads.get("001")!.workerAgents).toEqual({ T2: "omp" });
    // without --agent the role's run applies
    const plain = exec(threadWithTab(1), { cmd: "worker.spawn", thread: "001", ticket: "T1" }, COORD, config);
    expect(plain.ok && (plain.effects[0] as { run: object }).run).toEqual({ agent: "claude-code", model: "opus", effort: "high" });
    expect(() => CommandSchema.parse({ cmd: "worker.spawn", thread: "001", ticket: "T1", agent: "gpt" })).toThrow();
  });

  test("rejections", () => {
    const s = threadWithTab(1);
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" }, COORD);
    expect(err(exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" }, COORD))).toBe("ticket T1 already has a worker");
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T2" }, COORD);
    expect(err(exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T2" }, COORD))).toBe("ticket T2 already has a worker");
    expect(err(exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T9" }, COORD))).toBe("unknown ticket T9 in thread 001");
    expect(err(exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T3" }, USER))).toBe("role user may not run worker.spawn");
    const noTab = stateOf(INIT, threadCreated("001"));
    exec(noTab, { cmd: "ticket.add", thread: "001", title: "A", scope: ["a"] }, COORD);
    expect(err(exec(noTab, { cmd: "worker.spawn", thread: "001", ticket: "T1" }, COORD))).toBe(
      "thread 001 has no Herdr tab; run `agt start`",
    );
  });
});

describe("sessions", () => {
  test("signals map to events and stop after the session ends", () => {
    const s = threadWithTab();
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" }, COORD);
    const id = "00000000-0000-4000-8000-000000000001";
    expect(exec(s, { cmd: "session.signal", session: id, signal: "idle" }, { role: "worker", thread: "001", session: id })).toMatchObject({
      events: [{ type: "agent.idle", thread: "001", payload: { session: id } }],
    });
    exec(s, { cmd: "session.signal", session: id, signal: "ended" });
    expect(exec(s, { cmd: "session.signal", session: id, signal: "idle" })).toMatchObject({ ok: true, events: [] });
    expect(err(exec(s, { cmd: "session.signal", session: id, signal: "idle" }, { role: "worker", thread: "001", session: "other" }))).toBe(
      `actor session other cannot signal ${id}`,
    );
    expect(err(exec(s, { cmd: "session.signal", session: newId(), signal: "idle" }))).toMatch(/^unknown session /);
  });

  test("attached / failed reports", () => {
    const s = threadWithTab();
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" }, COORD);
    const id = "00000000-0000-4000-8000-000000000001";
    exec(s, { cmd: "session.failed", session: id, reason: "agent_not_ready" });
    expect(s.sessions.get(id)!.status).toBe("failed");
    // the spawn job must learn that its agent is unwanted: it stops it
    expect(err(exec(s, { cmd: "session.attached", session: id, pane: "w1:p9" }))).toBe(`session ${id} is no longer live`);
    expect(exec(s, { cmd: "session.failed", session: id, reason: "late" })).toMatchObject({ ok: true, events: [] });
    expect(err(exec(s, { cmd: "session.failed", session: id, reason: "x" }, COORD))).toBe("role coordinator may not run session.failed");
  });

  test("a repeated attach of a live session to the same pane emits nothing", () => {
    const s = threadWithTab();
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" }, COORD);
    const id = "00000000-0000-4000-8000-000000000001";
    expect(exec(s, { cmd: "session.attached", session: id, pane: "w1:p3" })).toMatchObject({ ok: true, events: [{ type: "session.attached" }] });
    expect(exec(s, { cmd: "session.attached", session: id, pane: "w1:p3" })).toMatchObject({ ok: true, events: [] });
    expect(exec(s, { cmd: "session.attached", session: id, pane: "w1:p3", pending: "again" })).toMatchObject({ ok: true, events: [] });
  });

  test("a command from a failed or ended session is rejected; its lifecycle signals still pass", () => {
    const s = threadWithTab();
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" }, COORD);
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T2" }, COORD);
    const [w1, w2] = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
    const worker = (session: string, ticket: string): Actor => ({ role: "worker", thread: "001", ticket, session });
    exec(s, { cmd: "session.failed", session: w1, reason: "spawn report lost after 3m" });
    expect(err(exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T1" }, worker(w1, "T1")))).toBe(`session ${w1} is no longer live`);
    expect(err(exec(s, { cmd: "progress", thread: "001", message: "x" }, worker(w1, "T1")))).toBe(`session ${w1} is no longer live`);
    exec(s, { cmd: "session.attached", session: w2, pane: "w1:p4" });
    expect(exec(s, { cmd: "ticket.claim", thread: "001", ticket: "T2" }, worker(w2, "T2")).ok).toBe(true);
    exec(s, { cmd: "session.signal", session: w2, signal: "ended" });
    expect(err(exec(s, { cmd: "ticket.done", thread: "001", ticket: "T2", summary: "x" }, worker(w2, "T2")))).toBe(`session ${w2} is no longer live`);
    expect(exec(s, { cmd: "session.signal", session: w2, signal: "idle" }, worker(w2, "T2"))).toMatchObject({ ok: true, events: [] });
    // any other actor session (here one the log does not know) passes
    expect(exec(s, { cmd: "progress", thread: "001", message: "x" }, COORD).ok).toBe(true);
  });

  test("attached with a pending bootstrap queues it as a notice for the session", () => {
    const s = threadWithTab();
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" }, COORD);
    const id = "00000000-0000-4000-8000-000000000001";
    expect(exec(s, { cmd: "session.attached", session: id, pane: "w1:p3", pending: "Start ticket T1 of thread 001 now." })).toMatchObject({
      ok: true,
      events: [
        { type: "session.attached", thread: "001", payload: { session: id, pane: "w1:p3" } },
        { type: "notice.queued", thread: "001", payload: { session: id, text: "Start ticket T1 of thread 001 now." } },
      ],
    });
    expect(s.sessions.get(id)!.notices).toEqual(["Start ticket T1 of thread 001 now."]);
  });

  test("open_main replaces a stale main session; tell reaches main and coordinators", () => {
    const s = threadWithTab();
    const m1 = newId();
    const m2 = newId();
    exec(s, { cmd: "session.open_main", session: m1, pane: "w1:p0" });
    const r = exec(s, { cmd: "session.open_main", session: m2, pane: "w1:p0" });
    expect(r.ok && r.events.map((e) => e.type)).toEqual(["session.ended", "session.created", "session.attached"]);
    expect(s.sessions.get(m1)!.status).toBe("ended");
    expect(exec(s, { cmd: "tell", target: "main", message: "hi" }, COORD)).toMatchObject({
      events: [{ type: "notice.queued", payload: { session: m2, text: "Message from coordinator: hi" } }],
    });
    expect(err(exec(s, { cmd: "tell", target: "001", message: "x" }))).toBe("no live coordinator for thread 001");
  });

  test("thread.new stores maxWorkers", () => {
    const s = stateOf(INIT);
    const r = exec(s, { cmd: "thread.new", title: "X", type: "bug", maxWorkers: 2 });
    expect(r.ok && r.events[0]).toMatchObject({ payload: { maxWorkers: 2 } });
    expect(() => CommandSchema.parse({ cmd: "thread.new", title: "X", type: "bug", maxWorkers: 0 })).toThrow();
  });

  test("signal carries contextTokens on idle and source on started only", () => {
    const s = threadWithTab();
    exec(s, { cmd: "worker.spawn", thread: "001", ticket: "T1" }, COORD);
    const id = "00000000-0000-4000-8000-000000000001";
    expect(exec(s, { cmd: "session.signal", session: id, signal: "idle", contextTokens: 42 })).toMatchObject({
      events: [{ type: "agent.idle", payload: { session: id, contextTokens: 42 } }],
    });
    expect(exec(s, { cmd: "session.signal", session: id, signal: "started", source: "compact", contextTokens: 9 })).toMatchObject({
      events: [{ type: "session.started", payload: { session: id, source: "compact" } }],
    });
    const started = exec(s, { cmd: "session.signal", session: id, signal: "started", contextTokens: 9 });
    expect(started.ok && started.events[0]!.payload).toEqual({ session: id });
  });
});
