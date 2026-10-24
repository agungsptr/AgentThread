# Memory recovery evaluation (dev runbook)

Checks, with real agents, that a replacement coordinator continues a thread from `brief.md` alone after the previous coordinator's agent was killed. Run it by hand; the test suite never starts real agents.

## Setup

1. Create a scratch git repo with a small task that needs at least 3 tickets (for example: add a CLI flag, wire it into the config, document it).
2. `agt init`, then `agt start` inside a Herdr pane.
3. Ask the main manager for a thread for that task. Note the thread id.

## Steps

1. Run to mid-work: at least one ticket done, one worker running, and the coordinator has recorded progress (`agt progress`), a note and ideally an open question.
2. Kill the coordinator's agent (quit it, or close its process) without writing a handoff.
3. Run `agt start` from the main tab. A fresh coordinator starts in a new split pane.
4. Let the replacement continue. Do not give it extra context by hand. Observe until its first productive action (a ticket spawned, a review, a commit) and beyond.
5. Repeat the whole run twice: first with the same vendor for the replacement, later with another vendor (change `agents.roles.coordinator.agent`, and its `model` and `effort`, in `.agentthread/config.yaml` before step 3, or run `agt setup`; the cross-vendor run needs both agents installed and logged in).

## Score sheet

One row per run.

| Run (vendor before -> after) | Continued from right point (y/n) | Repeated work (min) | Questions already answered by the brief (#) | Time to first productive action | Tokens to first productive action | Notes: what was missing from the brief |
|---|---|---|---|---|---|---|
| claude -> claude | | | | | | |
| claude -> other | | | | | | |

Notes to record: facts the replacement had to rediscover, decisions it re-asked, anything in `brief.md` that was stale or truncated, and whether the generated handoff matched the real state.
