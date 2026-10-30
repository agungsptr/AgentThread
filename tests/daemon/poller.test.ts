import { expect, test } from "bun:test";
import { diffAgentStatus } from "../../src/daemon/poller.ts";
import type { Session } from "../../src/state/projection.ts";

const sess = (status: string, pane = "p1"): Session =>
  ({ id: "s1", role: "coordinator", agent: "claude-code", name: "n", pane, status, notices: [], turns: 0, turnsSinceProgress: 0, createdAt: "" }) as Session;
const run = (status: string, listed: string | null, misses = new Map<string, number>()) =>
  diffAgentStatus({ sessions: [sess(status)], listed: listed ? [{ pane: "p1", status: listed as "idle" }] : [], misses, hooks: () => false });

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
  const list = (ss: Session[]) => diffAgentStatus({ sessions: ss, listed: [], misses: m, hooks: () => false });
  expect(list([sess("ended"), { ...sess("active"), role: "main" }, { ...sess("active"), pane: undefined }])).toEqual([]);
  expect(list([sess("ended"), { ...sess("active"), role: "main" }])).toEqual([]);
  expect(m.size).toBe(0);
});

test("the main session is polled for started, active and idle, never ended or blocked", () => {
  const m = new Map<string, number>();
  const main = (status: string) => ({ ...sess(status, "p0"), id: "m", role: "main" }) as Session;
  const poll = (status: string, listed: string | null) =>
    diffAgentStatus({ sessions: [main(status)], listed: listed ? [{ pane: "p0", status: listed as "idle" }] : [], misses: m, hooks: () => false });
  expect(poll("starting", "idle")).toEqual([{ session: "m", signal: "started" }]);
  expect(poll("idle", "working")).toEqual([{ session: "m", signal: "active" }]);
  expect(poll("active", "idle")).toEqual([{ session: "m", signal: "idle" }]);
  expect(poll("active", "blocked")).toEqual([]);
  expect(poll("active", null)).toEqual([]);
  expect(poll("active", null)).toEqual([]);
  expect(poll("active", null)).toEqual([]);
  expect(m.size).toBe(0);
});

test("a session with hooks gets only started, blocked and ended from the poller", () => {
  const hooks = (s: Session) => s.agent === "claude-code";
  const poll = (status: string, listed: string | null, over: Partial<Session> = {}) =>
    diffAgentStatus({ sessions: [{ ...sess(status), ...over }], listed: listed ? [{ pane: "p1", status: listed as "idle" }] : [], misses: new Map(), hooks });
  expect(poll("starting", "idle")).toEqual([{ session: "s1", signal: "started" }]);
  expect(poll("idle", "working")).toEqual([]);
  expect(poll("active", "idle")).toEqual([]);
  expect(poll("active", "done")).toEqual([]);
  expect(poll("active", "blocked")).toEqual([{ session: "s1", signal: "blocked" }]);
  expect(poll("active", null, {})).toEqual([]);
  // opencode has no hooks: the poller still reports its turns
  expect(poll("idle", "working", { agent: "opencode" })).toEqual([{ session: "s1", signal: "active" }]);
  expect(poll("active", "idle", { agent: "opencode" })).toEqual([{ session: "s1", signal: "idle" }]);
});

test("main is polled for active and idle only when its agent has no hooks", () => {
  const main = (status: string, agent: string) => ({ ...sess(status, "p0"), id: "m", role: "main", agent }) as Session;
  const poll = (status: string, listed: string, agent: string) =>
    diffAgentStatus({ sessions: [main(status, agent)], listed: [{ pane: "p0", status: listed as "idle" }], misses: new Map(), hooks: (s) => s.agent === "claude-code" });
  expect(poll("idle", "working", "claude-code")).toEqual([]);
  expect(poll("idle", "working", "opencode")).toEqual([{ session: "m", signal: "active" }]);
});
