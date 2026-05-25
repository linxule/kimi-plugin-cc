# tests

Test suite for `kimi-plugin-cc`. Runs via `bun run check` (build + typecheck + test + drift gate) or `bun test <path>` for a single file.

Coverage highlights:

- `runtime/stream-json.test.ts` — pure parser tests for kimi-code's `--output-format stream-json` records (assistant content + tool calls, tool results, malformed lines)
- `runtime/cli-client.test.ts` — subprocess wrapper: abort handling, SIGTERM → SIGKILL escalation, log drain, stderr tail, pre-aborted signal
- `runtime/cli-cancellation.test.ts` — AbortController-based signal handler used by long-running commands
- `runtime/approval-policy.test.ts` — pure hook decision function (per-command allow/deny posture)
- `runtime/approval-hook-subprocess.test.ts` — end-to-end subprocess test for `approval-hook.js`: exit-2 + stderr for deny, exit 0 for allow, fail-closed on malformed stdin
- `runtime/hook-install.test.ts` — verifier that detects the managed block in `~/.kimi-code/config.toml`
- `runtime/rescue-approval.test.ts` — file-edit policy and shell allowlist table (accept + reject paths)
- `runtime/rescue-command.test.ts` — rescue lifecycle: foreground, background, resume, cancellation, hook-not-installed refusal
- `runtime/read-only-commands.test.ts` — end-to-end ask/review/challenge flows against the v1 mock (review output is prose pass-through as of v0.2.3)
- `runtime/review-gate-hook.test.ts` — Stop hook end-to-end including disabled/enabled/malformed/timeout paths
- `runtime/replay-command.test.ts` — replay reproducing stored outputs and handling missing/malformed logs (v1.0 stream-json log format)
- `runtime/setup.test.ts` — managed-block installer lifecycle: install/check/uninstall, orphan detection, probe behavior
- `runtime/companion-unavailable.test.ts` — graceful degradation when `kimi` is missing from `PATH`
- `runtime/job-commands.test.ts` — status/result persistence across command types

Helpers under `helpers/`:

- `mock-kimi-cli-v1.ts` — emits `kimi -p --output-format stream-json` records for the cli-client path
- `mock-kimi-stream.ts` — lower-level NDJSON emitter for the stream-json parser tests
- `sigterm-trap.ts` — child process that traps SIGTERM with an optional self-exit so SIGKILL escalation paths can be exercised deterministically
- `test-env.ts` — repo-fixture + temp plugin-data helpers
