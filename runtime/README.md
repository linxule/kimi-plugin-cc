# runtime

Local runtime implementation for `kimi-plugin-cc`. v1.0 ships against the kimi-code Node.js rewrite (`kimi -p --output-format stream-json`); the v0.4 Wire transport is preserved on the `v0.4-maintenance` branch.

Command surface exposed via `companion.ts`:

- `setup` — write the managed PreToolUse hook block to `~/.kimi-code/config.toml`, probe the installed hook, and manage the review-gate config. Subcommands: `--check`, `--uninstall`, `--enable-review-gate`, `--disable-review-gate`.
- `review` / `task challenge` — read-only reviews; Kimi output is pass-through markdown prose (no schema parsing as of v0.2.3)
- `ask` — read-only free-form Q&A (fresh session per call by default; `--resume` to continue)
- `task rescue` — write-capable delegated task channel with workspace-bound allowlist; refuses to run if the PreToolUse hook is not installed
- `status` / `result` / `cancel` — SQLite-backed job lifecycle commands
- `replay <job-id>` — re-render a stored stream-json log into the same artifact the live runtime emits

Core modules:

- `companion.ts` — stable subcommand dispatcher invoked via `scripts/companion.sh`
- `cli-client.ts` — subprocess wrapper around `kimi -p --output-format stream-json` with AbortController-driven cancellation, SIGTERM → SIGKILL escalation, rolling stderr tail, and an optional NDJSON diagnostics log
- `stream-json.ts` — pure parser for the OpenAI-shaped NDJSON kimi emits; produces `assistant` / `tool` records and surfaces malformed lines as diagnostics
- `cli-cancellation.ts` — AbortController-based cancellation handler used by the long-running commands (replaces the v0.4 wire-client cancellation pattern)
- `kimi-command.ts` — `KIMI_PLUGIN_CC_KIMI_BIN` + `KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS` resolver
- `kimi-errors.ts` — unified classification for Kimi-unavailable failures across all managed commands
- `kimi-timeouts.ts` — per-command response budgets (ASK / REVIEW / REVIEW_GATE)
- `hooks/approval-policy.ts` — pure decision function for the PreToolUse hook (per-command allow/deny posture)
- `hooks/approval-hook.ts` — entry script (`dist/hooks/approval-hook.js`) installed in `~/.kimi-code/config.toml`
- `hooks/install.ts` — verifier that confirms the managed block is present in `~/.kimi-code/config.toml`
- `rescue-approval.ts` — workspace-bound allowlist (file-edit symlink and containment checks, shell command allowlist, find/sed/ruff/package-manager tightening). Called by the hook via `evaluateRescueHookRequest`.
- `job-store.ts` — SQLite job state in WAL mode with `busy_timeout`, terminal-state enforcement, and a partial unique index preventing concurrent rescue resume on the same session id
- `jobs.ts` — job lifecycle helpers, stale-worker sweep, `waitForTerminalJob`
- `render.ts` — `renderManagedJobOutput` used by both live command handlers and replay so both paths reproduce the same artifact

Behavior notes:

- Read-only commands (review/challenge/review_gate/ask) are enforced by the PreToolUse hook — kimi-code's `-p` mode auto-approves every tool call without it. The hook is installed by `/kimi:setup`.
- Rescue refuses to run when the hook is not installed (REFUSE_HOOK_NOT_INSTALLED). Bypass with `KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1` is reserved for tests and setup probes.
- Long-running commands (ask, review, challenge, rescue) wrap their subprocess in `runCliPromptWithBudget` so cancellation aborts the kimi child; SIGKILL escalation matches v0.4's 1500ms default.
- The Stop hook is disabled by default and reads `reviewGateEnabled` from plugin config; enable via `/kimi:setup --enable-review-gate`.
- `review`/`challenge`/`ask`/`rescue` are prose pass-through — Kimi's raw final output is stored verbatim and rendered as-is; only empty output is a hard failure. `review_gate` is the lone command that still parses Kimi output (JSON allow/block decision) and is warn-allow on parse failure.
- Stream-json output and diagnostic events are logged to `${CLAUDE_PLUGIN_DATA}/kimi-plugin-cc/logs/<command>-<job-id>.jsonl` for replay and debugging.
- The companion runs on Node from precompiled `dist/companion.js` in production; `tsx` is used only in development. Bun is the package manager and test runner (ADR 003).

Subdirectories:

- `schemas/` — structured output contract for `review_gate` only (review/challenge dropped their schema in v0.2.3; rescue and ask are pass-through prose)
- `hooks/` — PreToolUse approval hook + review-gate Stop hook
- `commands/` — one file per companion subcommand
- `dev-data/` — repo-local stand-in for `${CLAUDE_PLUGIN_DATA}` during development (gitignored)
