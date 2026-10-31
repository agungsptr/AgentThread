# agt guide and generated skill (Plan 9): rulings and follow-ups

Source: the SDD ledger for docs/superpowers/plans/2026-10-31-agt-guide-skill.md (branch feat/agt-guide-skill).

## Follow-ups
- Codex reads .agents/skills and ~/.codex/skills, not .claude/skills. Writing the skill to .agents/skills needs the same exclude, ownership and subdirectory-anchoring handling.
- Untested at runtime: whether OpenCode and omp load .claude/skills/agt/SKILL.md, and whether Claude Code loads both the root skill and a worktree skill (duplicate name) when the worktree is under <root>/.worktrees/.
- Repos that ran the pre-fix commit keep an old /.claude/skills/agt/ line in info/exclude, which hides sibling files of SKILL.md (the commit was unreleased, so unlikely).
- An untracked hand-written SKILL.md inside a single thread worktree is hidden by the shared worktree excludes, which are generated for all worktrees at once.

## Rulings
- Task 2: Ruling (plan defect): the mandated frontmatter description is quoted as a YAML double-quoted string (same text) — why: unquoted ': ' made the YAML invalid — cost if wrong: none.
- Task 2: fix round 1/5 (2 addressed — quoted frontmatter with a yaml parse test; async writer test; commit 7165ba5). Controller verified the frontmatter parses with the yaml package (name agt) directly — Ruling: 2-line fix verified by controller instead of a re-review dispatch — cost if wrong: caught by the final review.
- Ruling: one fix wave per final-fix-brief.md items 1–9 — why: "never surprise in git" bar — cost if wrong: none found.
- Final fix wave: re-review: items 1–9 ADDRESSED; the implementer's out-of-brief per-worktree hand-written-skill gate makes the shared worktree-excludes file flap — Ruling: revert that extension (scope restoration, not a second fix wave) — cost if wrong: an untracked hand-written SKILL.md inside one worktree stays hidden there.

## Deferred
- Task 1: minor (deferred): `guide nope` test passes without the feature (assert "unknown role"); outside-project fallback untested; main/worker "when things go wrong" untested; worker guide shows ticket reopen (verbatim USAGE); no RED run.
- Task 2: minor (deferred): exclude hides the whole /.claude/skills/agt/ dir; stale worktree exclude line for a tracked skill; writeAgentsFiles writes no skill when config is omitted; Codex reads .agents/skills, not .claude/skills (follow-up: also write there).
