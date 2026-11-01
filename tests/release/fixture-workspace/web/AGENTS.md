# web conventions

- One function per file `src/<name>.ts`, re-exported from `src/index.ts`.
- Every function has unit tests in `tests/<name>.test.ts`, using `bun:test`. Run them with `bun test`.
- `bun run typecheck` must pass. Do not add dependencies.
- web is a separate repo from api; share code by copying the small function, never by importing across repos.
