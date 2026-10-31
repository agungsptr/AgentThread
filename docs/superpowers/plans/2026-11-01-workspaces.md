# AgentThread Multi-Repo Workspaces (Plan 10) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a project a workspace of several git repos:
- `agt init` works in a folder that is not a git repo;
- each new thread gets a thread directory at `.worktrees/<task>/`;
- the coordinator creates per-repo worktrees there on `wip/<task>` with `agt worktree add`;
- the commit guard follows the new rules: workers commit on `wip/<task>`, the coordinator commits on `feat/<task>`, nobody pushes;
- brief.md shows a git trail per repo.

**Architecture:**
- A workspace module discovers repos and owns the `workspace` config.
- `thread.new` for a workspace project creates only the thread directory, not a git worktree.
- A new `worktree.add` command emits an effect that runs the project's setup command or `git worktree add`, writes the instruction files, and then emits `worktree.added`.
- The shared hook stub becomes branch- and role-aware.
- Old threads keep their single `branch`/`worktree` fields and replay unchanged.

**Tech Stack:** TypeScript on Bun ≥ 1.1.34, `bun:test`, zod, yaml, git.

**Spec:** `docs/specs/2026-10-09-agentthread-design.md` §13, including §13.9. This is plan 1 of 4 for §13:
- Plan 10, workspaces (this plan);
- Plan 11, tickets with repo and files, review/accept/return, stages, gates and stack lock;
- Plan 12, workflow content, config fields, setup prefill, `.docs` and cleanup;
- Plan 13, the release e2e on a multi-repo scratch workspace.

## Global Constraints

