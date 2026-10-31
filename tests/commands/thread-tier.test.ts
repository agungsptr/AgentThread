import { expect, test } from "bun:test";
import { ConfigSchema } from "../../src/config/config.ts";
import { handle, type HandleResult } from "../../src/commands/handler.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import type { Actor, EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { dueProposals } from "../../src/orchestration/tiers.ts";
import { renderBrief } from "../../src/render/brief.ts";
import { renderSub } from "../../src/render/markdown.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf } from "../helpers.ts";

const M = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MAIN: Actor = { role: "main", session: M };
const config = ConfigSchema.parse({
  agents: { roles: { coordinator: { agent: "codex" } }, complexity: { timeout: "10s", tiers: { big: { agent: "omp", model: "m1", effort: "high" }, small: { agent: "opencode" } } } },
});
let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const ctx = { root: "/repo", config, newId };

function apply(state: State, bodies: EventBody[], actor: Actor = USER): StoredEvent[] {
  return bodies.map((b) => {
    const ev = { ...b, seq: state.lastSeq + 1, ts: "2026-10-24T10:00:00.000Z", actor } as StoredEvent;
    applyEvent(state, ev);
    return ev;
  });
}

/** Runs a command like the daemon: apply its events, then react until nothing follows. Returns the command's result and all effects. */
function run(state: State, cmd: unknown, actor: Actor = MAIN): { r: HandleResult; effects: string[]; events: EventBody[] } {
  const r = handle(state, CommandSchema.parse(cmd), actor, ctx);
  const effects: string[] = [];
  const events: EventBody[] = [];
  if (!r.ok) return { r, effects, events };
  effects.push(...r.effects.map((e) => e.kind));
  events.push(...r.events);
  let fresh = apply(state, r.events, actor);
  for (let i = 0; i < 5 && fresh.length; i++) {
    const next = react(state, fresh, ctx);
    effects.push(...next.effects.map((e) => e.kind));
    events.push(...next.events);
    fresh = apply(state, next.events);
  }
  return { r, effects, events };
}

function base(mainStatus: "idle" | "active" = "idle"): State {
  n = 0;
  const s = stateOf(INIT, {
    type: "layout.registered",
    payload: { workspace: "w1", mainTab: "w1:t0", managerPane: "w1:p0", loggerPane: "w1:p1", herdrBin: "herdr" },
  });
  apply(s, [
    { type: "session.created", payload: { session: M, role: "main", agent: "claude-code", name: "m" } },
    { type: "session.attached", payload: { session: M, pane: "w1:p0" } },
    { type: "session.started", payload: { session: M } },
    ...(mainStatus === "active" ? [{ type: "session.active" as const, payload: { session: M } }] : []),
  ]);
  return s;
}

const NEW = { cmd: "thread.new", title: "Login", type: "feature" };
const types = (evs: EventBody[]) => evs.map((e) => e.type);

test("thread.new without a tier is unchanged: no proposal, a tab straight away", () => {
  const s = base();
  const { r, effects } = run(s, NEW);
  expect(r.ok && types(r.events)).toEqual(["thread.created"]);
  expect(effects).toEqual(["thread.dir.ensure", "herdr.tab.ensure"]);
  expect(s.threads.get("001")!.tierProposal).toBeUndefined();
});

test("thread.new with a tier proposes it: thread directory yes, tab no; the timer runs while main is idle", () => {
  const s = base();
  const { r, effects } = run(s, { ...NEW, tier: "big", reason: "touches auth" });
  expect(r.ok && r.events.map((e) => [e.type, e.payload])).toEqual([
    ["thread.created", expect.anything()],
    ["thread.tier_proposed", { tier: "big", reason: "touches auth" }],
    ["thread.tier_timer", { state: "running" }],
  ]);
  expect(effects).toEqual(["thread.dir.ensure"]);
  expect(s.threads.get("001")!.tierProposal).toMatchObject({ tier: "big", reason: "touches auth" });
});

test("while main is active the proposal starts paused", () => {
  const s = base("active");
  const { r } = run(s, { ...NEW, tier: "big", reason: "x" });
  expect(r.ok && types(r.events)).toEqual(["thread.created", "thread.tier_proposed"]);
  expect(s.threads.get("001")!.tierProposal!.runningSince).toBeUndefined();
});

test("an unknown tier is rejected with the configured list", () => {
  const s = base();
  const { r } = run(s, { ...NEW, tier: "huge", reason: "x" });
  expect(r).toEqual({ ok: false, error: "unknown tier huge; configured: big, small" });
});

test("reconcile never opens a tab for a proposed thread", () => {
  const s = base();
  run(s, { ...NEW, tier: "big", reason: "x" });
  run(s, { ...NEW, title: "Other" });
  const { r } = run(s, { cmd: "layout.reconcile" }, USER);
  expect(r.ok && r.effects.filter((e) => e.kind === "herdr.tab.ensure").map((e) => (e as { thread: string }).thread)).toEqual(["002"]);
});

test("choose before the timer fires gives exactly one coordinator, with that tier's agent", () => {
  const s = base();
  run(s, { ...NEW, tier: "big", reason: "x" });
  const { r, effects, events } = run(s, { cmd: "thread.choose", thread: "001", tier: "small" });
  expect(r.ok && r.events).toEqual([{ type: "thread.tier_chosen", thread: "001", payload: { tier: "small", auto: false } }]);
  expect(effects).toEqual(["herdr.tab.ensure"]);
  expect(events.some((e) => e.type === "notice.queued")).toBe(false);
  // the tab opens; exactly one coordinator follows
  const opened = apply(s, [{ type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } }]);
  const next = react(s, opened, ctx);
  expect(next.effects).toEqual([expect.objectContaining({ kind: "agent.spawn", role: "coordinator", run: { agent: "opencode" } })]);
  apply(s, next.events);
  expect([...s.sessions.values()].filter((x) => x.role === "coordinator")).toHaveLength(1);
});

