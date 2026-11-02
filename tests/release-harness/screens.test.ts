import { expect, test } from "bun:test";
import { dumpPaneScreens } from "../release/harness.ts";
import { allScenarios } from "../release/scenarios/index.ts";

const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n");

/** A fake Herdr: `pane list` names the panes, `pane read <id> --source visible` gives each one's screen. */
function fake(screens: Record<string, string | Error>) {
  const calls: string[][] = [];
  const herdr = {
    run: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "pane" && args[1] === "list") {
        return { exitCode: 0, stdout: "", stderr: "", result: { panes: Object.keys(screens).map((pane_id) => ({ pane_id })) } };
      }
      if (args[0] === "pane" && args[1] === "read") {
        const s = screens[args[2]!];
        return s instanceof Error ? { exitCode: 1, stdout: "", stderr: s.message } : { exitCode: 0, stdout: s ?? "", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected" };
    },
  } as unknown as Parameters<typeof dumpPaneScreens>[0];
  return { herdr, calls };
}

test("every pane's visible screen goes to the notes, truncated to its last 40 lines", async () => {
  const { herdr, calls } = fake({ "w1:p1": lines(50, "main"), "w1:p5": "worker exited\n$ " });
  const notes: string[] = [];
  await dumpPaneScreens(herdr, (m) => void notes.push(m));
  expect(calls.filter((c) => c[1] === "read")).toEqual([
    ["pane", "read", "w1:p1", "--source", "visible"],
    ["pane", "read", "w1:p5", "--source", "visible"],
  ]);
  expect(notes).toEqual([
    `screen of pane w1:p1 (last 40 lines):\n${lines(50, "main").split("\n").slice(-40).join("\n")}`,
    "screen of pane w1:p5 (last 40 lines):\nworker exited\n$ ",
  ]);
});

test("a pane that cannot be read is noted and the others are still read; a failed pane list is noted", async () => {
  const { herdr } = fake({ "w1:p1": new Error("pane gone"), "w1:p2": "ok" });
  const notes: string[] = [];
  await dumpPaneScreens(herdr, (m) => void notes.push(m));
  expect(notes).toEqual(["screen of pane w1:p1: unreadable (pane gone)", "screen of pane w1:p2 (last 40 lines):\nok"]);
  const broken = { run: async () => ({ exitCode: 1, stdout: "", stderr: "server unavailable" }) } as unknown as Parameters<typeof dumpPaneScreens>[0];
  const more: string[] = [];
  await dumpPaneScreens(broken, (m) => void more.push(m));
  expect(more).toEqual(["pane screens: herdr pane list failed (server unavailable)"]);
});

test("the workspace rows keep worker panes open so their screens stay readable", () => {
  for (const s of allScenarios().filter((x) => x.workspace)) expect(s.config?.herdr?.close_worker_pane_on_end).toBe(false);
});
