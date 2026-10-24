import { describe, expect, test } from "bun:test";
import { HerdrCli, HerdrError, shellQuote, spawnAsync, spawnRunner, type Runner } from "../../src/herdr/bridge.ts";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_HERDR, fakeHerdrState } from "../helpers.ts";

function recording(reply: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
  const calls: { bin: string; args: string[] }[] = [];
  const runner: Runner = (bin, args) => {
    calls.push({ bin, args });
    return { exitCode: reply.exitCode ?? 0, stdout: reply.stdout ?? '{"result":{"type":"ok"}}', stderr: reply.stderr ?? "" };
  };
  return { calls, runner };
}

describe("HerdrCli with a recording runner", () => {
  test("createTab passes workspace, cwd, label, no-focus and env, and reads ids from JSON", () => {
    const { calls, runner } = recording({
      stdout: JSON.stringify({ result: { type: "tab_created", tab: { tab_id: "w7:t3" }, root_pane: { pane_id: "w7:p9" } } }),
    });
    const h = new HerdrCli({ bin: "/bin/herdr", runner });
    const out = h.createTab({ workspace: "w7", cwd: "/r/wt", label: "001-x", env: { AGT_ROOT: "/r", AGT_THREAD: "001" } });
    expect(out).toEqual({ tabId: "w7:t3", rootPaneId: "w7:p9" });
    expect(calls).toEqual([
      {
        bin: "/bin/herdr",
        args: ["tab", "create", "--workspace", "w7", "--cwd", "/r/wt", "--label", "001-x", "--no-focus", "--env", "AGT_ROOT=/r", "--env", "AGT_THREAD=001"],
      },
    ]);
  });

  test("splitPane, rename, run and close build the expected argv", () => {
    const { calls, runner } = recording({ stdout: JSON.stringify({ result: { pane: { pane_id: "w7:p4" } } }) });
    const h = new HerdrCli({ bin: "herdr", runner });
    expect(h.splitPane({ pane: "w7:p1", direction: "right", cwd: "/r", env: { AGT_ROOT: "/r" } })).toBe("w7:p4");
    h.renamePane("w7:p4", "logger");
    h.renameTab("w7:t1", "main");
    h.runInPane("w7:p4", "agt logs -f");
    h.closeTab("w7:t2");
    expect(calls.map((c) => c.args)).toEqual([
      ["pane", "split", "w7:p1", "--direction", "right", "--cwd", "/r", "--no-focus", "--env", "AGT_ROOT=/r"],
      ["pane", "rename", "w7:p4", "logger"],
      ["tab", "rename", "w7:t1", "main"],
      ["pane", "run", "w7:p4", "agt logs -f"],
      ["tab", "close", "w7:t2"],
    ]);
  });

  test("runInPane accepts the empty stdout real Herdr prints for pane run", () => {
    const { calls, runner } = recording({ stdout: "" });
    const h = new HerdrCli({ bin: "herdr", runner });
    h.runInPane("w7:p4", "agt logs -f");
    expect(calls.map((c) => c.args)).toEqual([["pane", "run", "w7:p4", "agt logs -f"]]);
    // other commands still need their JSON
    expect(() => h.renamePane("w7:p4", "logger")).toThrow("herdr pane rename: unparseable output");
  });

  test("error JSON on stderr becomes a HerdrError with its code", () => {
    const { runner } = recording({ exitCode: 1, stderr: '{"error":{"code":"tab_not_found","message":"no such tab"}}' });
    const h = new HerdrCli({ bin: "herdr", runner });
    let caught: unknown;
    try {
      h.closeTab("w7:t9");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HerdrError);
    expect((caught as HerdrError).code).toBe("tab_not_found");
    expect((caught as HerdrError).message).toBe("herdr tab close: no such tab");
  });

  test("non-JSON failure keeps stderr text", () => {
    const { runner } = recording({ exitCode: 2, stderr: "usage: herdr ..." });
    expect(() => new HerdrCli({ bin: "herdr", runner }).renameTab("w1:t1", "x")).toThrow("herdr tab rename: usage: herdr ...");
  });

  test("missing ids in a success response are reported", () => {
    const { runner } = recording({ stdout: '{"result":{"type":"tab_created"}}' });
    expect(() => new HerdrCli({ bin: "herdr", runner }).createTab({ workspace: "w", cwd: "/", label: "l", env: {} })).toThrow(
      "herdr tab create: response missing tab.tab_id",
    );
  });

  test("tabExists is false only for not-found errors and throws on any other error", () => {
    const err = (code?: string) => recording({ exitCode: 1, stderr: code ? JSON.stringify({ error: { code, message: "x" } }) : "{}" }).runner;
    expect(new HerdrCli({ bin: "herdr", runner: recording().runner }).tabExists("w1:t1")).toBe(true);
    expect(new HerdrCli({ bin: "herdr", runner: err("tab_not_found") }).tabExists("w1:t1")).toBe(false);
    expect(new HerdrCli({ bin: "herdr", runner: err("not_found") }).tabExists("w1:t1")).toBe(false);
    expect(() => new HerdrCli({ bin: "herdr", runner: err() }).tabExists("w1:t1")).toThrow(HerdrError);
    expect(() => new HerdrCli({ bin: "herdr", runner: err("server_unavailable") }).tabExists("w1:t1")).toThrow(HerdrError);
  });
});

