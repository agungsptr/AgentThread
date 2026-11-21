import { expect, test } from "bun:test";
import type { StoredEvent } from "../../src/domain/types.ts";
import { formatEvent, runLogs, summarize, WAITING } from "../../src/cli/logs.ts";

const ev = (seq: number, type: string, payload: unknown, o: { thread?: string; role?: string } = {}) =>
  ({ seq, ts: "2026-01-02T03:04:05.000Z", type, payload, ...(o.thread ? { thread: o.thread } : {}), actor: { role: o.role ?? "coordinator" } }) as unknown as StoredEvent;

test("formats HH:MM:SS thread role type summary", () => {
  const e = ev(1, "ticket.created", { ticket: "T1", title: "Add login" }, { thread: "002" });
  const d = new Date(e.ts);
  const hhmmss = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  expect(formatEvent(e)).toBe(`${hhmmss} 002 coordinator ticket.created T1 Add login`);
});

test("summaries: stage, status change, session short id, message truncation, main and unknown types", () => {
  expect(summarize(ev(1, "stage.recorded", { stage: 5, state: "done", by: "coordinator" }))).toBe("stage 5 done");
  expect(summarize(ev(1, "thread.status_changed", { from: "open", to: "in_progress" }))).toBe("open→in_progress");
  expect(summarize(ev(1, "session.created", { session: "abcdef12-3456", role: "worker", agent: "codex" }))).toBe("abcdef12");
  const long = summarize(ev(1, "log.appended", { message: "x".repeat(300) }));
  expect(long.length).toBe(160);
  expect(long.endsWith("…")).toBe(true);
  expect(formatEvent(ev(1, "layout.registered", {}, { role: "user" }))).toMatch(/^\d\d:\d\d:\d\d main user layout\.registered$/);
  expect(formatEvent(ev(1, "something.new", { x: 1 }, { thread: "001" }))).toMatch(/ 001 coordinator something\.new$/);
});

function harness(batches: (StoredEvent[] | Error)[]) {
  const printed: string[] = [];
  const seqs: number[] = [];
  let i = 0;
  const sleeps: number[] = [];
  return {
    printed,
    seqs,
    sleeps,
    io: {
      async fetch(seq: number) {
        seqs.push(seq);
        const b = batches[i++];
        if (b === undefined) throw new Error("done");
        if (b instanceof Error) throw b;
        return b;
      },
      print: (l: string) => printed.push(l),
      sleep: async (ms: number) => void sleeps.push(ms),
      stop: () => i >= batches.length,
    },
  };
}

test("hides heartbeat events by default and shows them with --all", async () => {
  const batch = [ev(1, "session.active", { session: "s1" }), ev(2, "agent.idle", { session: "s1" }), ev(3, "log.appended", { message: "hi" }, { thread: "001" })];
  const a = harness([batch]);
  await runLogs(a.io, { follow: false, all: false });
  expect(a.printed).toHaveLength(1);
  expect(a.printed[0]).toContain("log.appended hi");
  const b = harness([batch]);
  await runLogs(b.io, { follow: false, all: true });
  expect(b.printed).toHaveLength(3);
});

test("without -f a daemon error propagates", async () => {
  const h = harness([new Error("daemon not running")]);
  await expect(runLogs(h.io, { follow: false, all: false })).rejects.toThrow("daemon not running");
});

test("-f prints one waiting line while the daemon is down, retries every 2s and resumes from the last seq", async () => {
  const h = harness([[ev(7, "log.appended", { message: "a" })], new Error("down"), new Error("down"), new Error("down"), [ev(8, "log.appended", { message: "b" })]]);
  await runLogs(h.io, { follow: true, all: false });
  expect(h.printed.filter((l) => l === WAITING)).toHaveLength(1);
  expect(h.printed).toHaveLength(3);
  expect(h.seqs).toEqual([0, 7, 7, 7, 7]);
  expect(h.sleeps.filter((ms) => ms === 2000)).toHaveLength(3);
});

test("-f prints the waiting line again after a second outage", async () => {
  const h = harness([new Error("x"), [ev(1, "log.appended", { message: "a" })], new Error("x"), [ev(2, "log.appended", { message: "b" })]]);
  await runLogs(h.io, { follow: true, all: false });
  expect(h.printed.filter((l) => l === WAITING)).toHaveLength(2);
});
