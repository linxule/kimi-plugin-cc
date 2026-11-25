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

`audit/v2-tag-scan.test.ts` checks the source assumptions behind native-v2 enforcement. It requires an exact upstream source tree through `KIMI_CODE_SOURCE_TAG_DIR`; it is skipped without that input. When the variable points at the top level of an upstream git clone, the suite also reads every certified row's release tag through `git show`, without a checkout, and checks the upstream facts each 3.0.0 relaxation rests on; a row whose tag is missing from the clone fails.

`runtime/real-binary-smoke.test.ts` runs through `bun run smoke:real`. It checks real hook denials, goal continuation, native-v2 preflight and resume, swarm child enforcement, and write-swarm patch capture. Exact 2.6.2/2.6.3/2.7.2/2.7.3 adds bounded-wave and direct single-worker controls. Exact 2.6.0 retains its narrowed production profile: swarm execution lanes are excluded and both commands must prove `v2-swarm-not-certified` before model spawn. Before any model turn it removes every other kimi-plugin-cc hook block from its isolated copy of the config, so its allows and denials come from this checkout's hook alone. `KIMI_PLUGIN_CC_SMOKE_INSTALL=1` adds the opt-in install lane, which runs the built companion's `setup --install-kimi` against npm into the smoke's own data root; run `bun run build` first. Read [CI and live smoke](../docs/ci.md) before running it: the harness can copy credential-bearing seed files even when API authentication is available. Use an empty seed home for environment-model authentication. Live runs need authorized authentication and run sequentially. A skipped lane is not a passing certification result.

`runtime/swarm-bounded-real.test.ts` exercises stock 2.6.2/2.6.3/2.7.2/2.7.3 with a local scripted provider, including retries, nesting, cancellation, wave admission and single-worker execution. It is opt-in and uses isolated homes, the canonical compiled hook and the real command paths; it requires no provider credentials.

## Test isolation

`bunfig.toml` preloads `helpers/preload.ts`, which removes inherited host plugin paths and per-spawn overlays before each test file. Keep this guard: a host can export another plugin's live data directory. Tests that need plugin paths must set their own temporary directories.

Helpers include `mock-kimi-cli-v1.ts` for mock CLI output, `mock-kimi-stream.ts` for parser inputs, `sigterm-trap.ts` for cancellation, and `test-env.ts` for repository fixtures and temporary data roots.