describe("HerdrCli against the fake herdr executable", () => {
  test("tab lifecycle", () => {
    const fake = fakeHerdrState();
    const h = new HerdrCli({ bin: FAKE_HERDR, env: { ...process.env, FAKE_HERDR_STATE: fake.file }, runner: spawnRunner });
    const { tabId, rootPaneId } = h.createTab({ workspace: "w1", cwd: "/tmp", label: "001-x", env: { AGT_THREAD: "001" } });
    expect([tabId, rootPaneId]).toEqual(["w1:t1", "w1:p1"]);
    expect(h.tabExists(tabId)).toBe(true);
    h.closeTab(tabId);
    expect(h.tabExists(tabId)).toBe(false);
    expect(fake.read().calls[0]).toEqual(["tab", "create", "--workspace", "w1", "--cwd", "/tmp", "--label", "001-x", "--no-focus", "--env", "AGT_THREAD=001"]);
  });
});

describe("herdr timeouts", () => {
  test("spawnAsync: a grandchild holding stdout after the timeout kill does not keep it waiting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agt-bin-"));
    const bin = join(dir, "holder");
    // prints, then leaves a sleeping background child that inherited stdout, and hangs itself
    writeFileSync(bin, `#!/bin/sh\necho started\nsleep 5 &\necho $! > ${join(dir, "pid")}\nsleep 5\n`);
    chmodSync(bin, 0o755);
    const t0 = Date.now();
    // the timeout leaves room for the shell to start and print under a busy test runner
    const r = await spawnAsync(bin, [], process.env, 1000);
    try {
      expect(Date.now() - t0).toBeLessThan(2_500); // not the grandchild's 5s
      expect(r.timedOut).toBe(true);
      expect(r.stdout).toContain("started");
    } finally {
      try {
        process.kill(Number(readFileSync(join(dir, "pid"), "utf8").trim()), "SIGKILL");
      } catch {}
    }
  });

  test("a hung herdr is killed and reported as a timeout", () => {
    const fake = fakeHerdrState({ hang: ["tab get"] });
    const h = new HerdrCli({ bin: FAKE_HERDR, env: { ...process.env, FAKE_HERDR_STATE: fake.file }, timeoutMs: 300 });
    const marker = `w1:hang-${crypto.randomUUID()}`;
    const started = Date.now();
    let caught: unknown;
    try {
      h.tabExists(marker);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HerdrError);
    expect((caught as HerdrError).code).toBe("timeout");
    expect((caught as HerdrError).message).toBe("herdr tab get: timed out after 300ms");
    expect(Date.now() - started).toBeLessThan(3_000);
    const left = Bun.spawnSync(["pgrep", "-f", marker]);
    expect(left.stdout.toString().trim()).toBe("");
  });
});

