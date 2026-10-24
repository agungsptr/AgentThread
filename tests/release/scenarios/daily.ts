import { runFor, type EventOf } from "../harness.ts";
import { DAILY } from "./happy.ts";
import { askForThread, closeThread, finishAndVerify, mainIdle, mainSession, newThread, sessionsOf, tiers, type Scenario } from "./common.ts";

/** §12.7 daily combination (main and coordinator on Claude Code, workers on OpenCode). Single vendor is happy-claude-code. */
export function dailyScenarios(): Scenario[] {
  return [
    {
      id: "daily-two-threads",
      agents: DAILY,
      manager: false,
      async run(h) {
        // Two threads at once, each limited to one worker at a time.
        const a = await newThread(h, ["--max-workers", "1"]);
        const b = await newThread(h, ["--max-workers", "1"]);
        await Promise.all([a, b].map((t) => finishAndVerify(h, t, { coordinator: "claude-code", worker: "opencode" })));
        // Never more than one live worker per thread, from the event log.
        const all = await h.events();
        for (const t of [a, b]) {
          const live = new Set<string>();
          let peak = 0;
          const workers = new Set(sessionsOf(all, t, "worker").map((w) => w.payload.session));
          for (const e of all) {
            const s = (e.payload as { session?: string }).session;
            if (!s || !workers.has(s)) continue;
            if (e.type === "session.created") live.add(s);
            if (e.type === "session.ended" || e.type === "session.failed" || e.type === "session.lost") live.delete(s);
            peak = Math.max(peak, live.size);
          }
          h.check(`thread ${t} never ran more than one worker`, peak <= 1, `peak ${peak}`);
        }
        for (const t of [a, b]) await closeThread(h, t);
      },
    },
    {
      id: "daily-tier-override",
      agents: DAILY,
      // A long timeout: the user's choice must land before the proposal auto-accepts.
      config: { agents: tiers(DAILY, "60s") },
      async run(h) {
        await mainIdle(h);
        const thread = await askForThread(h);
        const proposed = await h.waitFor("thread.tier_proposed", (e) => e.thread === thread, 120_000, "tier proposed");
        await mainIdle(h, 120_000);
        const want = proposed.payload.tier === "low" ? "high" : "low";
        await h.say(`use tier ${want}`);
        const chosen = await h.waitFor("thread.tier_chosen", (e) => e.thread === thread, 180_000, "tier chosen");
        h.check("the user's tier wins over the proposal", chosen.payload.tier === want && !chosen.payload.auto, JSON.stringify(chosen.payload));
        const all = await h.events();
        const c = sessionsOf(all, thread, "coordinator")[0];
        h.check("the coordinator runs at the chosen tier", c?.payload.effort === (want === "low" ? "low" : runFor(DAILY.coordinator).effort), JSON.stringify(c?.payload));
        await finishAndVerify(h, thread, { coordinator: "claude-code", worker: "opencode" });
        await closeThread(h, thread);
      },
    },
    {
      id: "daily-worker-question",
      agents: DAILY,
      manager: false,
      hints: [
        "How slugify treats accented letters (is 'é' turned into 'e', or dropped?) is not decided. A worker must not guess: it asks with agt question, ends its turn and waits for the answer.",
      ],
      async run(h) {
        const thread = await newThread(h);
        const q = await h.waitFor("question.recorded", (e, all) => e.thread === thread && sessionsOf(all, thread, "worker").some((w) => w.payload.session === e.actor.session), h.left() - 120_000, "a worker asks");
        const id = q.payload.id!;
        h.check("the question has an id", /^Q\d+$/.test(id), id);
        await h.waitFor("notice.queued", (e) => e.thread === thread && e.payload.text.startsWith(`Question ${id} from the worker for ticket `), 30_000, "coordinator told");
        const answered = await h.waitFor("question.answered", (e) => e.thread === thread && e.payload.question === id, 600_000, "coordinator answers");
        h.check("the coordinator answered", answered.actor.role === "coordinator");
        await h.waitFor("notice.queued", (e) => e.payload.session === q.actor.session && e.payload.text.startsWith(`Answer to ${id} from the coordinator: `), 30_000, "worker gets the answer");
        await finishAndVerify(h, thread, { coordinator: "claude-code", worker: "opencode" });
        await closeThread(h, thread);
      },
    },
    {
      id: "daily-coordinator-asks-user",
      agents: DAILY,
      hints: [
        'Before its first commit, the coordinator asks the user whether README lines end with a period: agt tell main "<question>", then it ends its turn and waits for the reply.',
      ],
      config: { agents: tiers(DAILY) },
      async run(h) {
        await mainIdle(h);
        const thread = await askForThread(h);
        const asked = await h.waitFor(
          "notice.queued",
          (e, all) => e.payload.session === mainSession(all) && e.payload.text.startsWith("Message from coordinator:"),
          h.left() - 300_000,
          "the coordinator asks the user",
        );
        h.note(`coordinator asked: ${asked.payload.text.slice(0, 200)}`);
        await mainIdle(h, 300_000);
        await h.say(`Tell the coordinator of thread ${thread}: no, README lines do not end with a period.`);
        const coordinators = new Set(sessionsOf(await h.events(), thread, "coordinator").map((c) => c.payload.session));
        await h.waitFor("notice.queued", (e) => coordinators.has(e.payload.session) && e.payload.text.startsWith("Message from main:"), 300_000, "main relays the answer");
        await finishAndVerify(h, thread, { coordinator: "claude-code", worker: "opencode" });
        const created = (await h.events()).find((e): e is EventOf<"thread.created"> => e.type === "thread.created" && e.thread === thread)!;
        h.note(`branch ${created.payload.branch}`);
        await closeThread(h, thread);
      },
    },
  ];
}
