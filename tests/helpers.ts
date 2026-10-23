import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor, EventBody, StoredEvent } from "../src/domain/types.ts";
import { project, type State } from "../src/state/projection.ts";

export const USER: Actor = { role: "user" };

export const INIT: EventBody = { type: "project.initialized", payload: { name: "demo" } };

type ThreadPayload = Extract<EventBody, { type: "thread.created" }>["payload"];

export function threadCreated(id: string, overrides: Partial<ThreadPayload> = {}): EventBody {
  return {
    type: "thread.created",
    thread: id,
    payload: {
      title: `Thread ${id}`,
      threadType: "feature",
      slug: `thread-${id}`,
      goal: "",
      criteria: [],
      dependsOn: [],
      branch: `thread/${id}-thread-${id}`,
      worktree: `/repo/.worktrees/${id}-thread-${id}`,
      status: "open",
      ...overrides,
    },
  };
}

export function stored(bodies: EventBody[], actor: Actor = USER): StoredEvent[] {
  return bodies.map(
    (body, i) => ({ ...body, seq: i + 1, ts: `2026-10-09T10:00:${String(i % 60).padStart(2, "0")}.000Z`, actor }) as StoredEvent,
  );
}

export function stateOf(...bodies: EventBody[]): State {
  return project(stored(bodies));
}

export function tempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agt-repo-")));
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", dir, ...args], { stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

/** A temp dir to use as XDG_CONFIG_HOME so tests never read the developer's real user config. */
export function isolatedConfigHome(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "agt-xdg-")));
}

export const FAKE_HERDR = join(import.meta.dir, "fixtures", "fake-herdr.ts");

export const FAKE_CLAUDE = join(import.meta.dir, "fixtures", "fake-claude.ts");

type Maybe<T> = T | undefined | false | null;

/** Polls `fn` (sync or async) until it returns a truthy value. */
export async function waitFor<T>(fn: () => Maybe<T> | Promise<Maybe<T>>, timeoutMs = 5000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(50);
  }
  throw new Error("waitFor timed out");
}

export interface FakeHerdrState {
  next: number;
  tabs: string[];
  panes: string[];
  calls: string[][];
  fail?: string[];
  failCode?: Record<string, string>;
  hang?: string[];
  envs: (string | null)[];
  agents?: string[];
  agentPanes?: string[];
  status?: Record<string, string>;
  kinds?: Record<string, string>;
}

/** A state file for tests/fixtures/fake-herdr.ts; pass `file` as FAKE_HERDR_STATE. */
export function fakeHerdrState(seed: Partial<FakeHerdrState> = {}): { file: string; read(): FakeHerdrState } {
  const file = join(realpathSync(mkdtempSync(join(tmpdir(), "agt-herdr-"))), "herdr.json");
  writeFileSync(file, JSON.stringify({ next: 0, tabs: [], panes: [], calls: [], envs: [], ...seed }));
  return { file, read: () => JSON.parse(readFileSync(file, "utf8")) as FakeHerdrState };
}
