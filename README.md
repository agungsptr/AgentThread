# AgentThread

AgentThread runs a team of Claude Code agents on one git repository, inside the Herdr terminal multiplexer.
You talk to a **main manager** agent. For each feature or bug it opens a **thread**: a git worktree plus a Herdr tab with a
**coordinator** agent, which splits the work into tickets and starts **worker** agents (in panes of that tab) to implement them.
A local daemon (`agt daemon`) keeps the event log and renders the state as Markdown under `.agentthread/`.

## Install

Requires [Bun](https://bun.sh) 1.1.34 or newer, git, Herdr and Claude Code.

```sh
bun install
bun link        # puts `agt` on your PATH
```

## Quick start

```sh
cd your-repo
agt init        # creates .agentthread/
agt start       # run inside a Herdr pane: sets up the main tab, then opens the main manager
```

Describe a feature or bug to the main manager. After you confirm, it creates a thread; the coordinator and workers take it from there.

## Configuration

User config: `~/.config/agentthread/config.yaml`. Project config (overrides it): `.agentthread/config.yaml`.

```yaml
agents:
  claude:
    permission_mode: acceptEdits        # acceptEdits | auto | bypassPermissions | manual | dontAsk | plan
    extra_allowed_tools: ["Bash(bun test*)"]  # lets workers run the tests without asking for approval
    # model: opus
workers:
  max_workers: 3                        # workers per thread; extra spawn requests are queued
herdr:
  main_tab_label: main
  close_tab_on_done: true
  close_worker_pane_on_end: true
```

Workers only run commands they are allowed to run without approval. If a ticket needs another command, the worker blocks
the ticket and names the command, so add the commands your project needs to `extra_allowed_tools`.

## Manual smoke test

The test suite never runs the real `herdr` or `claude` binaries. Run this once in a scratch git repo:

1. `agt init`, then `agt start` inside a Herdr pane. Claude Code opens as the main manager.
2. Ask the main manager to create a small thread and confirm it. A new tab appears, and a coordinator Claude starts in it.
3. Check that the coordinator can run `agt …` without a permission prompt (this confirms the `Bash(agt *)` allowlist pattern), and that `git commit` works for the coordinator but prompts for a worker.
4. Close the main-manager pane and run `agt daemon status` from another pane. The daemon must still be running.
5. In a coordinator pane, run `/compact`. The pane should get a HANDOFF REQUEST, the coordinator should submit it with `agt handoff … --stdin`, and a new coordinator pane should replace it.
6. Quit a coordinator's Claude (`/exit`), then run `agt start` from the main tab. A fresh coordinator should start in a new pane (nothing is resumed).
7. In a thread's worktree, check that `AGENTS.md` and `CLAUDE.md -> AGENTS.md` exist and that `git status` there is clean.
8. Let a coordinator work, then kill its Claude (`/exit`) and run `agt start`. A fresh coordinator should start in a new pane and continue from `brief.md`.
9. Remove the hooks from a coordinator's settings. It must still become idle and receive ticket notices (status comes from Herdr alone).
