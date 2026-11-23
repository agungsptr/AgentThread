import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config/config.ts";
import { switchAt } from "../config/config.ts";

/** `~/x`, `~` and `$HOME`/`${HOME}` in a value become the home directory. */
export function expandHome(value: string, home: string): string {
  const v = value === "~" || value.startsWith("~/") ? home + value.slice(1) : value;
  return v.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, () => home);
}

/** The configured Claude profiles (0 or 1: no switching; 2 or more: switching on). */
export const claudeProfiles = (config: Config): { name: string; config_dir: string }[] => config.agents.claude.profiles ?? [];

/** Whether usage-aware switching is on: 2 or more profiles. */
export const switching = (config: Config): boolean => claudeProfiles(config).length >= 2;

/** A profile's CLAUDE_CONFIG_DIR with `~/` and $HOME expanded; undefined for an unknown name. */
export function profileDir(config: Config, name: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const p = claudeProfiles(config).find((x) => x.name === name);
  return p ? expandHome(p.config_dir, env.HOME || homedir()) : undefined;
}

/** One rate-limit window as Claude Code reports it: used percentage (0-100) and the reset time (Unix epoch seconds). */
export interface UsageWindow {
  used: number;
  resets_at: number;
}

/** What `agt statusline` records for a profile (telemetry, not event-log state). */
export interface ProfileUsage {
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  seen_at: string;
  session_id?: string;
}

export const usageDir = (root: string): string => join(root, ".agentthread", "usage");
export const usageFile = (root: string, profile: string): string => join(usageDir(root), `${profile}.json`);

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function windowOf(v: unknown): UsageWindow | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const used = num(o.used ?? o.used_percentage);
  const resets = num(o.resets_at);
  return used === undefined || resets === undefined ? null : { used, resets_at: resets };
}

/** The usage a statusLine stdin JSON carries (`rate_limits`); undefined windows when absent or malformed. Never throws. */
export function usageFromStatusline(stdin: string, now: Date = new Date()): ProfileUsage {
  let j: unknown;
  try {
    j = JSON.parse(stdin);
  } catch {
    j = undefined;
  }
  const o = typeof j === "object" && j !== null ? (j as Record<string, unknown>) : {};
  const rl = typeof o.rate_limits === "object" && o.rate_limits !== null ? (o.rate_limits as Record<string, unknown>) : {};
  return {
    five_hour: windowOf(rl.five_hour),
    seven_day: windowOf(rl.seven_day),
    seen_at: now.toISOString(),
    ...(typeof o.session_id === "string" ? { session_id: o.session_id } : {}),
  };
}

