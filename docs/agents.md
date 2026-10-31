# Agents

## Verified CLI facts (from `--help` on 2026-10-24)

| Agent | Herdr kind | bin | model | effort | autonomous | first prompt | instruction file |
|---|---|---|---|---|---|---|---|
| Claude Code 2.1.314 | `claude` | `claude` | `--model <m>` | `--effort <low\|medium\|high\|xhigh\|max>` | `--permission-mode bypassPermissions` + `--settings` JSON with `"skipDangerousModePermissionPrompt": true` | positional | `CLAUDE.md` (symlink to `AGENTS.md`) |
| OpenCode 2.0.27 | `opencode` | `opencode` | env `OPENCODE_CONFIG_CONTENT` = `{"model":"<provider/model>"}` (the TUI has no `--model`) | variant suffix in the same value: `<provider/model>#<effort>` | `--standalone --auto` + `"permission"` in `OPENCODE_CONFIG_CONTENT` | `--prompt <text>` | `AGENTS.md` |
| Codex 0.164.0 | `codex` | `codex` | `-m <m>` | `-c model_reasoning_effort="<minimal\|low\|medium\|high\|xhigh>"` | `-s workspace-write -a never -c sandbox_workspace_write.network_access=true --add-dir <git common dir>` (coordinator only) `--search -c 'projects={"<root>"={trust_level="trusted"},"<worktree>"={trust_level="trusted"}}'` | positional | `AGENTS.md` |
| omp 18.13.3 | `omp` | `omp` (standalone binary in `~/.local/bin`; the npm build needs a newer Bun) | `--model <m>` | `--thinking <off\|minimal\|low\|medium\|high\|xhigh\|max\|auto>` | `--approval-mode yolo` | positional | `AGENTS.md` |

Claude Code (2.1.314) in every role: autonomous start (`--permission-mode bypassPermissions` with `skipDangerousModePermissionPrompt`), positional first prompt and the `CLAUDE.md` symlink are verified by the release matrix 2026-10-31 (`happy-claude-code`), and so is the failure message of a missing binary (`edge-missing-binary`).

