import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statuslineLine } from "../../src/cli/statusline.ts";
import { formatUsage, usageRows } from "../../src/cli/profile-usage.ts";
import { ConfigSchema } from "../../src/config/config.ts";
import { parseUsage, usageFile, writeUsage } from "../../src/agents/profiles.ts";
import { emptyState } from "../../src/state/projection.ts";
import { isolatedConfigHome } from "../helpers.ts";

const NOW = new Date("2026-11-24T12:00:00Z");
const PROFILES = "agents:\n  claude:\n    profiles:\n      - { name: personal, config_dir: /a }\n      - { name: work, config_dir: /b }\n      - { name: p, config_dir: /c }\n";
/** A root whose config lists the profiles the tests use. */
const root = (extra = "") => {
  const r = realpathSync(mkdtempSync(join(tmpdir(), "agt-sl-")));
  mkdirSync(join(r, ".agentthread"), { recursive: true });
  writeFileSync(join(r, ".agentthread", "config.yaml"), extra || PROFILES);
  return r;
};
const env = () => ({ XDG_CONFIG_HOME: isolatedConfigHome(), HOME: "/nonexistent" });
const stdin = (five?: [number, number], seven?: [number, number]) =>
  JSON.stringify({
    session_id: "s-1",
    cwd: "/x",
    rate_limits: {
      ...(five ? { five_hour: { used_percentage: five[0], resets_at: five[1] } } : {}),
      ...(seven ? { seven_day: { used_percentage: seven[0], resets_at: seven[1] } } : {}),
    },
  });
const T = (min: number) => Math.floor((NOW.getTime() + min * 60_000) / 1000);

test("statusline records the usage atomically and prints the short line", async () => {
  const r = root();
  const line = await statuslineLine({ profile: "personal", root: r, stdin: stdin([25, T(130)], [48, T(5000)]), env: env(), now: NOW });
  expect(line).toMatch(/^personal · 5h 25% ↻\d\d:\d\d · 7d 48%$/);
  const saved = parseUsage(readFileSync(usageFile(r, "personal"), "utf8"))!;
  expect(saved).toEqual({ five_hour: { used: 25, resets_at: T(130) }, seven_day: { used: 48, resets_at: T(5000) }, seen_at: NOW.toISOString(), session_id: "s-1" });
  // no temp file is left behind
  expect(readdirSync(join(r, ".agentthread", "usage"))).toEqual(["personal.json"]);
});

test("statusline with one window prints and records only that window", async () => {
  const r = root();
  expect(await statuslineLine({ profile: "work", root: r, stdin: stdin(undefined, [7, T(900)]), env: env(), now: NOW })).toBe("work · 7d 7%");
  expect(parseUsage(readFileSync(usageFile(r, "work"), "utf8"))).toMatchObject({ five_hour: null, seven_day: { used: 7, resets_at: T(900) } });
});

test("garbage stdin and a session before its first response print the profile and keep the previous data", async () => {
  const r = root();
  writeUsage(r, "work", { five_hour: { used: 40, resets_at: T(60) }, seven_day: null, seen_at: "2026-11-24T11:00:00.000Z" });
  expect(await statuslineLine({ profile: "work", root: r, stdin: "not json{", env: env(), now: NOW })).toBe("work");
  expect(await statuslineLine({ profile: "work", root: r, stdin: JSON.stringify({ session_id: "x" }), env: env(), now: NOW })).toBe("work");
  expect(parseUsage(readFileSync(usageFile(r, "work"), "utf8"))!.five_hour!.used).toBe(40);
  expect(await statuslineLine({ profile: "work", root: r, stdin: "", env: env(), now: NOW })).toBe("work");
});

test("an unwritable usage directory does not break the line", async () => {
  const r = root();
  writeFileSync(join(r, ".agentthread", "usage"), "a file where the directory should be");
  expect(await statuslineLine({ profile: "p", root: r, stdin: stdin([1, T(10)]), env: env(), now: NOW })).toMatch(/^p · 5h 1%/);
});

