# AgentThread Multi-Agent Adapters, Role Models and Release E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any of Claude Code, OpenCode, Codex and omp can fill any role. Each role gets its own agent, model and effort, set per project. Main proposes a complexity tier for each new thread's coordinator, and the proposal auto-accepts after a timeout. Every agent runs without permission stops. Workers talk only to their coordinator. A release e2e suite runs real Herdr, real agents and real models.

**Architecture:**
- **Declarative adapters.** Each agent has an adapter that turns `{ role, model, effort, autonomous }` into args, env and a prompt-delivery style.
- **One resolver.** `agentFor()` picks the `{ agent, model, effort }` for a session from the role defaults, or for a coordinator from its thread's tier. Sessions record the choice so that replacements and rotations reuse it.
- **Proposed threads.** A thread with a proposed tier exists and has a worktree, but no tab or coordinator yet. A daemon timer picks the tier when main is idle. The timer pauses while main is working, and the coordinator's tab opens on `thread.tier_chosen`.
- **Coordinator as the worker channel.** Worker questions and blocked workers notify the coordinator. The coordinator answers with `agt answer`.
- **Separate release e2e.** It lives under `tests/release/`. `bun test` never runs it, and it has its own runner and report.

**Tech Stack:** TypeScript on Bun ≥ 1.1.34, `bun:test`, zod, yaml, Herdr 0.9.3 CLI, git.

**Spec:** `docs/specs/2026-10-09-agentthread-design.md` §12, including §12.9. Context is in §11. Follow-ups are in `docs/superpowers/followups/`.

### Verified CLI facts (from `--help` on 2026-10-24; do not re-derive)

| | Herdr kind | bin | model | effort | autonomous | first prompt | reads |
|---|---|---|---|---|---|---|---|
| Claude Code 2.1.296 | `claude` | `claude` | `--model <m>` | `--effort <low\|medium\|high\|xhigh\|max>` | `--permission-mode bypassPermissions` + `--settings` with `"skipDangerousModePermissionPrompt": true` | positional | `CLAUDE.md` (symlink) |
| OpenCode 2.0.27 | `opencode` | `opencode` | env `OPENCODE_CONFIG_CONTENT` = `{"model":"<provider/model>"}` (the TUI has no `--model`) | model variant `<provider/model>#<effort>` in the same `model` value | `--auto` + `"permission"` in `OPENCODE_CONFIG_CONTENT` (see Task 2) | `--prompt <text>` | `AGENTS.md` |
| Codex 0.164.0 | `codex` | `codex` | `-m <m>` | `-c model_reasoning_effort="<minimal\|low\|medium\|high\|xhigh>"` | `-s workspace-write -a never -c sandbox_workspace_write.network_access=true --add-dir <git common dir> --add-dir <root>/.agentthread --search` | positional | `AGENTS.md` |
| omp 18.12.6 | `omp` | `omp` (standalone binary in `~/.local/bin`; the npm build needs a newer Bun) | `--model <m>` | `--thinking <off\|minimal\|low\|medium\|high\|xhigh\|max\|auto>` | `--approval-mode yolo` | positional | `AGENTS.md` |

Codex needs `--add-dir <git common dir>` because commits from a worktree write to the main repository's `.git`. That directory lies outside the workspace-write sandbox.

## Global Constraints

- Bun ≥ 1.1.34, TypeScript `strict: true`. Run tests as `env -u HERDR_ENV -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID -u HERDR_PANE_ID -u AGT_HERDR_IT bun test`, and run `bun run typecheck` before every commit. Every test file must exit on its own. Run the full suite under `timeout 300`.
- Never run the real `herdr`, `claude`, `opencode`, `codex` or `omp` binaries, or `agt start`, outside `tests/release/`. Running `--help` and `--version` is allowed. Leave no `agt daemon run` or `agt __spawn` processes behind.
- No `Bun.spawnSync` on daemon paths after startup. Use the async runners (`spawnAsync`, `*Async` bridge calls).
- `AgentKind` is exactly `"claude-code" | "opencode" | "codex" | "omp"`.
- Config:
  - `agents.roles.{main,coordinator,worker}: { agent, model?, effort? }`.
  - `agents.complexity: { timeout: duration (default "10s", at least "1s"), tiers: Record<name, { agent, model?, effort? }> }`, where a tier name matches `/^[a-z][a-z0-9_-]*$/`.
  - `agents.autonomous: boolean` (default `true`).
  - The legacy keys `main_manager`, `default_coordinator`, `default_worker` and `claude.{permission_mode, extra_allowed_tools, model, config_dir}` still load. A legacy key fills a role's `agent`, and `claude.model` fills its `model`, only when `agents.roles` does not set that role. When `autonomous` is true, `permission_mode` and `extra_allowed_tools` are ignored, with a one-time warning: `agents.claude.permission_mode/extra_allowed_tools are ignored while agents.autonomous is true`.
