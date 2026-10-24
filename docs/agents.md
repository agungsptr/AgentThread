# Agents

## Verified CLI facts (from `--help` on 2026-10-24)

| Agent | Herdr kind | bin | model | effort | autonomous | first prompt | instruction file |
|---|---|---|---|---|---|---|---|
| Claude Code 2.1.296 | `claude` | `claude` | `--model <m>` | `--effort <low\|medium\|high\|xhigh\|max>` | `--permission-mode bypassPermissions` + `--settings` JSON with `"skipDangerousModePermissionPrompt": true` | positional | `CLAUDE.md` (symlink to `AGENTS.md`) |
| OpenCode 2.0.27 | `opencode` | `opencode` | env `OPENCODE_CONFIG_CONTENT` = `{"model":"<provider/model>"}` (the TUI has no `--model`) | variant suffix in the same value: `<provider/model>#<effort>` | `--auto` + `"permission"` in `OPENCODE_CONFIG_CONTENT` | `--prompt <text>` | `AGENTS.md` |
| Codex 0.164.0 | `codex` | `codex` | `-m <m>` | `-c model_reasoning_effort="<minimal\|low\|medium\|high\|xhigh>"` | `-s workspace-write -a never -c sandbox_workspace_write.network_access=true --add-dir <git common dir> --add-dir <root>/.agentthread --search` | positional | `AGENTS.md` |
| omp 18.12.6 | `omp` | `omp` (standalone binary in `~/.local/bin`; the npm build needs a newer Bun) | `--model <m>` | `--thinking <off\|minimal\|low\|medium\|high\|xhigh\|max\|auto>` | `--approval-mode yolo` | positional | `AGENTS.md` |

Codex needs `--add-dir <git common dir>` because commits from a worktree write to the main repository's `.git`, which lies outside the workspace-write sandbox.

## Verification notes

### OpenCode permission keys
Source: https://opencode.ai/docs/permissions (fetched 2026-10-24). The docs confirm all three keys we use:
- `*` is the global wildcard ("globally (with `*`), and override specific tools"), e.g. `"*": "ask"`.
- `external_directory`: triggered when a tool touches paths outside the project working directory; default `ask`.
- `doom_loop`: triggered when the same tool call repeats 3 times with identical input; default `ask`.

The docs show `"permission": "allow"` as the allow-everything shorthand and do not show `"*": "allow"` literally. We use the explicit object `{"*":"allow","external_directory":"allow","doom_loop":"allow"}` so the two non-default-covered keys are named.

### Claude Code `skipDangerousModePermissionPrompt`
Source: https://code.claude.com/docs/en/settings-reference.md (settings index, fetched 2026-10-24): "Skip the confirmation dialog before bypassPermissions mode", category Permission settings, scope "User, local, or managed". Per https://code.claude.com/docs/en/settings.md, `--settings <json>` is applied above user and project files and can set any key a user settings file can, so passing it inline through `--settings` is valid. `claude --help` lists `--permission-mode`, `--effort`, `--model`, `--settings` and `--dangerously-skip-permissions` (the fallback if the key were absent). The detailed entry (type, default) was beyond the truncated part of the page and was not read.
