# AgentThread

AgentThread runs a team of coding agents (Claude Code, OpenCode, Codex, omp, Antigravity) on one git repository, inside the Herdr terminal multiplexer.
You talk to a **main manager** agent. For each feature or bug it opens a **thread**: a git worktree plus a Herdr tab with a
**coordinator** agent, which splits the work into tickets and starts **worker** agents (in panes of that tab) to implement them.
A local daemon (`agt daemon`) keeps the event log and renders the state as Markdown under `.agentthread/`.

## Install

Requires [Bun](https://bun.sh) 1.1.34 or newer, git, Herdr and at least one supported agent.

```sh
bun install
bun link        # puts `agt` on your PATH
```

## Supported agents

| Agent | Install |
|---|---|
| Claude Code (`claude-code`) | [Claude Code docs](https://docs.claude.com/en/docs/claude-code) |
| OpenCode (`opencode`) | see opencode.ai; runs with `--standalone` |
| Codex (`codex`) | `brew install --cask codex`, then `codex login` |
| omp (`omp`) | the standalone binary from [omp.sh](https://omp.sh) (the npm build needs a newer Bun than 1.1.34) |
| Antigravity (`agy`) | Google Antigravity CLI; reads `AGENTS.md` and `.agents/skills` |

Any agent can fill any role (main, coordinator, worker). CLI facts and how to add an agent: [docs/agents.md](docs/agents.md).
`AGT_CLAUDE_BIN`, `AGT_OPENCODE_BIN`, `AGT_CODEX_BIN`, `AGT_OMP_BIN` and `AGT_AGY_BIN` override the executable of main's launch only;
coordinators and workers are started by Herdr, which picks the executable itself.

## Quick start

```sh
cd your-repo
agt init        # creates .agentthread/ (runs the setup wizard on a terminal when agents.roles is missing)
agt start       # run inside a Herdr pane: sets up the main tab, then opens the main manager
                # (also runs the wizard on a terminal when no config file sets agents.roles; without one it
                # prints a hint and uses the configured defaults, claude-code unless set)
agt setup       # re-run the per-project wizard: agent, model and effort per role, and complexity tiers
```

`agt`, `agt --help` and `agt help` print the usage; `agt help <command>` or `agt <command> --help` (also two-word commands such as
`thread new` or `stack restart`) print only that command's lines and never run it.

The logger pane (right of the main manager) runs `agt logs -f`: one line per event, `HH:MM:SS <thread|main> <role> <event> <summary>`
(ticket, stage, status change, session id, message text up to 160 characters). Heartbeat events (session active, idle, compacting,
checkpoint reminders, notice delivery) are hidden; `agt logs --all` shows everything and `agt logs` without `-f` prints once.
With `-f` it survives daemon restarts: it prints `waiting for the agt daemon…` once and retries every 2 seconds. Run `agt start` again
to repair the layout: a closed logger pane is recreated, and one whose `agt logs -f` ended gets the command again.

Non-interactive configuration (for scripts and agent shells; no prompts, no terminal needed):

```sh
agt init --no-setup                 # init without the wizard; on an initialised project it says so and exits 0
agt config show [--json]            # effective config (user + project, validated) and the file each layer came from;
                                    # --json: {"config": {...}, "sources": {"user": {"path", "exists"}, "project": {...}}}
agt config apply <file|-> [--dry-run] [--no-restart]  # merge a partial YAML/JSON config into .agentthread/config.yaml
```

`config apply` deep-merges like `agt setup` (maps merge, so `workspace.repos` merges by repo name; lists replace; a `null`
removes the key from the project file only: the user config or the default then applies, and a note says so when
the effective config does not change), keeps the file's comments, validates the merged result, and prints a diff (`+ path: new`, `- path: old`,
`~ path: old -> new`). On a validation error it prints `path: message` lines and changes nothing (exit 1). `--dry-run` only
validates and prints the diff. A real apply then refreshes the banned-words file and the root skills, and restarts a
running daemon when the config changed so it takes effect (running agents are unaffected; `--no-restart` only prints a note instead).
If the restart fails the config stays saved and the command exits 1.

Describe a feature or bug to the main manager. After you confirm, it creates a thread; the coordinator and workers take it from there.

## Configuration

User config: `~/.config/agentthread/config.yaml`. Project config (overrides it): `.agentthread/config.yaml`.
`agt setup` writes the `agents` block below to the project config.

```yaml
agents:
  roles:                                # agent, model and effort per role
    main:        { agent: claude-code, model: claude-opus-5-5, effort: high }
    coordinator: { agent: claude-code, model: claude-sonnet-5-5 }
    worker:      { agent: opencode, model: anthropic/claude-sonnet-5-5 }
  complexity:
    timeout: 10s                        # how long main's tier proposal waits for your choice (at least 1s)
    tiers:                              # names match /^[a-z][a-z0-9_-]*$/
      simple:  { agent: claude-code, model: claude-haiku-5-5 }
      complex: { agent: claude-code, model: claude-opus-5-5, effort: high }
      gemini:  { agent: opencode, model: myrouter/gemini-flash }
  autonomous: true                      # default: agents run without approval prompts
  skill: true                           # default: write the generated skills (false turns them off)
workers:
  max_workers: 3                        # workers per thread; extra spawn requests are queued
herdr:
  main_tab_label: main
  close_tab_on_done: true
  close_worker_pane_on_end: true
workspace:                              # optional; without repos, the root's child git repos are used
  repos:
    api: { path: api, source_branch: main }   # path is relative to the root
  worktree_setup: make wt-new TASK={task} SRC={src} REPOS={repo}
```

Per repo, `copy: [.env, e2e/.env.local, e2e/.auth]` lists files and directories (recursive; symlinks inside are skipped) copied from the main
checkout into each new worktree (missing ones are skipped with a note; an existing file is never overwritten, except a git-tracked
file the worktree still has unmodified: it is replaced by the local copy and marked `git update-index --skip-worktree`, so it
never shows in `git status` nor gets staged). `link: [node_modules]` symlinks directories from the main checkout instead; with
`node_modules` linked, `install` is skipped for the repo unless the lockfile differs from the main checkout's (then it installs
instead and logs why; any install, including `agt stack start`, never writes through a node_modules symlink: it is skipped when
the lockfile matches the main checkout's, else the link is removed first). Other `link` entries are plain symlinks that install does not touch. Copies and links are git-excluded in the worktree. `agt config show` / `config apply` warn about a `copy`
entry tracked by git and about a `workflow.browser.urls` localhost port that no service uses. Also per repo, `install: <cmd>` runs in a new worktree (default: detected from the lockfile, `bun install` /
`yarn install --frozen-lockfile` / `pnpm install --frozen-lockfile` / `npm ci`; `""` disables). `workspace.services.<name>`
(`^[a-z][a-z0-9-]*$`) describes a process of the local stack: `repo` (must be in `workspace.repos`), `dir` (default `.`),
`start`, optional `port`, `health` (`http(s)://...` or `tcp:<port>`, default `tcp:<port>` when `port` is set), `migrate` (opt-in: runs only with
`agt stack start|restart --migrate` / `make start MIGRATE=1`, or on a changed checkout when `migrate_on_start: true`), `env: {KEY: value}`
(merged over the inherited environment for `start` and `migrate`; values are never printed),
`after: [<service>]` (start order, no cycles) and `enabled` (default true). Ports must be unique among enabled services.
With services configured and `workflow.stack.restart` / `status` unset, they default to
`agt stack restart --task {task}` and `agt stack status`; explicit values win.

`agt worktree add <thread> <repo> [--from <branch>]` creates `.worktrees/<task>/<repo>` on a new `wip/<task>` from the
source branch, in the background; the coordinator gets a notice when it is ready or failed. With `worktree_setup`, that
command runs instead (`sh -c` in the root, at most 5 minutes) and must leave `{path}` checked out on `wip/<task>`. It replaces the built-in copy and install step as well, so it must copy files and install dependencies itself. Its
placeholders `{root}`, `{task}`, `{repo}`, `{src}` and `{path}` are filled in already shell-quoted: use them unquoted
(`TASK={task}`, not `TASK="{task}"`).

An `effort` the agent does not accept is rejected when the config loads (`agents.<path>.effort: <agent> accepts <list>`).
The older keys `main_manager`, `default_coordinator`, `default_worker` and `agents.claude.{permission_mode,
extra_allowed_tools, model, config_dir}` still load: a legacy key fills a role only when `agents.roles` does not set it.

### Tier proposal

When main starts a thread it can propose a complexity tier:
`agt thread new ... --tier <name> --reason "<why>" [--now]`. The thread is only proposed: it has no tab and no
coordinator yet. You choose with `agt thread choose <thread> --tier <name>` or drop it with `agt thread cancel <thread>`.
The timer pauses while main is working. When it runs out (`agents.complexity.timeout`), the proposed tier is accepted
automatically and main is told so. `--now` starts the thread without waiting.

### Autonomy and the worker commit guard

With `agents.autonomous: true` (the default) every agent runs with its approval prompts off (see the autonomous column in
[docs/agents.md](docs/agents.md)), and `agents.claude.permission_mode` and `extra_allowed_tools` are ignored (with a
warning). Set it to `false` to keep every agent's approval prompts: Claude Code runs with
`agents.claude.permission_mode` and the `extra_allowed_tools` allowlist, OpenCode starts without `--auto` and asks for
every permission, Codex runs with `-a on-request` (still in the workspace-write sandbox), and omp gets no
`--approval-mode`, so its own default applies. Workers are then told to run only commands they may run without
approval; a ticket that needs another command blocks and names it (for Claude Code, add it to `extra_allowed_tools`).

Workers never commit. Each thread worktree gets its own `core.hooksPath` whose `pre-commit` refuses a commit when the
agent runs as a worker, and then forwards to the project's own hooks. The coordinator reviews and commits. A coordinator
does not implement tickets itself; it delegates them to workers.

The hooks share one stub in `.agentthread/hooks/`, which the daemon rewrites when it starts. After upgrading agt, restart
the daemon and every running agent: the hooks apply role rules only to processes launched with `AGT_AGENT_PROCESS`,
which agents started by an older agt do not have.

`agt worker spawn <thread> --ticket <T> --agent <kind>` runs one worker on another agent than `agents.roles.worker`,
with that agent's own default model and effort (the role's model and effort are not carried across vendors).

A task thread's ticket lists the repo-relative files its worker may commit (`agt ticket add <thread> "<title>" --repo <r> --file a --file b`; repeat `--file` for every path, `a b` is not two files). The commit guard refuses any other staged file. The coordinator fixes a wrong list with `agt ticket files <thread>/<T> --add <path>... --remove <path>...` (repeat each flag per path; not for a done ticket, and never down to zero files); the ticket's live worker is told. Without flags the command prints the list. A ticket the guard blocked is reopened with `agt ticket reopen` after the fix.

A worker with a question runs `agt question`; the coordinator replies with `agt answer <thread> <Q> "<text>"`. A blocked
worker is reported to its coordinator. If a session's first settled turn runs no `agt` command (for example because the
configured model does not exist), the daemon reports `session.stalled` (coordinators and workers only, not main) instead of waiting forever.