- An `effort` value that the agent does not list (see the facts table) is rejected at config load as `agents.<path>.effort: <agent> accepts <list>`.
- New event types, exactly:
  - `thread.tier_proposed {tier, reason}`
  - `thread.tier_timer {state: "paused"|"running"}`
  - `thread.tier_chosen {tier, auto: boolean}`
  - `question.answered {question, answer}`
- `question.recorded` gains an optional `id`, of the form `Q<n>` and numbered per thread. Old events without an id get ids assigned in log order.
- `session.created` gains optional `model` and `effort`.
- New commands, exactly:
  - `thread.new` gains `tier?`, `reason?` and `now?`.
  - `thread.choose {thread, tier}`
  - `thread.cancel {thread}`
  - `answer {thread, question, message}`
- CLI:
  - `agt thread new … --tier <name> --reason "<why>" [--now]`
  - `agt thread choose <thread> --tier <name>`
  - `agt thread cancel <thread>`
  - `agt answer <thread> <Q> "<text>"`
  - `agt setup`
- Notice texts, exactly:
  - to the coordinator, on a question: `Question <Q> from the worker for ticket <T>: <text> Answer with: agt answer <thread> <Q> "<answer>"`
  - to the worker, on an answer: `Answer to <Q> from the coordinator: <text>`
  - to the coordinator, on a blocked worker: `The worker for ticket <T> is blocked in pane <pane>. Check it, replace it with agt worker spawn <thread> --ticket <T>, or ask the user.`
  - to main, on an auto-accepted tier: `Thread <id> started with tier <tier> (<agent> <model|default> <effort|default>) after <timeout> without a choice.`
- Bootstrap prompts are unchanged from Plan 5.

## Review Focus

1. **A proposed thread never gets a coordinator twice and never loses one.** This covers `tab_opened`, reconcile, `--now`, `choose` racing the timer, and a daemon restart while proposed. Tests are in Task 5.
2. **A replacement or rotated coordinator keeps its thread's tier, agent, model and effort**, including when the tier has since been removed from config, in which case it falls back to `roles.coordinator`. Tests are in Tasks 3 and 5.
3. **Old configs and old event logs keep working:**
   - legacy agent keys,
   - `claude.model`,
   - a missing `agents.roles`, which keeps the legacy defaults (all `claude-code`) and does not error,
   - `question.recorded` events without an id.
   Tests are in Tasks 1, 3 and 6.
4. **No adapter stops on a permission prompt or a trust dialog.** A run with the autonomous args never asks, and the worker's AGENTS.md rules never tell it to wait for the user. Asserted by args tests in Task 2 and release scenarios in Task 8.
5. **A worker can never commit**, even with full auto-approve. The per-worktree pre-commit guard refuses when `AGT_ROLE=worker`, and the coordinator still can. Tests are in Task 4.

---

### Task 1: Role and tier config

**Files:**
- Modify: `src/domain/types.ts` (`AGENT_KINDS`), `src/config/config.ts`
- Create: `src/agents/roles.ts`
- Test: `tests/config/config.test.ts`, `tests/agents/roles.test.ts`

