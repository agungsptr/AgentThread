import { clockOf, claudeProfiles, eligible, limitedUntilMs, selectProfile, switching, thresholds, type Selection, type UsageMap } from "../agents/profiles.ts";
import type { Config } from "../config/config.ts";
import type { EventBody } from "../domain/types.ts";
import { liveSessions } from "./sessions.ts";
import type { State } from "../state/projection.ts";

/** The profile the next launch uses, chosen once per picker from the usage files and the projection (current, limited marks). */
export interface ProfilePicker {
  /** The chosen profile's name. */
  name(): string;
  /** The events recording the choice (profile.switched and the all-limited notice to main), once: later calls return none. */
  take(): EventBody[];
  /** The selection and the input it came from, for the sweep's own checks. */
  selection(): Selection;
  /** Whether a profile is over a threshold or marked limited at this picker's time. */
  exhausted(profile: string): boolean;
  /** Whether a profile carries an unexpired rate_limit mark. */
  limited(profile: string): boolean;
}

export interface PickerSources {
  /** The usage files by profile (telemetry; a missing file is undefined). */
  usage: () => UsageMap;
  now?: () => number;
}

/** The warning main gets when no profile is eligible. */
export const allNearLimitsNotice = (name: string, blocking: Selection["blocking"]) =>
  `All Claude profiles are near their limits; using ${name}${blocking ? ` (${blocking.window === "limit" ? "rate limit lifts" : `${blocking.window} resets`} at ${clockOf(blocking.at)})` : ""}.`;

/**
 * A picker for the launches of one decision (a command, a reactor pass, a sweep tick); undefined with fewer than 2
 * profiles (no switching). The choice is made on first use and kept, so every launch of the batch lands on one profile.
 */
export function profilePicker(state: State, config: Config, src: PickerSources): ProfilePicker | undefined {
  if (!switching(config)) return undefined;
  const names = claudeProfiles(config).map((p) => p.name);
  let input: Parameters<typeof selectProfile>[0] | undefined;
  let chosen: Selection | undefined;
  let taken = false;
  const get = () => {
    if (!input) {
      input = {
        profiles: names,
        switchAt: thresholds(config),
        usage: src.usage(),
        limited: Object.fromEntries(Object.entries(state.profiles.limited).map(([k, v]) => [k, v.at])),
        ...(state.profiles.current !== undefined ? { current: state.profiles.current } : {}),
        nowMs: (src.now ?? Date.now)(),
      };
      chosen = selectProfile(input);
    }
    return { input, chosen: chosen! };
  };
  return {
    name: () => get().chosen.name,
    selection: () => get().chosen,
    exhausted: (profile) => !eligible(profile, get().input),
    limited: (profile) => {
      const { input: i } = get();
      const mark = i.limited[profile];
      return mark !== undefined && i.nowMs < limitedUntilMs(mark, i.usage[profile], i.switchAt);
    },
    take() {
      const { chosen: c } = get();
      if (taken) return [];
      taken = true;
      const from = state.profiles.current;
      if (from === c.name) return [];
      const reason = from === undefined ? "first launch" : c.allLimited ? "all profiles near their limits" : "usage limit";
      const main = liveSessions(state, undefined, "main")[0];
      return [
        { type: "profile.switched", payload: { ...(from !== undefined ? { from } : {}), to: c.name, reason } },
        ...(c.allLimited && main ? [{ type: "notice.queued" as const, payload: { session: main.id, text: allNearLimitsNotice(c.name, c.blocking) } }] : []),
      ];
    },
  };
}
