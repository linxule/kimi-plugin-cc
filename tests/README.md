# tests

Test suite for `kimi-plugin-cc`. Runs via `bun run check` (typecheck + test) or `bun test <path>` for a single file.

Coverage:

- `wire/event-buffer.test.ts` — turn capture state machine, including the buffer-after-last-ToolResult rule and MISSING_TURN_END / TURN_INTERRUPTED failure modes
- `wire/approval-dispatcher.test.ts` — inbound ApprovalRequest dispatch and rejection semantics
- `wire/interrupted-turn.test.ts` — fail-closed approval handling during cancellation, plus partial-turn behavior
- `wire/live-kimi.integration.test.ts` — env-gated smoke test against a real `kimi --wire` install (skipped unless `KIMI_PLUGIN_CC_LIVE_TEST` is set)
- `runtime/parsing.test.ts` — argument parsing for ask, review, rescue, and job-lookup commands
- `runtime/read-only-commands.test.ts` — end-to-end ask/review flows against the mock Wire server (review output is prose pass-through as of v0.2.3)
- `runtime/rescue-approval.test.ts` — file-edit policy and the shell allowlist table (accept + reject paths)
- `runtime/rescue-command.test.ts` — rescue lifecycle: foreground, background, resume, cancellation edge cases
- `runtime/replay-command.test.ts` — replay reproducing stored outputs and handling missing/malformed logs
- `runtime/review-gate-hook.test.ts` — Stop hook end-to-end including disabled/enabled/malformed/timeout paths
- `runtime/companion-unavailable.test.ts` — graceful degradation when `kimi` is missing from `PATH`
- `runtime/job-commands.test.ts` — status/result persistence across command types

Helpers under `helpers/` provide a mock Kimi Wire server and a mock `kimi` CLI binary for the Bun test environment.
