import { expect, test } from "bun:test";
import { raceScenario, TimeoutError } from "../release/harness.ts";
import { stallClock } from "../release/stall-clock.ts";

test("a pause of the whole process (a sleeping Mac) does not count against a deadline", () => {
  let t = 1_000;
  const c = stallClock({ now: () => t, tickMs: 1_000, thresholdMs: 10_000 });
  const deadline = c.now() + 60_000;
  t += 1_000;
  c.observe(); // a normal tick
  expect(c.stalledMs()).toBe(0);
  t += 24 * 60_000; // nothing ran for 24 minutes
  c.observe();
  expect(c.stalledMs()).toBe(24 * 60_000 - 1_000);
  expect(deadline - c.now()).toBeGreaterThan(55_000); // the 60s budget is still (about) whole
  for (let i = 0; i < 61; i++) {
    t += 1_000;
    c.observe();
  }
  expect(deadline - c.now()).toBeLessThan(0); // real time still runs it out
});

test("a late tick under the threshold is not a stall", () => {
  let t = 0;
  const c = stallClock({ now: () => t, tickMs: 1_000, thresholdMs: 10_000 });
  t += 8_000;
  c.observe();
  expect(c.stalledMs()).toBe(0);
});

test("now() self-corrects after a wake without waiting for a tick", () => {
  let t = 0;
  const c = stallClock({ now: () => t, tickMs: 1_000, thresholdMs: 10_000 });
  t += 30 * 60_000; // slept; no interval tick ran yet
  expect(c.now()).toBe(1_000); // the 30 minutes are discounted by the read itself
});

test("raceScenario: a pause does not time the row out, real time does", async () => {
  let t = 0;
  const c = stallClock({ now: () => t, tickMs: 1_000, thresholdMs: 10_000 });
  const gate = new Promise<never>(() => {});
  const race = raceScenario(new Promise(() => {}), gate, c.now() + 5_000, "row timed out", { clock: c, pollMs: 5 });
  let settled: unknown = "pending";
  race.then(() => (settled = "ok"), (e) => (settled = e));
  t += 60 * 60_000; // an hour asleep
  await Bun.sleep(30);
  expect(settled).toBe("pending");
  t += 6_000; // then 6 real seconds
  await Bun.sleep(30);
  expect(settled).toBeInstanceOf(TimeoutError);
});