test("choose of an unknown tier is rejected", () => {
  const s = base();
  run(s, { ...NEW, tier: "big", reason: "x" });
  expect(run(s, { cmd: "thread.choose", thread: "001", tier: "huge" }).r).toEqual({ ok: false, error: "unknown tier huge; configured: big, small" });
});

test("choose after the timer fired is rejected", () => {
  const s = base();
  run(s, { ...NEW, tier: "big", reason: "x" });
  const auto = run(s, { cmd: "thread.choose", thread: "001", tier: "big", auto: true }, USER);
  expect(auto.r.ok && auto.r.events).toEqual([{ type: "thread.tier_chosen", thread: "001", payload: { tier: "big", auto: true } }]);
  expect(run(s, { cmd: "thread.choose", thread: "001", tier: "small" }).r).toEqual({ ok: false, error: "thread 001 is not waiting for a tier" });
  expect(run(s, { cmd: "thread.cancel", thread: "001" }).r).toEqual({ ok: false, error: "thread 001 is not waiting for a tier" });
});

test("only the user (the daemon) may auto-choose", () => {
  const s = base();
  run(s, { ...NEW, tier: "big", reason: "x" });
  expect(run(s, { cmd: "thread.choose", thread: "001", tier: "big", auto: true }).r.ok).toBe(false);
});

test("--now skips the wait", () => {
  const s = base();
  const { r, effects } = run(s, { ...NEW, tier: "big", reason: "user asked", now: true });
  expect(r.ok && types(r.events)).toEqual(["thread.created", "thread.tier_proposed", "thread.tier_chosen"]);
  expect(effects).toEqual(["thread.dir.ensure", "herdr.tab.ensure"]);
  const t = s.threads.get("001")!;
  expect(t.tier).toBe("big");
  expect(t.tierProposal).toBeUndefined();
});

test("cancel marks the thread done and gives no coordinator", () => {
  const s = base();
  run(s, { ...NEW, tier: "big", reason: "x" });
  const { r, effects, events } = run(s, { cmd: "thread.cancel", thread: "001" });
  expect(r.ok && r.events).toEqual([{ type: "thread.status_changed", thread: "001", payload: { from: "open", to: "done", reason: "cancelled before start" } }]);
  expect(effects).toEqual([]);
  expect(events.some((e) => e.type === "session.created")).toBe(false);
  expect(s.threads.get("001")!.status).toBe("done");
  expect(s.threads.get("001")!.tierProposal).toBeUndefined();
  expect(run(s, { cmd: "thread.choose", thread: "001", tier: "big" }).r).toEqual({ ok: false, error: "thread 001 is not waiting for a tier" });
});

test("cancel unblocks a thread that depends on the cancelled one", () => {
  const s = base();
  run(s, { ...NEW, tier: "big", reason: "x" });
  run(s, { ...NEW, title: "After", dependsOn: ["001"] });
  expect(s.threads.get("002")!.status).toBe("blocked");
  const { r } = run(s, { cmd: "thread.cancel", thread: "001" });
  expect(r.ok && r.events.map((e) => [e.thread, e.payload])).toEqual([
    ["001", { from: "open", to: "done", reason: "cancelled before start" }],
    ["002", { from: "blocked", to: "open", reason: "dependencies done" }],
  ]);
  expect(s.threads.get("002")!.status).toBe("open");
});

test("a proposal runs and comes due with no main session at all", () => {
  n = 0;
  const s = stateOf(INIT);
  const { r } = run(s, { ...NEW, tier: "big", reason: "x" }, USER);
  expect(r.ok && types(r.events)).toEqual(["thread.created", "thread.tier_proposed", "thread.tier_timer"]);
  expect(dueProposals(s, Date.parse("2026-10-24T10:00:10.000Z"), 10_000)).toEqual(["001"]);
});

test("choose and cancel are rejected for a thread that was never proposed", () => {
  const s = base();
  run(s, NEW);
  expect(run(s, { cmd: "thread.choose", thread: "001", tier: "big" }).r).toEqual({ ok: false, error: "thread 001 is not waiting for a tier" });
  expect(run(s, { cmd: "thread.cancel", thread: "001" }).r).toEqual({ ok: false, error: "thread 001 is not waiting for a tier" });
});

test("brief.md and sub.thread.md show the tier line", () => {
  const s = base();
  run(s, { ...NEW, tier: "big", reason: "touches auth" });
  run(s, { cmd: "thread.choose", thread: "001", tier: "big" });
  const t = s.threads.get("001")!;
  const line = "Tier: big (omp m1 high), chosen by user: touches auth";
  expect(renderBrief({ thread: t, sessions: [], config })).toContain(line);
  expect(renderSub(t, [], config)).toContain(line);

  const a = base();
  run(a, { ...NEW, tier: "small", reason: "a typo" });
  run(a, { cmd: "thread.choose", thread: "001", tier: "small", auto: true }, USER);
  expect(renderBrief({ thread: a.threads.get("001")!, sessions: [], config })).toContain("Tier: small (opencode default default), chosen by auto: a typo");

  const none = base();
  run(none, NEW);
  expect(renderBrief({ thread: none.threads.get("001")!, sessions: [], config })).not.toContain("Tier:");
});