A worker that stops for more than about 20s with its ticket unfinished (no done, no block, no open question) is
reported to its coordinator, at most three times per ticket, with a fourth notice to return or block it. The
coordinator (or you) can reach that worker with `agt tell <thread>/<T> "<text>"`. A worker that exits before it claims
its ticket gets a fresh one (at most twice per ticket; queued when `max_workers` is reached), and the coordinator is told.
See [docs/agents.md](docs/agents.md#behaviours-agt-adds-around-every-agent).

After upgrading agt, restart what is running: `agt daemon stop`, close the running agents' panes, then `agt start`
again. A running daemon and the agents it started keep the old code and instructions.

### Trusting the project

Claude Code asks once per folder whether you trust it. When main is Claude Code it asks in main's pane at `agt start`,
and the worktrees below the root inherit your answer. When main is another agent but a role or tier uses Claude Code,
`agt start` warns `claude-code agents will ask to trust <root>; open claude once in <root> and accept, or use
claude-code for main`. In the folders agt creates itself (thread directories and worktrees under `<root>/.worktrees/`)
agt answers a coordinator's or worker's trust dialog on screen, as you would; it never answers it in your own folders
and never reads or writes Claude Code's config. Codex is started with the project root and the worktree marked
trusted, so it never asks.

### Notes on instruction files and git config

- Worktrees live under `<root>/.worktrees/`. Claude Code also loads an ancestor `CLAUDE.md` (the one in the repo root)
  on top of the worktree's own `AGENTS.md`/`CLAUDE.md`, whose content already includes the project's instructions. The
  project's instructions can therefore appear twice for Claude Code; this is harmless.
- AgentThread sets `extensions.worktreeConfig = true` in the repository config. It is needed for the per-worktree
  excludes and commit guard, and leaves the main checkout untouched.

### The generated skills

`agt init`, `agt setup` and `agt start` write three skills into the project root, and every thread directory and repo
worktree gets the same files, each under both `.claude/skills/` and `.agents/skills/`:

- `agt/SKILL.md`: the `agt guide` text for all three roles, so an agent can load it when `AGT_ROLE` is set;
- `agt-feature-workflow/SKILL.md` and its `templates/` (spec, ticket, release): the ten-stage feature workflow, ending
  with a Project config section rendered from `.agentthread/config.yaml`;
- `manage-docs/SKILL.md`: the rules for the private `.docs/` versus each repo's shared `docs/`.

The files are regenerated, never edit them. The workflow is edited in agt's `src/workflow/`, never in the generated copies.
They are kept out of git (the root through `.git/info/exclude`, worktrees through their excludes), so they are never
committed. A skill your project tracks, or one with a file that lacks the generated marker line, is the project's own
and is left alone everywhere (the daemon logs `kept the project's own skill <name> at <path>`). Set
`agents.skill: false` to turn them off; existing generated files are then left as they are. Claude Code reads
`.claude/skills`, and so does omp, which loads skills from `.claude/skills/*/SKILL.md`; OpenCode's config has a Claude
compatibility directory, which its docs say covers `.claude/skills`. Codex and Antigravity read `.agents/skills`.

## Release check

Run `bun run e2e:release` before every release. It runs real agents against an isolated Herdr server and costs money;
see [docs/release-e2e.md](docs/release-e2e.md). `bun test` never starts real agents.

One time before the first release run, trust the folder of the `happy-mixed-main` row for Claude Code:
`mkdir -p ~/.cache/agt-e2e/mixed-main && cd ~/.cache/agt-e2e/mixed-main && git init && claude`, then accept the trust
prompt and exit.

## Manual smoke test

The test suite never runs the real `herdr` or agent binaries. Run this once in a scratch git repo:

1. `agt init`, then `agt start` inside a Herdr pane. The main manager's agent (per `agents.roles.main`) opens.
2. Ask the main manager to create a small thread and confirm it. A new tab appears, and the coordinator's agent starts in it.
3. Check that the coordinator can run `agt …` without a permission prompt and that `git commit` works for the coordinator, and that a worker's `git commit` is refused by the pre-commit guard (nothing prompts the worker).
4. Close the main-manager pane and run `agt daemon status` from another pane. The daemon must still be running.
5. In a coordinator pane, run `/compact`. The pane should get a HANDOFF REQUEST, the coordinator should submit it with `agt handoff … --stdin`, and a new coordinator pane should replace it.
6. Quit the coordinator's agent, then run `agt start` from the main tab. A fresh coordinator should start in a new pane (nothing is resumed).
7. In a thread's worktree, check that `AGENTS.md` and `CLAUDE.md -> AGENTS.md` exist and that `git status` there is clean.
8. Let a coordinator work, then kill its agent and run `agt start`. A fresh coordinator should start in a new pane and continue from `brief.md`.
9. With Claude Code as coordinator, remove the hooks from its settings. It must still become idle and receive ticket notices (status comes from Herdr alone).
