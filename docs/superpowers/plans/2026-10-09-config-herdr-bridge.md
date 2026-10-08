# AgentThread Config + Herdr Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add layered configuration and a Herdr bridge so that `agt start` builds the `main` tab (main-manager pane + logger pane), every subthread gets its own Herdr tab in its worktree, and that tab closes automatically when the thread is `done`.

**Architecture:** Herdr is driven only through its CLI (`herdr tab|pane …`, JSON on stdout, JSON errors on stderr) behind a small `HerdrBridge` interface, so tests use a fake `herdr` executable. The pure command handler emits Herdr *effects* (`herdr.tab.ensure`, `herdr.tab.close`); the daemon's effect runner executes them and turns their results into events (`thread.tab_opened`, `thread.tab_closed`). Herdr effects are *soft*: if Herdr fails, the command still succeeds and the next `agt start` reconciles missing tabs. `agt start` itself (running inside a Herdr pane) sets up the main tab and registers the layout with the daemon.

**Tech Stack:** TypeScript on Bun ≥ 1.1.34, `bun:test`, `zod`, `yaml`, Herdr CLI.

**Spec:** `docs/specs/2026-10-09-agentthread-design.md` (§8 Herdr layout, §9 Configuration). Follow-ups from Plan 1: `docs/superpowers/followups/2026-10-09-core-engine.md`.

### Roadmap position

Plan 2 of 5. Plan 1 (core engine) is merged. Plan 3 (Claude Code adapter) will start the main manager agent in the `main manager` pane, start coordinators in each subthread tab's root pane, and spawn worker panes. That plan also uses `workers.max_workers` and `herdr.close_worker_pane_on_end`. Plan 2 only creates and validates those config keys.

### Spec adjustments made in this plan

- **The main manager pane is the pane where `agt start` runs.** It is renamed `main manager` and stays a shell until Plan 3 starts Claude Code in it. The logger pane is split to the right and runs `agt logs -f`.
- **Per-thread config overrides (frontmatter `max_workers`) are deferred to Plan 3**, which is the first plan that reads `max_workers`. Plan 2 implements user > project > defaults.
- **Config is read once at daemon start.** Changing config requires `agt daemon stop && agt daemon start`. `agt config` prints the effective config.
- **`language` only accepts `en`** for now, because only English templates exist.
- **Subthread tab label is `<id>-<slug>`**, e.g. `002-fix-checkout-race`, and the tab's root pane gets env `AGT_ROOT`, `AGT_THREAD`, `AGT_ROLE=coordinator`. The root pane hosts the coordinator in Plan 3.
- **Plan 1 follow-ups folded in:** the daemon takes the `state.db` lock *before* touching the socket, and verifies the socket directory's owner and permissions.

## Global Constraints

- Runtime: Bun ≥ 1.1.34, TypeScript `strict: true`; tests with `bun:test`; run `bun test` and `bun run typecheck` before each commit.
- Config files: user `${XDG_CONFIG_HOME:-$HOME/.config}/agentthread/config.yaml`, project `<repo>/.agentthread/config.yaml`. Precedence: project > user > defaults. Unknown keys are errors.
- Config defaults exactly: `language: en`; `agents.main_manager|default_coordinator|default_worker: claude-code`; `workers.max_workers: 3`; `session.rotation.on_precompact: true`, `session.rotation.context_threshold: 0.7`, `session.rotation.idle_timeout: 24h`; `session.handoff.timeout: 5m`, `session.handoff.fallback_generate: true`; `herdr.main_tab_label: main`, `herdr.close_tab_on_done: true`, `herdr.close_worker_pane_on_end: true`.
- Herdr env vars used: `HERDR_ENV` (must be `1`), `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID`, `HERDR_BIN_PATH`, `HERDR_SOCKET_PATH`.
- Herdr IDs are opaque strings read from JSON responses (`result.tab.tab_id`, `result.root_pane.pane_id`, `result.pane.pane_id`); never derived.
- New event types exactly: `layout.registered`, `thread.tab_opened`, `thread.tab_closed`. New commands: `layout.register`, `layout.reconcile` (role `user` only).
- Herdr effects never fail a command; git effects still do.
- Never run a mutating `herdr` command without arguments in development (e.g. bare `herdr tab create` creates a tab).

## Review Focus

1. **Herdr unavailable or failing** (binary missing, server down, error JSON) → `agt thread new` / `thread status done` still succeed and write their events; the missing tab is created by the next `agt start`. Test in Task 5.
2. **A user closes a subthread tab by hand** → the next `agt start` reopens exactly that tab and does not duplicate tabs that are still open. Tests in Task 5 and Task 7.
3. **`agt start` run a second time** while the registered main tab still exists → no re-split, no renames, no second logger pane. Test in Task 6.
4. **A typo or wrong type in a config file** → `agt config` and daemon start fail with an error naming the key, instead of silently using defaults. Tests in Task 2 and Task 5.
5. **Project root containing spaces or quotes** → the logger pane command is shell-quoted correctly. Test in Task 6.

---

## File structure

```
src/daemon/socket-dir.ts       # ensureSocketDir: create /tmp/agt-<uid>, verify owner, enforce 0700
src/daemon/server.ts           # (modify) lock-first startup, config, effect runner, layout.get op
src/daemon/protocol.ts         # (modify) add { op: "layout.get" }
src/daemon/effects.ts          # createEffectRunner: git + herdr effects → extra events
src/config/config.ts           # ConfigSchema, DEFAULT_CONFIG, configPaths, loadConfig, deepMerge
src/herdr/bridge.ts            # HerdrBridge interface, HerdrCli implementation, HerdrError, shellQuote
src/domain/types.ts            # (modify) Layout, new event types
src/state/projection.ts        # (modify) state.layout, thread.tab / rootPane
src/commands/schema.ts         # (modify) layout.register, layout.reconcile
src/commands/handler.ts        # (modify) Herdr effects, ctx.config, layout commands
src/render/markdown.ts         # (modify) `tab:` in sub.thread.md frontmatter
src/cli/main.ts                # (modify) `agt config`, `agt start`, ensureDaemon refactor
tests/fixtures/fake-herdr.ts   # executable fake herdr CLI (state in $FAKE_HERDR_STATE)
tests/helpers.ts               # (modify) FAKE_HERDR, fakeHerdrState(), isolatedConfigHome()
```

---

### Task 1: Daemon startup hardening (Plan 1 follow-ups)

**Files:**
- Create: `src/daemon/socket-dir.ts`
- Modify: `src/daemon/server.ts` (startup sequence at the top of `startDaemon`)
- Test: `tests/daemon/daemon.test.ts` (add two tests)

**Interfaces:**
- Consumes: `EventStore(path, { exclusive: true })` (throws `daemon already running` when locked), `paths(root).socketDir` / `.socket`.
- Produces: `ensureSocketDir(dir: string): void`. Creates the directory with mode 0700, throws `socket directory <dir> is owned by another user` if the owner differs, and chmods it to 0700 if group/other bits are set. `startDaemon` now acquires the store lock before touching the socket.

- [ ] **Step 1: Write the failing tests**

Append to `tests/daemon/daemon.test.ts` (it already has `root`, `daemon`, `beforeEach`/`afterEach`, `sock()`; add the imports `chmodSync, statSync` from `node:fs` and `EventStore` from `../../src/store/event-store.ts` to the existing import lines):

```ts
test("a refused start never touches the socket of the daemon that holds the lock", async () => {
  await daemon.stop();
  const holder = new EventStore(paths(root).db, { exclusive: true });
  writeFileSync(sock(), "sentinel");
  try {
    await expect(startDaemon(root)).rejects.toThrow("daemon already running");
    expect(readFileSync(sock(), "utf8")).toBe("sentinel");
  } finally {
    holder.close();
    rmSync(sock(), { force: true });
  }
  daemon = await startDaemon(root);
});

test("socket directory is forced back to 0700", async () => {
  await daemon.stop();
  chmodSync(paths(root).socketDir, 0o755);
  daemon = await startDaemon(root);
  expect(statSync(paths(root).socketDir).mode & 0o777).toBe(0o700);
});
```

Add `rmSync` to the `node:fs` import too if missing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/daemon/daemon.test.ts`
Expected: FAIL. The first test sees the sentinel removed, because the old startup `rm`s a non-live socket before taking the lock. The second sees mode `0o755`.

- [ ] **Step 3: Implement `ensureSocketDir`**

Create `src/daemon/socket-dir.ts`:

```ts
import { chmodSync, mkdirSync, statSync } from "node:fs";

