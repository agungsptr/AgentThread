import { expect, test } from "bun:test";
import { ConfigSchema } from "../../src/config/config.ts";
import type { EventBody } from "../../src/domain/types.ts";
import { rotateCoordinator, spawnCoordinator, spawnReplacement, spawnWorker } from "../../src/orchestration/sessions.ts";
import { INIT, stateOf, threadCreated } from "../helpers.ts";

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
