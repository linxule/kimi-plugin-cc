# ADR 003: Run the companion on Node with `tsx`

- Status: accepted
- Date: 2026-04-15

## Decision

`kimi-plugin-cc` keeps **Bun** as the package manager and test runner, but the **companion runtime** executes on **Node.js** via `tsx`.

## Context

The companion runtime has to maintain a reliable stdio JSON-RPC connection to `kimi --wire`. During phase 1a, direct `python3` subprocess probes against `kimi --wire` returned the expected `initialize` response immediately, while equivalent Bun-launched probes timed out without delivering any stdout data to the caller. A second fallback attempt using `bun build` plus `bun <compiled.js>` also failed in this repo, surfacing a broken bundled `node:fs/promises` import (`mkdir is not a function`), so keeping Bun on the hot path for the companion introduced an avoidable silent I/O risk.

## Consequences

- `package.json` keeps Bun-centric workflows (`bun add`, `bun test`, `bun run check`).
- In dev (tests run from source), the companion entrypoint is launched with `node --import tsx runtime/companion.ts`.
- Setup output should make it clear that the companion is running on Node, while still probing the user's local Kimi CLI.

## Follow-up (post-0.1.4 drop-in install prep)

Since the 0.1.4 drop-in install work, installed plugins launch the companion via `node dist/companion.js` — `runtime/**/*.ts` is precompiled to `dist/**/*.js` via `tsc -p tsconfig.build.json`, and `dist/` is committed so installed plugins have no build step. `tsx` is now dev-only (used by tests and manual source runs), not a runtime dependency. The ADR's core decision ("Node, not Bun, for the companion hot path") is unchanged; only the specific invocation path differs between dev (`node --import tsx runtime/companion.ts`) and production (`node dist/companion.js`). See `CLAUDE.md` §Commands for the current workflow.
