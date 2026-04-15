# kimi-plugin-cc

A Claude Code plugin that delegates read-only review, free-form ask, and write-capable rescue work to a locally installed Kimi CLI. Includes an opt-in stop-time review gate.

## Status

Feature-complete against `docs/implementation-plan.md` through phase 3b. The plugin ships:

- `/kimi:setup` — verify local Kimi + manage review-gate state
- `/kimi:ask` — free-form read-only Q&A (fresh session per invocation)
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
- **Local runtime layer** — Node+tsx companion (see ADR 003) that owns Kimi Wire sessions, SQLite job state, rescue approval policy, replay tooling, and cancellation

Flow: `slash command → scripts/companion.sh → runtime/companion.ts → Kimi Wire session → SQLite job store → rendered artifact`.

Kimi Wire is the primary transport. Wire is labeled experimental in Kimi's docs; the runtime re-verifies Wire shape at every phase boundary.

## Prerequisites

- `kimi` CLI available on `PATH` (`kimi --version` should work)
- `bun` for package management and the test suite
- `node` >= 18.18 for the companion runtime

## Install locally

1. Clone the repo somewhere convenient.
2. `bun install` inside the clone — this installs `tsx`, `better-sqlite3`, and the other dependencies the companion resolves at runtime.
3. Point Claude Code at the clone as a local plugin (see Claude Code plugin install docs for the exact mechanism).
4. In a Claude Code session, run `/kimi:setup` to verify `kimi` is reachable and authenticated.
5. Optional: `/kimi:setup --enable-review-gate` to turn on stop-time review.

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

- `bun run check` — typecheck + test suite
- `bun test <path>` — run a single test file

Test helpers (mock Wire server, mock Kimi CLI) live under `tests/helpers`. The real-kimi smoke test in `tests/wire/live-kimi.integration.test.ts` is gated on `KIMI_PLUGIN_CC_LIVE_TEST` and only runs against an actual `kimi` CLI install.
