import { expect, test } from "bun:test";
import { ConfigSchema } from "../../src/config/config.ts";
import { eligible, limitedUntilMs, selectProfile, statuslineText, usageFromStatusline, type ProfileUsage, type SelectInput, type UsageMap } from "../../src/agents/profiles.ts";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const sec = (ms: number) => Math.floor(ms / 1000);
const win = (used: number, inMin: number) => ({ used, resets_at: sec(NOW + inMin * 60_000) });
const u = (five: ReturnType<typeof win> | null, seven: ReturnType<typeof win> | null = null): ProfileUsage => ({ five_hour: five, seven_day: seven, seen_at: "2026-11-24T11:59:00Z" });
const input = (usage: UsageMap, over: Partial<SelectInput> = {}): SelectInput => ({
  profiles: ["a", "b", "c"],
  switchAt: { five_hour: 90, seven_day: 95 },
  usage,
  limited: {},
  nowMs: NOW,
  ...over,
});

const agentsOf = (a: unknown) => ConfigSchema.safeParse({ agents: a });
const P2 = [{ name: "personal", config_dir: "~/.claude-a" }, { name: "work", config_dir: "~/.claude-b" }];

test("config: profiles, switch_at and statusline parse; unset stays absent", () => {
  const ok = agentsOf({ claude: { profiles: P2, switch_at: { five_hour: 80 }, statusline: "~/bin/s.sh" } });
  expect(ok.success).toBe(true);
  if (ok.success) {
    expect(ok.data.agents.claude.profiles).toEqual(P2);
    expect(ok.data.agents.claude.switch_at).toEqual({ five_hour: 80, seven_day: 95 });
    expect(ok.data.agents.claude.statusline).toBe("~/bin/s.sh");
  }
  const none = agentsOf({});
  expect(none.success && none.data.agents.claude.profiles).toBeUndefined();
});

test("config: profile names must be lowercase words and unique", () => {
  expect(agentsOf({ claude: { profiles: [{ name: "Work", config_dir: "/x" }] } }).success).toBe(false);
  expect(agentsOf({ claude: { profiles: [{ name: "1a", config_dir: "/x" }] } }).success).toBe(false);
  const dup = agentsOf({ claude: { profiles: [{ name: "a", config_dir: "/x" }, { name: "a", config_dir: "/y" }] } });
  expect(dup.success).toBe(false);
  expect(JSON.stringify(dup.error?.issues)).toContain("duplicate profile name");
});

test("config: 2+ profiles refuse claude.config_dir and CLAUDE_CONFIG_DIR in agents.env, role env and tier env", () => {
  const refused = (a: object) => {
    const r = agentsOf({ claude: { profiles: P2 }, ...a });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("conflicts with agents.claude.profiles");
  };
  refused({ claude: { profiles: P2, config_dir: "/x" } });
  refused({ env: { CLAUDE_CONFIG_DIR: "/x" } });
  refused({ roles: { worker: { agent: "claude-code", env: { CLAUDE_CONFIG_DIR: "/x" } } } });
  refused({ complexity: { tiers: { big: { agent: "claude-code", env: { CLAUDE_CONFIG_DIR: "/x" } } } } });
});

test("config: a single profile is allowed next to CLAUDE_CONFIG_DIR env", () => {
  expect(agentsOf({ claude: { profiles: [P2[0]] }, env: { CLAUDE_CONFIG_DIR: "/x" } }).success).toBe(true);
});

test("select: the current profile sticks while eligible", () => {
  const r = selectProfile(input({ a: u(win(10, 200)), b: u(win(0, 10)) }, { current: "a" }));
  expect(r.name).toBe("a");
});

test("select: threshold edge: used == switch_at is not eligible, one below is", () => {
  expect(eligible("a", input({ a: u(win(90, 60)) }))).toBe(false);
  expect(eligible("a", input({ a: u(win(89.9, 60)) }))).toBe(true);
  expect(eligible("a", input({ a: u(win(10, 60), win(95, 600)) }))).toBe(false);
  expect(eligible("a", input({ a: u(win(10, 60), win(94, 600)) }))).toBe(true);
});

test("select: a window past its reset counts 0", () => {
  expect(eligible("a", input({ a: u(win(99, -1), win(99, -5)) }))).toBe(true);
});

test("select: an over-threshold current moves to the nearest five-hour reset", () => {
  const r = selectProfile(input({ a: u(win(95, 30)), b: u(win(50, 200)), c: u(win(50, 20)) }, { current: "a" }));
  expect(r.name).toBe("c");
});

test("select: no current picks by nearest reset, unknown resets rank after known ones", () => {
  expect(selectProfile(input({ a: undefined, b: u(win(70, 100)), c: u(win(10, 300)) })).name).toBe("b");
  // a has no data (0%, unknown reset): after the known ones, even though it is the least used
  expect(selectProfile(input({ b: u(win(80, 100)) }, { profiles: ["a", "b"] })).name).toBe("b");
});

