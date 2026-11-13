// Fast tests of the release e2e harness's own logic (tests/release/harness.ts): no Herdr, no agents.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXED_MARKER, prepareFixedScratch, raceScenario, runClock, trustGate, watchTrustDialogs, type Herdr } from "../release/harness.ts";

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "agt-harness-test-")));

/** A Herdr with one blocked Claude Code agent showing the trust dialog in `pane`; records every send-keys. */
function fakeHerdr(pane: string) {
  const keys: string[] = [];
  let yes = false; // `down` moves the cursor to "Yes"
  const herdr = {
    agents: async () => [{ pane_id: pane, agent: "claude", agent_status: "blocked" }],
    run: async (args: string[]) => {
      if (args[1] === "send-keys") keys.push(`${args[2]} ${args[3]}`);
      if (args[1] === "send-keys" && args[3] === "down") yes = true;
      const dialog = `Do you trust the files in this folder?\n ${yes ? " " : "❯"} No, exit\n ${yes ? "❯" : " "} Yes, I trust this folder`;
      return { exitCode: 0, stdout: args[1] === "read" ? dialog : "", stderr: "" };
    },
  } as unknown as Herdr;
  return { herdr, keys };
}

// `graceMs: 0` stands for a dialog still showing past the 30s agt has to answer it (tests/release-harness/trust-gate.test.ts).
test("a trust dialog outside main's pane still showing past the grace is reported once and never answered", async () => {
  const { herdr, keys } = fakeHerdr("w1:p5");
  const foreign: string[] = [];
  const w = watchTrustDialogs(herdr, () => "w1:p1", () => {}, (p) => foreign.push(p), { graceMs: 0 });
  try {
    for (let i = 0; i < 50 && foreign.length === 0; i++) await Bun.sleep(20);
    await Bun.sleep(1_700); // a second poll: still reported once, still unanswered
    expect(foreign).toEqual(["w1:p5"]);
    expect(keys).toEqual([]);
    expect(w.answered).toEqual([]);
  } finally {
    w.stop();
  }
});

test("a trust dialog in main's pane is answered", async () => {
  const { herdr, keys } = fakeHerdr("w1:p1");
  const w = watchTrustDialogs(herdr, () => "w1:p1", () => {}, () => {});
  try {
    for (let i = 0; i < 100 && keys.length < 2; i++) await Bun.sleep(20);
    expect(keys).toEqual(["w1:p1 down", "w1:p1 enter"]);
  } finally {
    w.stop();
  }
});

test("a foreign trust dialog past the grace ends the row within seconds, not at its deadline", async () => {
  const gate = trustGate();
  const { herdr } = fakeHerdr("w1:p7");
  const w = watchTrustDialogs(herdr, () => "w1:p1", () => {}, (p) => gate.fail(p, "no trust dialog in a coordinator/worker pane"), { graceMs: 0 });
  const t0 = Date.now();
  try {
    const never = new Promise<void>(() => {});
    await expect(raceScenario(never, gate.promise, runClock.now() + 60_000, "scenario timed out after 20m")).rejects.toThrow(
      "trust dialog in coordinator/worker pane w1:p7: no trust dialog in a coordinator/worker pane",
    );
    expect(Date.now() - t0).toBeLessThan(3_000);
  } finally {
    w.stop();
  }
});

test("raceScenario: the scenario's own result and the deadline", async () => {
  await raceScenario(Promise.resolve(), trustGate().promise, runClock.now() + 60_000, "t");
  await expect(raceScenario(new Promise<void>(() => {}), trustGate().promise, runClock.now() + 20, "scenario timed out after 20m")).rejects.toThrow("scenario timed out after 20m");
});

test("the fixed scratch root: a missing folder fails with the one-time trust step", () => {
  const t = temp();
  try {
    expect(() => prepareFixedScratch(join(t, "mixed-main"))).toThrow(
      "~/.cache/agt-e2e/mixed-main does not exist; one time: mkdir -p ~/.cache/agt-e2e/mixed-main && cd ~/.cache/agt-e2e/mixed-main && git init && claude, then accept the trust prompt and exit",
    );
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("the fixed scratch root: a symlink is refused and its target left alone", () => {
  const t = temp();
  try {
    mkdirSync(join(t, "target"));
    writeFileSync(join(t, "target", "keep.txt"), "x");
    symlinkSync(join(t, "target"), join(t, "mixed-main"));
    expect(() => prepareFixedScratch(join(t, "mixed-main"))).toThrow("~/.cache/agt-e2e/mixed-main is a symlink; refusing to empty it");
    expect(existsSync(join(t, "target", "keep.txt"))).toBe(true);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("the fixed scratch root: unexpected files without the marker are refused and kept", () => {
  const t = temp();
  try {
    mkdirSync(join(t, ".git"));
    writeFileSync(join(t, "notes.txt"), "mine");
    expect(() => prepareFixedScratch(t)).toThrow("~/.cache/agt-e2e/mixed-main has unexpected files; it must only be the e2e folder (remove its contents and re-run)");
    expect(readdirSync(t).sort()).toEqual([".git", "notes.txt"]);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("the fixed scratch root: the user's git init, or a previous run (marker), is emptied; the folder stays", () => {
  const t = temp();
  try {
    prepareFixedScratch(t); // empty: fine
    mkdirSync(join(t, ".git"));
    prepareFixedScratch(t);
    expect(readdirSync(t)).toEqual([]);
    writeFileSync(join(t, FIXED_MARKER), "");
    mkdirSync(join(t, ".worktrees", "001-x"), { recursive: true });
    writeFileSync(join(t, "README.md"), "x");
    prepareFixedScratch(t);
    expect(existsSync(t)).toBe(true);
    expect(readdirSync(t)).toEqual([]);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});