describe("real herdr (opt-in: HERDR_ENV=1 AGT_HERDR_IT=1)", () => {
  const enabled = process.env.HERDR_ENV === "1" && process.env.AGT_HERDR_IT === "1" && !!process.env.HERDR_WORKSPACE_ID;
  test.skipIf(!enabled)("creates, finds and closes a tab", () => {
    const h = new HerdrCli({ bin: process.env.HERDR_BIN_PATH ?? "herdr" });
    const { tabId } = h.createTab({ workspace: process.env.HERDR_WORKSPACE_ID!, cwd: "/tmp", label: "agt-it", env: { AGT_IT: "1" } });
    try {
      expect(h.tabExists(tabId)).toBe(true);
    } finally {
      h.closeTab(tabId);
    }
    expect(h.tabExists(tabId)).toBe(false);
  });
});

test("shellQuote", () => {
  expect(shellQuote("/a b/it's")).toBe("'/a b/it'\\''s'");
  expect(shellQuote("plain")).toBe("'plain'");
});

describe("agent commands", () => {
  test("argv for agent start / prompt and pane close", () => {
    const calls: { args: string[]; timeout: number }[] = [];
    const runner: Runner = (_bin, args, _env, timeoutMs) => {
      calls.push({ args, timeout: timeoutMs });
      return { exitCode: 0, stdout: '{"result":{"type":"ok"}}', stderr: "" };
    };
    const h = new HerdrCli({ bin: "herdr", runner });
    h.agentStart({ name: "agt-ab12-c001", kind: "claude", pane: "w1:p2", args: ["--session-id", "s"] });
    h.agentStart({ name: "n", kind: "claude", pane: "w1:p3", args: [], timeoutMs: 5000 });
    h.agentPrompt("w1:p2", "Ticket T1 is done.");
    h.closePane("w1:p3");
    expect(calls).toEqual([
      { args: ["agent", "start", "agt-ab12-c001", "--kind", "claude", "--pane", "w1:p2", "--timeout", "60000", "--", "--session-id", "s"], timeout: 70000 },
      { args: ["agent", "start", "n", "--kind", "claude", "--pane", "w1:p3", "--timeout", "5000", "--"], timeout: 15000 },
      { args: ["agent", "prompt", "w1:p2", "Ticket T1 is done."], timeout: 10000 },
      { args: ["pane", "close", "w1:p3"], timeout: 10000 },
    ]);
  });

  test("fake herdr: agent start needs a known pane; pane close removes it", () => {
    const fake = fakeHerdrState({ panes: ["w1:p2"] });
    const h = new HerdrCli({ bin: FAKE_HERDR, env: { ...process.env, FAKE_HERDR_STATE: fake.file } });
    h.agentStart({ name: "a", kind: "claude", pane: "w1:p2", args: ["x"] });
    expect(() => h.agentStart({ name: "b", kind: "claude", pane: "w1:p9", args: [] })).toThrow(/pane w1:p9 not found/);
    h.closePane("w1:p2");
    expect(fake.read().panes).toEqual([]);
    expect(fake.read().agents).toEqual(["a"]);
  });
});

describe("agentExists", () => {
  test("true on success, false for not-found codes, rethrows others", () => {
    const run = (exitCode: number, stderr = "") => new HerdrCli({ bin: "herdr", runner: () => ({ exitCode, stdout: '{"result":{"type":"agent_info"}}', stderr }) });
    expect(run(0).agentExists("w1:p2")).toBe(true);
    expect(run(1, '{"error":{"code":"agent_not_found","message":"x"}}').agentExists("w1:p2")).toBe(false);
    expect(run(1, '{"error":{"code":"pane_not_found","message":"x"}}').agentExists("w1:p2")).toBe(false);
    expect(() => run(1, '{"error":{"code":"server_unavailable","message":"down"}}').agentExists("w1:p2")).toThrow("down");
  });

  test("fake herdr tracks agent panes", () => {
    const fake = fakeHerdrState({ panes: ["w1:p2"] });
    const h = new HerdrCli({ bin: FAKE_HERDR, env: { ...process.env, FAKE_HERDR_STATE: fake.file } });
    expect(h.agentExists("w1:p2")).toBe(false);
    h.agentStart({ name: "a", kind: "claude", pane: "w1:p2", args: [] });
    expect(h.agentExists("w1:p2")).toBe(true);
    h.closePane("w1:p2");
    expect(h.agentExists("w1:p2")).toBe(false);
  });
});