test("the user's own statusline runs with the same stdin and prints on a second line", async () => {
  const script = join(realpathSync(tmpdir()), `agt-mine-${process.pid}.sh`);
  const r = root(`${PROFILES}    statusline: ${script}\n`);
  writeFileSync(script, '#!/bin/sh\nread -r in\necho "mine: $(echo "$in" | grep -o s-1)"\n');
  chmodSync(script, 0o755);
  const e = env();
  const line = await statuslineLine({ profile: "personal", root: r, stdin: stdin([25, T(130)]) + "\n", env: e, now: NOW });
  expect(line.split("\n")).toEqual([expect.stringMatching(/^personal · 5h 25%/), "mine: s-1"]);
});

test("a failing or missing user statusline leaves only agt's line", async () => {
  const r = root(`${PROFILES}    statusline: /nonexistent/nope.sh\n`);
  expect(await statuslineLine({ profile: "p", root: r, stdin: stdin([1, T(10)]), env: env(), now: NOW })).toMatch(/^p · 5h 1% ↻\d\d:\d\d$/);
});

test("agt usage rows and table: windows, reset, current and limited", () => {
  const r = root();
  const config = ConfigSchema.parse({ agents: { claude: { profiles: [{ name: "a", config_dir: "/a" }, { name: "b", config_dir: "/b" }, { name: "c", config_dir: "/c" }] } } });
  writeUsage(r, "a", { five_hour: { used: 25, resets_at: T(130) }, seven_day: { used: 48, resets_at: T(5000) }, seen_at: new Date(NOW.getTime() - 3 * 60_000).toISOString() });
  // b: both windows already reset
  writeUsage(r, "b", { five_hour: { used: 99, resets_at: T(-10) }, seven_day: null, seen_at: new Date(NOW.getTime() - 3_600_000 * 2).toISOString() });
  const state = emptyState();
  state.profiles.current = "a";
  state.profiles.limited.b = { at: new Date(NOW.getTime() - 60_000).toISOString() };
  const rows = usageRows(r, config, state, NOW.getTime());
  expect(rows[0]).toMatchObject({ profile: "a", current: true, five_hour: { used: 25, resets_at: T(130) }, limited_until: null });
  expect(rows[1]).toMatchObject({ profile: "b", current: false, five_hour: { used: 0, resets_at: null }, seven_day: null });
  expect(rows[1]!.limited_until).not.toBeNull();
  expect(rows[2]).toMatchObject({ profile: "c", five_hour: null, seen_at: null });
  const text = formatUsage(rows, NOW.getTime()).split("\n");
  expect(text[0]).toMatch(/^profile\s+current\s+5h used\s+5h resets\s+7d used\s+7d resets\s+last seen\s+limited$/);
  expect(text[1]).toMatch(/^a\s+\*\s+25%\s+\d\d:\d\d\s+48%\s+\d\d:\d\d\s+3m ago\s+-$/);
  expect(text[2]).toMatch(/^b\s+0%\s+-\s+-\s+-\s+2h ago\s+until \d\d:\d\d$/);
  expect(text[3]).toMatch(/^c\s+-\s+-\s+-\s+-\s+-\s+-$/);
  expect(existsSync(usageFile(r, "c"))).toBe(false);
});

test("a profile name the config does not list prints nothing and writes nothing", async () => {
  const r = root();
  expect(await statuslineLine({ profile: "../evil", root: r, stdin: stdin([1, T(10)]), env: env(), now: NOW })).toBe("");
  expect(await statuslineLine({ profile: "nope", root: r, stdin: stdin([1, T(10)]), env: env(), now: NOW })).toBe("");
  expect(existsSync(join(r, ".agentthread", "usage"))).toBe(false);
  expect(await statuslineLine({ profile: "work", root: root("agents: [broken"), stdin: "{}", env: env(), now: NOW })).toBe("");
});
