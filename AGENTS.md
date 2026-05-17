# AGENTS.md

Project context for coding agents working in this repository.

## Quick reference

- **Version**: 0.3.1 (tagged `v0.3.1`)
- **Toolchain**: Node >= 22.5, TypeScript, **bun** (not npm/yarn)
- **Workflow**: edit `runtime/**/*.ts` → `bun run check` (build + typecheck + test + drift gate)

## Directory layout

```
.claude-plugin/     Plugin manifest (plugin.json, marketplace.json)
commands/           Slash command markdown — thin wrappers over companion.sh
agents/             Claude Code subagent definitions (kimi-rescue, kimi-review, kimi-challenge, kimi-ask)
hooks/              Stop hook for the review gate
scripts/            Shell entry points (companion.sh, review-gate-hook.sh)
runtime/            TypeScript source — the real runtime
  ├── background-spawn.ts  Shared detached-worker spawn helper (rescue + ask)
  ├── wire/         Wire client (JSON-RPC over stdio) + turn capture
  ├── commands/     One file per companion subcommand
  ├── agents/       Kimi agent profiles (YAML)
  ├── prompts/      System prompts per command type
  ├── schemas/      Structured output contract for review_gate (review/challenge dropped theirs in v0.2.3)
  └── hooks/        Stop hook entry point
dist/               Compiled JS — committed for zero-build install
tests/              bun test suite (146 tests / 22 files)
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
- Review/challenge/ask/rescue are all prose pass-through (review/challenge dropped their JSON schemas in v0.2.3). Review gate is the only command that still parses Kimi output (JSON allow/block).
- Review gate is a Stop hook, disabled by default, fail-open on malformed output.

## When editing

- Read the code before changing it — the runtime has specific invariants that aren't obvious from file names
- Run `bun run check` before considering any change done
- `dist/` is committed intentionally (zero-build install). The drift gate catches forgotten rebuilds.
- Agent files register at session start. Adding or editing `agents/*.md` mid-session doesn't activate them until Claude Code reloads — reach for slash commands or direct `companion.sh` in the same session.
- `.claude/` is gitignored — notes, worktrees, internal docs under it stay local. Don't try to commit them.

## Releasing

Version bump touches 5 files — update all before tagging:

- `runtime/version.ts` (`KIMI_PLUGIN_CC_VERSION` — sent on the Wire handshake)
- `package.json`
- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `AGENTS.md` (the "Version" line above)

Then `bun run check`, commit, `git tag -a vX.Y.Z -m "..."`, `git push` + `git push origin vX.Y.Z`, then `gh release create`.
