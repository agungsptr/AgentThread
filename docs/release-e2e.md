# Release e2e

The release e2e runs AgentThread end to end against a real Herdr server, real agents and real models. It runs only
before a release, never in `bun test` (nothing under `tests/release/` matches `bun test`'s file patterns). Its
assertions are on artifacts only (events, `brief.md`, `AGENTS.md`/`CLAUDE.md`, git commits, Herdr panes and tabs,
tickets), never on what a model writes.

## Prerequisites

- Herdr on `PATH` (or `AGT_E2E_HERDR_BIN`). The suite never touches your own Herdr session: every row starts its own
  headless server, `herdr --session agt-e2e-<pid>-<n> server`, and every Herdr call carries that session's socket with
  the parent's `HERDR_*` env removed. The harness refuses any socket outside `~/.config/herdr/sessions/agt-e2e-*`, and
  each row logs the isolated socket next to the live one. At the end the session is stopped by name
  (`herdr session stop agt-e2e-…`) and deleted.
- The agents installed and logged in: `claude`, `opencode`, `codex`, `omp`. Keys, routers and default models are your
  own agent config; the suite does not set them. A row whose agent is not installed is reported
  `SKIPPED (not installed: …)`; one whose agent cannot run is `SKIPPED (… not logged in)` (Codex: `codex login
  status`; omp: no `~/.omp/agent`; OpenCode: `opencode models` lists nothing). Set `AGT_E2E_ASSUME_LOGIN=omp,codex` to
  skip those login checks. Install notes: omp is the standalone binary from omp.sh; Codex is `brew install --cask codex`.
  If OpenCode's default model does not work, set `AGT_E2E_MODEL_OPENCODE`.
- Optional models and efforts per agent: `AGT_E2E_MODEL_<AGENT>` and `AGT_E2E_EFFORT_<AGENT>`, with `<AGENT>` one of
  `CLAUDE_CODE`, `OPENCODE`, `CODEX`, `OMP` (for example `AGT_E2E_MODEL_CLAUDE_CODE=sonnet`). Unset means the agent's
  default model. `AGT_E2E_EFFORT_OPENCODE` needs `AGT_E2E_MODEL_OPENCODE` (an OpenCode effort is a variant of a model).
- Every row's `agt` runs with its own `XDG_CONFIG_HOME`: a temp dir linking every entry of your `~/.config` except
  `agentthread`, so your own `~/.config/agentthread/config.yaml` never merges into a row's config.
- Claude Code asks once per new folder whether you trust it. Each row's scratch repo is a new temp folder, so in a
  row whose main is Claude Code the harness answers that dialog in main's pane for the repo root, as you would
  (worktrees below it inherit the trust). Only those rows, the ones whose main is Claude Code, add a trusted-folder
  entry to your Claude config, one per row's temp path. The harness never answers the dialog anywhere else: a trust
  dialog in a coordinator or worker pane fails the check `no trust dialog in a coordinator/worker pane` and ends the
  row at once, with the usual teardown, instead of waiting for its timeout.
- One time, for `happy-mixed-main` (main is not Claude Code, so nothing in the row trusts the folder for its Claude Code
  coordinator and worker): `mkdir -p ~/.cache/agt-e2e/mixed-main && cd ~/.cache/agt-e2e/mixed-main && git init && claude`,
  then accept the trust prompt and exit. Without this step the row fails at once: with the folder missing, it fails
  with that instruction; with the folder untrusted, it fails with `trust the e2e folder once: cd
  ~/.cache/agt-e2e/mixed-main && claude, then accept the trust prompt and exit`. Each run empties the folder, keeping
  the folder itself, and writes a `.agt-e2e-fixed` marker into it. Before emptying, the harness refuses a symlink
  (`… is a symlink; refusing to empty it`) and a folder holding anything but `.git`, unless the marker is there
  (`… has unexpected files; it must only be the e2e folder`).

Real runs cost money: every row runs main (except rows that create the thread as the user), a coordinator and 2–3
workers on a small task. A full run is roughly 23 rows of 5–20 minutes each.

## Running it

```sh
bun run e2e:release                                  # every row
bun run e2e:release --list                           # row ids and their agents
bun run e2e:release --only happy-claude-code,happy-daily
bun run e2e:release --agents claude-code,opencode    # rows whose three roles all use these agents
bun run e2e:release --timeout 30m                    # per row (default 20m)
bun run e2e:release --only smoke-layout              # no model calls: agt start against real Herdr
```

`--keep` keeps the scratch repos of passing rows too (failed rows always keep theirs).

Each row gets a fresh isolated Herdr server and a scratch git repo made from `tests/release/fixture-repo/` in a temp
dir, writes its `.agentthread/config.yaml`, runs `agt init`, creates a workspace in the isolated server and runs
`agt start` (or `agt start --no-manager`) in its root pane. The "user" is the harness: it types into main's pane with
`herdr agent prompt`. The fixture task is: add `slugify(s)`, its unit tests and a README line; it usually splits into
2–3 tickets.

Teardown runs on success, failure, timeout and Ctrl-C: the project's daemon is stopped, leftover `agt __spawn` jobs of
the row are killed, the isolated Herdr session is stopped and deleted (with every pane and agent in it), and any process
still running in the scratch repo is killed. Check afterwards with
`pgrep -fl "agt.*(daemon run|__spawn)|herdr --session agt-e2e"`.

## Rows

- `smoke-layout`: no model calls; `agt start --no-manager` sets up the main tab and the logger pane in real Herdr.
- Happy flow (§12.7), complexity timeout `5s`: `happy-claude-code` (Claude Code everywhere, the single-vendor row),
  `happy-daily` (main and coordinator on Claude Code, workers on OpenCode), `happy-coord-<agent>` (workers on OpenCode)
  and `happy-worker-<agent>` (coordinator on Claude Code), minus duplicates. `happy-mixed-main` puts main on OpenCode
  over a Claude Code coordinator and worker; it asserts that `agt start` printed the trust warning. Its scratch repo is
  the fixed folder `~/.cache/agt-e2e/mixed-main` (emptied and recreated each run; thread worktrees under its
  `.worktrees/` inherit the trust), which needs the one-time prerequisite below.
- Daily combination: `daily-two-threads` (two threads at once, `--max-workers 1`), `daily-tier-override` (the user
  says "use tier …" over main's proposal), `daily-worker-question` (an AGENTS.md hint makes the worker ask; the
  coordinator answers), `daily-coordinator-asks-user`.
- Edge cases: `edge-kill-coordinator`, `edge-coordinator-brake`, `edge-kill-worker`, `edge-blocked-worker` (the worker's
  OpenCode asks for every permission via the scenario-only `AGT_E2E_OPENCODE_ASK=worker`), `edge-rotate-turns`
  (`max_turns: 3`), `edge-rotate-age` (`max_age: 2m`), `edge-daemon-restart`, `edge-herdr-restart`, `edge-tab-closed`,
  `edge-missing-binary`, `edge-bad-model` (a coordinator on a model that does not exist: the stall watchdog's
  `session.stalled` notice reaches main after its first turn).
- Workspace (`tests/release/fixture-workspace/`: repos `api` and `web` under a root that is no repo): see Workspace
  rows below.

### Workspace rows

Every workspace row runs on Claude Code (except the worker of `ws-happy-worker-<agent>`). A row that runs a thread
answers each `thread.waiting` by typing into the coordinator's pane. Every row that starts an agent runs main: main's
pane answers Claude Code's trust dialog for the new scratch root, and the thread directories and worktrees under it
inherit that trust. The rows where the user creates the thread (`ws-edge-*`, `ws-stack-lock`, `ws-tab-shell`) wait for
main to go idle first; only `ws-smoke-worktrees` and `ws-edge-stage-gates` (no agents) run `agt start --no-manager`.

How to run them:

- `--agents` must include `claude-code`: a row whose roles name an agent not listed is dropped.
- Canary first (minutes): `bun run e2e:release --only ws-smoke-worktrees,ws-edge-stage-gates,ws-tab-shell --agents claude-code`.
- Then the heavy rows, marked 40m below, which run a whole thread: `bun run e2e:release --only
  ws-happy-claude-code,ws-cleanup,ws-edge-return,ws-edge-out-of-ticket,ws-stack-lock[,ws-happy-worker-<x>] --agents
  claude-code[,<x>] --timeout 40m`. Budget up to about 40 minutes per heavy row.

- `ws-smoke-worktrees`: no model calls. The harness creates a task thread and adds a worktree per repo.
- `ws-happy-claude-code` and `ws-happy-worker-<agent>` (coordinator on Claude Code), 40m: main gets the task; the thread
  runs to review; tickets, `wip/<task>` commits, stages 7, 8 and 10, the `feat/<task>` squash and its `bun test` are
  checked.
- `ws-edge-out-of-ticket`, 40m: api's `AGENTS.md` says to add a line to `CHANGELOG.md` whenever `src/slugify.ts`
  changes; the task text tells the coordinator that `CHANGELOG.md` is not part of the task, so no ticket lists it. No
  commit on `wip/<task>` may touch `CHANGELOG.md`; how the api slugify ticket ended (reviewed or blocked) is a note. If
  a ticket lists `CHANGELOG.md` anyway, the premise is not met: an inconclusive note, and such commits need only stay
  inside a ticket.
- `ws-edge-return`, 40m: the coordinator is told to return the first ticket once ("add a test for an empty string").
  The ticket is returned, reviewed again (by its still-live worker, else a new worker session), then accepted.
- `ws-edge-stage-gates`: no model calls; a browser URL is configured, so stage 8 is open. The scenario drives git and
  the CLI as the coordinator (`AGT_ROLE=coordinator`, `AGT_AGENT_PROCESS=1`): its commit on `feat/<task>` is refused
  until `agt stage <id> 8 na --reason test`, and `agt stack acquire <id> --for e2e4` is rejected until the user runs
  `agt stage <id> 7 approve --by user`.
- `ws-stack-lock`, 40m: two threads, each coordinator told to restart the stack before testing. Both get
  `stack.acquired`, the events never show two holders at once, and `.stack.log` has a restart per thread at least 5s
  apart (each restart sleeps 5s).
- `ws-cleanup`, 40m: after the happy flow the user runs `agt thread status <id> done` and `agt thread cleanup <id>`:
  `thread.cleaned`, both worktrees and `wip/<task>` gone, `feat/<task>` kept.
- `ws-tab-shell`: no model calls beyond main's and the coordinator's start. The first coordinator's agent process has
  `AGT_AGENT_PROCESS=1` (its env is read with `ps -E`, or `/proc/<pid>/environ` on Linux). The user's shell split in the
  thread's tab does not; that shell's commit on `wip/<task>` succeeds. Both environments are recorded as notes (`AGT_`
  variables only). Each line typed into that shell starts with a space after `HISTFILE=/dev/null`, so none reaches the
  user's shell history. A `FLAG:` note says when the split shell did not inherit the tab's `AGT_ROLE`/`AGT_THREAD`
  (then the marker logic was not exercised).

## Reading the report

Each run appends rows to `.agentthread/e2e-reports/<iso>.md` (a table) and `<iso>.json` (every check, note, the
isolated Herdr session and socket, and the scratch repo path) in this repo. The directory carries its own `.gitignore`.
Every row also gets two harness checks: the registered layout names the isolated socket, and no process is left in
the scratch repo after Herdr stopped (a leak fails the row). A row is `PASS` when every check passed, `FAIL` with the failed checks or the error (a timeout names the event it was
waiting for and the last events), or `SKIPPED` with the reason. Each isolated server's log is next to the report
(`agt-e2e-<pid>-<n>.herdr.log`); a failed row's scratch repo keeps `.agentthread/daemon.log` and the event database.

## The release rule

Release only when every row is `PASS`. A `SKIPPED` row blocks a release just like a `FAIL`: the runner exits non-zero
if any row failed or was skipped.
