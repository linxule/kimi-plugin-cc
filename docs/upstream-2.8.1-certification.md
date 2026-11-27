# Exact CLI 2.8.1 certification — plugin 3.1.3

## Scope and decision

**Status: certified for all seven operations.** Exact `@moonshot-ai/kimi-code@2.8.1` passed the mechanized tag scan (with `2.8.0` regression), exact-binary controls, deterministic stock-binary bounded-swarm suite, and real-provider operation smoke with `KIMI_PLUGIN_CC_SMOKE_INSTALL=1`. Certification does not update installed hosts or operator pins automatically.

Exact source commit: `62402f173c5a838a1c1f8fa263b637a22486fa39` (annotated tag `@moonshot-ai/kimi-code@2.8.1`, tag object `5eb17ca75b4698b8ee41871262d34481b6db6fdb`). The isolated npm binary reports `2.8.1`; `dist/main.mjs` SHA-256 is `8239be59316fde21d7fb24d9bfffab934033d0c6f21c0a5d9e3be3fa774a3ec4`.

The release row in [runtime/kimi-releases.ts](../runtime/kimi-releases.ts) is `{ version: "2.8.1", commit: "62402f17", scope: "all", capabilities: BASELINE }`. Because `approval-hook.ts` bundles `kimi-releases.ts`, plugin `3.1.3` updates `dist/hooks/approval-hook.js` cleanly and upgrading hosts run `setup` once (or auto-repin when `retryable_after_setup: true`). Unlisted plain `2.y.z` releases strictly above `2.8.1` borrow `local-environment` mechanics from `2.8.1` for read-only operations.

## Upstream source diff (2.8.0 -> 2.8.1)

Four commits separate `@moonshot-ai/kimi-code@2.8.0` (`46d9085f37c1b145ccfc82a24387e26aa940e94f`) and `@moonshot-ai/kimi-code@2.8.1` (`62402f173c5a838a1c1f8fa263b637a22486fa39`), touching only three production `.ts` files outside release version manifests:

- `packages/agent-core-v2/src/agent/toolSelect/toolSelectService.ts` (`#5516`): adds `shapeLifecycleAnnouncement()` so dynamic-tool lifecycle replay announces removed tools only when they were previously declared. 170 of 171 files pinned in `tests/audit/v2-tag-scan.test.ts` stay byte-identical to `2.8.0`, including `features/externalHooks/**`, `features/plan/**`, `agent/toolExecutor/**`, `agent/tools/task/task-wait/taskWaitTool.ts`, `cli/v2/run-v2-print.ts`, `features/swarm/**`, and `packages/kap-server/**`. `PINNED_HASHES["2.8.1"]` re-pins only `toolSelectService.ts` (`ced5e3ca3e9ef7230f69be16b55f3237d6516a9461c9f7c53a43644d630f7eb4`).
- `packages/core/src/llm/builtin/protocol/google-genai/{index,decode}.ts` (`#5515`): forwards `abortSignal` to Google GenAI SDK requests and emits usage chunks without requiring `finishReason`.

As established at `2.8.0`, the external `PreToolUse` listener executes inside `legacyHook` ahead of the `registerHook` plan guard and zero production code calls `event.allow()`. All four plugin-owned no-plan closures remain active on every launch as defense in depth.

## Monitor report and smoke-harness fixes

Codex's initial `2026-11-27` candidate monitor run on `2.8.1` (`39 pass / 9 skip / 5 fail`) exposed two harness gaps (neither an upstream `2.8.1` defect) plus the cron-sandbox `Glob` ripgrep issue:

- **Three swarm lanes in candidate mode:** `KIMI_PLUGIN_CC_SMOKE_V2_CANDIDATE` previously extended only `NATIVE_V2_CERTIFIED` and bypassed `kimi-releases.ts`, so preactivation (`requiresSwarmPreactivation`) and bounded swarm policy (`usesBoundedSwarmPolicy`, `boundedSwarmSuite`) treated the uncertified candidate as lacking those capabilities. `runtime/kimi-releases.ts` now exposes a test-process-only `registerSmokeCandidateReleaseForTests` helper wired exclusively inside `tests/runtime/real-binary-smoke.test.ts` (never mutating `KIMI_V2_RELEASES` or reading env vars in runtime code), and `runtime/swarm-activation.ts` queries `kimiCertifiedReleaseHas`.
- **`[ask] every experimental feature switched on`:** Under `runAsk`'s read-only prompt wrapper, the model declined in prose instead of calling `Write` to hit the managed hook denial. The test prompt now includes an explicit authorized-hook-test instruction so `Write` executes and records a same-call managed denial.

An initial live maintainer run on `2.8.1` (`smoke-2.8.1-01.log`, `48 pass / 3 skip / 2 fail / 674 assertions in 653.03s`) also hit two test-harness issues that were fixed and disclosed here:

