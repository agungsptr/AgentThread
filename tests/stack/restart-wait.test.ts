import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastRestart, waitRestart } from "../../src/stack/restart-wait.ts";

const root = () => {
  const r = realpathSync(mkdtempSync(join(tmpdir(), "agt-rw-")));
  mkdirSync(join(r, ".local-run"));
  return r;
};
const log = (r: string, ...lines: string[]) => appendFileSync(join(r, ".local-run", "restart.log"), lines.map((l) => `${l}\n`).join(""));
const pidFile = (r: string, pid: number) => writeFileSync(join(r, ".local-run", "restart.pid"), String(pid));
const noSleep = async () => {};

test("lastRestart reads the latest restart's lines and its outcome", () => {
  const r = root();
  expect(lastRestart(r)).toEqual({ state: "none", lines: [] });
  log(r, "restart requested", "api: stopped", "restart finished: ok", "restart requested", "api: stopped", "api: started pid 1 on :8001, healthy in 2.0s (worktree)");
  expect(lastRestart(r)).toEqual({ state: "running", lines: ["api: stopped", "api: started pid 1 on :8001, healthy in 2.0s (worktree)"] });
  log(r, "restart finished: failed (web)");
  expect(lastRestart(r)).toMatchObject({ state: "failed", lines: expect.arrayContaining(["restart finished: failed (web)"]) });
  log(r, "restart requested", "restart failed: unknown task x");
  expect(lastRestart(r)).toEqual({ state: "failed", lines: ["restart failed: unknown task x"] });
  log(r, "restart requested", "restart finished: ok");
  expect(lastRestart(r)).toEqual({ state: "ok", lines: ["restart finished: ok"] });
});

test("waitRestart returns as soon as the restart finishes, with its lines", async () => {
  const r = root();
  log(r, "restart requested", "api: stopped");
  pidFile(r, process.pid);
  let polls = 0;
  const res = await waitRestart(r, {
    timeoutMs: 60_000,
    sleep: async () => {
      if (++polls === 3) log(r, "api: started pid 1 on :8001, healthy in 2.0s (worktree)", "restart finished: ok");
    },
  });
  expect(res).toEqual({ code: 0, lines: ["api: stopped", "api: started pid 1 on :8001, healthy in 2.0s (worktree)", "restart finished: ok"] });
});

test("waitRestart: a failed restart exits 1; none requested exits 0 at once", async () => {
  const r = root();
  expect(await waitRestart(r, { timeoutMs: 1, sleep: noSleep })).toEqual({ code: 0, lines: ["no stack restart was requested"] });
  log(r, "restart requested", "web: failed: exited with code 1", "restart finished: failed (web)");
  expect((await waitRestart(r, { timeoutMs: 1, sleep: noSleep })).code).toBe(1);
});

test("waitRestart past its timeout exits 2 and says to run it again", async () => {
  const r = root();
  log(r, "restart requested", "web: installing (yarn install)");
  pidFile(r, process.pid);
  let t = 0;
  const res = await waitRestart(r, { timeoutMs: 5_000, now: () => (t += 1_000), sleep: noSleep });
  expect(res.code).toBe(2);
  expect(res.lines.at(-1)).toBe("still restarting after 5s; run agt stack wait again");
});

test("waitRestart: a restart process that died without finishing exits 1", async () => {
  const r = root();
  log(r, "restart requested", "api: stopped");
  pidFile(r, 2 ** 22 + 12345); // no such process
  const res = await waitRestart(r, { timeoutMs: 60_000, sleep: noSleep });
  expect(res.code).toBe(1);
  expect(res.lines.at(-1)).toBe("the restart process ended without finishing; see .local-run/restart.log");
});
