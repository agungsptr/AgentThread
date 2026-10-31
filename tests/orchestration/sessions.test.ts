import { expect, test } from "bun:test";
import { ConfigSchema } from "../../src/config/config.ts";
import type { EventBody } from "../../src/domain/types.ts";
import { rotateCoordinator, spawnCoordinator, spawnReplacement, spawnWorker, tabEnsure } from "../../src/orchestration/sessions.ts";
import { INIT, stateOf, taskThreadCreated, threadCreated } from "../helpers.ts";

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NEW = "00000000-0000-4000-8000-000000000001";
const cfg = (agents: unknown) => ConfigSchema.parse({ agents });
const ctx = (agents: unknown = {}) => ({ root: "/repo", config: cfg(agents), newId: () => NEW });
const created = (r: { events: EventBody[] }) => r.events.find((e) => e.type === "session.created")!.payload as Record<string, unknown>;

function base(coordinator: Record<string, unknown> = { agent: "claude-code" }) {
  return stateOf(
    INIT,
    threadCreated("001", { status: "in_progress" }),
    { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } },
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", name: "c", ...coordinator } as never },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
  );
}

test("a worker of a thread uses roles.worker", () => {
  const s = base();
  const r = spawnWorker(s, s.threads.get("001")!, "T1", ctx({ roles: { worker: { agent: "opencode", model: "p/m" } } }));
  expect(created(r)).toMatchObject({ agent: "opencode", model: "p/m" });
  expect(created(r)).not.toHaveProperty("effort");
  expect(r.effects[0]).toMatchObject({ kind: "agent.spawn", run: { agent: "opencode", model: "p/m" } });
});

test("a coordinator uses tierAgent(thread.tier)", () => {
  const s = base();
  const t = s.threads.get("001")!;
  const agents = { roles: { coordinator: { agent: "codex" } }, complexity: { tiers: { big: { agent: "omp", model: "m", effort: "high" } } } };
  expect(created(spawnCoordinator(t, ctx(agents)))).toMatchObject({ agent: "codex" });
  t.tier = "big";
  const r = spawnCoordinator(t, ctx(agents));
  expect(created(r)).toMatchObject({ agent: "omp", model: "m", effort: "high" });
  expect(r.effects[0]).toMatchObject({ kind: "agent.spawn", run: { agent: "omp", model: "m", effort: "high" } });
});

test("a replacement copies agent/model/effort from the session it replaces", () => {
  const s = base({ agent: "codex", model: "gpt-x", effort: "low" });
  // the config now says otherwise: the replacement still follows the session it replaces
  const r = spawnReplacement(s.threads.get("001")!, s.sessions.get(C)!, ctx({ roles: { coordinator: { agent: "omp" } } }), { bootstrap: "handoff" });
  expect(created(r)).toMatchObject({ agent: "codex", model: "gpt-x", effort: "low", replaces: C });
  expect(r.effects[0]).toMatchObject({ run: { agent: "codex", model: "gpt-x", effort: "low" } });
});

test("a rotation copies agent/model/effort from the session it replaces", () => {
  const s = base({ agent: "opencode", model: "p/m", effort: "max" });
  const r = rotateCoordinator(s, s.sessions.get(C)!, "age", ctx());
  expect(created(r)).toMatchObject({ agent: "opencode", model: "p/m", effort: "max", replaces: C });
  expect(r.effects[0]).toMatchObject({ run: { agent: "opencode", model: "p/m", effort: "max" } });
});

test("the projection keeps agent, model and effort from session.created", () => {
  const s = base({ agent: "omp", model: "m", effort: "auto" });
  expect(s.sessions.get(C)).toMatchObject({ agent: "omp", model: "m", effort: "auto" });
});

function taskBase() {
  return stateOf(
    INIT,
    taskThreadCreated("001", "kyc-1", { status: "in_progress" }),
    { type: "thread.tab_opened", thread: "001", payload: { tab: "w1:t2", rootPane: "w1:p2" } },
    { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", name: "c", agent: "claude-code" } },
    { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
  );
}

test("a thread with a task: the tab, the coordinator, a replacement and a worker run in the thread directory", () => {
  const s = taskBase();
  const t = s.threads.get("001")!;
  expect(t).toMatchObject({ task: "kyc-1", dir: "/repo/.worktrees/kyc-1", worktrees: {}, legacy: false });
  expect(tabEnsure(t, ctx())).toMatchObject({ kind: "herdr.tab.ensure", cwd: "/repo/.worktrees/kyc-1" });
  expect(spawnCoordinator(t, ctx()).effects[0]).toMatchObject({ kind: "agent.spawn", cwd: "/repo/.worktrees/kyc-1" });
  expect(spawnReplacement(t, s.sessions.get(C)!, ctx(), { bootstrap: "handoff" }).effects[0]).toMatchObject({ cwd: "/repo/.worktrees/kyc-1" });
  expect(spawnWorker(s, t, "T1", ctx()).effects[0]).toMatchObject({ kind: "agent.spawn", cwd: "/repo/.worktrees/kyc-1" });
});

test("an old log's thread (branch and worktree) replays as legacy and still runs in its worktree", () => {
  const s = base();
  const t = s.threads.get("001")!;
  expect(t).toMatchObject({ legacy: true, branch: "thread/001-thread-001", worktree: "/repo/.worktrees/001-thread-001", worktrees: {} });
  expect(t.dir).toBeUndefined();
  expect(t.task).toBeUndefined();
  expect(tabEnsure(t, ctx())).toMatchObject({ cwd: "/repo/.worktrees/001-thread-001" });
  expect(spawnCoordinator(t, ctx()).effects[0]).toMatchObject({ cwd: "/repo/.worktrees/001-thread-001" });
  expect(spawnWorker(s, t, "T1", ctx()).effects[0]).toMatchObject({ cwd: "/repo/.worktrees/001-thread-001" });
});