- **`--read-root: real Grep and Glob calls pass the argument-key rule`:** `createScopeFixture` allocated temporary directories inside gitignored `runtime/dev-data/tests/`, causing ripgrep inside `Grep` (without `include_ignored: true`) to ignore all fixture files (`"No non-sensitive matches found"`). Moving `createScopeFixture` into `os.tmpdir()` resolved this cleanly.
- **`write-swarm denies out-of-worktree writes (--write)`:** On `smoke-2.8.1-01`, no escape file was written (`expect(escaped).toBe(false)` passed), >= 2 children spawned, and the coordinator wrote no target, but a child declined the out-of-workspace path in prose instead of attempting `Write`. Adding the authorized-hook instruction into `prompt_template` (plus bounded diagnostic logging in `assertSwarmChildEvidence`) fixed both targeted lanes (`smoke-2.8.1-targeted-01.log`, `2 pass / 0 fail in 46.20s`).

## Gate evidence

- **Gate 1 — Mechanized source tag scan (`tests/audit/v2-tag-scan.test.ts`):**
  - Exact `2.8.1` clean worktree (`62402f173c5a838a1c1f8fa263b637a22486fa39`): **59 pass / 0 skip / 0 fail / 789 assertions in 1.71s** (`tag-scan-2.8.1.log`).
  - Exact `2.8.0` clean worktree regression (`46d9085f37c1b145ccfc82a24387e26aa940e94f`): **59 pass / 0 skip / 0 fail / 789 assertions in 1.67s** (`tag-scan-2.8.0.log`).
- **Gate 2 — Exact-binary live controls (isolated `2.8.1`, Agent Keys route where live):**
  - `write-off`: exit 0, first-line `system.version = "2.8.1"`, `Write` denied on the same call (`cert-control: denied`), zero files or plan journals.
  - `plan-on`: exit 0, KAP profile armed plan (`plan_mode.enter`), `Glob` and both plan-file `Write` attempts reached the deny hook (`cert-control: denied`), zero plan files and zero workspace files written.
  - `enter-off-forced`: exit 0, `EnterPlanMode` absent from offered tools (`offeredTools` includes `Write`, omits `EnterPlanMode`), scripted forced `EnterPlanMode` rejected with `Tool "EnterPlanMode" not found` before any hook call (`hookCallCount: 0`), zero plan state.
  - `environment-controls`: exit 0, real `web --json` local activation/deactivation passed; configured `[environments] default` refused before launcher (`CLI_V2_ENVIRONMENT_UNSAFE`); resumed nonlocal binding refused (`KIMI_SESSION_ENVIRONMENT_UNSAFE`).
  - `r1-control`: three fresh `kimi -p` runs each on `2.8.0` (`1/3` interleaved `mcp.tools_discovered`) and `2.8.1` (`2/3` interleaved `mcp.tools_discovered`) with `default_plan_mode = true` and a stdio MCP server; `PLAN_PAIR_BOOKKEEPING` tolerance covers both identically.
- **Deterministic untouched-binary bounded-swarm suite (`tests/runtime/swarm-bounded-real.test.ts`):**
  - Exact `2.8.1` binary (`dist/main.mjs` SHA-256 `8239be59316fde21d7fb24d9bfffab934033d0c6f21c0a5d9e3be3fa774a3ec4`): **23 pass / 0 fail / 138 assertions in 606.27s** (`deterministic-2.8.1.log`).
- **Gate 3 — Maintainer real-provider smoke (`tests/runtime/real-binary-smoke.test.ts`, empty seed home + Agent Keys API key, `KIMI_PLUGIN_CC_SMOKE_INSTALL=1`):**
  - Full run (`smoke-2.8.1-02.log`): **50 pass / 3 expected skip / 0 fail / 677 assertions in 598.84s**. The 3 skips are the two narrowed `non-swarm` skips (`v2-swarm-not-certified` suite, empty in `3.1.x`) and `--network: WebSearch` (skipped by name on an empty API-key seed home with no Kimi login or search endpoint).
  - `setup --install-kimi` downloaded and verified `@moonshot-ai/kimi-code@2.8.1` and ran an `ask` job calling `Grep` on the plugin-owned binary. All read-only, rescue, pursue, `[ask]` experimental-features, `default_plan_mode` cancellation, native-v2 resume + taint, read/write swarm, bounded swarm (`1` direct + `4` waves), `--read-root` (`Grep` + `Glob`), `FetchURL`, `WaitFor`, spelling, swarm child read-scope, and `--reference-session` lanes passed.

All receipts (`tag-scan-2.8.1.log`, `tag-scan-2.8.0.log`, `write-off/`, `plan-on/`, `enter-off-forced/`, `environment-controls/`, `r1-control/`, `deterministic-2.8.1.log`, `smoke-2.8.1-01.log`, `smoke-2.8.1-targeted-01.log`, `smoke-2.8.1-02.log`) are stored under `.claude/kimi-code-research/cert-2.8.1-live/`. Nothing was run on Windows.

## Release validation

Full repository release checks on `v3.1.3` (`bun run check`, `bun run check:package`, `bun run check:consumer-security`) run and pass before committing and tagging `v3.1.3`.
