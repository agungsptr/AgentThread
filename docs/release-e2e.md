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
  skip those login checks.
- Optional models and efforts per agent: `AGT_E2E_MODEL_<AGENT>` and `AGT_E2E_EFFORT_<AGENT>`, with `<AGENT>` one of
  `CLAUDE_CODE`, `OPENCODE`, `CODEX`, `OMP` (for example `AGT_E2E_MODEL_CLAUDE_CODE=sonnet`). Unset means the agent's
  default model.
- Claude Code asks once per new folder whether you trust it. Each row's scratch repo is a new temp folder, so the
  harness answers that dialog for the repo root as you would (worktrees below it inherit the trust). Your Claude
  config therefore gains a trusted-folder entry per row's temp path.

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
  and `happy-worker-<agent>` (coordinator on Claude Code), minus duplicates.
- Daily combination: `daily-two-threads` (two threads at once, `--max-workers 1`), `daily-tier-override` (the user
  says "use tier …" over main's proposal), `daily-worker-question` (an AGENTS.md hint makes the worker ask; the
  coordinator answers), `daily-coordinator-asks-user`.
- Edge cases: `edge-kill-coordinator`, `edge-coordinator-brake`, `edge-kill-worker`, `edge-blocked-worker` (the worker's
  OpenCode asks for every permission via the scenario-only `AGT_E2E_OPENCODE_ASK=worker`), `edge-rotate-turns`
  (`max_turns: 3`), `edge-rotate-age` (`max_age: 2m`), `edge-daemon-restart`, `edge-herdr-restart`, `edge-tab-closed`,
  `edge-missing-binary`, `edge-bad-model` (a coordinator on a model that does not exist: the stall watchdog's
  `session.stalled` notice reaches main after its second turn).

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