test("select: ties on the reset go to the lowest five-hour use, then seven-day use, then config order", () => {
  const same = win(0, 100);
  expect(selectProfile(input({ a: u({ ...same, used: 40 }), b: u({ ...same, used: 20 }) }, { profiles: ["a", "b"] })).name).toBe("b");
  expect(selectProfile(input({ a: u({ ...same, used: 20 }, win(60, 900)), b: u({ ...same, used: 20 }, win(10, 900)) }, { profiles: ["a", "b"] })).name).toBe("b");
  expect(selectProfile(input({ a: u({ ...same, used: 20 }), b: u({ ...same, used: 20 }) }, { profiles: ["a", "b"] })).name).toBe("a");
});

test("select: profiles without data count 0% with an unknown reset", () => {
  expect(selectProfile(input({}, { profiles: ["a", "b"] })).name).toBe("a");
  expect(selectProfile(input({ a: u(win(95, 50)) }, { profiles: ["a", "b"] })).name).toBe("b");
});

test("select: a current that is not in the config is ignored", () => {
  expect(selectProfile(input({}, { profiles: ["a", "b"], current: "gone" })).name).toBe("a");
});

test("limited mark: lasts until the latest known reset, else 60 minutes", () => {
  const at = new Date(NOW).toISOString();
  expect(limitedUntilMs(at, undefined)).toBe(NOW + 3_600_000);
  // a 5h limit does not wait for the 7d reset
  const sw = { five_hour: 90, seven_day: 95 };
  expect(limitedUntilMs(at, u(win(99, 30), win(50, 600)), sw)).toBe(sec(NOW + 30 * 60_000) * 1000);
  expect(limitedUntilMs(at, u(win(99, 30), win(50, 600)))).toBe(sec(NOW + 30 * 60_000) * 1000);
  // the window over its threshold decides, even when the other resets sooner
  expect(limitedUntilMs(at, u(win(10, 30), win(97, 600)), sw)).toBe(sec(NOW + 600 * 60_000) * 1000);
  expect(limitedUntilMs(at, u(win(95, 300), win(97, 600)), sw)).toBe(sec(NOW + 600 * 60_000) * 1000);
  // a stale resets_at (before the mark) is ignored
  expect(limitedUntilMs(at, u(win(99, -30)))).toBe(NOW + 3_600_000);
  const i = input({ a: undefined }, { limited: { a: at } });
  expect(eligible("a", i)).toBe(false);
  expect(eligible("a", { ...i, nowMs: NOW + 3_600_001 })).toBe(true);
});

test("select: none eligible picks the profile that frees up first and says so", () => {
  const r = selectProfile(input({ a: u(win(95, 120)), b: u(win(95, 40)), c: u(win(10, 5), win(99, 900)) }));
  expect(r).toMatchObject({ name: "b", allLimited: true });
  expect(r.blocking).toEqual({ window: "5h", at: sec(NOW + 40 * 60_000) * 1000 });
  // a 7d block is named as such
  const r7 = selectProfile(input({ a: u(win(10, 5), win(99, 900)), b: u(win(10, 5), win(98, 1200)) }, { profiles: ["a", "b"] }));
  expect(r7).toMatchObject({ name: "a", allLimited: true, blocking: { window: "7d", at: sec(NOW + 900 * 60_000) * 1000 } });
  const at = new Date(NOW).toISOString();
  expect(selectProfile(input({}, { profiles: ["a"], limited: { a: at } })).blocking).toEqual({ window: "limit", at: NOW + 3_600_000 });
});

test("select: a limited mark with a later reset keeps a profile behind a nearer one", () => {
  const at = new Date(NOW - 60_000).toISOString();
  const r = selectProfile(input({ a: u(win(10, 400)), b: u(win(95, 30)) }, { profiles: ["a", "b"], limited: { a: at } }));
  expect(r).toMatchObject({ name: "b", allLimited: true });
});

test("statusline stdin: both windows, one window, none, garbage", () => {
  const both = usageFromStatusline(JSON.stringify({ session_id: "s1", rate_limits: { five_hour: { used_percentage: 25, resets_at: 1000 }, seven_day: { used_percentage: 48, resets_at: 2000 } } }));
  expect(both.five_hour).toEqual({ used: 25, resets_at: 1000 });
  expect(both.seven_day).toEqual({ used: 48, resets_at: 2000 });
  expect(both.session_id).toBe("s1");
  expect(usageFromStatusline(JSON.stringify({ rate_limits: { seven_day: { used_percentage: 5, resets_at: 9 } } })).five_hour).toBeNull();
  expect(usageFromStatusline("{}")).toMatchObject({ five_hour: null, seven_day: null });
  expect(usageFromStatusline("not json")).toMatchObject({ five_hour: null, seven_day: null });
  expect(usageFromStatusline(JSON.stringify({ rate_limits: { five_hour: { used_percentage: "x", resets_at: 1 } } })).five_hour).toBeNull();
});

test("statusline text shows only the parts that are present", () => {
  const t = (ms: number) => sec(ms);
  const full = statuslineText("personal", { five_hour: { used: 25, resets_at: t(NOW) }, seven_day: { used: 48, resets_at: t(NOW) }, seen_at: "" });
  expect(full).toMatch(/^personal · 5h 25% ↻\d\d:\d\d · 7d 48%$/);
  expect(statuslineText("work", { five_hour: null, seven_day: { used: 3.4, resets_at: 1 }, seen_at: "" })).toBe("work · 7d 3%");
  expect(statuslineText("work", { five_hour: null, seven_day: null, seen_at: "" })).toBe("work");
});
