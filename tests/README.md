# tests

Test suite for `kimi-plugin-cc`. Runs via `bun run check` (build + typecheck + test + drift gate) or `bun test <path>` for a single file.

Coverage highlights:

- `runtime/stream-json.test.ts` — pure parser tests for kimi-code's `--output-format stream-json` records (assistant content + tool calls, tool results, the 0.8.0 role-less `goal.summary` record on its out-of-band channel, malformed lines)
- `runtime/cli-client.test.ts` — subprocess wrapper: abort handling, SIGTERM → SIGKILL escalation, log drain, stderr tail, pre-aborted signal
- `runtime/cli-cancellation.test.ts` — AbortController-based signal handler used by long-running commands
- `runtime/approval-policy.test.ts` — pure hook decision function (per-command allow/deny posture)
- `runtime/approval-hook-subprocess.test.ts` — end-to-end subprocess test for `approval-hook.js`: exit-2 + stderr for deny, exit 0 for allow, fail-closed on malformed stdin
- `runtime/hook-install.test.ts` — verifier that detects the managed block in `~/.kimi-code/config.toml`
- `runtime/rescue-approval.test.ts` — file-edit policy and shell allowlist table (accept + reject paths)
- `runtime/rescue-command.test.ts` — rescue lifecycle: foreground, background, resume, cancellation, hook-not-installed refusal
- `runtime/pursue.test.ts` — `/kimi:pursue` (autonomous goal mode) pure logic: arg parsing, `--budget` duration parsing, `/goal` prompt construction, terminal exit-code classification (0/3/6 → complete/blocked/paused)
- `runtime/swarm.test.ts` — `/kimi:swarm` (read-only parallel fan-out) pure logic: arg parsing (`--budget`/`--cap`), AgentSwarm coordination-prompt construction, read-only-with-cap clauses. The `swarm` hook-label allow/deny matrix (read-only + `AgentSwarm` allowed, writes + singular `Agent` denied) lives in `runtime/approval-policy.test.ts`
- `runtime/read-only-commands.test.ts` — end-to-end ask/review/challenge flows against the v1 mock (review output is prose pass-through as of v0.2.3)
- `runtime/review-gate-hook.test.ts` — Stop hook end-to-end including disabled/enabled/malformed/timeout paths
- `runtime/replay-command.test.ts` — replay reproducing stored outputs and handling missing/malformed logs (v1.0 stream-json log format)
- `runtime/setup.test.ts` — managed-block installer lifecycle: install/check/uninstall, orphan detection, probe behavior
- `runtime/companion-unavailable.test.ts` — graceful degradation when `kimi` is missing from `PATH`
- `runtime/job-commands.test.ts` — status/result persistence across command types
- `runtime/real-binary-smoke.test.ts` — **opt-in** (`KIMI_PLUGIN_CC_SMOKE=1`, needs a real kimi binary + authed home; skipped by default). Spawns the real `kimi -p` and proves end-to-end that (a) read-only commands' forced writes are hook-denied, (b) autonomous goal mode is hook-gated on *every* continuation turn (zero files land across a full-budget multi-turn run), and (c) a spawned **swarm subagent's** forced write is hook-denied under the `swarm` label (needs kimi >= 0.12.0 for the AgentSwarm tool)

Helpers under `helpers/`:

- `mock-kimi-cli-v1.ts` — emits `kimi -p --output-format stream-json` records for the cli-client path
- `mock-kimi-stream.ts` — lower-level NDJSON emitter for the stream-json parser tests
- `sigterm-trap.ts` — child process that traps SIGTERM with an optional self-exit so SIGKILL escalation paths can be exercised deterministically
- `test-env.ts` — repo-fixture + temp plugin-data helpers
