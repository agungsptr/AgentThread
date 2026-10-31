import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor, EventBody, StoredEvent } from "../src/domain/types.ts";
import { project, type State } from "../src/state/projection.ts";

export const USER: Actor = { role: "user" };

/**
 * A short spawn-report retry window (3 × 100ms instead of 20 × 500ms): a spawn job whose daemon a test has stopped
 * exits within about a second instead of retrying for 10s. Pass it in the env of a CLI-started daemon; daemons started
 * in the test process hand process.env to their jobs, so it is set there as well.
 */
export const SPAWN_REPORT_ENV = { AGT_SPAWN_REPORT_ATTEMPTS: "3", AGT_SPAWN_REPORT_DELAY_MS: "100" } as const;
process.env.AGT_SPAWN_REPORT_ATTEMPTS ??= SPAWN_REPORT_ENV.AGT_SPAWN_REPORT_ATTEMPTS;
process.env.AGT_SPAWN_REPORT_DELAY_MS ??= SPAWN_REPORT_ENV.AGT_SPAWN_REPORT_DELAY_MS;

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

/** A thread.created of the thread-directory layout: a task and its directory, no single worktree or branch. */
export function taskThreadCreated(id: string, task: string, overrides: Partial<ThreadPayload> = {}): EventBody {
  const { branch: _b, worktree: _w, ...payload } = (threadCreated(id) as Extract<EventBody, { type: "thread.created" }>).payload;
  return { type: "thread.created", thread: id, payload: { ...payload, task, dir: `/repo/.worktrees/${task}`, ...overrides } };
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

export const FAKE_AGENT = join(import.meta.dir, "fixtures", "fake-agent.ts");

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
  paneTab?: Record<string, string>;
  workspaces?: string[];
  agentStartPanes?: string[];
  busyStarts?: number;
}

/**
 * A state file for tests/fixtures/fake-herdr.ts; pass `file` as FAKE_HERDR_STATE. `update` changes it under the same
 * lock the fake takes, so a concurrent fake call (the daemon polls it) never overwrites the change.
 */
export function fakeHerdrState(seed: Partial<FakeHerdrState> = {}): {
  file: string;
  read(): FakeHerdrState;
  update(change: (s: FakeHerdrState) => Partial<FakeHerdrState>): void;
} {
  const file = join(realpathSync(mkdtempSync(join(tmpdir(), "agt-herdr-"))), "herdr.json");
  writeFileSync(file, JSON.stringify({ next: 0, tabs: [], panes: [], calls: [], envs: [], ...seed }));
  const read = () => JSON.parse(readFileSync(file, "utf8")) as FakeHerdrState;
  const update = (change: (s: FakeHerdrState) => Partial<FakeHerdrState>) => {
    const lock = `${file}.lock`;
    for (;;) {
      try {
        mkdirSync(lock);
        break;
      } catch {
        try {
          if (Date.now() - statSync(lock).mtimeMs > 5000) rmSync(lock, { recursive: true, force: true });
        } catch {}
        Bun.sleepSync(2);
      }
    }
    try {
      const s = read();
      writeFileSync(`${file}.test.tmp`, JSON.stringify({ ...s, ...change(s) }));
      renameSync(`${file}.test.tmp`, file);
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  };
  return { file, read, update };
}

/** A folder holding two git repos (a, b) and a plain folder. */
export function twoRepoFolder(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agt-ws-")));
  for (const n of ["a", "b"]) {
    mkdirSync(join(root, n));
    const r = Bun.spawnSync(["git", "-C", join(root, n), "init", "-q", "-b", "main"]);
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  }
  mkdirSync(join(root, "plain"));
  return root;
}