- Bun ≥ 1.1.34, TypeScript `strict: true`.
- Run tests as `env -u HERDR_ENV -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID -u HERDR_PANE_ID -u AGT_HERDR_IT bun test`. Run the full suite under `timeout 300`, and `bun run typecheck`, before every commit.
- Never run the real herdr or agent binaries, `agt start`, or tests/release/. Leave no `agt daemon run` or `agt __spawn` processes behind.
- No `Bun.spawnSync` on daemon paths. Use the async runners.
- Existing event logs and configs must keep replaying and loading. An old thread (one that has `branch` and `worktree`) keeps the old single-repo behavior: its worktree, its `thread/<name>` branch, and the coordinator committing.
- Paths:
  - thread directory: `<root>/.worktrees/<task>/`
  - repo worktree: `<root>/.worktrees/<task>/<repo>`
  - branches: `wip/<task>` (workers), `feat/<task>` (the coordinator's squash)
- Task names match `^[a-z0-9][a-z0-9._-]*$` and are unique among threads. Default: the title's slug. `agt thread new … --task <name>` sets it.
- Config:
  - `workspace.repos: Record<name, { path: string; source_branch?: string }>`, where `path` is relative to the root;
  - `workspace.worktree_setup?: string`, a shell command template with `{root}`, `{task}`, `{repo}`, `{src}`, `{path}`.
- Guard messages, exactly:
  - worker on a wrong branch: `AgentThread: workers commit only on wip/<task>.`
  - coordinator on a wrong branch: `AgentThread: the coordinator commits only the squash on feat/<task>.`
  - any push: `AgentThread: agents never push; the user pushes.`

## Review Focus

1. **A single-repo project keeps working end to end.** This is a project whose root is itself a git repo, such as AgentThread or any repo initialised before this plan. Tests are in Tasks 1 and 2.
2. **`agt worktree add` failures leave nothing half-made.** The cases are: an unknown repo, the same repo added twice, a source branch that does not exist, and a setup command that exits non-zero. Each one leaves no stray worktree and no `worktree.added` event. Tests are in Task 3.
3. **The guard never blocks the user in their own checkouts.** That means no `AGT_ROLE` set, or a repo folder at the root. Tests are in Task 4.

---

### Task 1: Workspace detection and `agt init` in a non-git folder

**Files:**
- Create: `src/project/workspace.ts`
- Modify: `src/project/init.ts`, `src/config/config.ts`, `src/project/setup.ts` (the wizard records repos)
- Test: `tests/project/workspace.test.ts`, `tests/project/init.test.ts`

**Interfaces:**
- `discoverRepos(root: string): Record<string, { path: string }>` returns the direct child folders whose `git rev-parse --show-toplevel` equals that folder. When root itself is a git top level, it returns `{ [basename(root)]: { path: "." } }` instead.
- `workspaceRepos(root: string, config: Config): Record<string, { path: string; source_branch?: string }>` returns config `workspace.repos` when it is set, otherwise `discoverRepos(root)`.
- `isWorkspaceProject(root): boolean` is true when root is not itself a git top level.

**Behavior:**
- `initProject` no longer requires a git repo. It throws `no git repositories found in <root>` only when `discoverRepos` is empty.
- It writes `.gitignore` lines only when the root is a git repo, as today.
- In a workspace root it creates `.docs/` when it is missing:
  - `git init`;
  - a `README.md` first commit;
  - `shared/` plus one folder per repo, each holding `issues/ specs/ plans/ adr/ notes/ agents/` with a `.gitkeep`.
- `agt setup` writes the discovered repos into `workspace.repos` and asks each repo's default source branch (blank means ask the user per task).

- [ ] **Step 1: Write the failing tests:**
  - in a folder holding two git repos and a plain folder, `discoverRepos` returns only the two repos;
  - a root that is a git repo returns one repo with path `.`;
  - `agt init` in a two-repo folder succeeds and creates `.agentthread/` and `.docs/`, where `.docs/` is a git repo with `shared/issues` and `<repo>/issues`;
  - a folder with no repos fails with the exact message;
  - a single-repo init behaves as before, with its `.gitignore` lines.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `feat: agt init works in a workspace of git repos`.

### Task 2: Thread directory and task names

**Files:**
- Modify:
  - `src/commands/schema.ts` (`thread.new` gains `task?`)
  - `src/commands/handler.ts` (`newThread`)
  - `src/domain/types.ts` (`thread.created` payload)
  - `src/state/projection.ts`
  - `src/orchestration/sessions.ts` (tab and spawn cwd)
  - `src/daemon/effects.ts`
  - `src/agents/agents-md.ts` (write into a non-git dir)
  - `src/cli/main.ts` (`--task`)
  - `src/cli/usage.ts`
- Test: `tests/commands/handler.test.ts`, `tests/agents/agents-md.test.ts`, `tests/orchestration/sessions.test.ts`

**Interfaces:**
- The `thread.created` payload gains optional `task: string` and `dir: string`. The projection's `Thread` gains:
  - `task?`, `dir?`;
  - `worktrees: Record<repo, { path: string; branch: string; source: string }>`, starting as `{}`;
  - `legacy: boolean`, which is true when the payload has `worktree` and no `dir`.
- A new effect, `{ kind: "thread.dir.ensure"; thread: { id; title; slug; task; dir } }`. It runs `mkdir -p` and writes AGENTS.md, CLAUDE.md and the skills into `dir` with plain fs. No git exclude is needed, because the folder is not in a repo.

**Behavior:**
- For a workspace project, or any project once this plan lands, `newThread` emits `thread.created` with `task` and `dir = <root>/.worktrees/<task>`, and **no** `git.worktree.add`.
  - It rejects a task name that is in use, with `task <name> is already used by thread <id>`.
  - It rejects an invalid name, with `task name must match ^[a-z0-9][a-z0-9._-]*$`.
- The tab and the coordinator's cwd are `t.dir`. A worker's cwd is `t.dir` for now; Plan 11 points it at the ticket's repo worktree.
- **Legacy threads:** when `t.legacy` is true, every path behaves as before.
- **Single-repo projects:** a single-repo project also uses the new layout for new threads, `.worktrees/<task>/<repo>`, where the repo name is the root folder's name (§13.2, my call).

- [ ] **Step 1: Write the failing tests:**
  - `thread new "Fix login" --task kyc-1` gives `dir` ending `.worktrees/kyc-1`, no `git.worktree.add` effect, and a `thread.dir.ensure` effect;
  - a duplicate task is rejected with the exact message;
  - a bad name is rejected with the exact message;
  - the default task is the slug;
  - the thread directory gets AGENTS.md and a CLAUDE.md symlink;
  - the tab cwd and the coordinator cwd are the thread directory;
  - an old log with a `thread.created` that has `worktree`/`branch` replays as `legacy: true`, and its spawn cwd is still the old worktree.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `feat: each thread gets a task name and a thread directory under .worktrees`.

### Task 3: `agt worktree add <thread> <repo> [--from <branch>]`

**Files:**
- Modify:
  - `src/commands/schema.ts` and `src/commands/handler.ts` (command `worktree.add`, coordinator or user)
  - `src/domain/types.ts` (event `worktree.added`)
  - `src/state/projection.ts`
  - `src/daemon/effects.ts` (effect `git.worktree.add` gains the `wip`/source form and the setup command)
  - `src/project/git.ts`
  - `src/cli/main.ts` and `usage.ts`
  - `src/agents/prompts.ts` (coordinator rule)
- Test: `tests/commands/worktree.test.ts`, `tests/daemon/worktree-effect.test.ts`

**Interfaces:**
- Command `{ cmd: "worktree.add"; thread; repo; from? }`.
- The effect `{ kind: "git.worktree.add"; thread; repo; repoPath; path; branch: "wip/<task>"; source }` returns `[{ type: "worktree.added", thread, payload: { repo, path, branch, source } }]` on success.
  - On failure it throws. As with `thread.new` today, the command fails and no event is written.
- `addWorktreeFromAsync(repoDir, branch, path, source)` runs `git -C <repoDir> worktree add -b <branch> <path> <source>`. It runs `git fetch` first only when `source` names a remote branch (`origin/…`) that is not yet present locally (my call).

**Behavior:**
- **Rejections**, each with its exact message:
  - an unknown repo: `unknown repo <r>; workspace repos: <list>`
  - a legacy thread: `thread <id> uses the single-repo layout`
  - a repo already added: `thread <id> already has a worktree for <r>`
  - no `--from` and no `source_branch`: `no source branch for <r>; pass --from <branch>`
- **With `workspace.worktree_setup` set,** the effect runs that command via `sh -c` in `<root>` with the placeholders filled in and shell-quoted, and a 5-minute timeout. It then verifies:
  - `<path>` exists;
  - `git -C <path> rev-parse --abbrev-ref HEAD` equals `wip/<task>`.

  Otherwise it fails with `worktree setup for <r> did not produce <path> on wip/<task>`. **Without a setup command,** it runs `addWorktreeFromAsync`.
- **After success** it writes AGENTS.md, CLAUDE.md and the skill into the worktree, reusing `writeAgentsFilesAsync`, and installs the guard.
- **A failed command leaves nothing behind.** A partially created worktree is removed (`git worktree remove --force <path>`) and a newly created `wip/<task>` branch is deleted.
- **Coordinator rule,** added to prompts.ts: `- Ask the user which source branch to start from, then create a worktree for each repo the task touches: agt worktree add <thread> <repo> --from <branch>. Never move or rename a worktree.`

- [ ] **Step 1: Write the failing tests:**
  - in a two-repo workspace, `worktree add 001 api --from main` creates `.worktrees/<task>/api` on `wip/<task>` from `main`. The event and the projection list it, and AGENTS.md is present and hidden from `git status`.
  - Each of the four rejections, with its message.
  - A setup command that creates the worktree is used instead of git, with the placeholders filled in.
  - A setup command that exits 1 leaves no event, no folder and no branch.
  - A nonexistent source branch leaves no event, no folder and no branch.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `feat: agt worktree add creates a task worktree per repo on wip/<task>`.

### Task 4: Branch-aware commit guard and no-push hook

**Files:**
- Modify: `src/agents/agents-md.ts` (`hookStub` and the guard), `src/agents/claude.ts` (`agentEnv` adds `AGT_TASK`), `src/orchestration/sessions.ts` (`tabEnv`)
- Test: `tests/agents/agents-md.test.ts`

**Behavior** (inside the shared stub):
- **pre-commit**, reading the branch from `git symbolic-ref --short HEAD`:
  - With `AGT_ROLE=worker`:
    - allow when the branch is `wip/$AGT_TASK`;
    - for a legacy `thread/*` branch, refuse with the old message `AgentThread: workers do not commit; the coordinator commits.`;
    - otherwise refuse with the worker message.
  - With `AGT_ROLE=coordinator`:
    - allow `feat/$AGT_TASK`;
    - allow a legacy `thread/*` branch;
    - otherwise refuse with the coordinator message.
  - With `AGT_ROLE=main` or unset: allow.
  - After the check, forward to the project's own hook as today.
- **pre-push:** refuse with the push message whenever `AGT_ROLE` is set. When it is unset, forward to the project's hook.
- **Environment:** `AGT_TASK` is set in the pane env of coordinators and workers of non-legacy threads.

- [ ] **Step 1: Write the failing tests** (real git, a worktree with the guard installed):
  - a worker on `wip/t1` with `AGT_TASK=t1` can commit;
  - a worker on `feat/t1` is refused with the exact message;
  - a coordinator on `feat/t1` can commit, and one on `wip/t1` is refused;
  - unset `AGT_ROLE` can commit on any branch;
  - `git push` with `AGT_ROLE=worker` to a local bare remote is refused with the push message, and with no role it pushes;
  - the legacy `thread/x` rules are unchanged;
  - the project's own pre-commit hook still runs after an allowed commit.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `feat: the commit guard follows wip/feat branches per role; agents never push`.

### Task 5: Git trail per repo in brief.md

**Files:**
- Modify: `src/project/gittrail.ts` (`trailCache` keyed by thread and repo), `src/render/brief.ts`, `src/render/markdown.ts` (the worktrees list), `src/render/write.ts`, `src/daemon/server.ts`
- Test: `tests/project/gittrail.test.ts`, `tests/render/brief.test.ts`

**Behavior:**
- For a non-legacy thread, the brief shows a `## Worktrees` section that lists each repo with its path, branch and source.
- `## Git trail` has one `### <repo>` subsection per worktree, each built from that worktree's trail, with the base `merge-base HEAD <source>`.
- With no worktrees yet, it reads `No worktrees yet.`
- Legacy threads keep the old single trail.
- The 16384-byte budget still holds, because each repo's trail is capped. The tail kept by `hardFit` now starts at `## Git trail`.

- [ ] **Step 1: Write the failing tests:**
  - with two worktrees, each with one commit, both subsections show their commit;
  - with no worktrees, the placeholder line appears;
  - a legacy thread is unchanged;
  - with 2 repos of 20 commits each plus content to fill the rest, the brief stays under 16384 bytes and keeps `## How to continue`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.** Commit `feat: brief.md shows each task worktree and its git trail`.