omp (18.13.3; the flags above are unchanged from 18.12.6's `--help`) as a worker under a Claude Code coordinator: autonomous start (`--approval-mode yolo`) and positional first prompt are verified by the release matrix 2026-10-31 (`happy-worker-omp`). An omp worker keeps working after `agt ticket done` (about 16s observed), so its pane closes only when that turn ends. omp as a coordinator (`happy-coord-omp`, workers on OpenCode) and `--model`/`--thinking` were not part of that run; still verified from `--help` only.

Codex: autonomous start verified from `--help` only; pending the release matrix.

OpenCode needs `--standalone`: by default its TUI attaches to the shared background service (`opencode serve`), whose own config wins, so `OPENCODE_CONFIG_CONTENT` (model and permissions) was ignored in the release e2e. `--standalone` runs a private server that reads it.

Codex's coordinator needs `--add-dir <git common dir>` because commits from a worktree write to the main repository's `.git`, which lies outside the workspace-write sandbox. Only the coordinator gets it: workers never commit, and write access to the git dir would let a worker rewrite its worktree's `config.worktree` and unhook the commit guard. There is no `--add-dir <root>/.agentthread`: agents only read the thread files there (reads are not sandboxed), and `agt` reaches the daemon through its socket in `/tmp/agt-<uid>/` (`src/project/paths.ts`, `ensureSocketDir`), not under `.agentthread`, over the sandbox's network access (`sandbox_workspace_write.network_access=true`); `/tmp` is a writable root of workspace-write by default. Not yet seen in a release run.

## Skill discovery (`.claude/skills/agt/SKILL.md`)

Checked 2026-10-31 against the installed binaries (`--help` and strings only, no agent run):
- Claude Code: reads `.claude/skills`.
- omp 18.13.3: has a "Load skills from .claude/skills/*/SKILL.md" provider (also `.codex/skills`, `.opencode/skills`, `.agents/skills`).
- OpenCode: its config has a Claude compatibility directory next to an `agents` one; its documented skill search includes `.claude/skills`. The binary was not exercised, so this rests on the docs and that string.
- Codex 0.164.0: skill sources are `.agents/skills` and `$CODEX_HOME/skills` (`~/.codex/skills`); no `.claude/skills` string found. Codex agents therefore get no generated skill and rely on the `agt guide <role>` line in their prompt.

## Adding an agent

1. Add the kind to `AGENT_KINDS` (`src/domain/types.ts`) and an adapter entry in `src/agents/adapters.ts`: `herdrKind`, `bin`, `prompt`, `launch` (model, effort and the autonomous flags), `promptArgs` and `capabilities`, plus its `AGT_<AGENT>_BIN` name.
2. Add its accepted effort values to `EFFORTS` in `src/agents/roles.ts` (an empty list accepts any string).
3. Set `instructionFiles` to the extra symlinks to `AGENTS.md` the agent reads (empty when it reads `AGENTS.md`).
4. Add a row to `tests/agents/adapters.test.ts` and a line to the table above, from the agent's own `--help`.
5. Add a release e2e row (`tests/release/`) and the agent to the login checks, then run `bun run e2e:release --agents <agent>`.

## Verification notes

### OpenCode permission keys
Source: https://opencode.ai/docs/permissions (fetched 2026-10-24). The docs confirm all three keys we use:
- `*` is the global wildcard ("globally (with `*`), and override specific tools"), e.g. `"*": "ask"`.
- `external_directory`: triggered when a tool touches paths outside the project working directory; default `ask`.
- `doom_loop`: triggered when the same tool call repeats 3 times with identical input; default `ask`.

The docs show `"permission": "allow"` as the allow-everything shorthand and do not show `"*": "allow"` literally. We use the explicit object `{"*":"allow","external_directory":"allow","doom_loop":"allow"}` so the two non-default-covered keys are named.

### Claude Code `skipDangerousModePermissionPrompt`
Source: https://code.claude.com/docs/en/settings-reference.md (settings index, fetched 2026-10-24): "Skip the confirmation dialog before bypassPermissions mode", category Permission settings, scope "User, local, or managed". Per https://code.claude.com/docs/en/settings.md, `--settings <json>` is applied above user and project files and can set any key a user settings file can, so passing it inline through `--settings` is valid. `claude --help` lists `--permission-mode`, `--effort`, `--model`, `--settings` and `--dangerously-skip-permissions` (the fallback if the key were absent). The detailed entry (type, default) was beyond the truncated part of the page and was not read. The release row `happy-claude-code` confirmed it (verified by the release matrix 2026-10-31): with `skipDangerousModePermissionPrompt` passed through `--settings`, Claude Code showed no bypass-permissions dialog.

### Codex directory trust
`codex --help` (0.164.0) has no trust flag; it documents `-c key=value` as a TOML override of `~/.codex/config.toml`.
The config reference (https://learn.chatgpt.com/docs/config-file/config-reference, fetched 2026-10-24) documents
`projects.<path>.trust_level` = `"trusted"` | `"untrusted"`: "Mark a project or worktree as trusted or untrusted". The
TUI's onboarding shows a directory-trust prompt for a project without a trust level (codex-rs/tui/src/lib.rs,
`check_directory_trust`, read 2026-10-24). Two source facts shape the override:
- The trust target of a git worktree is the main checkout: `resolve_root_git_project_for_trust` (codex-rs/git-utils/src/trust.rs)
  "resolves to the root of the main repository. Handles worktrees". So `<root>` is the key that matters; the worktree is
  added as well in case the resolution fails.
- `-c` paths are split with a plain `path.split('.')` (codex-rs/config/src/overrides.rs, `apply_toml_override`), so
  `-c 'projects."<path>".trust_level=…'` breaks on any dot in the path (`.worktrees`). The adapter passes the whole
  table instead, `-c 'projects={"<root>"={trust_level="trusted"},…}'`; the CLI layer is merged into the loaded config
  (`merge_toml_values`), so the user's other project entries stay. Not yet seen in a release run.
- The table also holds the realpath of `<root>` and of the worktree when it differs from the given path (`/tmp` is
  `/private/tmp` on macOS), so a trust lookup by either spelling matches.

### Push deny rules (spec §12.9)
No agent pushes; the vendors' own rules say so in both autonomy modes:
- Claude Code: `"permissions": {"deny": ["Bash(git push:*)"]}` in the `--settings` JSON, in both modes. That the rule
  holds under `bypassPermissions` is not yet seen in a release run.
- OpenCode: `"bash": {"*": "allow", "git push*": "deny"}` inside `permission` when autonomous, `{"*": "ask", "git push*": "deny"}`
  when not. Per https://opencode.ai/docs/permissions (fetched 2026-10-24) `*` "matches zero or more of any character",
  so `git push*` covers a bare `git push` as well as `git push <args>` (the docs' own example, `"git push *"`, misses
  the bare form), and "the last matching rule" wins, so the catch-all comes first.
- Codex and omp have no per-command deny rule on the command line; Codex workers cannot write the repository's git dir
  at all (see the sandbox scope below).
