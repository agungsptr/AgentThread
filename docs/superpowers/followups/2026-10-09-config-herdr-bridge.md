# Config + Herdr bridge (Plan 2) — rulings and deferred follow-ups

Source: SDD ledger for docs/superpowers/plans/2026-10-09-config-herdr-bridge.md. Review before Plans 3–5.

## Rulings
- Task 5: Ruling: (plan-mandated) tabExists swallowing all HerdrErrors can record tab_closed for a still-open tab / duplicate tabs — fix in bridge: tabExists returns false only for codes tab_not_found|not_found (verified real herdr returns tab_not_found), rethrows others so the soft effect logs and emits nothing; add fake failure mode + daemon test — cost if wrong: a real 'not found' with another code would log instead of recreating the tab.
- Final: Ruling: I-1 — `agt start` preflights before any Herdr mutation: refuse when AGT_THREAD is set or AGT_ROLE is coordinator/worker ("agt start must run from the main tab, not a subthread pane"); layout commands are sent as {role:"user"} explicitly since start is a human bootstrap command (so a Plan 3 main-manager pane with AGT_ROLE=main works) — cost if wrong: a non-user process can trigger layout registration.
- Final: Ruling: I-2 — herdr CLI calls get a 10s timeout; a killed/timed-out call becomes HerdrError("timeout"); fake herdr gets a hang mode + test — cost if wrong: very slow herdr ops (>10s) fail softly.
- Final: Ruling: I-3 — launch the daemon fully detached (new session via child_process spawn detached + unref, output to daemon.log) instead of sh/nohup — cost if wrong: none.
- Final: Ruling: include triaged fixes (lstat+isDirectory socket dir, HOME `||`, HERDR_SOCKET_PATH propagation test with fake recording env, stale-layout rebuild test) and minors M-1 (reconcile closes tabs of done threads when close_tab_on_done), M-2 (isolate config home in daemon/cli/e2e tests), M-5 (render failure via opts.log); defer M-3, M-4 — cost if wrong: small extra diff.
- Final: Ruling: I-2 implemented via a /bin/sh watchdog (SIGKILL after timeoutMs, exit 137 → timeout) because Bun 1.1.34 spawnSync timeouts don't kill — accepted pending re-review — cost if wrong: herdr exiting 137 on its own is reported as timeout.
- Final: parked — watchdog resolves `sleep` via PATH (use /bin/sleep); any exit 137 treated as timeout (stderr dropped); rare lingering sleep; fractional sleep non-POSIX; dead catch in ensureDaemon (spawn errors are async); stale envs in T4 test; socket-dir accept test asserts no mode — Ruling: real but non-blocking, deferred.

## Deferred minors
- Task 1: minor (deferred): socket dir check uses statSync (follows symlinks; lstat would reject); no test for other-owner error; import order.
- Task 2: minor (deferred): HOME="" yields relative config path (?? vs ||); duration allows 0s; deepMerge __proto__ key unguarded; null-section case untested.
- Task 3: minor (deferred): tabExists returns false for any HerdrError (outage looks like closed tab → possible duplicate tab if a later create succeeds); fake pane-split path untested here (covered in T6).
- Task 4: minor (deferred): herdrSocket round-trip untested; herdrSocket allows empty string.
- Task 5: minor (deferred): no HerdrError-path tests beyond tab get; layout.get not guarded by shuttingDown (read); "render failed after commit" uses console.error not opts.log; reconcile-failure test asserts only create count.
- Task 6: minor (deferred): stale-layout rebuild path untested; quoted-root test doesn't reach shellQuote (shellQuote unit-tested in T3; logger command quotes bun+agt paths); layout.register payload (herdrBin/herdrSocket) unasserted.
- Task 7: minor (deferred): afterAll swallows all errors (cleanup); e2e doesn't cover herdr-unavailable (owned by T5).
- Final: parked — watchdog resolves `sleep` via PATH (use /bin/sleep); any exit 137 treated as timeout (stderr dropped); rare lingering sleep; fractional sleep non-POSIX; dead catch in ensureDaemon (spawn errors are async); stale envs in T4 test; socket-dir accept test asserts no mode — Ruling: real but non-blocking, deferred.
- Final: deferred — M-3 (start reads label from fresh config while daemon uses startup config), M-4 (stale layout with surviving main tab id treated healthy).
