# Workspace stack runner (Plan 15): results, rulings and follow-ups

Source: the SDD ledger for docs/superpowers/plans/2026-11-21-workspace-stack.md (branch feat/workspace-stack).

## What shipped
- **Config.** `workspace.services` (repo, dir, start, port, health, migrate, after, enabled) and, per repo, `copy` and `install`.
  - When services exist, the stack commands default to `agt stack restart --task {task}` and `agt stack status`.
- **`agt stack start|stop|restart|status|logs`.** The commands are CLI-only and mirror the Zentro v4 tooling:
  - detached starts that write their log and pid to `.local-run/`;
  - HTTP/TCP health waits;
  - a git stamp gating install and migrate;
  - stop by process group, then by port, but only for listeners whose cwd is inside the workspace unless `--force` is given;
  - pid files verified by start time and pgid;
  - task targets (`--task`, `--main`, or the recorded `.local-run/task`);
  - restart detached, with output to `.local-run/restart.log`, or in the foreground with `--wait`.
- **Worktrees come ready to run.**
  - `copy` files are taken from the main checkout safely: no overwrite, no symlink escape, mode kept.
  - The copies are git-excluded in the worktree.
  - `install` is detected from the lockfile only.
  - An `agt-ready` marker in the worktree's git dir covers half-finished setups.
  - Credentials are redacted in install errors.
  - `worktree_setup` still replaces the built-in step.
- **Generated make files.** A `Makefile` and `MAKEFILE.md` are written only when absent or marked as agt's, plus an always-written `.agentthread/agt.mk`. The Makefile uses `-include` with a "needs agt" fallback.
  - Targets: start, stop, restart, status, logs, `wt-new` (through `agt thread find --task`) and help.
- **`agt config apply`** restarts a live daemon when the config changed; `--no-restart` turns that off.

## Live e2e
`ws-stack-runner` passed (report 2026-11-20T22-29-45-283Z). It ran no agents and covered: config apply, then a worktree with the copied and excluded `.env` and the ready marker, then stack start on the task's worktrees, `make restart TASK=…`, and stop.

The runs also found three bugs, all fixed:
- `npm ci` was chosen without a lockfile;
- the daemon kept its old config after `config apply`;
- the release rows timed out instead of failing fast on `worktree.failed`.

## Rulings
- **Option A:** a built-in runner driven by config. The generated Makefile is a thin wrapper, and project extras stay project scripts.
- **Make files:** written only when services exist. A user's own `Makefile` and `MAKEFILE.md` are never overwritten.
- **Committed Makefile on a fresh clone:** `-include` plus a fallback that prints "needs agt".
- **Daemon restart from agent panes:** `config apply` may restart the daemon from inside an agent pane. AGT_* identity is stripped from the restarted daemon's environment.

## Deferred
- **`agt.mk`** is always overwritten, so hand edits are lost. Its header says so.
- **Option-like values:** `SVC` or `SRC` values that start with `-` are passed through quoted.
- **Install-time background children** survive a successful install.
- **Lockfile changes:** no check that the lockfile is unchanged after install (Zentro's `ensure_npm` has one).
- **Stamp scope:** the stamp reruns install and migrate whenever the repo's `git status` changes.
