# Core engine (Plan 1) — rulings and deferred follow-ups

Source: SDD ledger for docs/superpowers/plans/2026-10-09-core-engine.md. Review these before Plans 2–4.

## Rulings
- Ruling: git repo initialized by controller with spec+plan committed on `main` (6146530), work on branch `feat/core-engine` in place (no separate worktree) — repo was empty, so a branch gives isolation without extra machinery — cost if wrong: none, branch can be moved to a worktree any time.
- Ruling: Task 1 Step 1 `git init -b main` is skipped (already done); `.gitignore` already exists with `node_modules/` and `.superpowers/` and must be kept, not overwritten — overwriting would expose the SDD workspace to git — cost if wrong: none.
- Ruling: Task 1 commit trailer says Claude Haiku 5.5 (the model that wrote it) instead of Opus 5.5 — accurate attribution of the authoring model is acceptable — cost if wrong: cosmetic, amend trailers later.
- Task 4: Ruling: assignee check fails open without session — fix by requiring actor.session for worker ticket commands (claim/done/block), rejecting with 'worker commands require AGT_SESSION'; all planned worker call sites (Tasks 7-9 tests, Plan 3 spawns) set a session — cost if wrong: sessionless manual worker use is refused.
- Task 5: Ruling: (plan-mandated) heading handling — replace demoteHeadings with a clamp so every ATX heading in handoff AND goal becomes level ≥3 (# and ## → ###, deeper unchanged); code fences/setext deferred as minor — Review Focus 2 requires user text never create h2 sections; Task 9 expects '### Decisions' which the clamp preserves — cost if wrong: h1/h2 in handoffs render flatter.
- Task 7: Ruling: client resolves before s.end() (Bun 1.1.34 fires close() synchronously on end) — necessary platform adaptation, behavior identical — cost if wrong: none. TDD RED evidence is the verbatim-code 8/8 failure rather than a missing-module run — accepted.
- Task 8: Ruling: parse() returns values cast to Record<string, any> because the plan's ParseArgsConfig typing fails typecheck — behavior unchanged — cost if wrong: weaker typing in CLI arg handling. RED run not captured separately — accepted, bin/agt absence is the implicit RED.
- Task 8: Ruling: (plan-mandated) daemon stop reports success after timeout — fix: re-check isAlive after the wait loop and throw 'daemon did not stop' — cheap and prevents a false success — cost if wrong: none.
- Final: Ruling: Important #1 (two daemons via differing TMPDIR) — fix with (a) socket path independent of TMPDIR: /tmp/agt-<uid>/<hash(realpath root)>.sock in a 0700 dir, and (b) daemon holds an exclusive SQLite lock on state.db so a second daemon fails with "daemon already running" — single-writer is the core invariant — cost if wrong: daemon can't share state.db with other readers while running (none exist in Plan 1).
- Final: Ruling: Important #2 — heading clamp regex becomes /^ {0,3}#{1,2}(?=[ \t]|$)/gm, and an odd number of fence lines in goal/handoff gets a closing fence appended; setext still deferred — Review Focus 2 — cost if wrong: rare over-clamping.
- Final: Ruling: include Minors 1-4 (realpath AGT_ROOT, writeAll failure after commit returns ok + logs, stopping flag rejects new commands, `ticket block` without --reason is a UsageError) in the single fix wave — each is a few lines — cost if wrong: small extra diff.
- Final: parked — ROLLBACK in EventStore.append can mask the original error after auto-rollback — Ruling: real, deferred (guard with db.inTransaction) — nothing in Plan 1 depends on it.
- Final: parked — unclosed ~~~ / longer fences not closed correctly (ruling gap) — Ruling: real, deferred; track fence char+length later.
- Final: parked — startDaemon deletes socket before acquiring lock; existing socket dir perms not verified — Ruling: deferred to Plan 2 (daemon lifecycle work).

## Deferred minors
- Task 1: minor (deferred): slugify turns accented chars into dashes (résumé → re-sume); strip \p{M} after NFKD.
- Task 1: minor (deferred): pathsOverlap does not collapse `..`, `//`, or backslashes — relevant to Task 7 overlap guarantee.
- Task 1: minor (deferred): validateHandoff ignores code fences, repeated headings reset content, `## Risks:` treated as missing.
- Task 1: minor (deferred): transition/scopesOverlap test coverage thin.
- Task 2: minor (deferred): batch atomicity untested; no busy_timeout pragma (matters if a 2nd process opens state.db); statement prepared per append.
- Task 3: minor (deferred): ticket projection tests thin (completed, unknown-ticket throw, assignee deletion not pinned); payload arrays aliased into state; lastSeq set before validation.
- Task 4: minor (deferred): ticket/log commands don't check thread status (claim/done allowed on done/review threads); unblock cascade reopens manually-blocked dependents; untested branches (role denials, successful handoff, partial-deps cascade, sessionless block); goal/reason not trimmed; redundant workerSession call in claim.
- Task 5: minor (deferred): writeAll untested; no test for `|` in board/log cells; long $TMPDIR could exceed socket limit; stray .tmp files after crash; code fences/setext headings not clamped.
- Task 6: minor (deferred): partial init leaves state.db → "already initialized" on retry; isGitRepo accepts subdirectories (init from repo subdir); gitignore edge-case tests missing; AGT_ROOT not validated.
- Task 7: minor (deferred): client hangs if response JSON malformed (parse inside finish); socket not closed on timeout; store not closed if Bun.listen throws; orphan worktree if append fails after effect (plan-mandated order); request shape unvalidated / no max line size; socket perms default umask; shutdown/large-response untested.
- Task 8: minor (deferred): parse() untyped values; untested decide/block/reopen/thread status/logs -f/parseTicketRef failure; AGT_ROLE="" not defaulted; extra positionals ignored; void d.stop() unhandled rejection; logs -f no reconnect.
- Task 9: minor (deferred): e2e doesn't assert decision/handoff body content or T1 row; temp repo not cleaned; afterAll unguarded; default 5s timeout for ~17 subprocesses.
