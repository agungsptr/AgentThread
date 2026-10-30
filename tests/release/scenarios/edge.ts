import type { StoredEvent } from "../../../src/domain/types.ts";
import type { EventOf } from "../harness.ts";
import { DAILY } from "./happy.ts";
import { actingCoordinator, closeThread, finishAndVerify, mainSession, newThread, sessionsOf, type H, type Scenario } from "./common.ts";

const done = (h: H, t: string) => finishAndVerify(h, t, { coordinator: h.agents.coordinator, worker: h.agents.worker });

/** The first coordinator of `thread`, once attached and past `agt thread status in_progress`. */
async function workingCoordinator(h: H, thread: string): Promise<{ session: string; pane: string }> {
  await h.waitFor("thread.status_changed", (e) => e.thread === thread && e.payload.to === "in_progress", 300_000, "coordinator started");
  const c = actingCoordinator(await h.events(), thread);
  if (!c?.pane) throw new Error("no attached coordinator");
  return { session: c.session, pane: c.pane };
}

const replacementOf = (all: StoredEvent[], old: string) =>
  all.find((e): e is EventOf<"session.created"> => e.type === "session.created" && e.payload.replaces === old);

/** §12.7 edge cases. Most run without main (agt start --no-manager): the thread is created as the user. */
export function edgeScenarios(): Scenario[] {
  return [
    {
      id: "edge-kill-coordinator",
      agents: DAILY,
      manager: false,
      async run(h) {
        const thread = await newThread(h);
        const c = await workingCoordinator(h, thread);
        // Kill it while a worker runs, so the tab stays open: the replacement splits from a live pane of the thread.
        await h.waitFor("session.attached", (e, all) => sessionsOf(all, thread, "worker").some((w) => w.payload.session === e.payload.session), 600_000, "a worker attached");
        const killedAt = (await h.events()).at(-1)!.seq;
        await h.herdr.ok(["pane", "close", c.pane]);
        const next = await h.waitFor("session.created", (e) => e.thread === thread && e.payload.role === "coordinator" && e.seq > killedAt, 120_000, "automatic replacement");
        h.check("the replacement replaces the killed coordinator", next.payload.replaces === c.session, `replaces ${next.payload.replaces ?? "nothing"}`);
        const all = await h.events();
        // Generated at the kill, or written by the killed coordinator itself during its life (then none is generated).
        const killedCreated = all.find((e) => e.type === "session.created" && e.payload.session === c.session)!.ts;
        h.check(
          "a handoff for the replacement: generated after the kill, or the killed coordinator's own",
          all.some(
            (e) =>
              e.type === "handoff.submitted" &&
              e.thread === thread &&
              (e.seq > killedAt || (e.actor.role === "coordinator" && !e.payload.generated && Date.parse(e.ts) >= Date.parse(killedCreated))),
          ),
        );
        const attached = await h.waitFor("session.attached", (e) => e.payload.session === next.payload.session, 180_000, "replacement attached");
        h.check("the replacement runs in another pane", attached.payload.pane !== c.pane, attached.payload.pane);
        // Its first prompt is the replacement bootstrap: typed into its pane, or queued while the agent was not ready.
        const bootstrap = `You are the new coordinator of thread ${thread}; the previous session ended.`;
        let screen = "";
        for (let i = 0; i < 20 && !screen.replace(/\s+/g, " ").includes(bootstrap); i++) {
          screen = await h.herdr.read(attached.payload.pane, 400);
          if (!screen.replace(/\s+/g, " ").includes(bootstrap)) await Bun.sleep(1_000);
        }
        const queued = (await h.events()).some((e) => e.type === "notice.queued" && e.payload.session === next.payload.session && e.payload.text.startsWith(bootstrap));
        h.check("the replacement got the brief.md continuation bootstrap", screen.replace(/\s+/g, " ").includes(bootstrap) || queued);
        await done(h, thread);
        await closeThread(h, thread);
      },
    },
    {
      id: "edge-coordinator-brake",
      agents: DAILY,
      async run(h) {
        // Every coordinator exits as soon as it is up; after 3 replacements in 10m the daemon stops replacing it.
        const thread = await newThread(h);
        const seen = new Set<string>();
        for (let round = 0; round < 4; round++) {
          const all = await h.waitFor("session.attached", (e, all) => sessionsOf(all, thread, "coordinator").some((c) => c.payload.session === e.payload.session && !seen.has(c.payload.session)), 240_000, `coordinator ${round + 1} attached`);
          seen.add(all.payload.session);
          await Bun.sleep(5_000);
          // Ctrl-C twice exits Claude Code; the pane stays as a shell, so the next replacement can split from it.
          await h.herdr.run(["pane", "send-keys", all.payload.pane, "ctrl+c"]);
          await Bun.sleep(500);
          await h.herdr.run(["pane", "send-keys", all.payload.pane, "ctrl+c"]);
          await h.waitFor("session.ended", (e) => e.payload.session === all.payload.session, 60_000, `coordinator ${round + 1} ended`);
        }
        await h.waitFor("notice.queued", (e, all) => e.payload.session === mainSession(all) && /keeps exiting \(3 replacements in 10m\); not replacing/.test(e.payload.text), 120_000, "brake notice to main");
        h.check("no fourth replacement", sessionsOf(await h.events(), thread, "coordinator").length === 4);
      },
    },
    {
      id: "edge-kill-worker",
      agents: DAILY,
      manager: false,
      async run(h) {
        const thread = await newThread(h);
        const claimed = await h.waitFor("ticket.claimed", (e) => e.thread === thread, 600_000, "a worker claims a ticket");
        const pane = (await h.events()).find((e): e is EventOf<"session.attached"> => e.type === "session.attached" && e.payload.session === claimed.payload.assignee)?.payload.pane;
        if (!pane) throw new Error("claiming worker has no pane");
        await h.herdr.ok(["pane", "close", pane]);
        const released = await h.waitFor("ticket.released", (e) => e.thread === thread && e.payload.ticket === claimed.payload.ticket, 60_000, "ticket released");
        h.check("the released ticket is the killed worker's", released.payload.ticket === claimed.payload.ticket);
        await h.waitFor("notice.queued", (e) => e.thread === thread && new RegExp(`^Worker for ${claimed.payload.ticket} (ended|was lost)`).test(e.payload.text), 30_000, "coordinator notified");
        await done(h, thread);
        await closeThread(h, thread);
      },
    },
    {
      id: "edge-blocked-worker",
      agents: DAILY,
      manager: false,
      // Scenario-only: the worker's OpenCode asks for every permission, so it blocks at its first tool call.
      startEnv: { AGT_E2E_OPENCODE_ASK: "worker" },
      async run(h) {
        const thread = await newThread(h);
        const blocked = await h.waitFor("agent.blocked", (e, all) => sessionsOf(all, thread, "worker").some((w) => w.payload.session === e.payload.session), 600_000, "a worker blocks");
        const all = await h.events();
        const worker = sessionsOf(all, thread, "worker").find((w) => w.payload.session === blocked.payload.session)!;
        const ticket = worker.payload.ticket!;
        h.check("agent.blocked is for a worker of the thread", worker.payload.agent === "opencode", `${worker.payload.session} ${ticket}`);
        const pane = all.find((e): e is EventOf<"session.attached"> => e.type === "session.attached" && e.payload.session === worker.payload.session)?.payload.pane;
        const text = `The worker for ticket ${ticket} is blocked in pane ${pane}. Check it, replace it with agt worker spawn ${thread} --ticket ${ticket}, or ask the user.`;
        const notice = await h.waitFor("notice.queued", (e) => e.thread === thread && e.payload.text.includes(`The worker for ticket ${ticket} is blocked in pane `), 30_000, "coordinator notified");
        const coords = new Set(sessionsOf(all, thread, "coordinator").map((c) => c.payload.session));
        h.check("the coordinator gets the exact blocked-worker notice", coords.has(notice.payload.session) && notice.payload.text === text, notice.payload.text);
        // Blocked at its first tool call (agt ticket claim): the ticket is not done, and the worker still holds no other one.
        const after = await h.events();
        h.check("the ticket is not done", !after.some((e) => e.type === "ticket.completed" && e.thread === thread && e.payload.ticket === ticket));
        h.check("the blocked worker's session is still live", !after.some((e) => ["session.ended", "session.failed", "session.lost"].includes(e.type) && (e.payload as { session: string }).session === worker.payload.session));
      },
    },
    {
      id: "edge-rotate-turns",
      agents: DAILY,
      manager: false,
      config: { session: { rotation: { max_turns: 3 } } },
      async run(h) {
        const thread = await newThread(h);
        const req = await h.waitFor("session.rotation_requested", (e) => e.thread === thread && e.payload.reason === "turns", 900_000, "rotation by turns");
        await h.waitFor("session.rotated", (e) => e.payload.session === req.payload.session, 600_000, "rotated");
        h.check("a handoff was submitted", (await h.events()).some((e) => e.type === "handoff.submitted" && e.thread === thread));
        h.check("a replacement took over", !!replacementOf(await h.events(), req.payload.session));
        await done(h, thread);
        await closeThread(h, thread);
      },
    },
    {
      id: "edge-rotate-age",
      agents: DAILY,
      manager: false,
      config: { session: { rotation: { max_age: "2m" } } },
      async run(h) {
        const thread = await newThread(h);
        const req = await h.waitFor("session.rotation_requested", (e) => e.thread === thread && e.payload.reason === "age", 600_000, "rotation by age");
        await h.waitFor("session.rotated", (e) => e.payload.session === req.payload.session, 600_000, "rotated");
        h.check("a replacement took over", !!replacementOf(await h.events(), req.payload.session));
      },
    },
    {
      id: "edge-daemon-restart",
      agents: DAILY,
      manager: false,
      async run(h) {
        const thread = await newThread(h);
        await h.waitFor("ticket.created", (e) => e.thread === thread, 600_000, "a ticket");
        await h.agtOk(["daemon", "stop"]);
        await Bun.sleep(3_000);
        await h.agtOk(["daemon", "start"], { HERDR_SOCKET_PATH: h.server.socket });
        await done(h, thread);
        const all = await h.events();
        // Acting coordinators only: not ended, rotated, lost or failed.
        const gone = new Set(all.filter((e) => ["session.ended", "session.rotated", "session.lost", "session.failed"].includes(e.type)).map((e) => (e.payload as { session: string }).session));
        const acting = sessionsOf(all, thread, "coordinator").filter((c) => !gone.has(c.payload.session));
        h.check("one acting coordinator after the restart", acting.length === 1, `${acting.length}`);
        await closeThread(h, thread);
      },
    },
    {
      id: "edge-herdr-restart",
      agents: DAILY,
      manager: false,
      async run(h) {
        const thread = await newThread(h);
        await workingCoordinator(h, thread);
        const before = (await h.events()).at(-1)!.seq;
        // Stop the isolated server and start it again under the same session name: panes and agents are gone.
        await h.restartHerdr();
        await h.startAgt(["--no-manager"]);
        await h.waitFor("thread.tab_opened", (e) => e.thread === thread && e.seq > before, 120_000, "thread tab reopened");
        await h.waitFor("session.attached", (e, all) => e.seq > before && sessionsOf(all, thread, "coordinator").some((c) => c.payload.session === e.payload.session), 240_000, "a coordinator again");
        await done(h, thread);
        await closeThread(h, thread);
      },
    },
    {
      id: "edge-tab-closed",
      agents: DAILY,
      manager: false,
      async run(h) {
        const thread = await newThread(h);
        await workingCoordinator(h, thread);
        const tab = (await h.events()).filter((e): e is EventOf<"thread.tab_opened"> => e.type === "thread.tab_opened" && e.thread === thread).at(-1)!.payload.tab;
        const before = (await h.events()).at(-1)!.seq;
        await h.herdr.ok(["tab", "close", tab]);
        // Closing the tab takes the coordinator's pane with it: the daemon may record that as ended or as lost.
        await h.waitFor(["session.ended", "session.lost"], (e, all) => sessionsOf(all, thread, "coordinator").some((c) => c.payload.session === e.payload.session), 60_000, "coordinator ended or lost with its tab");
        // agt start reconciles: the missing tab is reopened and a coordinator starts from brief.md.
        await h.startAgt(["--no-manager"]);
        const reopened = await h.waitFor("thread.tab_opened", (e) => e.thread === thread && e.seq > before, 120_000, "tab reopened");
        h.check("a new tab", reopened.payload.tab !== tab, reopened.payload.tab);
        await done(h, thread);
        await closeThread(h, thread);
      },
    },
    {
      id: "edge-missing-binary",
      agents: { main: "claude-code", coordinator: "claude-code", worker: "claude-code" },
      startEnv: { AGT_CLAUDE_BIN: "/nonexistent/agt-e2e/claude" },
      async run(h) {
        // `agt start` itself fails to launch main; it must say so and end main's session within 60s.
        const t0 = Date.now();
        const m = await h.waitFor("session.created", (e) => e.payload.role === "main", 30_000, "main session");
        await h.waitFor("session.ended", (e) => e.payload.session === m.payload.session, 60_000, "main session ended");
        h.check("failed within 60s", Date.now() - t0 < 60_000, `${Math.round((Date.now() - t0) / 1000)}s`);
        h.check("the pane says what failed", /cannot start Claude Code \(\/nonexistent\/agt-e2e\/claude\)/.test(await h.herdr.read(h.mainPane)));
      },
    },
    {
      id: "edge-bad-model",
      agents: DAILY,
      // Main receives the stall notice.
      config: { agents: { roles: { coordinator: { agent: "claude-code", model: "agt-e2e-no-such-model" } } } },
      async run(h) {
        // A coordinator on a model that does not exist runs no agt command; the stall watchdog reports it to main.
        const thread = await newThread(h);
        const c = await h.waitFor("session.created", (e) => e.thread === thread && e.payload.role === "coordinator", 30_000, "coordinator spawned");
        const s = c.payload.session;
        const t0 = Date.parse(c.ts);
        // Its bootstrap turn errors and it idles with no further prompt: that first turn is enough.
        const stalled = await h.waitFor("session.stalled", (e) => e.payload.session === s, 60_000, "stall reported");
        const pane = (await h.events()).find((e): e is EventOf<"session.attached"> => e.type === "session.attached" && e.payload.session === s)?.payload.pane;
        const text = `Session ${s} (claude-code agt-e2e-no-such-model) finished its first turn without running any agt command; it may be misconfigured (for example a wrong model). Check pane ${pane}.`;
        const notice = await h.waitFor("notice.queued", (e, all) => e.payload.session === mainSession(all) && e.payload.text === text, 10_000, "main told of the stall");
        h.check("main gets the stall notice", !!notice, text);
        h.check("reported within 60s of the spawn", Date.parse(stalled.ts) - t0 <= 60_000, `${Math.round((Date.parse(stalled.ts) - t0) / 1000)}s`);
      },
    },
  ];
}
