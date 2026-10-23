import { expect, test } from "bun:test";
import { diffAgentStatus } from "../../src/daemon/poller.ts";
import type { Session } from "../../src/state/projection.ts";

const sess = (status: string, pane = "p1"): Session =>
  ({ id: "s1", role: "coordinator", agent: "claude-code", name: "n", pane, status, notices: [], turns: 0, turnsSinceProgress: 0, createdAt: "" }) as Session;
const run = (status: string, listed: string | null, misses = new Map<string, number>()) =>
  diffAgentStatus({ sessions: [sess(status)], listed: listed ? [{ pane: "p1", status: listed as "idle" }] : [], misses });

test("start, work, idle", () => {
  expect(run("starting", "idle")).toEqual([{ session: "s1", signal: "started" }]);
  expect(run("starting", "working")).toEqual([{ session: "s1", signal: "active" }]);
  expect(run("active", "working")).toEqual([]);
  expect(run("idle", "working")).toEqual([{ session: "s1", signal: "active" }]);
  expect(run("active", "idle")).toEqual([{ session: "s1", signal: "idle" }]);
  expect(run("active", "done")).toEqual([{ session: "s1", signal: "idle" }]);
  expect(run("idle", "idle")).toEqual([]);
  expect(run("active", "unknown")).toEqual([]);
});

test("blocked fires once per entry", () => {
  const m = new Map<string, number>();
  expect(run("active", "blocked", m)).toEqual([{ session: "s1", signal: "blocked" }]);
  expect(run("active", "blocked", m)).toEqual([]);
  expect(run("active", "working", m)).toEqual([]);
  expect(run("active", "blocked", m)).toEqual([{ session: "s1", signal: "blocked" }]);
});

test("one miss is nothing, two misses end, recovery resets", () => {
  const m = new Map<string, number>();
  expect(run("active", null, m)).toEqual([]);
  expect(run("active", "working", m)).toEqual([]);
  expect(run("active", null, m)).toEqual([]);
  expect(run("active", null, m)).toEqual([{ session: "s1", signal: "ended" }]);
  expect(m.size).toBe(0);
});

test("ended, non-agent or pane-less sessions are ignored", () => {
  const m = new Map<string, number>();
  const list = (ss: Session[]) => diffAgentStatus({ sessions: ss, listed: [], misses: m });
  expect(list([sess("ended"), { ...sess("active"), role: "main" }, { ...sess("active"), pane: undefined }])).toEqual([]);
  expect(list([sess("ended"), { ...sess("active"), role: "main" }])).toEqual([]);
  expect(m.size).toBe(0);
});
