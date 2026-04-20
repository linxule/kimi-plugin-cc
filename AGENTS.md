# AGENTS.md

Project context for coding agents working in this repository.

## Quick reference

- **Version**: 0.1.9 (tagged `v0.1.9`)
- **Toolchain**: Node >= 22.5, TypeScript, **bun** (not npm/yarn)
- **Workflow**: edit `runtime/**/*.ts` → `bun run check` (build + typecheck + test + drift gate)

## Directory layout

```
.claude-plugin/     Plugin manifest (plugin.json, marketplace.json)
commands/           Slash command markdown — thin wrappers over companion.sh
agents/             Claude Code subagent definitions (kimi-rescue)
hooks/              Stop hook for the review gate
scripts/            Shell entry points (companion.sh, review-gate-hook.sh)
runtime/            TypeScript source — the real runtime
  ├── wire/         Wire client (JSON-RPC over stdio) + turn capture
  ├── commands/     One file per companion subcommand
  ├── agents/       Kimi agent profiles (YAML)
  ├── prompts/      System prompts per command type
  ├── schemas/      Structured output contracts (review, review-gate)
  └── hooks/        Stop hook entry point
dist/               Compiled JS — committed for zero-build install
tests/              bun test suite (132 tests / 20 files)
```

## Commands

- `bun run check` — rebuild `dist/`, typecheck, run full test suite, then drift gate (`git diff --exit-code -- dist`). If dist has unstaged changes, check fails — stage them and retry.
- `bun test <path>` — run a single test file
- `bun run build` — compile `runtime/**/*.ts` → `dist/**/*.js`

The companion runs via `scripts/companion.sh <subcommand>`, which resolves `node` and runs `dist/companion.js`. Subcommands: `setup`, `review`, `task`, `status`, `result`, `cancel`, `replay`.

## Architecture

**Thin plugin, rich runtime** — mirrors [codex-plugin-cc](https://github.com/openai/codex-plugin-cc):

- Plugin layer (commands/, agents/, hooks/) handles routing only
- Runtime layer (runtime/, scripts/) owns Wire sessions, SQLite job store, approval policy, and rendering
- Flow: `slash command → companion.sh → companion.js → kimi --wire → job store → artifact`

**Key invariants:**

- Wire-first. One `kimi --wire` process per job. Client-assigned session UUIDs.
- Read-only commands (review, challenge, ask, review_gate) enforced by agent-file `exclude_tools`, not prompts.
- Rescue is the only write-capable profile. Shell access bounded by allowlist in `runtime/rescue-approval.ts`.
- Rescue cannot mutate git state. The main Claude thread owns branch/commit.
- Jobs in SQLite are the source of truth. Terminal states are permanent.
- Review/challenge emit structured JSON. Ask/rescue are prose pass-through.
- Review gate is a Stop hook, disabled by default, fail-open on malformed output.

## When editing

- Read the code before changing it — the runtime has specific invariants that aren't obvious from file names
- Run `bun run check` before considering any change done
- `dist/` is committed intentionally (zero-build install). The drift gate catches forgotten rebuilds.