/** Creates the per-user socket directory and makes sure nobody else can reach sockets inside it. */
export function ensureSocketDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new Error(`socket directory ${dir} is owned by another user`);
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}
```

- [ ] **Step 4: Reorder daemon startup**

In `src/daemon/server.ts`, replace everything from `const p = paths(root);` down to and including the existing `mkdirSync(p.socketDir, { recursive: true, mode: 0o700 });` line with:

```ts
  const p = paths(root);
  // Taking the exclusive store lock first makes "one daemon per project" a property of state.db, not of the socket path.
  const store = new EventStore(p.db, { exclusive: true });
  let state: ReturnType<typeof project>;
  try {
    state = project(store.all());
    if (!state.project) throw new Error("project not initialized; run `agt init`");
    ensureSocketDir(p.socketDir);
    rmSync(p.socket, { force: true });
    writeAll(root, state);
  } catch (e) {
    store.close();
    throw e;
  }
```

Then fix the imports: add `import { ensureSocketDir } from "./socket-dir.ts";`, remove `existsSync` and `mkdirSync` from the `node:fs` import if they are no longer used, and remove the `isAlive` import if it is no longer used.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/daemon && bun run typecheck`
Expected: PASS, including the existing "refuses a second daemon and recovers from a stale socket" test.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/socket-dir.ts src/daemon/server.ts tests/daemon/daemon.test.ts
git commit -m "fix: take the state lock before touching the daemon socket"
```

---

### Task 2: Layered configuration and `agt config`

**Files:**
- Create: `src/config/config.ts`
- Modify: `src/cli/main.ts` (add `config` command + usage line)
- Modify: `tests/helpers.ts` (add `isolatedConfigHome`)
- Test: `tests/config/config.test.ts`, `tests/cli/config.test.ts`

**Interfaces:**
- Consumes: `AGENT_KINDS` from `src/domain/types.ts`; `findRoot`, `initProject`.
- Produces:
  - `ConfigSchema` (zod), `type Config`, `DEFAULT_CONFIG: Config`
  - `configPaths(root: string, env?: Record<string, string | undefined>): { user: string; project: string }`
  - `loadConfig(root: string, env?: Record<string, string | undefined>): Config` (throws `invalid config (...): <path>: <message>; ...`, `cannot parse <file>: ...`, or `<file> must contain a YAML mapping`)
  - `deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown>`
  - CLI: `agt config` prints the effective config as YAML.
  - Test helper: `isolatedConfigHome(): string`. Creates a temp dir to use as `XDG_CONFIG_HOME`.

- [ ] **Step 1: Add the helper**

Append to `tests/helpers.ts`:

```ts
/** A temp dir to use as XDG_CONFIG_HOME so tests never read the developer's real user config. */
export function isolatedConfigHome(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "agt-xdg-")));
}
```

(`mkdtempSync`, `realpathSync`, `tmpdir`, `join` are already imported there.)

- [ ] **Step 2: Write the failing tests**

Create `tests/config/config.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, configPaths, deepMerge, loadConfig } from "../../src/config/config.ts";
import { isolatedConfigHome } from "../helpers.ts";

