# AgentThread Workspace Stack (Plan 15) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** agt owns the generic part of the workspace tooling that the reference project keeps in `Makefile` + `.scripts/` + `.local-run/`. The user describes services in config, and agt then provides:
- a stack runner (`agt stack start|stop|restart|status|logs`) that works on the main checkouts or on a task's worktrees;
- worktrees that come ready to run (env files copied, dependencies installed);
- a thin generated `Makefile` + `MAKEFILE.md` so `make restart TASK=…` keeps working.

Project-specific extras (Caddy, deploy, …) stay project scripts. A service can be any command.

**Reference:** the the reference project tooling summary (`.scripts/1-start-all-services.sh`, `6-restart-services.sh`, `7-worktree-new.sh`, `9-status.sh`, `.local-run/`). The behaviour below mirrors it.

**Tech Stack:** TypeScript on Bun, `bun:test`. The stack commands are CLI-only: no daemon needed, and no `Bun.spawnSync` on daemon paths.

## Global Constraints
- **Tests.** Run `env -u HERDR_ENV -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID -u HERDR_PANE_ID -u AGT_HERDR_IT bun test` (full suite under `timeout 600`) plus `bun run typecheck` before each commit. Baseline: 1102 pass / 1 skip / 0 fail.
- **Forbidden.**
  - Never run real herdr, real agents or tests/release.
  - Tests may start tiny local processes (e.g. `bun -e` HTTP servers on free ports) and must always stop them.
  - Leave no `agt daemon run`, `__spawn` or test servers running.
  - Don't commit bun.lockb.
- **agt stays agent-agnostic.** Nothing here concerns agents.
- **Exact config shape:**
  ```yaml
  workspace:
    repos:
      <repo>:
        path, source_branch, …            # existing
        copy: [.env, e2e/.env.local]       # copied from the main checkout into each new worktree (missing ones are skipped with a note)
        install: <cmd>                     # default: detected from the lockfile (bun install / yarn install --frozen-lockfile / pnpm install --frozen-lockfile / npm ci); "" disables
    services:
      <name>:                              # ^[a-z][a-z0-9-]*$
        repo: <repo>                       # must exist in workspace.repos
        dir: <path inside the repo>        # optional, default "."
        start: <cmd>                       # run in the background
        port: <int>                        # optional; used for health, stop and status
        health: <http(s) url | tcp:<port>> # optional; default tcp:<port> when port is set
        migrate: <cmd>                     # optional; run before start when the stamp changed
        after: [<service>, …]              # optional start order
        enabled: true                      # default true
  ```
- **Exact CLI:**
  - `agt stack start [--task <slug>|--main] [--only a,b]`
  - `agt stack stop [--only a,b]`
  - `agt stack restart [--task <slug>|--main] [--only a,b]`
  - `agt stack status [--json]`
  - `agt stack logs <service> [-f] [-n <lines>]`
- **`.local-run/` layout** (at the project root, git-ignored by `agt init`):
  - `<service>.pid` and `<service>.log`;
  - `<service>.stamp`;
  - `task` (the current target: a slug or `main`);
  - `restart.log`.

---

### Task 1: Config schema for services and repo copy/install

**Files:** `src/config/config.ts`, `src/workflow/project-config.ts` (the project-config section lists services), `README.md`, `docs/agents.md`. Tests: `tests/config/*.test.ts`, `tests/workflow/project-config.test.ts`.

**Validation:**
- service names follow the regex;
- `repo` exists in `workspace.repos`;
- ports are unique among enabled services;
- `after` names exist and form no cycle;
- `health` is `http(s)://…` or `tcp:<int>`.

**Default stack commands.** When services exist and `workflow.stack.restart` / `status` are unset, the effective defaults become `agt stack restart --task {task}` and `agt stack status`. Explicit values still win.

- [ ] Failing tests → implement → full suite + typecheck → commit `feat: services and per-repo copy/install in workspace config`.

### Task 2: Stack runner — start, stop, status, logs

**Files:** create `src/stack/` (`runner.ts`, `health.ts`, `stamp.ts`, `target.ts`), and modify `src/cli/main.ts` and `src/cli/usage.ts`. Tests go in `tests/stack/*.test.ts`, with real tiny servers.

**Target.**
- `--task <slug>` runs each service from `.worktrees/<slug>/<repo>/<dir>` when that worktree exists, and otherwise from the main checkout. The status output notes which one was used.
- `--main` uses the main checkouts.
- With neither, the target is the one recorded in `.local-run/task`, falling back to main.
- The chosen target is written to `.local-run/task`.

