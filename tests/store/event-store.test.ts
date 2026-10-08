import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../../src/store/event-store.ts";

const dbPath = () => join(mkdtempSync(join(tmpdir(), "agt-store-")), "state.db");
const actor = { role: "user" as const };

test("append assigns increasing seq and round-trips payloads", () => {
  const store = new EventStore(dbPath());
  const now = new Date("2026-10-09T10:00:00Z");
  const stored = store.append(
    [
      { type: "project.initialized", payload: { name: "demo" } },
      { type: "log.appended", thread: "001", payload: { message: "hello" } },
    ],
    actor,
    now,
  );
  expect(stored.map((e) => e.seq)).toEqual([1, 2]);
  expect(store.all()).toEqual([
    { seq: 1, ts: "2026-10-09T10:00:00.000Z", type: "project.initialized", actor, payload: { name: "demo" } },
    { seq: 2, ts: "2026-10-09T10:00:00.000Z", type: "log.appended", thread: "001", actor, payload: { message: "hello" } },
  ]);
  store.close();
});

test("events persist across reopen", () => {
  const path = dbPath();
  const first = new EventStore(path);
  first.append([{ type: "project.initialized", payload: { name: "demo" } }], actor);
  first.close();
  const second = new EventStore(path);
  expect(second.all()).toHaveLength(1);
  expect(second.append([{ type: "log.appended", thread: "001", payload: { message: "x" } }], actor)[0]!.seq).toBe(2);
  second.close();
});

test("since returns only newer events", () => {
  const store = new EventStore(dbPath());
  store.append(
    [1, 2, 3].map((n) => ({ type: "log.appended" as const, thread: "001", payload: { message: `m${n}` } })),
    actor,
  );
  expect(store.since(2).map((e) => e.seq)).toEqual([3]);
  store.close();
});
