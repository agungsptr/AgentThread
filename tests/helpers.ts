import { mkdtempSync, realpathSync } from "node:fs";
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
