# `agt stop` — design

## Intent

One command that shuts AgentThread down completely, the counterpart of `agt start`: every agent, the thread tabs, the
logger, the workspace stack, the daemon and the main manager. Thread state is kept: the next `agt start` recovers as
after a reboot (tabs reopened, dead sessions probed, recovery coordinators from the log).

## Decisions (the user's)

- Stop everything, including the main manager.
- Stop at once; no handoff round before shutting down.

## Approaches considered

1. **Reuse the reboot path** *(chosen)*: stop the daemon first, then close what it started; `agt start` already recovers
   from dead sessions. No new daemon state.
2. A daemon-side "shutdown" command that ends each session with events, then exits. Rejected: session-ended events
   trigger respawns and ticket releases in the reactor, which would need a new stopping mode for no user-visible gain.

## Behaviour, in order

1. Refused in a coordinator's or worker's agent pane (`AGT_ROLE` coordinator/worker): only the user or main stops agt.
2. Read the state: from the daemon when it runs (`events.since`), else from `.agentthread/state.db` directly.
3. Stop the daemon (if running), so nothing reacts to the agents dying.
4. With a registered Herdr layout: close every thread tab and every workers tab (`<id>-<slug>-workers[-n]`) that still
   exists, then the logger pane. The main tab and the manager pane stay. A Herdr failure is reported and the rest goes on.
5. Stop the workspace services, as `agt stack stop` does (skipped when none are configured).
6. Last, stop the main manager: `agt start` records the main agent's pid in `.agentthread/main.pid` while it runs;
   `agt stop` sends it SIGTERM (only if that pid is alive and its command line is the agent's binary). The main pane
   drops back to its shell. A stale or missing file is ignored.
7. Print one line per step (`daemon stopped`, `closed 3 thread tabs`, `logger pane closed`, `stack: …`,
   `main manager stopped`), and exit 0 unless a step failed.

## Left to the builder

Module layout (a testable `runStop` with injected daemon, Herdr, stack and process functions), message wording.
