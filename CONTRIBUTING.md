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

## Real-binary smoke test

The test suite includes opt-in real-binary smokes that spawn the actual `kimi -p` and prove read-only commands deny writes end-to-end (plus that autonomous goal mode is hook-gated on every continuation turn):

```bash
bun run smoke:real   # = KIMI_PLUGIN_CC_SMOKE=1 bun test tests/runtime/real-binary-smoke.test.ts
```

This requires a local kimi-code install with valid authentication (OAuth seeded from `~/.kimi-code`, or env-model `KIMI_MODEL_*` auth). The smokes are skipped by default in `bun run check`. To smoke against a specific kimi-code release without touching your install, see [docs/ci.md](./docs/ci.md).

## Platform support

No Windows support currently. Build and launch scripts (`scripts/companion.sh`, `scripts/review-gate-hook.sh`) use POSIX shell.
