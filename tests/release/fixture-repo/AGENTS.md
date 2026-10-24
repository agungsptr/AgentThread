# Project conventions

- Every function lives in its own file `src/<name>.ts` and is re-exported from `src/index.ts`.
- Every function has unit tests in `tests/<name>.test.ts`, using `bun:test`. Run them with `bun test`.
- Every function is listed in README.md under "## Functions", one line each, in the same style as the existing lines.
- Do not add dependencies.
