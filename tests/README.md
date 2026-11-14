# Tests

Run `bun run check` for the full gate: build, generated-surface checks, typecheck, tests, and distribution drift checks. Use `bun test <path>` for a focused test file. See [contributing](../CONTRIBUTING.md) for the build and staging order.

The default suite uses local fixtures and mock subprocesses. Live provider calls are opt-in.

## Coverage

| Area | Main tests |
|---|---|
| Exact-version engine selection, capabilities, and provenance | `runtime/kimi-engine.test.ts`, `runtime/cli-client.test.ts` |
| Plan-mode config, experimental selectors, and resume journal checks | `runtime/native-v2-preflight.test.ts` |
| Hook policy, subprocess denials, installation, and detached workers | `runtime/approval-policy.test.ts`, `runtime/approval-hook-subprocess.test.ts`, `runtime/hook-install.test.ts`, `runtime/background-hook-enforcement.test.ts` |
| Write paths and shell allowlist | `runtime/rescue-approval.test.ts` |
| Setup and sanitized model inventory | `runtime/setup.test.ts`, `runtime/setup-command.test.ts`, `runtime/models.test.ts` |
| Generated Codex plugin | `runtime/codex-surfaces.test.ts` |
| Parsing, cancellation, and stored results | `runtime/stream-json.test.ts`, `runtime/cli-cancellation.test.ts`, `runtime/job-commands.test.ts`, `runtime/replay-command.test.ts` |
| Command and review-gate behavior | `runtime/read-only-commands.test.ts`, `runtime/rescue-command.test.ts`, `runtime/pursue.test.ts`, `runtime/swarm.test.ts`, `runtime/review-gate-hook.test.ts` |

`audit/v2-tag-scan.test.ts` checks the source assumptions behind native-v2 enforcement. It requires an exact upstream source tree through `KIMI_CODE_SOURCE_TAG_DIR`; it is skipped without that input.

`runtime/real-binary-smoke.test.ts` runs through `bun run smoke:real`. It checks real hook denials, goal continuation, native-v2 preflight and resume, swarm child enforcement, and write-swarm patch capture. On exact 2.6.0/2.6.2's narrowed production profile, the three swarm execution lanes are excluded; both production command paths must instead prove `v2-swarm-not-certified` before model spawn. Read [CI and live smoke](../docs/ci.md) before running it: the harness can copy credential-bearing seed files even when API authentication is available. It needs authorized test authentication, and runs must be sequential. A skipped lane is not a passing certification result.

## Test isolation

`bunfig.toml` preloads `helpers/preload.ts`, which removes inherited host plugin paths and per-spawn overlays before each test file. Keep this guard: a host can export another plugin's live data directory. Tests that need plugin paths must set their own temporary directories.

Helpers include `mock-kimi-cli-v1.ts` for mock CLI output, `mock-kimi-stream.ts` for parser inputs, `sigterm-trap.ts` for cancellation, and `test-env.ts` for repository fixtures and temporary data roots.