function setup(files: { user?: string; project?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agt-cfg-")));
  const env = { XDG_CONFIG_HOME: isolatedConfigHome(), HOME: "/nonexistent" };
  const p = configPaths(root, env);
  if (files.user !== undefined) {
    mkdirSync(join(p.user, ".."), { recursive: true });
    writeFileSync(p.user, files.user);
  }
  if (files.project !== undefined) {
    mkdirSync(join(p.project, ".."), { recursive: true });
    writeFileSync(p.project, files.project);
  }
  return { root, env, p };
}

test("defaults match the spec", () => {
  expect(DEFAULT_CONFIG).toEqual({
    language: "en",
    agents: { main_manager: "claude-code", default_coordinator: "claude-code", default_worker: "claude-code" },
    workers: { max_workers: 3 },
    session: {
      rotation: { on_precompact: true, context_threshold: 0.7, idle_timeout: "24h" },
      handoff: { timeout: "5m", fallback_generate: true },
    },
    herdr: { main_tab_label: "main", close_tab_on_done: true, close_worker_pane_on_end: true },
  });
});

test("no files gives the defaults", () => {
  const { root, env } = setup();
  expect(loadConfig(root, env)).toEqual(DEFAULT_CONFIG);
});

test("config paths honor XDG_CONFIG_HOME and fall back to HOME", () => {
  expect(configPaths("/repo", { XDG_CONFIG_HOME: "/x" })).toEqual({
    user: "/x/agentthread/config.yaml",
    project: "/repo/.agentthread/config.yaml",
  });
  expect(configPaths("/repo", { HOME: "/home/me" }).user).toBe("/home/me/.config/agentthread/config.yaml");
});

test("project overrides user, nested keys merge", () => {
  const { root, env } = setup({
    user: "workers:\n  max_workers: 5\nherdr:\n  close_tab_on_done: false\n",
    project: "workers:\n  max_workers: 2\nherdr:\n  main_tab_label: home\n",
  });
  const cfg = loadConfig(root, env);
  expect(cfg.workers.max_workers).toBe(2);
  expect(cfg.herdr).toEqual({ main_tab_label: "home", close_tab_on_done: false, close_worker_pane_on_end: true });
});

test("empty files are allowed", () => {
  const { root, env } = setup({ user: "", project: "# nothing\n" });
  expect(loadConfig(root, env)).toEqual(DEFAULT_CONFIG);
});

test("unknown keys are rejected with their path", () => {
  const { root, env } = setup({ project: "workers:\n  max_worker: 2\n" });
  expect(() => loadConfig(root, env)).toThrow(/workers: Unrecognized key\(s\) in object: 'max_worker'/);
});

test("wrong types and ranges are rejected with their path", () => {
  const { root, env } = setup({ project: "session:\n  rotation:\n    context_threshold: 7\n" });
  expect(() => loadConfig(root, env)).toThrow(/session\.rotation\.context_threshold/);
  const bad = setup({ user: "session:\n  handoff:\n    timeout: soon\n" });
  expect(() => loadConfig(bad.root, bad.env)).toThrow(/session\.handoff\.timeout: duration must look like 30s, 5m, 24h or 2d/);
});

test("non-mapping and unparseable files are rejected", () => {
  const list = setup({ project: "- a\n- b\n" });
  expect(() => loadConfig(list.root, list.env)).toThrow("must contain a YAML mapping");
  const broken = setup({ user: "workers: [\n" });
  expect(() => loadConfig(broken.root, broken.env)).toThrow(/cannot parse .*config\.yaml/);
});

test("deepMerge replaces arrays and scalars, merges objects", () => {
  expect(deepMerge({ a: { b: 1, c: [1] }, d: 1 }, { a: { c: [2] }, d: 2 })).toEqual({ a: { b: 1, c: [2] }, d: 2 });
});
```

Create `tests/cli/config.test.ts`:

```ts
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { initProject } from "../../src/project/init.ts";
import { isolatedConfigHome, tempRepo } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");

function agt(root: string, args: string[]) {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", XDG_CONFIG_HOME: isolatedConfigHome(), AGT_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

test("agt config prints the effective config", () => {
  const root = tempRepo();
  initProject(root, "demo");
  writeFileSync(join(root, ".agentthread", "config.yaml"), "workers:\n  max_workers: 4\n");
  const r = agt(root, ["config"]);
  expect(r.code).toBe(0);
  expect(parse(r.out)).toMatchObject({ language: "en", workers: { max_workers: 4 }, herdr: { main_tab_label: "main" } });
});

test("agt config reports invalid config", () => {
  const root = tempRepo();
  initProject(root, "demo");
  writeFileSync(join(root, ".agentthread", "config.yaml"), "herdr:\n  close_tab_on_done: maybe\n");
  const r = agt(root, ["config"]);
  expect(r.code).toBe(1);
  expect(r.err).toMatch(/^agt: invalid config .*herdr\.close_tab_on_done/);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test tests/config tests/cli/config.test.ts`
Expected: FAIL with `Cannot find module '../../src/config/config.ts'`.

- [ ] **Step 4: Implement the config module**

Create `src/config/config.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { AGENT_KINDS } from "../domain/types.ts";

type Env = Record<string, string | undefined>;

const duration = z.string().regex(/^\d+[smhd]$/, "duration must look like 30s, 5m, 24h or 2d");
const agent = z.enum(AGENT_KINDS);

export const ConfigSchema = z
  .object({
    language: z.enum(["en"]).default("en"),
    agents: z
      .object({
        main_manager: agent.default("claude-code"),
        default_coordinator: agent.default("claude-code"),
        default_worker: agent.default("claude-code"),
      })
      .strict()
      .default({}),
    workers: z
      .object({ max_workers: z.number().int().min(1).max(16).default(3) })
      .strict()
      .default({}),
    session: z
      .object({
        rotation: z
          .object({
            on_precompact: z.boolean().default(true),
            context_threshold: z.number().gt(0).lt(1).default(0.7),
            idle_timeout: duration.default("24h"),
          })
          .strict()
          .default({}),
        handoff: z
          .object({ timeout: duration.default("5m"), fallback_generate: z.boolean().default(true) })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    herdr: z
      .object({
        main_tab_label: z.string().trim().min(1).default("main"),
        close_tab_on_done: z.boolean().default(true),
        close_worker_pane_on_end: z.boolean().default(true),
      })
      .strict()
      .default({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

export function configPaths(root: string, env: Env = process.env): { user: string; project: string } {
  const base = env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), ".config");
  return { user: join(base, "agentthread", "config.yaml"), project: join(root, ".agentthread", "config.yaml") };
}

export function loadConfig(root: string, env: Env = process.env): Config {
  const p = configPaths(root, env);
  const parsed = ConfigSchema.safeParse(deepMerge(readYaml(p.user), readYaml(p.project)));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`invalid config (${p.user}, ${p.project}): ${issues}`);
  }
  return parsed.data;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
    out[key] = isPlainObject(value) && isPlainObject(current) ? deepMerge(current, value) : value;
  }
  return out;
}

function readYaml(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let value: unknown;
  try {
    value = parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`cannot parse ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (value === null || value === undefined) return {};
  if (!isPlainObject(value)) throw new Error(`${file} must contain a YAML mapping`);
  return value;
}
```

- [ ] **Step 5: Add `agt config` to the CLI**

In `src/cli/main.ts`:
- add imports `import { stringify } from "yaml";` and `import { loadConfig } from "../config/config.ts";`
- add the usage line `  config` directly after `  daemon start|stop|status` in `USAGE`
- add this case in `run()` directly after the `case "daemon":` line pair:

```ts
    case "config":
      console.log(stringify(loadConfig(findRoot(cwd, env), env)).trimEnd());
      return 0;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/config tests/cli/config.test.ts && bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/config tests/config tests/cli/config.test.ts tests/helpers.ts src/cli/main.ts
git commit -m "feat: add layered config and agt config"
```

---

### Task 3: Herdr bridge and fake herdr

**Files:**
- Create: `src/herdr/bridge.ts`
- Create: `tests/fixtures/fake-herdr.ts` (executable)
- Modify: `tests/helpers.ts` (add `FAKE_HERDR`, `FakeHerdrState`, `fakeHerdrState`)
- Test: `tests/herdr/bridge.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type Runner = (bin: string, args: string[], env: Record<string, string | undefined>) => { exitCode: number; stdout: string; stderr: string }`
  - `spawnRunner: Runner`
  - `class HerdrError extends Error { code: string }`
  - `interface HerdrBridge { createTab(o: { workspace: string; cwd: string; label: string; env: Record<string, string> }): { tabId: string; rootPaneId: string }; renameTab(tabId: string, label: string): void; closeTab(tabId: string): void; tabExists(tabId: string): boolean; splitPane(o: { pane: string; direction: "right" | "down"; cwd: string; env: Record<string, string> }): string; renamePane(paneId: string, label: string): void; runInPane(paneId: string, command: string): void }`
  - `class HerdrCli implements HerdrBridge { constructor(opts: { bin: string; env?: Record<string, string | undefined>; runner?: Runner }); readonly bin: string }`
  - `shellQuote(s: string): string`
  - Test helpers: `FAKE_HERDR` (absolute path of the fixture), `interface FakeHerdrState { next: number; tabs: string[]; panes: string[]; calls: string[][] }`, `fakeHerdrState(seed?: Partial<FakeHerdrState>): { file: string; read(): FakeHerdrState }`
  - Fake herdr behavior (state in `$FAKE_HERDR_STATE`): records every argv in `calls`. `tab create` → new `w1:t<n>` + root pane `w1:p<n>`. `pane split` → new `w1:p<n>`. `tab get <id>` → exit 0 if the tab is in `tabs`, else exit 1 with `{"error":{"code":"tab_not_found",...}}` on stderr. `tab close <id>` removes it (same error if unknown). Everything else → `{"result":{"type":"ok"}}`.

- [ ] **Step 1: Write the fake herdr fixture**

Create `tests/fixtures/fake-herdr.ts`:

```ts
#!/usr/bin/env bun
// Test double for the herdr CLI. State lives in the JSON file named by $FAKE_HERDR_STATE.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

interface FakeState {
  next: number;
  tabs: string[];
  panes: string[];
  calls: string[][];
}

const file = process.env.FAKE_HERDR_STATE;
if (!file) {
  console.error(JSON.stringify({ error: { code: "fake_misconfigured", message: "FAKE_HERDR_STATE not set" } }));
  process.exit(1);
}
const state: FakeState = existsSync(file)
  ? { next: 0, tabs: [], panes: [], calls: [], ...JSON.parse(readFileSync(file, "utf8")) }
  : { next: 0, tabs: [], panes: [], calls: [] };
const args = process.argv.slice(2);
state.calls.push(args);

function ok(result: unknown): never {
  writeFileSync(file!, JSON.stringify(state));
  console.log(JSON.stringify({ id: "fake", result }));
  process.exit(0);
}

function fail(code: string, message: string): never {
  writeFileSync(file!, JSON.stringify(state));
  console.error(JSON.stringify({ error: { code, message } }));
  process.exit(1);
}

const [group, sub, target] = args;

if (group === "tab" && sub === "create") {
  const n = ++state.next;
  const tab = `w1:t${n}`;
  const pane = `w1:p${n}`;
  state.tabs.push(tab);
  state.panes.push(pane);
  ok({ type: "tab_created", tab: { tab_id: tab }, root_pane: { pane_id: pane } });
}
if (group === "tab" && sub === "get") {
  if (!state.tabs.includes(target ?? "")) fail("tab_not_found", `tab ${target} not found`);
  ok({ type: "tab_info", tab: { tab_id: target } });
}
if (group === "tab" && sub === "close") {
  if (!state.tabs.includes(target ?? "")) fail("tab_not_found", `tab ${target} not found`);
  state.tabs = state.tabs.filter((t) => t !== target);
  ok({ type: "ok" });
}
if (group === "pane" && sub === "split") {
  const n = ++state.next;
  const pane = `w1:p${n}`;
  state.panes.push(pane);
  ok({ type: "pane_split", pane: { pane_id: pane } });
}
ok({ type: "ok" });
```

Run: `chmod +x tests/fixtures/fake-herdr.ts`

- [ ] **Step 2: Add test helpers**

Append to `tests/helpers.ts` (add `existsSync, readFileSync, writeFileSync` to its `node:fs` import):

```ts
export const FAKE_HERDR = join(import.meta.dir, "fixtures", "fake-herdr.ts");

export interface FakeHerdrState {
  next: number;
  tabs: string[];
  panes: string[];
  calls: string[][];
}

/** A state file for tests/fixtures/fake-herdr.ts; pass `file` as FAKE_HERDR_STATE. */
export function fakeHerdrState(seed: Partial<FakeHerdrState> = {}): { file: string; read(): FakeHerdrState } {
  const file = join(realpathSync(mkdtempSync(join(tmpdir(), "agt-herdr-"))), "herdr.json");
  writeFileSync(file, JSON.stringify({ next: 0, tabs: [], panes: [], calls: [], ...seed }));
  return { file, read: () => JSON.parse(readFileSync(file, "utf8")) as FakeHerdrState };
}
```

If `existsSync` ends up unused, do not import it.

- [ ] **Step 3: Write the failing tests**

Create `tests/herdr/bridge.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { HerdrCli, HerdrError, shellQuote, spawnRunner, type Runner } from "../../src/herdr/bridge.ts";
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

  test("tabExists is true on success and false on a herdr error", () => {
    expect(new HerdrCli({ bin: "herdr", runner: recording().runner }).tabExists("w1:t1")).toBe(true);
    expect(new HerdrCli({ bin: "herdr", runner: recording({ exitCode: 1, stderr: "{}" }).runner }).tabExists("w1:t1")).toBe(false);
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
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `bun test tests/herdr`
Expected: FAIL with `Cannot find module '../../src/herdr/bridge.ts'`.

- [ ] **Step 5: Implement the bridge**

Create `src/herdr/bridge.ts`:

```ts
type Env = Record<string, string | undefined>;

export type Runner = (bin: string, args: string[], env: Env) => { exitCode: number; stdout: string; stderr: string };

export const spawnRunner: Runner = (bin, args, env) => {
  const r = Bun.spawnSync([bin, ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { exitCode: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};

export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface HerdrBridge {
  createTab(o: { workspace: string; cwd: string; label: string; env: Record<string, string> }): { tabId: string; rootPaneId: string };
  renameTab(tabId: string, label: string): void;
  closeTab(tabId: string): void;
  tabExists(tabId: string): boolean;
  splitPane(o: { pane: string; direction: "right" | "down"; cwd: string; env: Record<string, string> }): string;
  renamePane(paneId: string, label: string): void;
  runInPane(paneId: string, command: string): void;
}

const envArgs = (env: Record<string, string>) => Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Drives Herdr through its CLI. Every call parses the JSON `result`, and herdr's JSON errors become HerdrError. */
export class HerdrCli implements HerdrBridge {
  constructor(private readonly opts: { bin: string; env?: Env; runner?: Runner }) {}

  get bin(): string {
    return this.opts.bin;
  }

  createTab(o: { workspace: string; cwd: string; label: string; env: Record<string, string> }) {
    const args = ["tab", "create", "--workspace", o.workspace, "--cwd", o.cwd, "--label", o.label, "--no-focus", ...envArgs(o.env)];
    const result = this.call(args);
    return { tabId: field(args, result, "tab", "tab_id"), rootPaneId: field(args, result, "root_pane", "pane_id") };
  }

  renameTab(tabId: string, label: string): void {
    this.call(["tab", "rename", tabId, label]);
  }

  closeTab(tabId: string): void {
    this.call(["tab", "close", tabId]);
  }

  tabExists(tabId: string): boolean {
    try {
      this.call(["tab", "get", tabId]);
      return true;
    } catch (e) {
      if (e instanceof HerdrError) return false;
      throw e;
    }
  }

  splitPane(o: { pane: string; direction: "right" | "down"; cwd: string; env: Record<string, string> }): string {
    const args = ["pane", "split", o.pane, "--direction", o.direction, "--cwd", o.cwd, "--no-focus", ...envArgs(o.env)];
    return field(args, this.call(args), "pane", "pane_id");
  }

  renamePane(paneId: string, label: string): void {
    this.call(["pane", "rename", paneId, label]);
  }

  runInPane(paneId: string, command: string): void {
    this.call(["pane", "run", paneId, command]);
  }

  private call(args: string[]): unknown {
    const what = `herdr ${args.slice(0, 2).join(" ")}`;
    const r = (this.opts.runner ?? spawnRunner)(this.opts.bin, args, this.opts.env ?? process.env);
    if (r.exitCode !== 0) {
      let code = "herdr_failed";
      let message = r.stderr.trim() || `exited with ${r.exitCode}`;
      try {
        const err = (JSON.parse(r.stderr) as { error?: { code?: string; message?: string } }).error;
        if (err?.code) {
          code = err.code;
          message = err.message ?? message;
        }
      } catch {
        // stderr was not JSON; keep the raw text
      }
      throw new HerdrError(code, `${what}: ${message}`);
    }
    try {
      return (JSON.parse(r.stdout) as { result?: unknown }).result;
    } catch {
      throw new HerdrError("bad_output", `${what}: unparseable output`);
    }
  }
}

function field(args: string[], value: unknown, ...keys: string[]): string {
  let cur: unknown = value;
  for (const k of keys) cur = typeof cur === "object" && cur !== null ? (cur as Record<string, unknown>)[k] : undefined;
  if (typeof cur !== "string") throw new HerdrError("bad_output", `herdr ${args.slice(0, 2).join(" ")}: response missing ${keys.join(".")}`);
  return cur;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/herdr && bun run typecheck`
Expected: PASS, with the real-herdr test reported as skipped.

- [ ] **Step 7: Commit**

```bash
git add src/herdr tests/herdr tests/fixtures/fake-herdr.ts tests/helpers.ts
git commit -m "feat: add Herdr CLI bridge and fake herdr for tests"
```

---

### Task 4: Layout and tab domain (events, commands, effects, rendering)

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/state/projection.ts`
- Modify: `src/commands/schema.ts`
- Modify: `src/commands/handler.ts`
- Modify: `src/render/markdown.ts`
- Test: `tests/commands/layout.test.ts`, plus one assertion in `tests/render/markdown.test.ts`

**Interfaces:**
- Consumes: `Config`, `DEFAULT_CONFIG` (Task 2).
- Produces:
  - `interface Layout { workspace: string; mainTab: string; managerPane: string; loggerPane: string; herdrBin: string; herdrSocket?: string }` (in `types.ts`)
  - Events: `{ type: "layout.registered"; thread?: undefined; payload: Layout }`, `{ type: "thread.tab_opened"; thread: string; payload: { tab: string; rootPane: string } }`, `{ type: "thread.tab_closed"; thread: string; payload: { tab: string } }`
  - Projection: `State.layout?: Layout`, `Thread.tab?: string`, `Thread.rootPane?: string`
  - Commands: `{ cmd: "layout.register"; workspace; mainTab; managerPane; loggerPane; herdrBin; herdrSocket? }` → event `layout.registered`, result `null`. `{ cmd: "layout.reconcile" }` → no events, one `herdr.tab.ensure` effect per non-`done` thread, result `{ threads: number }`. It rejects with `no Herdr layout registered; run \`agt start\`` if there is no layout. Both commands are role `user` only.
  - `type Effect = { kind: "git.worktree.add"; branch: string; path: string } | { kind: "herdr.tab.ensure"; thread: string; label: string; cwd: string; tab?: string } | { kind: "herdr.tab.close"; thread: string; tab: string }`
  - `interface HandlerContext { root: string; config?: Config }`, so the signature becomes `handle(state, cmd, actor, ctx: HandlerContext)`. A missing `config` means `DEFAULT_CONFIG`.
  - `thread.new` adds `herdr.tab.ensure { thread, label: "<id>-<slug>", cwd: worktree }` after the worktree effect **only when `state.layout` exists**.
  - `thread.status … done` adds `herdr.tab.close { thread, tab }` when the thread has a `tab` and `config.herdr.close_tab_on_done` is true.
  - `sub.thread.md` frontmatter gains `tab: <id>` (or `tab: null`) directly after `worktree`.

- [ ] **Step 1: Write the failing tests**

Create `tests/commands/layout.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config/config.ts";
import { handle, type HandleResult } from "../../src/commands/handler.ts";
import { CommandSchema } from "../../src/commands/schema.ts";
import type { Actor, EventBody, Layout } from "../../src/domain/types.ts";
import { INIT, USER, stateOf, threadCreated } from "../helpers.ts";

const LAYOUT: Layout = { workspace: "w7", mainTab: "w7:t1", managerPane: "w7:p1", loggerPane: "w7:p2", herdrBin: "/bin/herdr" };
const REGISTERED: EventBody = { type: "layout.registered", payload: LAYOUT };

function run(bodies: EventBody[], cmd: unknown, actor: Actor = USER, config = DEFAULT_CONFIG): HandleResult {
  return handle(stateOf(...bodies), CommandSchema.parse(cmd), actor, { root: "/repo", config });
}

describe("layout.register", () => {
  test("emits layout.registered and the projection stores it", () => {
    const r = run([INIT], { cmd: "layout.register", ...LAYOUT });
    expect(r).toEqual({ ok: true, events: [REGISTERED], effects: [], result: null });
    expect(stateOf(INIT, REGISTERED).layout).toEqual(LAYOUT);
  });

  test("is user-only and validates herdr ids", () => {
    const r = run([INIT], { cmd: "layout.register", ...LAYOUT }, { role: "main" });
    expect(r.ok ? "accepted" : r.error).toBe("role main may not run layout.register");
    expect(() => CommandSchema.parse({ cmd: "layout.register", ...LAYOUT, mainTab: "w7 t1" })).toThrow("invalid herdr id");
  });
});

describe("thread.new with and without a layout", () => {
  test("no layout: only the worktree effect", () => {
    const r = run([INIT], { cmd: "thread.new", title: "Fix race", type: "bug" });
    expect(r.ok && r.effects.map((e) => e.kind)).toEqual(["git.worktree.add"]);
  });

  test("with a layout: worktree, then tab ensure labelled <id>-<slug> in the worktree", () => {
    const r = run([INIT, REGISTERED], { cmd: "thread.new", title: "Fix race", type: "bug" });
    expect(r.ok && r.effects).toEqual([
      { kind: "git.worktree.add", branch: "thread/001-fix-race", path: "/repo/.worktrees/001-fix-race" },
      { kind: "herdr.tab.ensure", thread: "001", label: "001-fix-race", cwd: "/repo/.worktrees/001-fix-race" },
    ]);
  });
});

describe("thread.status done", () => {
  const opened: EventBody = { type: "thread.tab_opened", thread: "001", payload: { tab: "w7:t3", rootPane: "w7:p5" } };

  test("closes the tab when configured", () => {
    const r = run([INIT, REGISTERED, threadCreated("001", { status: "review" }), opened], {
      cmd: "thread.status",
      thread: "001",
      status: "done",
    });
    expect(r.ok && r.effects).toEqual([{ kind: "herdr.tab.close", thread: "001", tab: "w7:t3" }]);
  });

  test("keeps the tab when close_tab_on_done is false", () => {
    const config = { ...DEFAULT_CONFIG, herdr: { ...DEFAULT_CONFIG.herdr, close_tab_on_done: false } };
    const r = run(
      [INIT, REGISTERED, threadCreated("001", { status: "review" }), opened],
      { cmd: "thread.status", thread: "001", status: "done" },
      USER,
      config,
    );
    expect(r.ok && r.effects).toEqual([]);
  });

  test("no tab, no close effect", () => {
    const r = run([INIT, threadCreated("001", { status: "review" })], { cmd: "thread.status", thread: "001", status: "done" });
    expect(r.ok && r.effects).toEqual([]);
  });
});

describe("layout.reconcile", () => {
  test("ensures a tab for every thread that is not done, passing known tab ids", () => {
    const r = run(
      [
        INIT,
        REGISTERED,
        threadCreated("001"),
        { type: "thread.tab_opened", thread: "001", payload: { tab: "w7:t3", rootPane: "w7:p5" } },
        threadCreated("002", { status: "done" }),
        threadCreated("003", { status: "blocked", dependsOn: ["001"] }),
      ],
      { cmd: "layout.reconcile" },
    );
    expect(r.ok && r.result).toEqual({ threads: 2 });
    expect(r.ok && r.effects).toEqual([
      { kind: "herdr.tab.ensure", thread: "001", label: "001-thread-001", cwd: "/repo/.worktrees/001-thread-001", tab: "w7:t3" },
      { kind: "herdr.tab.ensure", thread: "003", label: "003-thread-003", cwd: "/repo/.worktrees/003-thread-003" },
    ]);
  });

  test("rejects without a layout", () => {
    const r = run([INIT], { cmd: "layout.reconcile" });
    expect(r.ok ? "accepted" : r.error).toBe("no Herdr layout registered; run `agt start`");
  });
});

test("tab events update the projection and the log", () => {
  const s = stateOf(
    INIT,
    threadCreated("001"),
    { type: "thread.tab_opened", thread: "001", payload: { tab: "w7:t3", rootPane: "w7:p5" } },
  );
  expect(s.threads.get("001")).toMatchObject({ tab: "w7:t3", rootPane: "w7:p5" });
  const closed = stateOf(
    INIT,
    threadCreated("001"),
    { type: "thread.tab_opened", thread: "001", payload: { tab: "w7:t3", rootPane: "w7:p5" } },
    { type: "thread.tab_closed", thread: "001", payload: { tab: "w7:t3" } },
  ).threads.get("001")!;
  expect(closed.tab).toBeUndefined();
  expect(closed.rootPane).toBeUndefined();
  expect(closed.log.map((e) => e.message).slice(-2)).toEqual(["herdr tab w7:t3 opened", "herdr tab w7:t3 closed"]);
});
```

In `tests/render/markdown.test.ts`, add this test at the end:

```ts
test("sub thread frontmatter carries the herdr tab", () => {
  const withTab = stateOf(
    INIT,
    threadCreated("001"),
    { type: "thread.tab_opened", thread: "001", payload: { tab: "w7:t3", rootPane: "w7:p5" } },
  ).threads.get("001")!;
  expect(parse(renderSub(withTab).split("---\n")[1]!)).toMatchObject({ tab: "w7:t3" });
  expect(parse(renderSub(stateOf(INIT, threadCreated("002")).threads.get("002")!).split("---\n")[1]!)).toMatchObject({ tab: null });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/commands/layout.test.ts tests/render`
Expected: FAIL. Typecheck errors or schema errors appear for `layout.register`, and the frontmatter has no `tab`.

- [ ] **Step 3: Extend the types**

In `src/domain/types.ts`, add above `EventBody`:

```ts
export interface Layout {
  workspace: string;
  mainTab: string;
  managerPane: string;
  loggerPane: string;
  herdrBin: string;
  herdrSocket?: string;
}
```

and add these members to the `EventBody` union:

```ts
  | { type: "layout.registered"; thread?: undefined; payload: Layout }
  | { type: "thread.tab_opened"; thread: string; payload: { tab: string; rootPane: string } }
  | { type: "thread.tab_closed"; thread: string; payload: { tab: string } }
```

- [ ] **Step 4: Extend the projection**

In `src/state/projection.ts`:
- import `Layout` from `../domain/types.ts`
- add `tab?: string;` and `rootPane?: string;` to `Thread`, and `layout?: Layout;` to `State`
- directly after the `project.initialized` early-return block in `applyEvent`, add:

```ts
  if (ev.type === "layout.registered") {
    state.layout = ev.payload;
    return;
  }
```

- add these cases to the `switch` in `applyEvent`:

```ts
    case "thread.tab_opened":
      t.tab = ev.payload.tab;
      t.rootPane = ev.payload.rootPane;
      note(t, ev, `herdr tab ${ev.payload.tab} opened`);
      break;
    case "thread.tab_closed":
      delete t.tab;
      delete t.rootPane;
      note(t, ev, `herdr tab ${ev.payload.tab} closed`);
      break;
```

- [ ] **Step 5: Extend the command schema**

In `src/commands/schema.ts`, add next to the other id schemas:

```ts
const herdrId = z.string().regex(/^[\w-]+(:[\w-]+)?$/, "invalid herdr id");
```

and add to the `discriminatedUnion` array:

```ts
  z.object({
    cmd: z.literal("layout.register"),
    workspace: herdrId,
    mainTab: herdrId,
    managerPane: herdrId,
    loggerPane: herdrId,
    herdrBin: text,
    herdrSocket: z.string().optional(),
  }),
  z.object({ cmd: z.literal("layout.reconcile") }),
```

- [ ] **Step 6: Extend the handler**

In `src/commands/handler.ts`:

1. Add `import { DEFAULT_CONFIG, type Config } from "../config/config.ts";`.
2. Replace the `Effect` type with:

```ts
export type Effect =
  | { kind: "git.worktree.add"; branch: string; path: string }
  | { kind: "herdr.tab.ensure"; thread: string; label: string; cwd: string; tab?: string }
  | { kind: "herdr.tab.close"; thread: string; tab: string };

export interface HandlerContext {
  root: string;
  config?: Config;
}
```

3. Replace every `ctx: { root: string }` parameter type in this file with `ctx: HandlerContext`.
4. Add to `ALLOWED`: `"layout.register": ["user"],` and `"layout.reconcile": ["user"],`.
5. In `decide()`, directly after the line `if (cmd.cmd === "thread.new") return newThread(state, cmd, ctx);`, add:

```ts
  if (cmd.cmd === "layout.register") {
    const { cmd: _cmd, ...layout } = cmd;
    return { events: [{ type: "layout.registered", payload: layout }] };
  }
  if (cmd.cmd === "layout.reconcile") {
    if (!state.layout) reject("no Herdr layout registered; run `agt start`");
    const open = [...state.threads.values()].filter((t) => t.status !== "done");
    return { events: [], effects: open.map(tabEnsure), result: { threads: open.length } };
  }
```

6. Change `case "thread.status": return threadStatus(state, t, cmd.status, cmd.reason);` to `return threadStatus(state, t, cmd.status, cmd.reason, ctx);`, change the `threadStatus` signature to `function threadStatus(state: State, t: Thread, to: ThreadStatus, reason: string | undefined, ctx: HandlerContext): Decision`, and replace its final `return { events };` with:

```ts
  const config = ctx.config ?? DEFAULT_CONFIG;
  const effects: Effect[] = to === "done" && t.tab && config.herdr.close_tab_on_done ? [{ kind: "herdr.tab.close", thread: t.id, tab: t.tab }] : [];
  return { events, effects };
```

7. In `newThread`, replace `effects: [{ kind: "git.worktree.add", branch, path: worktree }],` with:

```ts
    effects: [
      { kind: "git.worktree.add", branch, path: worktree },
      ...(state.layout ? [tabEnsure({ id, slug, worktree })] : []),
    ],
```

8. Add this helper at the bottom of the file:

```ts
function tabEnsure(t: { id: string; slug: string; worktree: string; tab?: string }): Effect {
  return { kind: "herdr.tab.ensure", thread: t.id, label: `${t.id}-${t.slug}`, cwd: t.worktree, ...(t.tab ? { tab: t.tab } : {}) };
}
```

- [ ] **Step 7: Render the tab in frontmatter**

In `src/render/markdown.ts` `renderSub`, add `tab: t.tab ?? null,` to the object passed to `stringify`, directly after `worktree: t.worktree,`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bun test && bun run typecheck`
Expected: PASS. `tests/daemon` and `tests/e2e` are unaffected because no layout is registered there.

- [ ] **Step 9: Commit**

```bash
git add src/domain/types.ts src/state/projection.ts src/commands src/render/markdown.ts tests/commands/layout.test.ts tests/render/markdown.test.ts
git commit -m "feat: model Herdr layout, thread tabs and tab effects"
```

---

### Task 5: Daemon effect runner, config and `layout.get`

**Files:**
- Create: `src/daemon/effects.ts`
- Modify: `src/daemon/server.ts`
- Modify: `src/daemon/protocol.ts`
- Test: `tests/daemon/herdr.test.ts`

**Interfaces:**
- Consumes: `Effect`, `HandlerContext` (Task 4); `HerdrCli`, `HerdrBridge` (Task 3); `loadConfig` (Task 2); `addWorktree`; test helpers `FAKE_HERDR`, `fakeHerdrState`, `isolatedConfigHome`, `tempRepo`.
- Produces:
  - `createEffectRunner(opts: { root: string; layout: () => Layout | undefined; bridge?: (layout: Layout) => HerdrBridge; log?: (message: string) => void }): (effect: Effect) => EventBody[]`. Git effects throw on failure. Herdr effects never throw: they log `herdr <kind> for thread <id> failed: <message>` and return `[]`.
    - `herdr.tab.ensure`: if `tab` is set and still exists → `[]`. Otherwise it creates a tab (`workspace` from the layout, given cwd and label, env `AGT_ROOT=<root>`, `AGT_THREAD=<id>`, `AGT_ROLE=coordinator`) → `[thread.tab_opened]`.
    - `herdr.tab.close`: closes the tab if it still exists → `[thread.tab_closed]`.
    - The default bridge is `new HerdrCli({ bin: layout.herdrBin, env: { ...process.env, HERDR_SOCKET_PATH: layout.herdrSocket } })`, and `HERDR_SOCKET_PATH` is only set when the layout has one.
  - `startDaemon(root: string, opts?: { log?: (message: string) => void }): Promise<Daemon>`. Loads config with `loadConfig(root)` (an invalid config rejects startup), passes `{ root, config }` to `handle`, and appends `decision.events` followed by the effect events in one `store.append`.
  - Protocol op `{ op: "layout.get" }` → `{ ok: true, result: Layout | null }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/daemon/herdr.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { request } from "../../src/daemon/client.ts";
import { startDaemon, type Daemon } from "../../src/daemon/server.ts";
import type { Actor, StoredEvent } from "../../src/domain/types.ts";
import { initProject } from "../../src/project/init.ts";
import { paths } from "../../src/project/paths.ts";
import { FAKE_HERDR, fakeHerdrState, isolatedConfigHome, tempRepo } from "../helpers.ts";

let root: string;
let daemon: Daemon;
let fake: ReturnType<typeof fakeHerdrState>;
let logged: string[];
const savedEnv = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, FAKE_HERDR_STATE: process.env.FAKE_HERDR_STATE };

beforeAll(() => {
  process.env.XDG_CONFIG_HOME = isolatedConfigHome();
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(async () => {
  root = tempRepo();
  initProject(root, "demo");
  fake = fakeHerdrState();
  process.env.FAKE_HERDR_STATE = fake.file;
  logged = [];
  daemon = await startDaemon(root, { log: (m) => logged.push(m) });
});

afterEach(async () => {
  await daemon.stop();
});

const cmd = (command: object, actor: Actor = { role: "user" }) => request(paths(root).socket, { op: "command", command, actor });
const register = (herdrBin = FAKE_HERDR) =>
  cmd({ cmd: "layout.register", workspace: "w1", mainTab: "w1:t0", managerPane: "w1:p0", loggerPane: "w1:p00", herdrBin });
const frontmatter = (dir: string) => parse(readFileSync(join(root, ".agentthread/threads", dir, "sub.thread.md"), "utf8").split("---\n")[1]!);
const events = async () => {
  const r = await request(paths(root).socket, { op: "events.since", seq: 0 });
  return (r.ok ? (r.result as StoredEvent[]) : []).map((e) => e.type);
};

test("layout.get returns null, then the registered layout", async () => {
  expect(await request(paths(root).socket, { op: "layout.get" })).toEqual({ ok: true, result: null });
  await register();
  expect(await request(paths(root).socket, { op: "layout.get" })).toMatchObject({ ok: true, result: { workspace: "w1", mainTab: "w1:t0" } });
});

test("thread.new opens a tab in the worktree and records it", async () => {
  await register();
  expect(await cmd({ cmd: "thread.new", title: "Fix race", type: "bug" })).toMatchObject({ ok: true });
  const create = fake.read().calls.find((c) => c[0] === "tab" && c[1] === "create")!;
  expect(create).toEqual([
    "tab", "create", "--workspace", "w1", "--cwd", join(root, ".worktrees", "001-fix-race"), "--label", "001-fix-race", "--no-focus",
    "--env", `AGT_ROOT=${root}`, "--env", "AGT_THREAD=001", "--env", "AGT_ROLE=coordinator",
  ]);
  expect(frontmatter("001-fix-race")).toMatchObject({ tab: "w1:t1" });
  expect(await events()).toEqual(["project.initialized", "layout.registered", "thread.created", "thread.tab_opened"]);
});

test("done closes the tab", async () => {
  await register();
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  for (const status of ["in_progress", "review", "done"]) await cmd({ cmd: "thread.status", thread: "001", status });
  expect(fake.read().tabs).toEqual([]);
  expect(frontmatter("001-x")).toMatchObject({ status: "done", tab: null });
  expect((await events()).at(-1)).toBe("thread.tab_closed");
});

test("close_tab_on_done: false keeps the tab", async () => {
  await daemon.stop();
  writeFileSync(join(root, ".agentthread", "config.yaml"), "herdr:\n  close_tab_on_done: false\n");
  daemon = await startDaemon(root, { log: (m) => logged.push(m) });
  await register();
  await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  for (const status of ["in_progress", "review", "done"]) await cmd({ cmd: "thread.status", thread: "001", status });
  expect(fake.read().tabs).toEqual(["w1:t1"]);
});

test("herdr failure does not fail the command; reconcile opens the tab later", async () => {
  await register("/nonexistent/herdr");
  const r = await cmd({ cmd: "thread.new", title: "X", type: "bug" });
  expect(r).toMatchObject({ ok: true, result: { thread: "001" } });
  expect(existsSync(join(root, ".worktrees", "001-x"))).toBe(true);
  expect(frontmatter("001-x")).toMatchObject({ tab: null });
  expect(logged.join("\n")).toMatch(/herdr herdr\.tab\.ensure for thread 001 failed/);

  await register();
  expect(await cmd({ cmd: "layout.reconcile" })).toEqual({ ok: true, result: { threads: 1 } });
  expect(frontmatter("001-x")).toMatchObject({ tab: "w1:t1" });
});

test("reconcile reopens only tabs that were closed by hand", async () => {
  await register();
  await cmd({ cmd: "thread.new", title: "A", type: "bug" });
  await cmd({ cmd: "thread.new", title: "B", type: "bug" });
  const state = fake.read();
  writeFileSync(fake.file, JSON.stringify({ ...state, tabs: state.tabs.filter((t) => t !== "w1:t2") }));
  await cmd({ cmd: "layout.reconcile" });
  expect(fake.read().tabs.sort()).toEqual(["w1:t1", "w1:t3"]);
  expect(fake.read().calls.filter((c) => c[1] === "create")).toHaveLength(3);
  expect(frontmatter("002-b")).toMatchObject({ tab: "w1:t3" });
});

test("an invalid config stops the daemon from starting", async () => {
  await daemon.stop();
  writeFileSync(join(root, ".agentthread", "config.yaml"), "workers:\n  max_workers: 0\n");
  await expect(startDaemon(root)).rejects.toThrow(/invalid config .*workers\.max_workers/);
  writeFileSync(join(root, ".agentthread", "config.yaml"), "");
  daemon = await startDaemon(root, { log: (m) => logged.push(m) });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/daemon/herdr.test.ts`
Expected: FAIL. `layout.get` is unknown, no tab is created, and `startDaemon` ignores `opts`.

- [ ] **Step 3: Implement the effect runner**

Create `src/daemon/effects.ts`:

```ts
import type { Effect } from "../commands/handler.ts";
import type { EventBody, Layout } from "../domain/types.ts";
import { HerdrCli, type HerdrBridge } from "../herdr/bridge.ts";
import { addWorktree } from "../project/git.ts";

type HerdrEffect = Extract<Effect, { kind: "herdr.tab.ensure" | "herdr.tab.close" }>;

export function createEffectRunner(opts: {
  root: string;
  layout: () => Layout | undefined;
  bridge?: (layout: Layout) => HerdrBridge;
  log?: (message: string) => void;
}): (effect: Effect) => EventBody[] {
  const log = opts.log ?? ((m: string) => console.error(m));
  const bridgeFor =
    opts.bridge ??
    ((layout: Layout) =>
      new HerdrCli({ bin: layout.herdrBin, env: { ...process.env, ...(layout.herdrSocket ? { HERDR_SOCKET_PATH: layout.herdrSocket } : {}) } }));

  return (effect) => {
    switch (effect.kind) {
      case "git.worktree.add":
        addWorktree(opts.root, effect.branch, effect.path);
        return [];
      case "herdr.tab.ensure":
      case "herdr.tab.close": {
        const layout = opts.layout();
        if (!layout) return [];
        try {
          return runHerdr(effect, bridgeFor(layout), layout, opts.root);
        } catch (e) {
          // Herdr is a view: a failure here must never fail the command. `agt start` reconciles missing tabs.
          log(`herdr ${effect.kind} for thread ${effect.thread} failed: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        }
      }
    }
  };
}

function runHerdr(effect: HerdrEffect, bridge: HerdrBridge, layout: Layout, root: string): EventBody[] {
  if (effect.kind === "herdr.tab.ensure") {
    if (effect.tab && bridge.tabExists(effect.tab)) return [];
    const { tabId, rootPaneId } = bridge.createTab({
      workspace: layout.workspace,
      cwd: effect.cwd,
      label: effect.label,
      env: { AGT_ROOT: root, AGT_THREAD: effect.thread, AGT_ROLE: "coordinator" },
    });
    return [{ type: "thread.tab_opened", thread: effect.thread, payload: { tab: tabId, rootPane: rootPaneId } }];
  }
  if (bridge.tabExists(effect.tab)) bridge.closeTab(effect.tab);
  return [{ type: "thread.tab_closed", thread: effect.thread, payload: { tab: effect.tab } }];
}
```

- [ ] **Step 4: Wire it into the daemon**

In `src/daemon/protocol.ts`, add `| { op: "layout.get" }` to `Request`.

In `src/daemon/server.ts`:
1. Add imports `import { loadConfig, type Config } from "../config/config.ts";` and `import { createEffectRunner } from "./effects.ts";`. Remove the `addWorktree` import and `type Effect` from the handler import if they become unused.
2. Change the signature to `export async function startDaemon(root: string, opts: { log?: (message: string) => void } = {}): Promise<Daemon> {`.
3. Inside the startup `try` block from Task 1, directly after the `if (!state.project) …` line, add `config = loadConfig(root);`, and declare `let config: Config;` next to `let state…`.
4. Replace the old `runEffect` function with:

```ts
  const runEffect = createEffectRunner({ root, layout: () => state.layout, log: opts.log });
```

5. In `runCommand`, replace:

```ts
    const decision = handle(state, command.data, actor.data, { root });
    if (!decision.ok) return decision;
    for (const effect of decision.effects) runEffect(effect);
    for (const ev of store.append(decision.events, actor.data)) applyEvent(state, ev);
```

with:

```ts
    const decision = handle(state, command.data, actor.data, { root, config });
    if (!decision.ok) return decision;
    const effectEvents = decision.effects.flatMap(runEffect);
    for (const ev of store.append([...decision.events, ...effectEvents], actor.data)) applyEvent(state, ev);
```

6. In `respond`, add before `default:`:

```ts
      case "layout.get":
        return { ok: true, result: state.layout ?? null };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test && bun run typecheck`
Expected: PASS. The suite must produce no stray stderr output from the Herdr failure test, because it logs through the injected `log`.

- [ ] **Step 6: Commit**

```bash
git add src/daemon tests/daemon/herdr.test.ts
git commit -m "feat: run Herdr tab effects from the daemon"
```

---

### Task 6: `agt start`

**Files:**
- Modify: `src/cli/main.ts` (extract `ensureDaemon`, add `start` command + usage line)
- Test: `tests/cli/start.test.ts`

**Interfaces:**
- Consumes: `HerdrCli`, `shellQuote` (Task 3); `loadConfig` (Task 2); `layout.get` op, `layout.register` / `layout.reconcile` commands (Tasks 4–5).
- Produces:
  - `ensureDaemon(root: string, env: Env): Promise<"started" | "running">`, extracted from `daemon start`. `agt daemon start` keeps printing `daemon started` / `daemon already running`.
  - `agt start`:
    1. If `HERDR_ENV !== "1"` or `HERDR_WORKSPACE_ID` / `HERDR_TAB_ID` / `HERDR_PANE_ID` is missing, it fails with `agt start must run inside a Herdr pane` (exit 1).
    2. It loads config, ensures the daemon, and builds `HerdrCli({ bin: HERDR_BIN_PATH ?? "herdr", env })`.
    3. If `layout.get` returns a layout whose `mainTab` still exists, it prints `layout already set up (main tab <id>)` and makes no Herdr layout calls.
    4. Otherwise:
       - `renameTab(HERDR_TAB_ID, config.herdr.main_tab_label)`
       - `renamePane(HERDR_PANE_ID, "main manager")`
       - `splitPane({ pane: HERDR_PANE_ID, direction: "right", cwd: root, env: { AGT_ROOT: root } })` → logger
       - `renamePane(logger, "logger")`
       - `runInPane(logger, "<quoted bun> <quoted agt> logs -f")`
       - sends `layout.register` with `herdrBin` = the bridge's bin and `herdrSocket` = `HERDR_SOCKET_PATH`
       - prints `main tab <id>: main manager <pane>, logger <pane>`
    5. It always sends `layout.reconcile` last and prints `subthread tabs reconciled (<n> open threads)`.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli/start.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "../../src/herdr/bridge.ts";
import { initProject } from "../../src/project/init.ts";
import { FAKE_HERDR, fakeHerdrState, isolatedConfigHome, tempRepo } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");

let root: string;
let fake: ReturnType<typeof fakeHerdrState>;
let xdg: string;

function agt(args: string[], extra: Record<string, string> = {}, opts: { herdr?: boolean } = {}) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: "/nonexistent",
    XDG_CONFIG_HOME: xdg,
    AGT_ROOT: root,
    FAKE_HERDR_STATE: fake.file,
    ...extra,
  };
  if (opts.herdr !== false) {
    Object.assign(env, {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t0",
      HERDR_PANE_ID: "w1:p0",
      HERDR_BIN_PATH: FAKE_HERDR,
      HERDR_SOCKET_PATH: "/tmp/fake-herdr.sock",
    });
  }
  const r = Bun.spawnSync([process.execPath, BIN, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

beforeEach(() => {
  const parent = tempRepo();
  // A project root with a space and a quote exercises the logger command's shell quoting.
  root = join(parent, "my 'proj'");
  mkdirSync(root);
  Bun.spawnSync(["git", "-C", root, "init", "-q", "-b", "main"]);
  Bun.spawnSync(["git", "-C", root, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init"]);
  initProject(root, "demo");
  fake = fakeHerdrState({ tabs: ["w1:t0"], panes: ["w1:p0"] });
  xdg = isolatedConfigHome();
});

afterEach(() => {
  agt(["daemon", "stop"]);
});

test("refuses to run outside Herdr", () => {
  expect(agt(["start"], {}, { herdr: false })).toMatchObject({ code: 1, err: "agt: agt start must run inside a Herdr pane" });
});

test("builds the main tab: rename, split a logger running agt logs -f, register, reconcile", () => {
  const r = agt(["start"]);
  expect(r.code).toBe(0);
  expect(r.out.split("\n")).toEqual([
    "main tab w1:t0: main manager w1:p0, logger w1:p1",
    "subthread tabs reconciled (0 open threads)",
  ]);
  const calls = fake.read().calls;
  expect(calls.slice(0, 5)).toEqual([
    ["tab", "rename", "w1:t0", "main"],
    ["pane", "rename", "w1:p0", "main manager"],
    ["pane", "split", "w1:p0", "--direction", "right", "--cwd", root, "--no-focus", "--env", `AGT_ROOT=${root}`],
    ["pane", "rename", "w1:p1", "logger"],
    ["pane", "run", "w1:p1", `${shellQuote(process.execPath)} ${shellQuote(BIN)} logs -f`],
  ]);
});

test("a second start keeps the existing layout", () => {
  agt(["start"]);
  const before = fake.read().calls.length;
  const r = agt(["start"]);
  expect(r.out.split("\n")[0]).toBe("layout already set up (main tab w1:t0)");
  const after = fake.read().calls.slice(before);
  expect(after).toEqual([["tab", "get", "w1:t0"]]);
});

test("uses the configured main tab label", () => {
  mkdirSync(join(xdg, "agentthread"), { recursive: true });
  writeFileSync(join(xdg, "agentthread", "config.yaml"), "herdr:\n  main_tab_label: home\n");
  agt(["start"]);
  expect(fake.read().calls[0]).toEqual(["tab", "rename", "w1:t0", "home"]);
});

test("subthreads created after start get their own tab", () => {
  agt(["start"]);
  expect(JSON.parse(agt(["thread", "new", "Fix", "--type", "bug"]).out)).toMatchObject({ thread: "001" });
  expect(fake.read().tabs).toEqual(["w1:t0", "w1:t2"]);
});
```

On the first start `layout.get` returns `null`, so no `tab get` call happens before the rename.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/cli/start.test.ts`
Expected: FAIL. `start` is an unknown command and exits 2.

- [ ] **Step 3: Extract `ensureDaemon`**

In `src/cli/main.ts`, add:

```ts
async function ensureDaemon(root: string, env: Env): Promise<"started" | "running"> {
  const p = paths(root);
  if (await isAlive(p.socket)) return "running";
  const spawned = Bun.spawnSync(
    ["/bin/sh", "-c", 'nohup "$0" "$1" daemon run >>"$2" 2>&1 &', process.execPath, Bun.main, p.daemonLog],
    { env: { ...env, AGT_ROOT: root } },
  );
  if (spawned.exitCode !== 0) throw new Error("failed to launch daemon");
  for (let i = 0; i < 50; i++) {
    if (await isAlive(p.socket)) return "started";
    await Bun.sleep(100);
  }
  throw new Error(`daemon failed to start; see ${p.daemonLog}`);
}
```

and replace the body of `case "start":` inside `daemon()` with:

```ts
      console.log((await ensureDaemon(root, env)) === "running" ? "daemon already running" : "daemon started");
      return 0;
```

- [ ] **Step 4: Implement `agt start`**

In `src/cli/main.ts`:
- add imports `import { HerdrCli, shellQuote } from "../herdr/bridge.ts";` and `import type { Layout } from "../domain/types.ts";` (merge with the existing types import)
- add the usage line `  start                      set up the Herdr layout (run inside a Herdr pane)` as the first line after `  init [--name <name>]`
- add `case "start": return start(findRoot(cwd, env), env);` in `run()` after `case "config"`
- add:

```ts
async function start(root: string, env: Env): Promise<number> {
  const workspace = env.HERDR_WORKSPACE_ID;
  const mainTab = env.HERDR_TAB_ID;
  const managerPane = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== "1" || !workspace || !mainTab || !managerPane) throw new Error("agt start must run inside a Herdr pane");
  const config = loadConfig(root, env);
  await ensureDaemon(root, env);
  const socket = paths(root).socket;
  const herdr = new HerdrCli({ bin: env.HERDR_BIN_PATH ?? "herdr", env });

  const current = await request(socket, { op: "layout.get" });
  if (!current.ok) throw new Error(current.error);
  const layout = current.result as Layout | null;
  if (layout && herdr.tabExists(layout.mainTab)) {
    console.log(`layout already set up (main tab ${layout.mainTab})`);
  } else {
    herdr.renameTab(mainTab, config.herdr.main_tab_label);
    herdr.renamePane(managerPane, "main manager");
    const loggerPane = herdr.splitPane({ pane: managerPane, direction: "right", cwd: root, env: { AGT_ROOT: root } });
    herdr.renamePane(loggerPane, "logger");
    herdr.runInPane(loggerPane, `${shellQuote(process.execPath)} ${shellQuote(Bun.main)} logs -f`);
    await commandOrThrow(socket, env, {
      cmd: "layout.register",
      workspace,
      mainTab,
      managerPane,
      loggerPane,
      herdrBin: herdr.bin,
      herdrSocket: env.HERDR_SOCKET_PATH,
    });
    console.log(`main tab ${mainTab}: main manager ${managerPane}, logger ${loggerPane}`);
  }

  const reconciled = (await commandOrThrow(socket, env, { cmd: "layout.reconcile" })) as { threads: number };
  console.log(`subthread tabs reconciled (${reconciled.threads} open threads)`);
  return 0;
}

async function commandOrThrow(socket: string, env: Env, command: object): Promise<unknown> {
  const res = await request(socket, { op: "command", command, actor: actorFromEnv(env) });
  if (!res.ok) throw new Error(res.error);
  return res.result;
}
```

Note: `agt start` uses the caller's `AGT_ROLE` (default `user`), and both layout commands are user-only. That is intended: only the human starts the layout.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test && bun run typecheck`
Expected: PASS. `pgrep -fl "daemon run"` shows no daemon from these tests afterwards.

- [ ] **Step 6: Commit**

```bash
git add src/cli/main.ts tests/cli/start.test.ts
git commit -m "feat: add agt start to build the Herdr layout"
```

---

### Task 7: End-to-end Herdr scenario

**Files:**
- Test: `tests/e2e/herdr-flow.test.ts`

**Interfaces:**
- Consumes: the `agt` binary and the fake herdr.
- Produces: a regression test for spec §8 flow steps 1–6 and its recovery paragraph.

- [ ] **Step 1: Write the scenario**

Create `tests/e2e/herdr-flow.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { initProject } from "../../src/project/init.ts";
import { FAKE_HERDR, fakeHerdrState, isolatedConfigHome, tempRepo } from "../helpers.ts";

const BIN = join(import.meta.dir, "../../bin/agt");
let root: string;
let fake: ReturnType<typeof fakeHerdrState>;
let xdg: string;

function agt(args: string[], extra: Record<string, string> = {}) {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: "/nonexistent",
      XDG_CONFIG_HOME: xdg,
      AGT_ROOT: root,
      FAKE_HERDR_STATE: fake.file,
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_TAB_ID: "w1:t0",
      HERDR_PANE_ID: "w1:p0",
      HERDR_BIN_PATH: FAKE_HERDR,
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`agt ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const tabOf = (dir: string) =>
  parse(readFileSync(join(root, ".agentthread/threads", dir, "sub.thread.md"), "utf8").split("---\n")[1]!).tab as string | null;
const coord = (thread: string) => ({ AGT_ROLE: "coordinator", AGT_THREAD: thread, AGT_SESSION: `c${thread}` });

beforeAll(() => {
  root = tempRepo();
  initProject(root, "shop");
  fake = fakeHerdrState({ tabs: ["w1:t0"], panes: ["w1:p0"] });
  xdg = isolatedConfigHome();
});

afterAll(() => {
  try {
    agt(["daemon", "stop"]);
  } catch {
    // daemon may never have started
  }
});

test("start → tabs per thread → manual close recovered → done closes tab", () => {
  agt(["start"]);
  agt(["thread", "new", "OAuth login", "--type", "feature"]);
  agt(["thread", "new", "Fix session race", "--type", "bug", "--depends", "001"]);
  expect(tabOf("001-oauth-login")).toBe("w1:t2");
  expect(tabOf("002-fix-session-race")).toBe("w1:t3");

  // The user closes 002's tab by hand; the next start reopens exactly that one.
  const s = fake.read();
  writeFileSync(fake.file, JSON.stringify({ ...s, tabs: s.tabs.filter((t) => t !== "w1:t3") }));
  expect(agt(["start"]).split("\n")).toEqual([
    "layout already set up (main tab w1:t0)",
    "subthread tabs reconciled (2 open threads)",
  ]);
  expect(tabOf("002-fix-session-race")).toBe("w1:t4");
  expect(fake.read().tabs.sort()).toEqual(["w1:t0", "w1:t2", "w1:t4"]);

  for (const status of ["in_progress", "review"]) agt(["thread", "status", "001", status], coord("001"));
  agt(["thread", "status", "001", "done"]);
  expect(tabOf("001-oauth-login")).toBeNull();
  expect(fake.read().tabs.sort()).toEqual(["w1:t0", "w1:t4"]);
  expect(readFileSync(join(root, ".agentthread/threads/001-oauth-login/log.md"), "utf8")).toContain("herdr tab w1:t2 closed");
});
```

- [ ] **Step 2: Run the scenario**

Run: `bun test tests/e2e/herdr-flow.test.ts`
Expected: PASS. If it fails, the failing `agt` call's stderr is in the error. Fix the owning task's code, not the scenario.

- [ ] **Step 3: Run the full suite**

Run: `bun test && bun run typecheck`
Expected: all PASS; no `daemon run` processes left (`pgrep -fl "daemon run"`).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/herdr-flow.test.ts
git commit -m "test: add end-to-end Herdr layout scenario"
```