**Interfaces:**
- Produces:
  - `type RoleAgent = { agent: AgentKind; model?: string; effort?: string }`
  - `Config.agents.roles: Record<SessionRole, RoleAgent>`, always filled after load
  - `Config.agents.complexity: { timeout: string; tiers: Record<string, RoleAgent> }`
  - `Config.agents.autonomous: boolean`
  - `EFFORTS: Record<AgentKind, readonly string[]>` in `src/agents/roles.ts`
  - `roleAgent(config, role): RoleAgent`
  - `tierAgent(config, tier: string | undefined): RoleAgent`, which returns the tier, else `roles.coordinator`
  - `configWarnings(config): string[]`

- [ ] **Step 1: Write the failing tests:**
  - `defaults fill every role with claude-code`: `roleAgent(DEFAULT_CONFIG,"worker")` equals `{agent:"claude-code"}`.
  - `legacy keys fill roles`: `{agents:{default_worker:"opencode", claude:{model:"claude-opus-5-5"}}}` gives worker `{agent:"opencode"}` and main `{agent:"claude-code", model:"claude-opus-5-5"}`.
  - `roles win over legacy keys`.
  - `tiers parse; the timeout defaults to 10s; a timeout under 1s is rejected`.
  - `effort outside the agent's list is rejected`: `roles.worker {agent:"omp", effort:"ultra"}` throws, and the message contains `agents.roles.worker.effort: omp accepts off, minimal, low, medium, high, xhigh, max, auto`.
  - `a bad tier name is rejected`.
  - `tierAgent falls back to roles.coordinator for an unknown tier`.
  - `configWarnings names the ignored claude permission keys only when autonomous and set`.
- [ ] **Step 2: Run them** (`bun test tests/config tests/agents/roles.test.ts`). Expected: FAIL.
- [ ] **Step 3: Implement.** Use a zod `superRefine` for effort per agent, using `EFFORTS` from the facts table. Fill `roles` in a post-parse step inside `loadConfig`, and in `DEFAULT_CONFIG`, from the legacy keys.
- [ ] **Step 4: Run the full suite and typecheck.** Expected: PASS. Existing config tests are updated only where defaults are asserted.
- [ ] **Step 5: Commit** `feat: per-role agent, model and effort with complexity tiers in config`.

### Task 2: Adapters for Claude Code, OpenCode, Codex and omp

**Files:**
- Modify: `src/agents/adapters.ts`, `src/agents/claude.ts`
- Test: `tests/agents/adapters.test.ts`

**Interfaces:**
- Consumes: `RoleAgent` and `Config` from Task 1.
- Produces:
```ts
interface AgentAdapter {
  agent: AgentKind;
  herdrKind: "claude" | "opencode" | "codex" | "omp";
  bin: string;                         // default executable; env override AGT_<AGENT>_BIN (AGT_CLAUDE_BIN stays)
  instructionFiles: string[];          // extra symlinks to AGENTS.md: ["CLAUDE.md"] for claude, [] otherwise
  prompt: "positional" | "flag";       // how a first message is passed on the command line (main only)
  launch(o: { role: SessionRole; run: RoleAgent; config: Config; root: string; worktree?: string; gitCommonDir?: string }): { args: string[]; env: Record<string, string> };
  promptArgs(text: string): string[];  // ["<text>"] or ["--prompt", "<text>"]
  capabilities: { hooks: boolean; contextSize: boolean; preCompact: boolean };
}
adapterFor(agent: AgentKind): AgentAdapter
```
`launch` replaces `startArgs`. Bootstrap prompts for coordinators and workers still go through `herdr agent prompt`.

- [ ] **Step 1: Write the failing table tests.** Each test asserts exact arrays.
  - **Claude**, autonomous, with `{model:"claude-opus-5-5", effort:"high"}`:
    - args include `--permission-mode bypassPermissions`, `--model claude-opus-5-5` and `--effort high`;
    - the `--settings` JSON has `skipDangerousModePermissionPrompt: true` and the existing hooks;
    - there is no `--allowed-tools`.
  - **Claude**, `autonomous:false`: keeps today's `--permission-mode <config>` and `--allowed-tools`.
  - **OpenCode**, worker, `{model:"myrouter/gemini-flash-3.8", effort:"high"}`:
    - args are `["--auto"]`;
    - the env `OPENCODE_CONFIG_CONTENT` parses to `{model:"myrouter/gemini-flash-3.8#high", permission:{"*":"allow", external_directory:"allow", doom_loop:"allow"}}`.
  - **OpenCode**, no model: the config content has no `model` key.
  - **Codex**, with `{model:"gpt-6.1-sol", effort:"medium"}`, root `/r`, gitCommonDir `/r/.git`: args are exactly `["-m","gpt-6.1-sol","-c",'model_reasoning_effort="medium"',"-s","workspace-write","-a","never","-c","sandbox_workspace_write.network_access=true","--add-dir","/r/.git","--add-dir","/r/.agentthread","--search"]`.
  - **omp**, with `{model:"opus", effort:"high"}`: args are `["--model","opus","--thinking","high","--approval-mode","yolo"]`.
  - `promptArgs` gives `["x"]` for claude, codex and omp, and `["--prompt","x"]` for opencode.
  - `adapterFor` covers every `AGENT_KINDS` entry.
