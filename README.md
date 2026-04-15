# kimi-plugin-cc

A Claude Code plugin that delegates read-only review, free-form ask, and write-capable rescue work to a locally installed Kimi CLI. Includes an opt-in stop-time review gate.

## Status

Feature-complete against `docs/implementation-plan.md` through phase 3b. The plugin ships:

- `/kimi:setup` — verify local Kimi + manage review-gate state
- `/kimi:ask` — free-form read-only Q&A (fresh by default, `-r` to continue)
- `/kimi:review` — structured read-only code review of a working-tree or branch diff
- `/kimi:adversarial-review` — adversarial read-only review with free-form focus
- `/kimi:rescue` — write-capable delegation with session persistence and resume
- `/kimi:status` / `/kimi:result` / `/kimi:cancel` — job lifecycle commands
- `kimi-rescue` subagent — proactive delegation trigger
- `kimi-review` skill — proactive second-opinion review trigger
- Opt-in `Stop` hook review gate (disabled by default; enable via `/kimi:setup --enable-review-gate`)

## How it works

The plugin mirrors the thin-plugin-rich-runtime split of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc):

- **Claude plugin layer** — thin slash commands, agent, skill, hook, and manifest
- **Local runtime layer** — Node runtime (see ADR 003) compiled from TypeScript sources under `runtime/` to ESM JavaScript under `dist/`. The runtime owns Kimi Wire sessions, SQLite job state, rescue approval policy, replay tooling, and cancellation. `dist/` is committed so installed plugins have no build step.

Flow: `slash command → scripts/companion.sh → node dist/companion.js → Kimi Wire session → SQLite job store → rendered artifact`.

Kimi Wire is the primary transport. Wire is labeled experimental in Kimi's docs; the runtime re-verifies Wire shape at every phase boundary.

## Prerequisites

- `kimi` CLI available on `PATH` (`kimi --version` should work). Alternatively, point the runtime at a custom binary via `KIMI_PLUGIN_CC_KIMI_BIN=/absolute/path/to/kimi`.
- `node` >= 22.5 on `PATH`. `node:sqlite` is a built-in starting in Node 22.5, and kimi-plugin-cc uses it for the SQLite job store. Older versions will fail at first query. If node lives outside `PATH`, set `KIMI_PLUGIN_CC_NODE_BIN=/absolute/path/to/node` — both the slash-command launcher and the Stop hook honor this.
- `bun` is only required for contributor tooling (`bun run check`, `bun test`). Installed plugins do not need `bun` at runtime.

## Install

Two supported paths.

### Option A — via the marketplace (recommended)

In a Claude Code session:

```
/plugin marketplace add linxule/kimi-plugin-cc
/plugin install kimi@kimi-marketplace
/kimi:setup
```

If the repo is private, `gh auth login` must be set up (Claude Code shells out to `gh` for private clones).

### Option B — from a local clone (fastest for development)

```bash
git clone https://github.com/linxule/kimi-plugin-cc ~/kimi-plugin-cc
cd ~/kimi-plugin-cc && bun install   # only needed for contributor tooling; the installed runtime uses committed dist/ plus built-ins and vendored code
claude --plugin-dir ~/kimi-plugin-cc
```

Then inside Claude Code: `/kimi:setup`.

### After install

Run `/kimi:setup` to verify the local `kimi` CLI is reachable and authenticated. Use `/kimi:ask -r` to continue the latest ask conversation in the current repo. Optional: `/kimi:setup --enable-review-gate` to turn on the stop-time review gate (disabled by default).

## Architecture and non-negotiables

See [CLAUDE.md](./CLAUDE.md) for the locked architectural decisions. The canonical spec lives in [docs/spec.md](./docs/spec.md); ADRs in [docs/adr](./docs/adr).

## Documentation

- [docs/spec.md](./docs/spec.md) — canonical product and technical spec
- [docs/adr/001-wire-first-transport.md](./docs/adr/001-wire-first-transport.md) — why Wire is the primary transport
- [docs/adr/002-plugin-runtime-shape.md](./docs/adr/002-plugin-runtime-shape.md) — why the runtime mirrors the Codex plugin split
- [docs/adr/003-node-tsx-companion-runtime.md](./docs/adr/003-node-tsx-companion-runtime.md) — why the companion runs on Node+tsx instead of Bun
- [docs/implementation-plan.md](./docs/implementation-plan.md) — phased implementation plan
- [docs/test-plan.md](./docs/test-plan.md) — acceptance and failure-mode coverage
- [docs/review/checklist.md](./docs/review/checklist.md) — review checklist
- [docs/references.md](./docs/references.md) — primary source links

## Development

- `bun run check` — rebuild `dist/`, typecheck, run the full test suite, then fail if the rebuild produced any uncommitted changes in `dist/` (the drift gate)
- `bun run build` — recompile `runtime/**/*.ts` → `dist/**/*.js` via `tsc -p tsconfig.build.json`
- `bun test <path>` — run a single test file

Test helpers (mock Wire server, mock Kimi CLI) live under `tests/helpers`. The real-kimi smoke test in `tests/wire/live-kimi.integration.test.ts` is gated on `KIMI_PLUGIN_CC_LIVE_TEST` and only runs against an actual `kimi` CLI install.
