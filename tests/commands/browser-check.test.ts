import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, browserCheckMode, ConfigSchema, type Config } from "../../src/config/config.ts";
import { handle, type HandleResult } from "../../src/commands/handler.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import type { Actor, EventBody, StoredEvent } from "../../src/domain/types.ts";
import { react } from "../../src/orchestration/reactor.ts";
import { renderBrief } from "../../src/render/brief.ts";
import { writeAll } from "../../src/render/write.ts";
import { applyEvent, type State } from "../../src/state/projection.ts";
import { INIT, USER, stateOf } from "../helpers.ts";

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const COORD: Actor = { role: "coordinator", thread: "001", session: C };
const cfg = (check?: "on_request" | "always"): Config => ({
  ...DEFAULT_CONFIG,
  workflow: { ...DEFAULT_CONFIG.workflow, stack: { restart: "make up {task}" }, browser: { urls: ["http://localhost:3000"], ...(check ? { check } : {}) } },
});
const apply = (s: State, bodies: EventBody[], actor: Actor): StoredEvent[] =>
  bodies.map((b) => {
    const ev = { ...b, seq: s.lastSeq + 1, ts: "2026-10-09T11:00:00.000Z", actor } as StoredEvent;
    applyEvent(s, ev);
    return ev;
  });
const exec = (s: State, cmd: unknown, actor: Actor, config: Config): HandleResult => {
  const r = handle(s, CommandSchema.parse(cmd), actor, { root: "/repo", config });
  if (r.ok) apply(s, r.events, actor);
  return r;
};
const newThread = (s: State, config: Config, extra: Record<string, unknown> = {}) => exec(s, { cmd: "thread.new", title: "Login", type: "feature", ...extra }, USER, config);
const stage8 = (s: State) => s.threads.get("001")!.stages[8];

describe("workflow.browser.check", () => {
  test("defaults to on_request, accepts always, rejects anything else", () => {
    expect(browserCheckMode(DEFAULT_CONFIG)).toBe("on_request");
    expect(browserCheckMode(ConfigSchema.parse({ workflow: { browser: { urls: ["http://x"], check: "always" } } }))).toBe("always");
    expect(() => ConfigSchema.parse({ workflow: { browser: { check: "never" } } })).toThrow();
  });

  test("on_request and not requested: agt records stage 8 skipped itself, no user needed", () => {
    for (const config of [cfg(), cfg("on_request")]) {
      const s = stateOf(INIT);
      newThread(s, config);
      expect(stage8(s)).toMatchObject({ state: "skipped", by: "agt", reason: "not requested" });
      expect(renderBrief({ thread: s.threads.get("001")!, sessions: [], config })).not.toContain("Browser check: requested");
    }
  });

  test("--browser-check is stored on the thread and its brief; stage 8 stays required", () => {
    const s = stateOf(INIT);
    const r = newThread(s, cfg(), { browserCheck: true });
    expect(r.ok && r.events[0]).toMatchObject({ type: "thread.created", payload: { browserCheck: true } });
    expect(s.threads.get("001")!.browserCheck).toBe(true);
    expect(stage8(s)).toBeUndefined();
    expect(renderBrief({ thread: s.threads.get("001")!, sessions: [], config: cfg() })).toContain("Browser check: requested");
  });

  test("always keeps today's behaviour: stage 8 required without the flag", () => {
    const s = stateOf(INIT);
    newThread(s, cfg("always"));
    expect(stage8(s)).toBeUndefined();
  });

  test("no urls: still na, whatever the mode", () => {
    const s = stateOf(INIT);
    newThread(s, DEFAULT_CONFIG);
    expect(stage8(s)).toMatchObject({ state: "na", by: "agt" });
  });

  test("the coordinator may record done after agt's skip (the user asked later)", () => {
    const s = stateOf(INIT);
    newThread(s, cfg());
    const r = exec(s, { cmd: "stage", thread: "001", stage: 8, state: "done" }, COORD, cfg());
    expect(r.ok).toBe(true);
    expect(stage8(s)).toMatchObject({ state: "done", by: "coordinator" });
  });

  test("the squash guard file (stage8) is written for skipped, and absent while stage 8 is required", () => {
    const root = mkdtempSync(join(tmpdir(), "agt-bc-"));
    const skipped = stateOf(INIT);
    newThread(skipped, cfg());
    writeAll(root, skipped, cfg(), () => undefined);
    const f = join(root, ".agentthread", "threads", "001-login", "stage8");
    const required = stateOf(INIT);
    newThread(required, cfg(), { browserCheck: true });
    expect(existsSync(f) ? readFileSync(f, "utf8") : "").toBe("skipped\n");
    const root2 = mkdtempSync(join(tmpdir(), "agt-bc-"));
    writeAll(root2, required, cfg(), () => undefined);
    expect(existsSync(join(root2, ".agentthread", "threads", "001-login", "stage8"))).toBe(false);
  });

  test("agt thread browser-check withdraws agt's skip, closes the guard, tells the coordinator; a user's skip stays", () => {
    const root = mkdtempSync(join(tmpdir(), "agt-bc-"));
    const s = stateOf(INIT);
    newThread(s, cfg());
    apply(s, [{ type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } }], USER);
    writeAll(root, s, cfg(), () => undefined);
    const f = join(root, ".agentthread", "threads", "001-login", "stage8");
    expect(existsSync(f)).toBe(true);
    const r = exec(s, { cmd: "thread.browser_check", thread: "001" }, { role: "main" }, cfg());
    expect(r.ok).toBe(true);
    expect(s.threads.get("001")!.browserCheck).toBe(true);
    expect(stage8(s)).toBeUndefined();
    writeAll(root, s, cfg(), () => undefined);
    expect(existsSync(f)).toBe(false);
    const out = react(s, r.ok ? apply(s, [], USER) : [], { root, config: cfg(), newId: () => C });
    expect(out.events).toEqual([]);
    const u = stateOf(INIT);
    newThread(u, cfg());
    exec(u, { cmd: "stage", thread: "001", stage: 8, state: "skipped", by: "user", reason: "no time" }, USER, cfg());
    exec(u, { cmd: "thread.browser_check", thread: "001" }, COORD, cfg());
    expect(stage8(u)).toMatchObject({ state: "skipped", by: "user" });
  });

  test("the reactor tells the coordinator, unless it asked itself", () => {
    const s = stateOf(INIT);
    newThread(s, cfg());
    apply(s, [
      { type: "session.created", thread: "001", payload: { session: C, role: "coordinator", agent: "claude-code", name: "c" } },
      { type: "session.attached", thread: "001", payload: { session: C, pane: "w1:p2" } },
    ], USER);
    const ev = apply(s, [{ type: "thread.browser_check", thread: "001", payload: {} }], { role: "main" });
    const out = react(s, ev, { root: "/repo", config: cfg(), newId: () => C });
    expect(out.events).toMatchObject([{ type: "notice.queued", payload: { session: C } }]);
    const own = apply(s, [{ type: "thread.browser_check", thread: "001", payload: {} }], COORD);
    expect(react(s, own, { root: "/repo", config: cfg(), newId: () => C }).events).toEqual([]);
  });
});
