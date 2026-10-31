# Pre-release follow-ups (Plan 8): rulings and follow-ups

Source: the SDD ledger for docs/superpowers/plans/2026-10-31-pre-release-followups.md (branch fix/pre-release-followups).

## Still before release
- The rest of the release matrix: the opencode and codex rows, omp as coordinator, happy-mixed-main, and the edge rows that use an opencode worker. Codex needs a login, and AGT_E2E_MODEL_OPENCODE needs a value.
- Release note: a thread tab closed by hand while its coordinator is still spawning is reopened, up to 3 times in 10 minutes, and main is told each time. There is no signal for "the user closed this tab" yet.

## Rulings
- Task 3: Ruling: the fresh-tab path applies only to failed coordinator replacements (s.replaces), not first coordinators — why: a tab-spawned coordinator is not counted by the brake, so reopening on every failure could loop — cost if wrong: a first coordinator failing on a missing pane still needs agt start.
- Task 3: Ruling: tab_opened into a thread whose latest coordinator is failed/ended spawns a replacement of it (carries queued notices, sets replaces so the brake counts, handoff bootstrap when a handoff exists) — why: notices and continuity were lost vs the manual agt start path — cost if wrong: none found.
- Task 4: Ruling: controller reviewed the prompt diff directly (text matches the brief; tier names rendered from config keys) — why: two-line text change — cost if wrong: caught by the final review.
- Ruling: one fix wave (final-fix-brief.md items 1–6) incl. extending the missing-pane reopen to first coordinators (safe now that tab-spawned coordinators count toward the brake) — why: cheap correctness fixes — cost if wrong: none found.
- Final: parked — a tab the user closes by hand while an in-progress thread's coordinator spawns is reopened (bounded by the brake, main told); no "user closed tab" signal exists — Ruling: follow-up (new event or a mid-spawn rule) + release note — cost if wrong: up to 3 reopens in 10m of a tab the user meant to close.

## Deferred
- Task 1: minor (deferred): misplaced comment in reactor.test.ts; session.failed calls doneWorkerEnded even for a done thread (inconsistent with ended/lost gates); idle-at-completed test doesn't exercise fillWorkers.
- Task 2: minor (deferred): no test of hung-notice delivery; coordinator-target fallback duplicated from reactor (coordinatorToNotify not exported); no test for done thread / reassigned ticket skip.
- Task 3: minor (deferred): first-coordinator missing-pane failure still needs agt start; workers in the old tab are found lost only by the poller (~4-6s); no layout guard on the reopen path; smoke check depends on Herdr's error code strings; tab_opened branch lacks an explicit replaces check (safe).