- [ ] **Step 2: Run** `bun test tests/agents/adapters.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the four adapters.**
  - Check the OpenCode permission keys against `opencode.ai/docs/permissions` (`*`, `external_directory`, `doom_loop`). If a key differs, use the documented name and note it in the commit body.
  - Check the Claude `skipDangerousModePermissionPrompt` settings key with `claude --help` or the Claude Code settings docs. If it is absent, use `--dangerously-skip-permissions` instead of the `--permission-mode` pair.
  - Record each verification in `docs/agents.md` (Task 9 extends it).
- [ ] **Step 4: Run** the adapter tests, the full suite and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat: adapters for Claude Code, OpenCode, Codex and omp with autonomous launch`.

### Task 3: Spawn every role through its resolved agent

**Files:**
- Modify:
  - `src/orchestration/sessions.ts`
  - `src/daemon/effects.ts` (the `agent.spawn` effect and `runHerdr`'s tab env)
  - `src/commands/handler.ts` (the `Effect` type, `herdr.tab.ensure`)
  - `src/agents/claude.ts` (`agentEnv`)
  - `src/daemon/server.ts` (delete the `claude-code` guard at line 51)
  - `src/cli/main.ts` (main launch)
  - `src/state/projection.ts`
  - `src/domain/types.ts`
- Modify (fixtures): `tests/fixtures/fake-herdr.ts`. `agent start` records `--kind` per pane into `kinds`.
- Create (fixture): `tests/fixtures/fake-agent.ts`. It is a copy of fake-claude that also records `OPENCODE_CONFIG_CONTENT`, and it is used for the `AGT_OPENCODE_BIN`/`AGT_CODEX_BIN`/`AGT_OMP_BIN` overrides.
- Test: `tests/orchestration/sessions.test.ts`, `tests/daemon/agents.test.ts`, `tests/cli/start.test.ts`, `tests/e2e/agents-flow.test.ts`

**Interfaces:**
- Consumes: `roleAgent`, `tierAgent` (Task 1), `adapterFor().launch` (Task 2).
- Produces:
  - `Session.agent`, `Session.model?`, `Session.effort?`.
  - `Thread.tier?: string`. Task 5 sets it; until then it is undefined.
  - Effect `agent.spawn` carries `run: RoleAgent`.
  - Effect `herdr.tab.ensure` carries `env: Record<string,string>`, the coordinator adapter env merged over the AGT_* env.
  - `agentEnv(o & { agent: AgentKind })` sets `AGT_AGENT` to the session's agent, and sets `CLAUDE_CONFIG_DIR` only for claude-code.

- [ ] **Step 1: Write the failing tests:**
  - `a worker of a thread uses roles.worker`: config worker `{agent:"opencode", model:"p/m"}` gives a `session.created` payload `{agent:"opencode", model:"p/m"}`. The spawn job has `kind:"opencode"`, args `["--auto"]`, and a split env with `OPENCODE_CONFIG_CONTENT`.
  - `a coordinator uses tierAgent(thread.tier)`.
  - `a replacement copies agent/model/effort from the session it replaces`.
  - `a rotation copies agent/model/effort from the session it replaces`.
  - `the tab env carries the coordinator adapter env`.
  - `the daemon starts with a non-claude role`: there is no "not supported yet" error.
  - `agt start launches main with adapterFor(roles.main)`: with `AGT_OPENCODE_BIN` pointing at fake-agent, the argv is `["--auto","--prompt",<main system prompt>]`, run in cwd root.
  - `the SessionStart re-print stays claude-only`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The projection stores `agent`, `model` and `effort` from `session.created`.
  - `spawnCoordinator`, `spawnWorker`, `spawnReplacement` and `rotateCoordinator` resolve `RoleAgent`. A replacement or rotation uses the replaced session's fields.
  - Effects compute `gitCommonDir` once with `git rev-parse --git-common-dir`, using the async runner.
- [ ] **Step 4: Run** the full suite under timeout and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat: spawn every role with its own agent, model and effort`.

### Task 4: Instruction symlinks per adapter and the worker commit guard

**Files:**
- Modify: `src/agents/agents-md.ts`, `src/agents/prompts.ts`
- Test: `tests/agents/agents-md.test.ts`

**Interfaces:**
- Consumes: `adapterFor().instructionFiles` (Task 2).
- Produces:
  - `writeAgentsFilesAsync(o)` always writes `AGENTS.md` and a `CLAUDE.md` symlink, as today. It also writes any extra `instructionFiles` from every adapter, and excludes them the same way.
  - A per-worktree `core.hooksPath` pointing at `<root>/.agentthread/hooks`, which contains an executable `pre-commit`.
  - Existing project hooks still run: the guard script runs the repo's original `core.hooksPath` (or `.git/hooks`) `pre-commit` after its own check.

- [ ] **Step 1: Write the failing tests:**
  - `a worker cannot commit in a thread worktree`: `AGT_ROLE=worker git commit` exits non-zero with stderr `AgentThread: workers do not commit; the coordinator commits.`
  - `the coordinator can commit`.
  - `the project's own pre-commit hook still runs`.
  - `the main checkout is not affected`: the hook is not set there.
  - `rerunning is idempotent`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Use `git config --worktree core.hooksPath`, reusing the `extensions.worktreeConfig` setup. When `--worktree` is unsupported, skip the guard and log `worker commit guard unavailable: git without worktree config`.
- [ ] **Step 4: Update the worker prompt in `prompts.ts`.**
  - Replace step 2's approval sentence with: `2. Implement the ticket. You may run any command the work needs (tests, the dev stack, installs) inside the worktree. When you need a decision you cannot make, run agt question <thread> "<question>", end your turn and wait for the answer.`
  - Add to the coordinator rules: `- Workers' questions arrive as notifications; answer each with agt answer <thread> <Q> "<answer>". Only you and the main manager ever ask the user.`
  - Update the prompt tests.
- [ ] **Step 5: Run** the full suite and typecheck. Commit `feat: guard worker commits per worktree; workers ask the coordinator, never the user`.

### Task 5: Complexity proposal for new threads

**Files:**
- Modify:
  - `src/commands/schema.ts`, `src/commands/handler.ts`
  - `src/state/projection.ts`, `src/domain/types.ts`
  - `src/orchestration/reactor.ts`, `src/orchestration/sweep.ts`
  - `src/daemon/poller.ts`, `src/daemon/server.ts`
  - `src/cli/main.ts`, `src/agents/prompts.ts`
  - `src/render/brief.ts`, `src/render/markdown.ts`
- Create: `src/orchestration/tiers.ts`
- Test: `tests/orchestration/tiers.test.ts`, `tests/commands/thread-tier.test.ts`, `tests/daemon/poller.test.ts`, `tests/e2e/tier-flow.test.ts`

**Interfaces:**
- Consumes: `Config.agents.complexity` (Task 1), `Thread.tier` (Task 3).
- Produces:
  - `Thread.tierProposal?: { tier: string; reason: string; runningSince?: string }`. `runningSince` is undefined while paused.
  - `dueProposals(state, now: number, timeoutMs: number): string[]` in `src/orchestration/tiers.ts`, which returns thread ids.
  - Commands:
    - `thread.new{tier,reason,now}`. An unknown tier is rejected as `unknown tier <x>; configured: <list>`.
    - `thread.choose`, which is rejected unless the thread is proposed.
    - `thread.cancel`, which is rejected unless the thread is proposed.

**Behavior:**
- **`thread.new` without `tier`:** unchanged. It does not propose, and the coordinator uses `roles.coordinator`.
- **`thread.new` with `tier` and without `now`:**
  - emits `thread.created` and `thread.tier_proposed`, plus `thread.tier_timer{running}` if main's session is not `active`;
  - creates the worktree;
  - does not emit `herdr.tab.ensure`.
- **`--now`:** emits `thread.tier_chosen{auto:false}` straight away.
- **`thread.tier_chosen`:** sets `t.tier` and clears the proposal. The reactor then emits `herdr.tab.ensure`, and the coordinator spawns on `tab_opened` as today.
- **On `auto:true`:** main is notified with the exact text from Global Constraints.
- **The reactor:**
  - `session.active` for main emits `thread.tier_timer{paused}` for each running proposal;
  - `agent.idle` for main emits `thread.tier_timer{running}` for each paused proposal.
- **The poller** includes the main session for `started`, `active` and `idle`, never `ended`.
- **The daemon poll tick** runs `dueProposals` and, for each thread, handles a `thread.choose`-equivalent through `handle()` with `{auto:true}`.
- **Reconcile and `tab_opened`** never open a tab or spawn a coordinator for a proposed thread.
- **`thread.cancel`:** `thread.status_changed` to `done` with reason `cancelled before start`. The worktree is removed the same way a done thread's is today.
- **`brief.md` and `sub.thread.md`:** show a `Tier:` line, `Tier: <tier> (<agent> <model> <effort>), chosen by user|auto: <reason>`.
- **Main prompt, new lines:**
  - `Before creating a thread, judge its complexity and pick one tier from: <tier list with agent/model/effort>. Create it with agt thread new … --tier <name> --reason "<why>", tell the user the tier and why, say it starts in <timeout> unless they choose another, then end your turn.`
  - `If the user picks another tier, run agt thread choose <id> --tier <name>; if they want to stop, agt thread cancel <id>. If the user named a tier themselves, add --now.`
  - The tier list is rendered from config.

- [ ] **Step 1: Write the failing tests:**
  - `dueProposals` table cases: running and due; running and not due; paused.
  - The proposed thread gets no tab on `thread.new`, on reconcile, or on a daemon restart.
  - `choose` before the timer fires gives exactly one coordinator, with that tier's agent.
  - Main working pauses the timer, and main idle restarts it with a full timeout.
  - The timer fires gives `tier_chosen{auto:true}` and the main notice text.
  - `choose` after the timer fired is rejected with `thread <id> is not waiting for a tier`.
  - `--now` skips the wait.
  - `cancel` marks the thread done and gives no coordinator.
  - The tier line appears in `brief.md`.
  - A replacement coordinator keeps the tier.
  - With the tier deleted from config, the replacement uses `roles.coordinator`.
  - E2E (fake herdr, `complexity.timeout: 1s`, `poll_interval: 100ms`): main is idle, the thread is proposed, a coordinator spawns within 3s with the tier's agent kind, and `brief.md` shows `chosen by auto`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the behavior above.
- [ ] **Step 4: Run** the full suite under timeout and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat: main proposes a complexity tier per thread; it auto-accepts after a pause-aware timeout`.

### Task 6: Workers talk to their coordinator

**Files:**
- Modify:
  - `src/commands/schema.ts`, `src/commands/handler.ts`
  - `src/state/projection.ts`, `src/domain/types.ts`
  - `src/orchestration/reactor.ts`
  - `src/render/markdown.ts`, `src/render/brief.ts`
  - `src/cli/main.ts`
- Test: `tests/orchestration/questions.test.ts`, `tests/state/memory.test.ts`

**Interfaces:**
- Produces:
  - `Thread.questions: { id: string; message: string; ts: string; by?: { role; ticket? }; answer?: { message: string; ts: string } }[]`. Ids are `Q1`, `Q2`, and so on per thread.
  - Command `answer {thread, question, message}`, coordinator only. Any other role is rejected with `only the coordinator answers questions`. An unknown id is rejected with `unknown question <Q> in thread <id>`.

- [ ] **Step 1: Write the failing tests:**
  - A worker's `question` notifies the thread's coordinator with the exact text, and the payload gets an `id`.
  - A coordinator's or main's `question` notifies nobody, as today.
  - `answer` emits `question.answered` and delivers the exact answer text to the asking worker's session.
  - If the asking worker has ended, the answer is still recorded, nothing is delivered, and the coordinator is not told again.
  - A worker `agent.blocked` notifies the coordinator with the exact text and not main.
  - A coordinator `agent.blocked` still notifies main, as today.
  - Old `question.recorded` events without an id get `Q1..` in log order.
  - Open questions in `brief.md` show the id and the answer once answered. Answered questions leave "Open questions".
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** The asker's session is the event's `actor.session`.
- [ ] **Step 4: Run** the full suite and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat: worker questions and blocks go to the coordinator; agt answer replies`.

### Task 7: Per-project setup

**Files:**
- Create: `src/project/setup.ts`
- Modify: `src/cli/main.ts` (the `setup` command; `init` and `start` call it when needed)
- Test: `tests/project/setup.test.ts`, `tests/cli/cli.test.ts`

**Interfaces:**
- Consumes: Task 1 config.
- Produces:
  - `detectAgents(which = Bun.which): AgentKind[]`, using `bin` from Task 2 and the `AGT_<AGENT>_BIN` overrides.
  - `runSetup(o: { root: string; ask: (q: string, def?: string) => Promise<string>; detected: AgentKind[] }): Promise<void>`.
  - `needsSetup(root): boolean`, which is true when the project config has no `agents.roles`.

**Behavior:**
- `runSetup` asks, in this order:
  1. for each role, the agent (choices limited to detected agents, with `claude-code` as the default when detected), then the model (blank means the agent default), then the effort (blank means the default; validated against `EFFORTS`);
  2. then the tiers, repeated: a name (blank finishes), then agent, model and effort;
  3. then the timeout (default `10s`).
- It writes `agents.roles`, `agents.complexity` and `agents.autonomous: true` into `.agentthread/config.yaml` through `yaml`'s `parseDocument`, keeping the other keys and comments.
- `agt init` and `agt start` call it when `needsSetup` is true and stdin is a TTY.
- On a non-TTY they print `run agt setup (or edit .agentthread/config.yaml) to choose agents per role; using claude-code for every role` and continue with the defaults.

- [ ] **Step 1: Write the failing tests.** Use a scripted `ask`:
  - the written YAML round-trips through `loadConfig`;
  - an existing `workers.max_workers` and its comment are kept;
  - an undetected agent is refused with `opencode is not installed (looked for opencode on PATH)`;
  - a bad effort re-asks;
  - `needsSetup` is true only without `agents.roles`;
  - with a non-TTY, `agt init` prints the hint and succeeds.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Read answers with `node:readline/promises` on the TTY.
- [ ] **Step 4: Run** the full suite and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat: agt setup asks for agents, models, effort and complexity tiers per project`.

### Task 8: Release e2e with real Herdr and real agents

**Files:**
- Create:
  - `tests/release/run.ts`, the runner
  - `tests/release/harness.ts`
  - `tests/release/scenarios/*.ts`
  - `tests/release/fixture-repo/` (template files for the scratch repo)
  - `docs/release-e2e.md`
- Modify:
  - `package.json`: `"e2e:release": "bun tests/release/run.ts"`. It must not match `bun test`'s patterns: no `*.test.ts` under `tests/release/`.
  - `tests/fixtures/fake-herdr.ts`, plus fast-suite regression tests for every mismatch found.

**Interfaces:**
- **Harness:**
  - `startHerdr(): Promise<{ socket: string; stop(): Promise<void> }>` runs an isolated headless Herdr server for each run, using `herdr server` with its own `HERDR_SOCKET_PATH` or `--session agt-e2e-<pid>`. It never touches the user's live session.
  - `scratchRepo(): Promise<string>` makes a git repo from `fixture-repo/` in a temp dir.
  - `agt(args, env)` runs the CLI.
  - `waitForEvent(root, type, pred, timeoutMs)`.
  - `say(pane, text)` acts as the "user" by sending text to main's pane with `herdr agent prompt`.
  - `report(scenario, result)` writes a JSON and Markdown row to `.agentthread/e2e-reports/<iso>.md` in this repo, which is gitignored.
- **A scenario** is `{ id, agents: { main, coordinator, worker }, run(h): Promise<void> }`. Assertions are on artifacts only:
  - events,
  - `brief.md`,
  - `AGENTS.md` and the `CLAUDE.md` symlink present and absent from `git status --porcelain`,
  - commits on the thread branch,
  - Herdr panes opened and closed (`herdr agent list`, `pane list`),
  - tickets done.
- **Runner:**
  - It takes `--only <id,…>`, `--agents <kind,…>` and `--timeout <dur>` (default 20m per scenario).
  - An agent not found by `detectAgents` marks its rows `skipped (not installed)`.
  - The exit code is non-zero if any row failed or was skipped. Skipped rows block a release.

**Scenarios (§12.7):**
- **Happy flow,** for each agent as coordinator (worker on the daily default) and each agent as worker (coordinator on the daily default). That is 8 rows, minus duplicates.
  - The task in fixture-repo is: add a `slugify(s)` function, its unit tests, and a README line. The task is known to split into 2–3 tickets.
  - Complexity timeout `5s`.
- **Daily combination** (main and coordinator on claude-code, worker on opencode):
  - single vendor;
  - two concurrent threads with `max-workers 1`;
  - override the proposal with `say(main, "use tier low")`;
  - a worker asks and the coordinator answers (the fixture's task includes an ambiguity the AGENTS.md hint makes the worker ask about);
  - the coordinator asks the user.
- **Edge cases:**
  - kill the coordinator agent: `herdr pane close`, then expect an automatic replacement and `brief.md` continuation;
  - a coordinator keeps exiting (`AGT_CLAUDE_BIN=/usr/bin/false` for replacements), then expect the brake notice;
  - kill a worker, then expect the ticket released and the coordinator notified;
  - a blocked worker (spawn opencode without `--auto` via a scenario-only env override), then expect the coordinator notice;
  - rotation by turns with `max_turns: 3`;
  - rotation by age with `max_age: 2m`;
  - a daemon restart mid-thread;
  - a Herdr server restart;
  - a thread tab closed;
  - a missing binary or a bad model fails clearly within 60s.

- [ ] **Step 1: Build the harness** and the single happy-flow scenario for claude-code. Run `bun run e2e:release --only happy-claude-code`. Expected: a report row PASS, or a concrete failure to fix.
- [ ] **Step 2: Add the remaining scenarios.** Run them all. Every failure is triaged as one of:
  - **a product bug:** fix it in the owning code, with a fast-suite test;
  - **a fake-herdr gap:** fix `fake-herdr.ts` plus a fast-suite regression test;
  - **a scenario bug.**
- [ ] **Step 3: Write `docs/release-e2e.md`**, covering:
  - prerequisites: agents installed and logged in (keys and routers are the user's own config);
  - running it, and reading the report;
  - the release rule: all rows PASS, none skipped.
- [ ] **Step 4: Run** the fast suite and typecheck. Commit `test: release e2e against real Herdr and real agents`.

### Task 9: Documentation

**Files:**
- Modify: `README.md`, `docs/agents.md` (from Task 2), `docs/memory-eval.md`

- [ ] **Step 1: README:**
  - agents supported, with their install notes: omp from `omp.sh` as a binary; Codex from `brew install --cask codex`;
  - `agt setup` and the config shape;
  - tier proposal behavior;
  - autonomy and the worker commit guard;
  - `bun run e2e:release` before every release;
  - the ancestor-`CLAUDE.md` note carried from the Plan 5 follow-ups;
  - the `extensions.worktreeConfig` note.
- [ ] **Step 2: `docs/agents.md`:** the verified facts table plus "adding an agent" steps: an adapter entry, `EFFORTS`, `instructionFiles`, an adapters test row, and a release e2e row.
- [ ] **Step 3: `docs/memory-eval.md`:** the cross-vendor run is now possible. Name the config to switch `roles.coordinator`.
- [ ] **Step 4: Commit** `docs: multi-agent setup, tiers, autonomy and the release e2e`.