/** Parses a usage file; undefined when it is not one (a missing or unreadable file means "unknown"). */
export function parseUsage(text: string): ProfileUsage | undefined {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (typeof o !== "object" || o === null || typeof o.seen_at !== "string") return undefined;
    return {
      five_hour: windowOf(o.five_hour),
      seven_day: windowOf(o.seven_day),
      seen_at: o.seen_at,
      ...(typeof o.session_id === "string" ? { session_id: o.session_id } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Writes a profile's usage atomically (temp file in the same directory, then rename). */
export function writeUsage(root: string, profile: string, usage: ProfileUsage): void {
  mkdirSync(usageDir(root), { recursive: true });
  const file = usageFile(root, profile);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(usage)}\n`);
  renameSync(tmp, file);
}

export function readUsage(root: string, profile: string): ProfileUsage | undefined {
  try {
    return parseUsage(readFileSync(usageFile(root, profile), "utf8"));
  } catch {
    return undefined;
  }
}

export type UsageMap = Record<string, ProfileUsage | undefined>;

export function readAllUsage(root: string, names: string[]): UsageMap {
  return Object.fromEntries(names.map((n) => [n, readUsage(root, n)]));
}

/** A window's used percentage now: 0 once `now >= resets_at` (the window reset), undefined when unknown. */
export function usedNow(w: UsageWindow | null | undefined, nowMs: number): number | undefined {
  if (!w) return undefined;
  return nowMs >= w.resets_at * 1000 ? 0 : w.used;
}

/** A window's reset time in epoch ms while it still counts (not yet reset); undefined when unknown or reset. */
export function resetMs(w: UsageWindow | null | undefined, nowMs: number): number | undefined {
  return w && nowMs < w.resets_at * 1000 ? w.resets_at * 1000 : undefined;
}

/** How long a rate_limit failure marks a profile exhausted when its usage file knows no later reset. */
export const LIMITED_FALLBACK_MS = 60 * 60_000;

/**
 * When a profile marked limited at `at` is eligible again: the latest known resets_at of its usage file (after the
 * mark), else 60 minutes after it.
 */
export function limitedUntilMs(at: string, usage: ProfileUsage | undefined): number {
  const atMs = Date.parse(at);
  const resets = [usage?.five_hour, usage?.seven_day].flatMap((w) => (w && w.resets_at * 1000 > atMs ? [w.resets_at * 1000] : []));
  return resets.length ? Math.max(...resets) : atMs + LIMITED_FALLBACK_MS;
}

export interface SelectInput {
  /** Profile names in config order. */
  profiles: string[];
  switchAt: { five_hour: number; seven_day: number };
  usage: UsageMap;
  /** `profile.limited` marks by profile: the ISO time of the latest. */
  limited: Record<string, string>;
  current?: string | undefined;
  nowMs: number;
}

export interface Selection {
  name: string;
  /** No profile was eligible: `name` is the one that frees up first. */
  allLimited: boolean;
  /** The chosen profile's five-hour reset time (epoch ms) when known. */
  fiveHourResetsAt?: number;
}

/** Whether a profile may take a new launch: below both thresholds (a reset window counts 0) and not marked limited. */
export function eligible(name: string, i: SelectInput): boolean {
  const u = i.usage[name];
  const mark = i.limited[name];
  if (mark !== undefined && i.nowMs < limitedUntilMs(mark, u)) return false;
  const five = usedNow(u?.five_hour, i.nowMs) ?? 0;
  const seven = usedNow(u?.seven_day, i.nowMs) ?? 0;
  return five < i.switchAt.five_hour && seven < i.switchAt.seven_day;
}

/** When an ineligible profile is eligible again (epoch ms): the latest reset among what blocks it. */
function freeAtMs(name: string, i: SelectInput): number {
  const u = i.usage[name];
  const blocks: number[] = [];
  const mark = i.limited[name];
  if (mark !== undefined) blocks.push(limitedUntilMs(mark, u));
  const five = resetMs(u?.five_hour, i.nowMs);
  if (five !== undefined && (usedNow(u?.five_hour, i.nowMs) ?? 0) >= i.switchAt.five_hour) blocks.push(five);
  const seven = resetMs(u?.seven_day, i.nowMs);
  if (seven !== undefined && (usedNow(u?.seven_day, i.nowMs) ?? 0) >= i.switchAt.seven_day) blocks.push(seven);
  return blocks.length ? Math.max(...blocks) : i.nowMs;
}

/**
 * The profile a new launch uses. The current one while it is eligible (use up the first profile); otherwise the
 * eligible one whose five-hour window resets nearest (unknown after known), then the lowest five-hour use, then the
 * lowest seven-day use, then config order. With none eligible, the one that frees up first.
 */
export function selectProfile(i: SelectInput): Selection {
  const pick = (name: string, allLimited: boolean): Selection => {
    const r = resetMs(i.usage[name]?.five_hour, i.nowMs);
    return { name, allLimited, ...(r !== undefined ? { fiveHourResetsAt: r } : {}) };
  };
  if (i.profiles.length === 0) throw new Error("no profiles");
  if (i.current !== undefined && i.profiles.includes(i.current) && eligible(i.current, i)) return pick(i.current, false);
  const ok = i.profiles.map((name, order) => ({ name, order })).filter((p) => eligible(p.name, i));
  if (ok.length > 0) {
    const key = (p: { name: string; order: number }) => {
      const u = i.usage[p.name];
      return [resetMs(u?.five_hour, i.nowMs) ?? Number.POSITIVE_INFINITY, usedNow(u?.five_hour, i.nowMs) ?? 0, usedNow(u?.seven_day, i.nowMs) ?? 0, p.order];
    };
    ok.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      for (let n = 0; n < ka.length; n++) if (ka[n] !== kb[n]) return ka[n]! < kb[n]! ? -1 : 1;
      return 0;
    });
    return pick(ok[0]!.name, false);
  }
  const free = i.profiles.map((name, order) => ({ name, order, at: freeAtMs(name, i) })).sort((a, b) => a.at - b.at || a.order - b.order);
  return pick(free[0]!.name, true);
}

/** Whether a profile is over a threshold or marked limited right now (the sweep's test for a running session's profile). */
export const exhausted = (name: string, i: SelectInput): boolean => !eligible(name, i);

export const thresholds = (config: Config) => switchAt(config.agents.claude);

const two = (n: number) => String(n).padStart(2, "0");
/** HH:MM in local time for an epoch-seconds or epoch-ms instant. */
export const clockOf = (ms: number): string => {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};

/** The line `agt statusline` prints: `<profile> · 5h 25% ↻14:10 · 7d 48%`, only the parts that are present. */
export function statuslineText(profile: string, usage: ProfileUsage): string {
  const parts = [profile];
  const { five_hour: five, seven_day: seven } = usage;
  if (five) parts.push(`5h ${Math.round(five.used)}% ↻${clockOf(five.resets_at * 1000)}`);
  if (seven) parts.push(`7d ${Math.round(seven.used)}%`);
  return parts.join(" · ");
}
