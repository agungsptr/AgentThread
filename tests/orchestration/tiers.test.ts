import { expect, test } from "bun:test";
import { ConfigSchema } from "../../src/config/config.ts";
import type { EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { rotateCoordinator, spawnReplacement } from "../../src/orchestration/sessions.ts";
import { renderBrief } from "../../src/render/brief.ts";
import { renderSub } from "../../src/render/markdown.ts";
import { dueProposals } from "../../src/orchestration/tiers.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, threadCreated } from "../helpers.ts";

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const M = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const T0 = Date.parse("2026-10-24T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const config = ConfigSchema.parse({
  agents: { roles: { coordinator: { agent: "codex" } }, complexity: { timeout: "10s", tiers: { big: { agent: "omp", model: "m1", effort: "high" }, small: { agent: "opencode" } } } },
});
let n = 0;
const ctx = (c = config) => ({ root: "/repo", config: c, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` });

function apply(state: State, ts: string, ...bodies: EventBody[]): StoredEvent[] {
  return bodies.map((b) => {
    const ev = { ...b, seq: state.lastSeq + 1, ts, actor: USER } as StoredEvent;
    applyEvent(state, ev);
    return ev;
  });
}

/** A proposed thread 001 (tier big), main session M idle in w1:p0, and a registered layout. */
function proposed(running = true): State {
  n = 0;
  const s = stateOf(INIT);
  apply(
    s,
    at(0),
    { type: "layout.registered", payload: { workspace: "w1", mainTab: "w1:t0", managerPane: "w1:p0", loggerPane: "w1:p1", herdrBin: "herdr" } },
    { type: "session.created", payload: { session: M, role: "main", agent: "claude-code", name: "m" } },
    { type: "session.attached", payload: { session: M, pane: "w1:p0" } },
    { type: "session.started", payload: { session: M } },
    threadCreated("001"),
    { type: "thread.tier_proposed", thread: "001", payload: { tier: "big", reason: "touches auth" } },
    ...(running ? [{ type: "thread.tier_timer" as const, thread: "001", payload: { state: "running" as const } }] : []),
  );
  return s;
}

test("dueProposals: running and due, running and not due, paused", () => {
  const s = proposed();
  expect(dueProposals(s, T0 + 10_000, 10_000)).toEqual(["001"]);
  expect(dueProposals(s, T0 + 9_999, 10_000)).toEqual([]);
  expect(dueProposals(proposed(false), T0 + 60_000, 10_000)).toEqual([]);
  expect(s.threads.get("001")!.tierProposal).toEqual({ tier: "big", reason: "touches auth", runningSince: at(0) });
});

test("main working pauses the timer; main idle restarts it with a full timeout", () => {
  const s = proposed();
  const active = apply(s, at(5_000), { type: "session.active", payload: { session: M } });
  const r1 = react(s, active, ctx());
  expect(r1.events).toEqual([{ type: "thread.tier_timer", thread: "001", payload: { state: "paused" } }]);
  apply(s, at(5_000), ...r1.events);
  expect(s.threads.get("001")!.tierProposal!.runningSince).toBeUndefined();
  expect(dueProposals(s, T0 + 60_000, 10_000)).toEqual([]);
  // a second active while paused changes nothing
  expect(react(s, apply(s, at(6_000), { type: "session.active", payload: { session: M } }), ctx()).events).toEqual([]);

  const idle = apply(s, at(30_000), { type: "agent.idle", payload: { session: M } });
  const r2 = react(s, idle, ctx());
  expect(r2.events).toEqual([{ type: "thread.tier_timer", thread: "001", payload: { state: "running" } }]);
  apply(s, at(30_000), ...r2.events);
  expect(dueProposals(s, T0 + 39_999, 10_000)).toEqual([]);
  expect(dueProposals(s, T0 + 40_000, 10_000)).toEqual(["001"]);
});

test("a chosen tier opens the tab; the coordinator spawns on tab_opened with that tier's agent", () => {
  const s = proposed();
  const chosen = apply(s, at(1_000), { type: "thread.tier_chosen", thread: "001", payload: { tier: "small", auto: false } });
  expect(s.threads.get("001")!.tier).toBe("small");
  expect(s.threads.get("001")!.tierProposal).toBeUndefined();
  const r = react(s, chosen, ctx());
  expect(r.events).toEqual([]);
  expect(r.effects).toEqual([expect.objectContaining({ kind: "herdr.tab.ensure", thread: "001", env: expect.objectContaining({ AGT_AGENT: "opencode" }) })]);
  const opened = apply(s, at(1_100), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
  const spawned = react(s, opened, ctx());
  expect(spawned.events.filter((e) => e.type === "session.created")).toHaveLength(1);
  expect(spawned.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", role: "coordinator", run: { agent: "opencode" } })]);
});

test("an auto-accepted tier notifies main with the exact text", () => {
  const s = proposed();
  const chosen = apply(s, at(10_000), { type: "thread.tier_chosen", thread: "001", payload: { tier: "big", auto: true } });
  const r = react(s, chosen, ctx());
  expect(r.events).toEqual([
    { type: "notice.queued", payload: { session: M, text: "Thread 001 started with tier big (omp m1 high) after 10s without a choice." } },
  ]);
  expect(r.effects.map((e) => e.kind)).toEqual(["herdr.tab.ensure"]);
  const small = proposed();
  const r2 = react(small, apply(small, at(10_000), { type: "thread.tier_chosen", thread: "001", payload: { tier: "small", auto: true } }), ctx());
  expect(r2.events[0]).toMatchObject({ payload: { text: "Thread 001 started with tier small (opencode default default) after 10s without a choice." } });
});

test("tab_opened never spawns a coordinator for a proposed thread", () => {
  const s = proposed();
  const opened = apply(s, at(1_000), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
  expect(react(s, opened, ctx())).toEqual({ events: [], effects: [] });
});

function withCoordinator(tier: string): State {
  const s = proposed();
  apply(
    s,
    at(1_000),
    { type: "thread.tier_chosen", thread: "001", payload: { tier, auto: false } },
    { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } },
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "omp", model: "m1", effort: "high", name: "c" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
  );
  return s;
}

test("a replacement coordinator keeps the tier", () => {
  const s = withCoordinator("big");
  const r = spawnReplacement(s.threads.get("001")!, s.sessions.get(C)!, ctx(), { bootstrap: "handoff" });
  expect(r.effects[0]).toMatchObject({ kind: "agent.spawn", run: { agent: "omp", model: "m1", effort: "high" } });
});

test("editing the tier's model, then rotating, keeps the old model", () => {
  const s = withCoordinator("big");
  const edited = ConfigSchema.parse({
    agents: { roles: { coordinator: { agent: "codex" } }, complexity: { tiers: { big: { agent: "omp", model: "m2", effort: "low" } } } },
  });
  const r = rotateCoordinator(s, s.sessions.get(C)!, "turns", ctx(edited));
  expect(r.events.find((e) => e.type === "session.created")!.payload).toMatchObject({ agent: "omp", model: "m1", effort: "high", replaces: C });
  expect(r.effects[0]).toMatchObject({ kind: "agent.spawn", run: { agent: "omp", model: "m1", effort: "high" } });
});

test("the Tier line shows the running coordinator session; before one exists, the config", () => {
  const s = withCoordinator("big");
  const edited = ConfigSchema.parse({ agents: { complexity: { tiers: { big: { agent: "omp", model: "m2" } } } } });
  const t = s.threads.get("001")!;
  const sessions = [...s.sessions.values()];
  expect(renderBrief({ thread: t, sessions, config: edited })).toContain("Tier: big (omp m1 high), chosen by user: touches auth");
  expect(renderSub(t, sessions, edited)).toContain("Tier: big (omp m1 high), chosen by user: touches auth");
  expect(renderBrief({ thread: t, sessions: [], config: edited })).toContain("Tier: big (omp m2 default), chosen by user: touches auth");
});

test("a notice delivered to main pauses the timer", () => {
  const s = proposed();
  apply(s, at(1_000), { type: "notice.queued", payload: { session: M, text: "hi" } });
  const r = react(s, apply(s, at(2_000), { type: "notice.delivered", payload: { session: M, count: 1 } }), ctx());
  expect(r.events).toEqual([{ type: "thread.tier_timer", thread: "001", payload: { state: "paused" } }]);
});

test("main session.started (idle) and session.ended resume a paused timer", () => {
  const s = proposed(false);
  // a fresh main session: started leaves it idle at the prompt
  apply(s, at(1_000), { type: "session.ended", payload: { session: M } });
  const M2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  apply(s, at(1_000), { type: "session.created", payload: { session: M2, role: "main", agent: "claude-code", name: "m" } });
  apply(s, at(1_000), { type: "thread.tier_timer", thread: "001", payload: { state: "paused" } });
  const started = react(s, apply(s, at(2_000), { type: "session.started", payload: { session: M2 } }), ctx());
  expect(started.events).toEqual([{ type: "thread.tier_timer", thread: "001", payload: { state: "running" } }]);

  const p = proposed(false);
  apply(p, at(1_000), { type: "session.active", payload: { session: M } });
  const ended = react(p, apply(p, at(2_000), { type: "session.ended", payload: { session: M } }), ctx());
  expect(ended.events).toEqual([{ type: "thread.tier_timer", thread: "001", payload: { state: "running" } }]);
});

test("with the tier deleted from config, the replacement uses roles.coordinator", () => {
  const s = withCoordinator("big");
  const without = ConfigSchema.parse({ agents: { roles: { coordinator: { agent: "codex" } } } });
  const r = spawnReplacement(s.threads.get("001")!, s.sessions.get(C)!, ctx(without), { bootstrap: "handoff" });
  expect(r.effects[0]).toMatchObject({ kind: "agent.spawn", run: { agent: "codex" } });
  expect((r.events[0]!.payload as Record<string, unknown>).agent).toBe("codex");
});

test("main's prompt lists the configured tiers; without tiers the lines are left out", async () => {
  const { systemPrompt } = await import("../../src/agents/prompts.ts");
  const p = systemPrompt({ root: "/repo", role: "main", config });
  expect(p).toContain(
    'Before creating a thread, judge its complexity and pick one tier from: big (omp m1 high), small (opencode default default). Create it with agt thread new … --tier <name> --reason "<why>", tell the user the tier and why, say it starts in 10s unless they choose another, then end your turn.',
  );
  expect(p).toContain("If the user picks another tier, run agt thread choose <id> --tier <name>; if they want to stop, agt thread cancel <id>. If the user named a tier themselves, add --now.");
  expect(systemPrompt({ root: "/repo", role: "main", config: ConfigSchema.parse({}) })).not.toContain("tier");
});
