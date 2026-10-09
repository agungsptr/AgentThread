# Claude Code agents (Plan 3) — rulings and deferred follow-ups

Source: SDD ledger for docs/superpowers/plans/2026-10-10-claude-code-agents.md. Review before Plans 4–5.

## Rulings
- Task 3: Ruling: temporary `default: return []` in effects.ts switch to keep typecheck green until Task 7 handles agent.spawn/notice.deliver/pane.close — Task 7 must replace it with real cases — cost if wrong: none if T7 removes it.
- Task 4: Ruling: (plan-mandated) busy/duplicate delivery — projection: notice.delivered also sets a live session's status to `active` (the paste starts a turn); Task 7's loop already commits effect events (notice.delivered) before the next round — cost if wrong: a notice arriving right after a delivery waits for the next Stop hook.
- Task 4: Ruling: include cheap guards — reactor dedupes session.ended per call (and pane.close), skips delivery to a worker being torn down; projection session.ended does not overwrite `failed`; strengthen the two-slots test (queue T3,T4,T5 → exactly 2 spawns) and add a multi-round test — cost if wrong: none.
- Task 4: Ruling: defer — notices to non-live targets dropped (Plan 4 respawn/handoff), slot fill on tab_opened/blocked→open, spawning into blocked threads, done→ no pane.close (tab closes), same-call shared split pane.
- Task 7: Ruling: tests/daemon/herdr.test.ts adjusted (launch no-op, session.created in expected list, last-event checks → contains) because the reactor now legitimately appends session events — behavior assertions unchanged — cost if wrong: weaker ordering checks in Plan 2 tests. Hang test kills its own spawned child.
- Task 8: Ruling: (plan-mandated) unbounded stdin read in agt event — race Bun.stdin.text() against ~1.5s and treat timeout as empty input; also include: missing Claude binary after session.open_main sends 'ended' and exits 1 with a clean message; tests for open-stdin hang, daemon-down with a session id, start exit-code propagation; defer actor/session mismatch after /clear (new untracked session is correctly rejected) — cost if wrong: none.
- Task 9: Ruling: test-only helper spawned(role,ticket) replaces brief's '?.pane && session()' expression that failed typecheck — same semantics — cost if wrong: none.
- Final: Ruling: M-2 rejected — `claude --help` (2.1.296) was checked by the controller before planning: choices are acceptEdits, auto, bypassPermissions, manual, dontAsk, plan; PERMISSION_MODES matches — cost if wrong: invalid mode fails every spawn (caught by manual smoke test).
- Final: Ruling: I-1 coordinator tab env gets PATH (bin dir prefix) and AGT_AGENT — cost if wrong: none.
- Final: Ruling: I-2 allowlist adds Read(/<root>/.agentthread/**) (absolute-path rule, `//` prefix) for coordinator and worker; verify in manual smoke — cost if wrong: coordinators prompt on reads until fixed via extra_allowed_tools.
- Final: Ruling: I-3 a worker idle with its ticket blocked is torn down like done (spec §6.3 one session per ticket) — cost if wrong: blocked worker context lost; coordinator respawns after reopen.
- Final: Ruling: I-4 spawn job treats `agent_not_ready` from agent start as attached (agent is in the pane); a failed bootstrap prompt is reported via session.attached with `pending` text that the handler queues as a notice; coordinator failure notifies the main manager — cost if wrong: a truly dead agent shows as attached until Plan 4 health checks.
- Final: Ruling: I-5 worker prompt says to run only commands it may run without approval and to block the ticket otherwise; add README with install (bun link) and extra_allowed_tools example — cost if wrong: none.
- Final: Ruling: include 'error' listener on spawned child, reactor round-cap log, M-1 (main session SessionStart → idle), M-3 (worker names get 4-char session suffix), M-4 (agt start refuses AGT_ROLE=main), M-6 (main manager cwd = root); defer M-5 and narrower Bash patterns.

## Residual / deferred
- Task 1: minor (deferred): no tests for extra_allowed_tools empty/trim or unknown claude keys.
- Task 2: minor (deferred): compacting/over-count delivered/writeAll sessions filter/renderMain multi-worker untested; duplicate session.created overwrites silently.
- Task 3: minor (deferred): untested rejections (thread done, non-open ticket, open_main duplicate); split target when previous worker has no pane yet untested.
- Task 4: minor (deferred): idle + →done in same call untested.
- Task 5: minor (deferred, surface to user): workers told to "run the relevant tests" but test commands aren't allowlisted by default → permission prompt; user should add e.g. Bash(bun test*) to agents.claude.extra_allowed_tools. Also: coordinator prompt silent on re-spawning after reopen, on handoff, on in_progress guard; main prompt silent on review→done.
- Task 6: minor (deferred): fake-claude/waitFor untested directly.
- Task 7: minor (deferred → final review triage): hang test orphans watchdog+fake herdr ~90s (kill process group); no 'error' listener on spawned child (session stuck non-terminal); silent reactor 10-round truncation; bootstrap failure after start in coordinator pane reports failed while claude runs; notice.deliver/pane.close sync herdr in daemon (≤10s); system prompt/allowed-tools not asserted in daemon test.
- Task 8: minor (deferred): hook session_id ≠ AGT_SESSION (after /clear) rejected silently; signal-killed claude exit code convention.
- Task 9: minor (deferred): no negative assertion T2 not spawned before w1 finished (covered in T4).
- Final: RESIDUAL (load-bearing, surfaced to user — no second fix wave): I-4 bootstrap queued as pending notice is never delivered for an agent recovered from a startup dialog (status stays active; delivery needs idle). Proposed minimal fix: projection session.started sets idle when status was `starting` (any role; replaces main-only M-1 rule), reactor `case "session.started"` → deliver, integration test signals `started` not `idle`.
- Final: deferred — allowed-tools comma join breaks roots with commas/spaces; unbounded id lengths vs 32-char names; coordinator prompt should say re-spawn after reopen; global-constraints text outdated for names/tools.
