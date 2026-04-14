# Contributing

## Prerequisites

- **Node >= 22.5** -- the runtime uses `node:sqlite` (built-in since 22.5) for the job store
- **bun** -- used for building, testing, and the dev workflow (not required at runtime for installed plugins)

## Workflow

1. Edit source files under `runtime/**/*.ts`
2. Run `bun run check`

`bun run check` rebuilds `dist/`, runs `tsc --noEmit`, executes the full test suite, then runs `git diff --exit-code -- dist/` as a drift gate. If the rebuild produced unstaged changes in `dist/`, the check fails -- stage the rebuilt files and retry.

### Why `dist/` is committed

Installed plugins run as plain JavaScript with no build step. `dist/` is the precompiled output of `runtime/` and is committed so that users who install via the marketplace or a local clone never need `bun` or `tsc`. The drift gate in `bun run check` catches forgotten rebuilds before they ship.

### Individual commands

- `bun run build` -- recompile `runtime/**/*.ts` to `dist/**/*.js`
- `bun test <path>` -- run a single test file

## Live integration test

The test suite includes a real-kimi smoke test that talks to an actual Kimi CLI:

```bash
KIMI_PLUGIN_CC_LIVE_TEST=1 bun test tests/wire/live-kimi.integration.test.ts
```

This requires a local `kimi` CLI install with valid authentication. It is skipped by default in `bun run check`.

## Platform support

No Windows support currently. Build and launch scripts (`scripts/companion.sh`, `scripts/review-gate-hook.sh`) use POSIX shell.
