import { describe, expect, test } from "bun:test";
import { FAKE_HERDR, fakeHerdrState } from "../helpers.ts";

// Each case pins a behavior of real Herdr 0.9.3 that the release e2e (tests/release) observed, so the fake matches it.

function herdr(file: string, ...args: string[]) {
  const r = Bun.spawnSync([FAKE_HERDR, ...args], { env: { ...process.env, FAKE_HERDR_STATE: file }, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString();
  const err = r.stderr.toString();
  return {
    code: r.exitCode,
    stdout: out,
    result: out ? (JSON.parse(out) as { result: Record<string, any> }).result : undefined,
    error: err ? (JSON.parse(err) as { error: { code: string; message: string } }).error : undefined,
  };
}

describe("fake herdr matches real Herdr", () => {
  test("pane run prints nothing on success and fails pane_not_found for an unknown pane", () => {
    const fake = fakeHerdrState({ tabs: ["w1:t1"], panes: ["w1:p1"] });
    const ok = herdr(fake.file, "pane", "run", "w1:p1", "echo hi");
    expect(ok.code).toBe(0);
    expect(ok.stdout).toBe("");
    const missing = herdr(fake.file, "pane", "run", "w1:p9", "echo hi");
    expect(missing.code).toBe(1);
    expect(missing.error).toEqual({ code: "pane_not_found", message: "pane w1:p9 not found" });
  });

  test("ids carry the workspace they were created in", () => {
    const fake = fakeHerdrState();
    const tab = herdr(fake.file, "tab", "create", "--workspace", "w7", "--cwd", "/tmp", "--label", "x", "--no-focus").result!;
    expect(tab.type).toBe("tab_created");
    expect(tab.tab.tab_id).toMatch(/^w7:t\d+$/);
    expect(tab.root_pane.pane_id).toMatch(/^w7:p\d+$/);
    const split = herdr(fake.file, "pane", "split", tab.root_pane.pane_id, "--direction", "right", "--no-focus").result!;
    expect(split.type).toBe("pane_info");
    expect(split.pane.pane_id).toMatch(/^w7:p\d+$/);
  });

  test("pane split of an unknown pane fails pane_not_found", () => {
    const fake = fakeHerdrState();
    const r = herdr(fake.file, "pane", "split", "w1:p9", "--direction", "right", "--no-focus");
    expect(r.code).toBe(1);
    expect(r.error?.code).toBe("pane_not_found");
    expect(fake.read().panes).toEqual([]);
  });

  test("closing a tab closes its panes and the agents in them", () => {
    const fake = fakeHerdrState();
    const tab = herdr(fake.file, "tab", "create", "--workspace", "w1", "--cwd", "/tmp", "--label", "x", "--no-focus").result!;
    const root = tab.root_pane.pane_id as string;
    const split = herdr(fake.file, "pane", "split", root, "--direction", "right", "--no-focus").result!.pane.pane_id as string;
    herdr(fake.file, "agent", "start", "a", "--kind", "claude", "--pane", split);
    expect(herdr(fake.file, "tab", "close", tab.tab.tab_id).code).toBe(0);
    expect(fake.read().panes).toEqual([]);
    expect(herdr(fake.file, "agent", "list").result!.agents).toEqual([]);
  });

  test("closing a tab's last pane closes the tab", () => {
    const fake = fakeHerdrState();
    const tab = herdr(fake.file, "tab", "create", "--workspace", "w1", "--cwd", "/tmp", "--label", "x", "--no-focus").result!;
    const root = tab.root_pane.pane_id as string;
    const split = herdr(fake.file, "pane", "split", root, "--direction", "right", "--no-focus").result!.pane.pane_id as string;
    herdr(fake.file, "pane", "close", root);
    expect(herdr(fake.file, "tab", "get", tab.tab.tab_id).code).toBe(0); // one pane left
    herdr(fake.file, "pane", "close", split);
    expect(herdr(fake.file, "tab", "get", tab.tab.tab_id).error?.code).toBe("tab_not_found");
  });

  test("agent start in an unknown pane fails agent_pane_not_found", () => {
    const fake = fakeHerdrState();
    const r = herdr(fake.file, "agent", "start", "a", "--kind", "claude", "--pane", "w1:p9");
    expect(r.code).toBe(1);
    expect(r.error).toEqual({ code: "agent_pane_not_found", message: "agent target pane w1:p9 not found" });
  });

  test("agent prompt needs an agent in the target and rejects a blocked one", () => {
    const fake = fakeHerdrState({ tabs: ["w1:t1"], panes: ["w1:p1", "w1:p2"] });
    const shell = herdr(fake.file, "agent", "prompt", "w1:p1", "hello");
    expect(shell.code).toBe(1);
    expect(shell.error).toEqual({ code: "agent_not_found", message: "agent target w1:p1 not found" });
    herdr(fake.file, "agent", "start", "a", "--kind", "claude", "--pane", "w1:p2");
    expect(herdr(fake.file, "agent", "prompt", "a", "hello").code).toBe(0);
    expect(herdr(fake.file, "agent", "prompt", "w1:p2", "hello").code).toBe(0);
    fake.update((s) => ({ status: { ...s.status, "w1:p2": "blocked" } }));
    expect(herdr(fake.file, "agent", "prompt", "w1:p2", "hello").error?.code).toBe("agent_blocked");
  });

  test("tab create in an unknown workspace fails workspace_not_found when workspaces are seeded", () => {
    const fake = fakeHerdrState({ workspaces: ["w1"] });
    const r = herdr(fake.file, "tab", "create", "--workspace", "w9", "--cwd", "/tmp", "--label", "x", "--no-focus");
    expect(r.code).toBe(1);
    expect(r.error).toEqual({ code: "workspace_not_found", message: "workspace w9 not found" });
  });
});

test("an agent blocked at a startup dialog (agent_not_ready) stays listed as blocked", () => {
  const fake = fakeHerdrState({ tabs: ["w1:t1"], panes: ["w1:p1"], fail: ["agent start"], failCode: { "agent start": "agent_not_ready" } });
  const r = herdr(fake.file, "agent", "start", "c", "--kind", "claude", "--pane", "w1:p1");
  expect(r.error?.code).toBe("agent_not_ready");
  expect(herdr(fake.file, "agent", "list").result!.agents).toEqual([{ pane_id: "w1:p1", agent_status: "blocked", agent: "claude" }]);
  expect(herdr(fake.file, "agent", "get", "c").code).toBe(0);
});

test("an agent name stops resolving once its pane is closed", () => {
  const fake = fakeHerdrState({ tabs: ["w1:t1"], panes: ["w1:p1", "w1:p2"] });
  herdr(fake.file, "agent", "start", "c", "--kind", "claude", "--pane", "w1:p2");
  expect(herdr(fake.file, "agent", "get", "c").result!.agent.pane_id).toBe("w1:p2");
  herdr(fake.file, "pane", "close", "w1:p2");
  expect(herdr(fake.file, "agent", "get", "c").error).toEqual({ code: "agent_not_found", message: "agent target c not found" });
});

test("agent start can fail agent_pane_busy like a pane whose shell has not reached its prompt", () => {
  const fake = fakeHerdrState({ tabs: ["w1:t1"], panes: ["w1:p1"], busyStarts: 1 });
  expect(herdr(fake.file, "agent", "start", "c", "--kind", "claude", "--pane", "w1:p1").error).toEqual({ code: "agent_pane_busy", message: "agent target pane w1:p1 is not an available shell" });
  expect(herdr(fake.file, "agent", "start", "c", "--kind", "claude", "--pane", "w1:p1").code).toBe(0);
});
