/**
 * A clock that does not run while the whole process is paused (a Mac that went to sleep, a SIGSTOP): a release row's
 * deadlines are budgets of work, and 24 minutes of sleep once used up a row's 33 and failed it with nothing wrong.
 * A tick that comes much later than it should adds the missing time to `stalledMs`; `now()` is the wall clock minus it.
 */
export function stallClock(o: { now?: () => number; tickMs?: number; thresholdMs?: number } = {}) {
  const wall = o.now ?? Date.now;
  const tickMs = o.tickMs ?? 1_000;
  const thresholdMs = o.thresholdMs ?? 15_000;
  let last = wall();
  let stalled = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const clock = {
    /** Called on every tick: a gap past the threshold is a stall. */
    observe(): void {
      const t = wall();
      const gap = t - last;
      last = t;
      if (gap > thresholdMs) stalled += gap - tickMs;
    },
    now: () => wall() - stalled,
    stalledMs: () => stalled,
    start(): void {
      timer ??= setInterval(() => clock.observe(), tickMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
  return clock;
}

/** The release run's clock; `run.ts` starts it. */
export const runClock = stallClock();
