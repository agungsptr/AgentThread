import { claudeProfiles, clockOf, limitedUntilMs, readAllUsage, resetMs, usedNow, type ProfileUsage } from "../agents/profiles.ts";
import type { Config } from "../config/config.ts";
import type { State } from "../state/projection.ts";

export interface UsageRow {
  profile: string;
  current: boolean;
  five_hour: { used: number; resets_at: number | null } | null;
  seven_day: { used: number; resets_at: number | null } | null;
  seen_at: string | null;
  /** When the rate_limit mark lifts (ISO), while it holds. */
  limited_until: string | null;
}

/** One row per configured profile, from the usage files and (when the daemon answered) the projection. */
export function usageRows(root: string, config: Config, state: State | undefined, nowMs: number): UsageRow[] {
  const names = claudeProfiles(config).map((p) => p.name);
  const files = readAllUsage(root, names);
  const win = (w: ProfileUsage["five_hour"]) => (w ? { used: usedNow(w, nowMs) ?? 0, resets_at: resetMs(w, nowMs) !== undefined ? w.resets_at : null } : null);
  return names.map((profile) => {
    const u = files[profile];
    const mark = state?.profiles.limited[profile]?.at;
    const until = mark !== undefined ? limitedUntilMs(mark, u) : undefined;
    return {
      profile,
      current: state?.profiles.current === profile,
      five_hour: win(u?.five_hour ?? null),
      seven_day: win(u?.seven_day ?? null),
      seen_at: u?.seen_at ?? null,
      limited_until: until !== undefined && nowMs < until ? new Date(until).toISOString() : null,
    };
  });
}

const pct = (w: UsageRow["five_hour"]) => (w ? `${Math.round(w.used)}%` : "-");
const at = (w: UsageRow["five_hour"]) => (w?.resets_at ? clockOf(w.resets_at * 1000) : "-");

function ago(iso: string | null, nowMs: number): string {
  if (!iso) return "-";
  const m = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000));
  return m < 1 ? "now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

/** The `agt usage` table: profile | current | 5h used | 5h resets | 7d used | 7d resets | last seen | limited. */
export function formatUsage(rows: UsageRow[], nowMs: number): string {
  const head = ["profile", "current", "5h used", "5h resets", "7d used", "7d resets", "last seen", "limited"];
  const body = rows.map((r) => [r.profile, r.current ? "*" : "", pct(r.five_hour), at(r.five_hour), pct(r.seven_day), at(r.seven_day), ago(r.seen_at, nowMs), r.limited_until ? `until ${clockOf(Date.parse(r.limited_until))}` : "-"]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(head), ...body.map(line)].join("\n");
}
