# runtime

Local runtime implementation for `kimi-plugin-cc`. Feature-complete through phase 3b.

Command surface exposed via `companion.ts`:

- `setup` — verify `kimi --wire` round-trip and manage review-gate config
- `review` / `task challenge` — read-only reviews with fixed JSON schemas
- `ask` — read-only free-form Q&A (fresh session per call)
- `task rescue` — write-capable delegated task channel with a companion-side approval allowlist and resumable Kimi sessions; output is pass-through prose (no schema)
- `status` / `result` / `cancel` — SQLite-backed job lifecycle commands
- `replay <job-id>` — re-render a stored Wire event log through the same buffer-after-last-ToolResult path the live runtime uses

Core modules:

- `companion.ts` — stable subcommand dispatcher invoked via `scripts/companion.sh`
- `wire/client.ts` — stdio JSON-RPC Wire client with serialized stdout handling and `close`-based exit semantics
- `wire/turn-capture.ts` — shared turn state machine used by both live buffering and replay
- `wire/event-buffer.ts` — thin class wrapper around `turn-capture.ts` for the live path
- `wire/approval-dispatcher.ts` — policy hook for inbound `ApprovalRequest`s
- `job-store.ts` — SQLite job state in WAL mode with `busy_timeout`, terminal-state enforcement, and a partial unique index preventing concurrent rescue resume on the same session id
- `jobs.ts` — job lifecycle helpers, stale-worker sweep, `waitForTerminalJob`
- `kimi-launch.ts` — builds `WireClient` instances with the right `--session` and `--agent-file` flags
- `kimi-errors.ts` — unified classification for Kimi-unavailable failures across all managed commands
- `kimi-timeouts.ts` — shared timeout constants and `withTimeout` helper
- `rescue-approval.ts` — the rescue approval policy: file-edit symlink and workspace containment checks, shell command allowlist, find/sed/ruff/package-manager tightening
- `render.ts` — `renderManagedJobOutput` used by both live command handlers and replay so both paths reproduce the same artifact

Behavior notes:

- Every managed command uses client-assigned session UUIDs that are persisted to the SQLite job record before the Wire connection opens
- `start()`, `initialize()`, and (for ask/review) `prompt()` are wrapped in `withTimeout` so a Kimi that starts but never becomes usable surfaces a clean timeout instead of hanging forever
- Rescue session resume is guarded by a partial unique index; two concurrent `/kimi:rescue --resume` calls against the same session id cannot both enter the running state
- The Stop hook is disabled by default and reads `reviewGateEnabled` from plugin config; enable via `/kimi:setup --enable-review-gate`
- Parse failure is a hard failure for `review`/`challenge` and a warn-allow for `review_gate`; `rescue` has no schema to parse against — Kimi's raw final output is stored verbatim and rendered as-is
- Raw Wire traffic is logged to `${CLAUDE_PLUGIN_DATA}/kimi-plugin-cc/logs/<command>-<job-id>.jsonl` for replay and debugging
- The companion runs on Node from precompiled `dist/companion.js` in production; `tsx` is used only in development. Bun is the package manager and test runner (ADR 003)

Subdirectories:

- `agents/` — Kimi agent profiles (read-only: review, ask, review-gate; write-capable: rescue)
- `prompts/` — system prompts per command type
- `schemas/` — structured output contracts (review, review-gate); rescue is pass-through prose and has no schema
- `hooks/` — Stop hook entry point for the review gate
- `commands/` — one file per companion subcommand
- `wire/` — Wire client + turn capture
- `dev-data/` — repo-local stand-in for `${CLAUDE_PLUGIN_DATA}` during development (gitignored)
