import { expect, test } from "bun:test";
import { adapterFor } from "../../src/agents/adapters.ts";
import { hookSettings } from "../../src/agents/claude.ts";
import type { ProfileUsage, UsageMap } from "../../src/agents/profiles.ts";
import { handle } from "../../src/commands/handler.ts";
import { ConfigSchema, DEFAULT_CONFIG, type Config } from "../../src/config/config.ts";
import type { EventBody, StoredEvent } from "../../src/domain/types.ts";
import { profilePicker } from "../../src/orchestration/profile-pick.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { spawnCoordinator, spawnReplacement, spawnWorker, tabEnv } from "../../src/orchestration/sessions.ts";
import { sweep } from "../../src/orchestration/sweep.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf, threadCreated } from "../helpers.ts";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const NOW_ISO = new Date(NOW).toISOString();
const T = (min: number) => Math.floor((NOW + min * 60_000) / 1000);
const win = (used: number, inMin: number) => ({ used, resets_at: T(inMin) });
const u = (five: ReturnType<typeof win> | null, seven: ReturnType<typeof win> | null = null): ProfileUsage => ({ five_hour: five, seven_day: seven, seen_at: NOW_ISO });
const cfg = (): Config => ConfigSchema.parse({ agents: { claude: { profiles: [{ name: "personal", config_dir: "~/.claude-a" }, { name: "work", config_dir: "/abs/.claude-b" }] } } });
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const C2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const M = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const W = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ids = (...v: string[]) => {
  let i = 0;
  return () => v[i++] ?? `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
};

function apply(state: State, ts: string, ...bodies: EventBody[]): StoredEvent[] {
  return bodies.map((b) => {
    const ev = { ...b, seq: state.lastSeq + 1, ts, actor: USER } as StoredEvent;
    applyEvent(state, ev);
    return ev;
  });
}
const picker = (state: State, usage: UsageMap, config = cfg()) => profilePicker(state, config, { usage: () => usage, now: () => NOW })!;

/** Thread 001 with a coordinator on `profile`, attached and past its first turn, plus a live main on `mainProfile`. */
function running(profile: string, mainProfile?: string, createdAt = "2026-11-24T10:00:00.000Z"): State {
  const s = stateOf(INIT, threadCreated("001", { status: "in_progress" }), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
  apply(
    s,
    createdAt,
    { type: "session.created", payload: { session: M, role: "main", agent: "claude-code", name: "m", ...(mainProfile ? { profile: mainProfile } : {}) } },
    { type: "session.attached", payload: { session: M, pane: "w1:p0" } },
    { type: "session.started", payload: { session: M } },
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c", profile } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    { type: "session.started", thread: "001", payload: { session: C } },
    { type: "session.active", thread: "001", payload: { session: C } },
    { type: "agent.idle", thread: "001", payload: { session: C } },
  );
  return s;
}

test("the picker: no switching below 2 profiles", () => {
  expect(profilePicker(stateOf(INIT), DEFAULT_CONFIG, { usage: () => ({}) })).toBeUndefined();
  const one = ConfigSchema.parse({ agents: { claude: { profiles: [{ name: "a", config_dir: "/a" }] } } });
  expect(profilePicker(stateOf(INIT), one, { usage: () => ({}) })).toBeUndefined();
});

test("the picker records a first choice once, then nothing while the current stays", () => {
  const s = stateOf(INIT);
  const p = picker(s, {});
  expect(p.name()).toBe("personal");
  expect(p.take()).toEqual([{ type: "profile.switched", payload: { to: "personal", reason: "first launch" } }]);
  expect(p.take()).toEqual([]);
  apply(s, NOW_ISO, { type: "profile.switched", payload: { to: "personal", reason: "first launch" } });
  expect(s.profiles.current).toBe("personal");
  expect(picker(s, { personal: u(win(10, 60)) }).take()).toEqual([]);
});

test("the picker switches when the current profile is over its threshold, and warns main when none is eligible", () => {
  const s = running("personal", "personal");
  apply(s, NOW_ISO, { type: "profile.switched", payload: { to: "personal", reason: "first launch" } });
  const p = picker(s, { personal: u(win(95, 60)), work: u(win(20, 200)) });
  expect(p.name()).toBe("work");
  expect(p.take()).toEqual([{ type: "profile.switched", payload: { from: "personal", to: "work", reason: "usage limit" } }]);
  const bad = picker(s, { personal: u(win(95, 90)), work: u(win(92, 30)) });
  expect(bad.name()).toBe("work");
  const [sw, notice] = bad.take();
  expect(sw).toMatchObject({ type: "profile.switched", payload: { from: "personal", to: "work", reason: "all profiles near their limits" } });
  expect(notice).toMatchObject({ type: "notice.queued", payload: { session: M, text: expect.stringMatching(/^All Claude profiles are near their limits; using work \(5h resets at \d\d:\d\d\)\.$/) } });
});

test("spawns carry the profile in session.created and the agent.spawn effect, and record the switch first", () => {
  const s = running("personal");
  const t = s.threads.get("001")!;
  const p = picker(s, { personal: u(win(99, 60)), work: u(win(1, 100)) });
  const ctx = { root: "/repo", config: cfg(), newId: ids("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"), profile: p };
  const coord = spawnCoordinator(t, ctx);
  expect(coord.events.map((e) => e.type)).toEqual(["profile.switched", "session.created"]);
  expect(coord.events[1]).toMatchObject({ payload: { role: "coordinator", profile: "work" } });
  expect(coord.effects[0]).toMatchObject({ kind: "agent.spawn", profile: "work" });
  const worker = spawnWorker(s, t, "T1", ctx);
  expect(worker.events.map((e) => e.type)).toEqual(["session.created"]); // already recorded by the first launch
  expect(worker.effects[0]).toMatchObject({ profile: "work" });
  const repl = spawnReplacement(t, s.sessions.get(C)!, ctx, { bootstrap: "handoff" });
  expect(repl.events[0]).toMatchObject({ type: "session.created", payload: { profile: "work", replaces: C } });
  expect(repl.effects[0]).toMatchObject({ profile: "work" });
});

test("a session on another agent gets no profile", () => {
  const s = running("personal");
  const config = ConfigSchema.parse({ agents: { roles: { worker: { agent: "codex" } }, claude: { profiles: cfg().agents.claude.profiles! } } });
  const w = spawnWorker(s, s.threads.get("001")!, "T1", { root: "/r", config, newId: ids(W), profile: picker(s, {}, config) });
  expect(w.events[0]).toMatchObject({ type: "session.created", payload: { agent: "codex" } });
  expect((w.events[0] as { payload: { profile?: string } }).payload.profile).toBeUndefined();
  expect((w.effects[0] as { profile?: string }).profile).toBeUndefined();
});

test("the claude adapter: settings carry the statusLine and the StopFailure hook, and CLAUDE_CONFIG_DIR is expanded", () => {
  const launched = adapterFor("claude-code").launch({ role: "worker", run: { agent: "claude-code" }, config: cfg(), root: "/my root", profile: "personal", env: { HOME: "/home/u" } });
  expect(launched.env).toEqual({ CLAUDE_CONFIG_DIR: "/home/u/.claude-a" });
  const settings = JSON.parse(launched.args[launched.args.indexOf("--settings") + 1]!);
  expect(settings.statusLine).toMatchObject({ type: "command", refreshInterval: 60 });
  expect(settings.statusLine.command).toContain("statusline --profile 'personal' --root '/my root'");
  expect(settings.hooks.StopFailure).toEqual([{ matcher: "rate_limit", hooks: [{ type: "command", command: expect.stringContaining("event rate-limited --profile 'personal'") }] }]);
  expect(Object.keys(settings.hooks)).toContain("Stop");
  // not autonomous: the same settings
  const manual = adapterFor("claude-code").launch({ role: "worker", run: { agent: "claude-code" }, config: ConfigSchema.parse({ agents: { autonomous: false, claude: { profiles: cfg().agents.claude.profiles! } } }), root: "/r", profile: "work" });
  expect(manual.env).toEqual({ CLAUDE_CONFIG_DIR: "/abs/.claude-b" });
  expect(JSON.parse(manual.args[manual.args.indexOf("--settings") + 1]!).statusLine).toBeDefined();
});

test("without a profile the launch is exactly what it was", () => {
  const l = adapterFor("claude-code").launch({ role: "worker", run: { agent: "claude-code" }, config: DEFAULT_CONFIG, root: "/r" });
  expect(l.env).toEqual({});
  const settings = JSON.parse(l.args[l.args.indexOf("--settings") + 1]!);
  expect(settings.statusLine).toBeUndefined();
  expect(settings.hooks.StopFailure).toBeUndefined();
  expect(hookSettings()).toEqual({ hooks: expect.objectContaining({ Stop: expect.anything() }) });
  expect(Object.keys(hookSettings().hooks)).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "PreCompact", "SessionEnd"]);
});

test("a thread tab's env carries the chosen profile's config dir", () => {
  const s = stateOf(INIT);
  const env = tabEnv({ id: "001" }, { root: "/repo", config: cfg(), profile: picker(s, { personal: u(win(95, 10)) }, cfg()) });
  expect(env.CLAUDE_CONFIG_DIR).toMatch(/\/abs\/\.claude-b$/);
  expect(tabEnv({ id: "001" }, { root: "/repo", config: DEFAULT_CONFIG }).CLAUDE_CONFIG_DIR).toBeDefined();
});

const limitCmd = (state: State, actor: Parameters<typeof handle>[2], profile = "personal", config = cfg(), p?: ReturnType<typeof picker>) => handle(state, { cmd: "profile.limit", profile }, actor, { root: "/repo", config, ...(p ? { profile: p } : {}) });

test("profile.limit records the mark; a worker's coordinator is told to return the ticket, once per worker", () => {
  const s = running("personal");
  apply(s, NOW_ISO, { type: "ticket.created", thread: "001", payload: { ticket: "T1", title: "t", scope: ["t"] } });
  const actor = { role: "worker", thread: "001", ticket: "T1", session: W } as const;
  apply(s, NOW_ISO, { type: "session.created", thread: "001", payload: { session: W, role: "worker", agent: "claude-code", name: "w", ticket: "T1", profile: "personal" } });
  const r = limitCmd(s, actor);
  expect(r.ok && r.events).toEqual([
    { type: "profile.limited", payload: { profile: "personal", at: expect.any(String) } },
    { type: "profile.notified", payload: { session: W, profile: "personal" } },
    { type: "notice.queued", thread: "001", payload: { session: C, text: 'The worker for ticket T1 hit the usage limit of Claude profile personal. Return the ticket so a fresh worker continues on another profile: agt ticket return 001/T1 "<what is left>".' } },
  ]);
  if (r.ok) apply(s, NOW_ISO, ...r.events);
  expect(s.profiles.limited.personal).toBeDefined();
  expect(s.sessions.get(C)!.notices).toHaveLength(1);
  // the hook firing again: no new mark while it holds, no second notice for the worker, even after the first was delivered
  apply(s, NOW_ISO, { type: "notice.delivered", thread: "001", payload: { session: C, count: 1 } });
  const live = profilePicker(s, cfg(), { usage: () => ({}), now: Date.now })!; // the handler stamps real time
  const again = limitCmd(s, actor, "personal", cfg(), live);
  expect(again.ok && again.events).toEqual([]);
  // another worker of the same profile is told
  const W2 = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  apply(s, NOW_ISO, { type: "session.created", thread: "001", payload: { session: W2, role: "worker", agent: "claude-code", name: "w2", ticket: "T2", profile: "personal" } });
  const other = limitCmd(s, { role: "worker", thread: "001", ticket: "T2", session: W2 }, "personal", cfg(), live);
  expect(other.ok && other.events.map((e) => e.type)).toEqual(["profile.notified", "notice.queued"]);
});

test("profile.limit from a coordinator or an unknown profile only marks / is ignored; a worker is not 'authored'", () => {
  const s = running("personal");
  const c = limitCmd(s, { role: "coordinator", thread: "001", session: C });
  expect(c.ok && c.events.map((e) => e.type)).toEqual(["profile.limited"]);
  expect(c.ok && c.actor).toBeUndefined();
  const unknown = limitCmd(s, { role: "coordinator", thread: "001", session: C }, "nope");
  expect(unknown.ok && unknown.events).toEqual([]);
  const single = limitCmd(s, USER, "personal", DEFAULT_CONFIG);
  expect(single.ok && single.events).toEqual([]);
});

test("a mark that expired is recorded again", () => {
  const s = running("personal");
  apply(s, new Date(NOW - 2 * 3_600_000).toISOString(), { type: "profile.limited", payload: { profile: "personal", at: new Date(NOW - 2 * 3_600_000).toISOString() } });
  const r = limitCmd(s, USER, "personal", cfg(), picker(s, {}));
  expect(r.ok && r.events.map((e) => e.type)).toEqual(["profile.limited"]);
});

test("profile.choose answers with the profile and dir, and records the switch; user only", () => {
  const s = stateOf(INIT);
  const r = handle(s, { cmd: "profile.choose" }, USER, { root: "/repo", config: cfg(), profile: picker(s, { personal: u(win(95, 10)) }) });
  expect(r).toMatchObject({ ok: true, result: { profile: "work", config_dir: "/abs/.claude-b" }, events: [{ type: "profile.switched", payload: { to: "work", reason: "first launch" } }] });
  expect(handle(s, { cmd: "profile.choose" }, { role: "worker" }, { root: "/repo", config: cfg() }).ok).toBe(false);
  const none = handle(s, { cmd: "profile.choose" }, USER, { root: "/repo", config: DEFAULT_CONFIG });
  expect(none).toMatchObject({ ok: true, result: null });
  const one = ConfigSchema.parse({ agents: { claude: { profiles: [{ name: "solo", config_dir: "/solo" }] } } });
  expect(handle(s, { cmd: "profile.choose" }, USER, { root: "/repo", config: one })).toMatchObject({ ok: true, result: { profile: "solo", config_dir: "/solo" } });
});

test("session.open_main records the profile on main", () => {
  const s = stateOf(INIT);
  const r = handle(s, { cmd: "session.open_main", session: M, pane: "w1:p0", profile: "work" }, USER, { root: "/repo", config: cfg() });
  if (r.ok) apply(s, NOW_ISO, ...r.events);
  expect(s.sessions.get(M)!.profile).toBe("work");
});

test("sweep: a coordinator whose profile passed its threshold is asked to rotate, once, with reason usage limit", () => {
  const s = running("personal");
  const usage = { personal: u(win(95, 90)), work: u(win(5, 200)) };
  const r = sweep(s, NOW_ISO, { root: "/repo", config: cfg(), newId: ids(C2), profile: picker(s, usage) });
  expect(r.events.map((e) => e.type)).toEqual(["profile.switched", "session.rotation_requested"]);
  expect(r.events[1]).toMatchObject({ thread: "001", payload: { session: C, reason: "usage limit" } });
  // once a rotation is requested the coordinator is left alone (a handoff in progress)
  apply(s, NOW_ISO, ...r.events);
  const again = sweep(s, NOW_ISO, { root: "/repo", config: cfg(), newId: ids(C2), profile: picker(s, usage) });
  expect(again.events.filter((e) => e.type === "session.rotation_requested")).toEqual([]);
});

test("sweep: no rotation while eligible, with nowhere better to go, on a rate_limit mark of another profile, or within 10 minutes of a replacement", () => {
  const ok = running("personal");
  expect(sweep(ok, NOW_ISO, { root: "/repo", config: cfg(), newId: ids(), profile: picker(ok, { personal: u(win(50, 90)) }) }).events).toEqual([]);
  // over the threshold but the choice is the same profile (every profile is exhausted and this frees up first)
  const stuck = running("personal");
  expect(sweep(stuck, NOW_ISO, { root: "/repo", config: cfg(), newId: ids(), profile: picker(stuck, { personal: u(win(95, 10)), work: u(win(95, 90)) }) }).events.some((e) => e.type === "session.rotation_requested")).toBe(false);
  // a rate_limit mark alone makes a profile exhausted
  const limited = running("personal");
  apply(limited, NOW_ISO, { type: "profile.limited", payload: { profile: "personal", at: NOW_ISO } });
  expect(sweep(limited, NOW_ISO, { root: "/repo", config: cfg(), newId: ids(), profile: picker(limited, {}) }).events.some((e) => e.type === "session.rotation_requested")).toBe(true);
  // a coordinator replaced 5 minutes ago is not rotated again
  const recent = running("personal");
  apply(recent, new Date(NOW - 5 * 60_000).toISOString(), { type: "session.created", thread: "001", payload: { session: C2, role: "coordinator", agent: "claude-code", name: "c2", profile: "personal", replaces: C } });
  apply(recent, new Date(NOW - 4 * 60_000).toISOString(), { type: "session.rotated", thread: "001", payload: { session: C, reason: "age" } }, { type: "session.attached", thread: "001", payload: { session: C2, pane: "w1:p5" } }, { type: "session.started", thread: "001", payload: { session: C2 } });
  expect(sweep(recent, NOW_ISO, { root: "/repo", config: cfg(), newId: ids(), profile: picker(recent, { personal: u(win(95, 90)), work: u(win(5, 200)) }) }).events.some((e) => e.type === "session.rotation_requested")).toBe(false);
});

test("the replacement of a usage rotation launches on the newly chosen profile", () => {
  const s = running("personal");
  const usage = { personal: u(win(95, 90)), work: u(win(5, 200)) };
  const sw = sweep(s, NOW_ISO, { root: "/repo", config: cfg(), newId: ids(C2), profile: picker(s, usage) });
  const stored = apply(s, NOW_ISO, ...sw.events);
  const out = react(s, stored, { root: "/repo", config: cfg(), newId: ids(C2), profile: picker(s, usage) });
  expect(out.events.some((e) => e.type === "notice.queued" && e.payload.session === C && e.payload.text.startsWith("HANDOFF REQUEST"))).toBe(true);
  const handoff = apply(s, NOW_ISO, { type: "handoff.submitted", thread: "001", payload: { content: "x", generated: true } });
  const next = react(s, handoff, { root: "/repo", config: cfg(), newId: ids(C2), profile: picker(s, usage) });
  expect(next.events.find((e) => e.type === "session.created")).toMatchObject({ payload: { replaces: C, profile: "work" } });
  expect(next.effects.find((e) => e.kind === "agent.spawn")).toMatchObject({ profile: "work" });
});

test("sweep: main is told once, only to restart later", () => {
  const s = running("work", "personal");
  const usage = { personal: u(win(96, 90)), work: u(win(5, 200)) };
  const r = sweep(s, NOW_ISO, { root: "/repo", config: cfg(), newId: ids(), profile: picker(s, usage) });
  const notice = r.events.find((e) => e.type === "notice.queued");
  expect(notice?.type === "notice.queued" && notice.payload.session === M && notice.payload.text).toContain("Restart main later with agt start");
  expect(r.events.some((e) => e.type === "session.rotation_requested")).toBe(false);
  apply(s, NOW_ISO, ...r.events);
  expect(sweep(s, NOW_ISO, { root: "/repo", config: cfg(), newId: ids(), profile: picker(s, usage) }).events.filter((e) => e.type === "notice.queued")).toEqual([]);
});

test("a single profile or none: the sweep does nothing about profiles", () => {
  const s = running("personal");
  expect(sweep(s, NOW_ISO, { root: "/repo", config: DEFAULT_CONFIG, newId: ids() }).events).toEqual([]);
});

test("sweep: when every profile is over its threshold the coordinator is not rotated (no ping-pong)", () => {
  const s = running("personal");
  const usage = { personal: u(win(95, 90)), work: u(win(96, 30)) };
  const r = sweep(s, NOW_ISO, { root: "/repo", config: cfg(), newId: ids(), profile: picker(s, usage) });
  expect(picker(s, usage).selection().allLimited).toBe(true);
  expect(r.events.some((e) => e.type === "session.rotation_requested")).toBe(false);
});

test("a tab ensure and a spawn in one decision still record the profile switch", () => {
  const s = stateOf(INIT, threadCreated("001", { status: "in_progress" }), { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } });
  const p = picker(s, { personal: u(win(95, 10)) });
  const env = tabEnv({ id: "001" }, { root: "/repo", config: cfg(), profile: p });
  expect(env.CLAUDE_CONFIG_DIR).toBe("/abs/.claude-b");
  const c = spawnCoordinator(s.threads.get("001")!, { root: "/repo", config: cfg(), newId: ids(C2), profile: p });
  expect(c.events.map((e) => e.type)).toEqual(["profile.switched", "session.created"]);
});