**Start.**
- Order follows `after`, then name.
- Per service:
  - If the service is already running (its pid is alive and it holds its port), skip it.
  - Otherwise, if the stamp changed (git HEAD + a hash of `git status --porcelain` for that repo dir), run `install` and then `migrate`, and write the stamp.
  - Spawn `start` detached in its own process group, with stdout and stderr appended to `<service>.log`, and write `<service>.pid`.
  - Wait for health: HTTP 2xx–4xx or a TCP connect, up to 120s, polling every 1s. A timeout prints a warning and the last 20 log lines, but does not fail the other services.
- Exit 1 if any service failed to start or became healthy.

**Stop.**
- Kill each service's process group: SIGTERM, then SIGKILL after 5s.
- Then, if the port is still held, kill the listener on that port (found with `lsof -nP -iTCP:<port> -sTCP:LISTEN -t`).
- Remove the `.pid` file.

**Status.**
- A table with columns service | state (running/stopped/unhealthy) | port | pid | cwd | branch | target.
- The cwd comes from the pid (`lsof -a -d cwd -p`), and the branch from `git -C <cwd> branch --show-current`.
- `--json` gives the same data as JSON.

**Logs.** Tail `<service>.log` (`-n` lines, default 50); `-f` follows.

- [ ] Failing tests (start two fake services with `after`, health, stamp skip on a second start, stop by pid group and by port, status, logs, task target with and without the worktree, `.local-run/task` fallback) → implement → full suite → commit `feat: agt stack start, stop, status and logs`.

### Task 3: Restart and integration with the workflow

**Files:** `src/stack/runner.ts`, `src/cli/main.ts`, `src/agents/prompts.ts` (task threads: the coordinator rule names `agt stack restart --task <task>` when services exist), and the generated skill's project-config section.

**Behavior.**
- `agt stack restart` = stop + start, detached into its own session so it survives the caller's pane; output goes to `.local-run/restart.log`. With `--wait`, it runs in the foreground instead.
- The coordinator still takes the stack lock first (Plan 11).

- [ ] Tests → implement → full suite → commit `feat: agt stack restart; the workflow uses the stack runner`.

### Task 4: Worktrees come ready to run

**Files:** the worktree job (`src/daemon/effects.ts` worktree effect and its helper) and `src/project/workspace.ts`. Tests: the worktree tests (real git).

**Behavior.**
- After `git worktree add`, for each `copy` entry: copy it from the main checkout if it exists, keeping the file mode, without overwriting, and without following a symlink out of the repo.
- Then run `install` (detected by default) in the worktree, inside the same process-group and timeout handling as the setup command.
- A failed install fails the worktree with the last log lines (`worktree.failed`).
- When `workspace.worktree_setup` is configured, it replaces this built-in step as before.

- [ ] Tests (copy present and missing, symlink refused, detected install command per lockfile, install failure → `worktree.failed`, `worktree_setup` override) → implement → full suite → commit `feat: new worktrees get their env files and dependencies`.

### Task 5: Generated Makefile and MAKEFILE.md

**Files:** create `src/stack/makefile.ts`; modify `src/project/init.ts` and `config-apply`/`setup` (regenerate after config changes). Tests: `tests/stack/makefile.test.ts`.

**Behavior.** agt writes `Makefile` and `MAKEFILE.md` at the project root only when they are absent or already carry agt's marker line. It never overwrites the user's own. A project-owned Makefile can `include .agentthread/agt.mk` instead: agt always writes that file with the same targets.

**Targets:**
- `start`, `stop`, `restart` and `status` pass `TASK=<slug>` → `--task` and `ONLY=a,b` → `--only`;
- `logs SVC=<name>`;
- `wt-new TASK= REPOS= [SRC=]`, which runs `agt worktree add` for each repo on the current thread's task when a thread exists for that task; otherwise it prints how to create the thread first.
- `help` lists all targets.

`MAKEFILE.md` documents each target, the variables, the services table and the `.local-run/` layout, all generated from config.

- [ ] Tests (absent → written, marker → rewritten, a user's own file untouched with `agt.mk` still written, content reflects config) → implement → full suite → commit `feat: agt writes a thin Makefile and MAKEFILE.md for the stack`.

### Task 6: Release check (controller)

Add the release row `ws-stack-runner`. It needs no agents and runs no model calls.
- The fixture workspace's two repos get a tiny bun HTTP server service each, plus a `copy: [.env]`.
- The row runs, in order:
  1. `agt worktree add` (the copy and install happen);
  2. `agt stack start --task <slug>`, then status shows the worktree cwd;
  3. `make restart TASK=<slug>`;
  4. `agt stack stop`.

Then run it once. Finish with a final review, a follow-ups doc and the merge.
