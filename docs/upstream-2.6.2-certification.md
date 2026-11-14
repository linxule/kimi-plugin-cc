# Exact CLI 2.6.2 certification — plugin 2.6.2

## Bounded swarm certification — pending Linux fix validation

**Status: PENDING final fix validation; not released.** Linux release CI run `43604995805` exposed a process-identity bug before tagging or publication and was canceled after 20 minutes with 64 recorded failures. The collector fell back to `ps` start tokens while identity probes used `/proc` start ticks after encountering a kernel process with PGID 0; the resulting timeout cascade was not a deadlock. The fix keeps Linux identity collection on `/proc` and narrowly excludes `PF_KTHREAD` entries with PGID 0, while test helpers add early-failure cleanup. Those changes and fresh release gates are still pending validation.

The prior macOS source, stock-binary, real-provider, repository and package passes below are retained against their recorded runtime bytes. They do not certify the repaired runtime or replace the failed Linux gate. The published plugin 2.5.9 non-swarm certification remains historical evidence below.

The exact source and binary remain commit `6a8493df3e1d796a63f7c7ca0de76c1e690cd943` and bundle SHA-256 `f07d4f0d28ba1dd3397cb070aa757f7b7610a51bb15164f1e158fad7809cb36a`. The upstream rate-limit scheduler is unchanged. The plugin enforces the bound through admission and terminal cancellation:

- At concurrency at least 2, the canonical managed hook counts fresh items plus resumed entries and denies a wave larger than the requested limit. It rejects forks, malformed input and fresh singleton waves; a singleton remainder needs regrouping or an own-child resume. The policy and width come from the immutable operation/version plan, overwrite ambient values and also reach the escape monitor.
- `KIMI_CODE_SWARM_TIMEOUT_MS=2147483647` overrides saved or ambient short child timeouts. A native swarm-child timeout therefore cannot return a wave while its retry still runs. A stuck child holds the wave until completion or finite whole-job stop. Environment `0` is ignored by stock 2.6.2.
- Parallel activation disables native `TaskStop` in the fresh owned session after web shutdown and before print. Stock 2.6.2 requires all three task tools for Bash backgrounding, so this closes automatic detachment and completion-driven child wakeups. The canonical hook also denies explicit background Bash on both bounded paths.
- Normal exit and terminal cancellation require identity-verified owned-process quiescence before artifact or patch capture. Individual native Bash timeouts do not prove arbitrary descendant quiescence between waves.
- Concurrency 1 runs one direct worker through fresh print without native swarm activation. Both AgentSwarm and singular Agent are denied. Native automatic Bash timeout-to-background remains possible, with sequential root turns and whole-job settlement; explicit background requests remain denied. Parallel Bash has a 60-second default and 300-second maximum foreground timeout, so longer tests should use concurrency 1. Read-only restrictions, write-worktree confinement, patch capture, operation identity and finite budgets remain unchanged.
- The concurrency bound counts simultaneous Kimi child-agent turns, excluding the coordinator and OS subprocess counts; allowed repository tests can spawn multiple processes. `--cap` remains a soft lifetime-total hint. The existing repository-code trust boundary remains; no operating-system sandbox or spend cap is claimed.
- The construction applies only to exact native-v2 2.6.2. Exact 2.6.0 remains non-swarm-only. Older full-operation rows retain their inherited recovery limitation; other versions gain no compatibility by implication.

The native TaskStop policy persists after deactivation of the owned parallel session. A later external interactive resume of that historical session is outside the managed-job certification.

### Validation receipts

The prior validated macOS runtime is commit `e8f7059ec211489263710dff76595b2ef80c949c`; the Linux correction changes runtime bytes and requires replacement final receipts. The full repository, live-provider and package gates below ran from an isolated Git clone at `/var/folders/93/qllsxfwn1tz2jbj6zt868c780000gn/T/kimi-release-2.6.2-final-odld3_2v`. The stock-binary `production-03` run verified all 184 covered files against that commit's Git blobs both before and after execution. Its manifest SHA-256 is `fe5bacb5478a2f63f5dd1651c0b8967ac6c63a142748ff3bf910c9e9229a3f79`; its covered-file digest is `47b5e0cd5186ac7d62e5df1a629935d0a852a411b64fd0fee64d6697f408b3c3`. Local evidence lives under `.claude/kimi-code-research/cert-2.6.2-bounded/`; ignored logs are evidence locations, not package contents.

| Gate | Receipt |
| --- | --- |
| Exact-source audit and tag scan | PASS: 31 tests / 393 assertions, 115 source pins; exact 2.5.3 regression 19 pass / 12 version-specific skips / 153 assertions |
| Canonical policy, emitted-runtime and repository regressions | PASS in the final full gate: all three compiled distributions, canonical-hook policy, escape-monitor propagation and unsafe-settlement patch refusal |
| Scripted stock-binary waves, resume counting, nesting, recovery and timeout-tail controls | PASS: `production-03.log`, 23 tests / 138 assertions in 275.03s; no failures |
| Native background-policy closure, explicit background denial, normal-exit descendant quiescence before capture | PASS: parallel auto-background and explicit-background controls in that same stock-binary suite |
| Single-worker read/write, delegation denial, patch and cancellation controls | PASS: explicit/default concurrency-one, automatic-background, cancellation and budget controls in that same suite |
| Real-provider production operation matrix | PASS: `live-release-commit.log`, 30 pass / 2 intentional narrowed-version-refusal skips / 390 assertions in 440.53s; exit 0 at 2026-11-14T14:20:59Z. Both swarm execution paths run; the two skipped tests assert refusals that do not apply to the full 2.6.2 scope |
| No-plan and local-execution controls | PASS: same-day exact-source and exact-binary controls retained in the historical receipt below; unchanged source/binary and safety closures are rechecked by the final tag scan and operation matrix |
| Frozen dependency install and full repository gate | PASS: `release-full-check.log`, 1,720 pass / 75 expected opt-in skips / 0 failures / 22,490 assertions; 1,795 tests across 93 files in 541.73s |
| Package and isolated consumer security | PASS: final `release-package.log` verifies 340 files, all three distributions, isolated setup/check, version refusal and MCP checks; audited DSH host/profile, seven providers/tools and Web boot. `release-consumer-security.log` passes isolated npm consumer security |
| Independent reviews | PASS: Codex reports no actionable findings. Fable's `FABLE-BATCH.md` finds no remaining defect in its reviewed caller/helper source scope and explicitly leaves runtime tests and emitted-artifact verification to the final gates above |
| Linux CI and publication | FAILED release gate: run `43604995805`, 64 recorded failures before cancellation; correction and final reruns PENDING. No tag, publication or installed-host result is claimed |

The 23 stock-binary controls use the untouched 2.6.2 executable with a scripted test provider. They exercise new/resumed waves, odd target grouping, both nested profiles, invalid resumes, read/write cancellation, active HTTP/tool budget expiry, and 429/context recovery beyond the native 180-second interval. Their deterministic responses prove enforcement and settlement; the separate passing real-provider matrix proves useful model behavior through the production operation paths.

Commit `9db8e97` subsequently corrects zombie-process quiescence checks in two test helpers only; runtime and emitted artifacts are unchanged from `e8f7059`. Focused checks passed 50 tests / 218 assertions, and churn controls passed 4 tests / 36 assertions after that correction. Linux CI remains a separate release gate. Same-day source and no-plan/local controls are explicitly reused against the unchanged exact CLI; earlier prototype or pre-fix runtime passes do not replace the final receipts above.

| Completed evidence file | SHA-256 |
| --- | --- |
| `source-scan-2.6.2.log` | `ea21898d94dba98fa68792565c6d2bb409af04307fc72446af2da58598f2e507` |
| `source-scan-2.5.3.log` | `f04df6af7b6c2252526bba52a2df357a1f152618c4f6fc12ca6354400232723c` |
| `production-03.log` | `d8e7dd94fd94aee7b42e20d06ffdd3735a4e16cf8a8d3fdbb2f7cb41284d9125` |
| `release-full-check.log` | `b46be31f50499ab5947344510c6382b786538adf06a1b354e9fb3d5fbe4af636` |
| `live-release-commit.log` | `cd8a8a3ca145d239474ca7e2e6a8576be576178cb1c67da7f3bee524666434bc` |
| `release-package.log` | `ba151af3382fafbcbbe0a8b47fccd679f92f6a5e47642c73185fd2c8283bb1ac` |
| `release-consumer-security.log` | `3dea92a3793941ba29017dec7b3e7a7a254eb45473130349fa4502b70a817221` |
| `FABLE-BATCH.md` | `d27e38068eff4d241d476527471a4f7bff1ed72da11ac2d3ba7497e84b0b8e1f` |

### Counterexamples that determined the construction

The earlier prototype supplied 11 admission/recovery binary controls, 18 direct hook probes and 10 lifecycle controls. It established a real guard-only failure (three active children at width two after a short native timeout) and a protected counterpart, including process checks before provider cleanup. Those ignored research artefacts motivated the production construction; they do not replace the canonical implementation or release gates above.

Review then exposed a second route: native Bash background completion could wake a child after its wave had returned. The owned-session TaskStop policy closes both explicit and automatic detachment in parallel mode; the hook separately rejects explicit background requests. A later parallel control found a timed-out Bun descendant surviving successful print exit. That failure required identity tracking and a normal-exit settlement barrier before artifact or patch capture, plus refusal to capture a patch when settlement remains uncertain. The passing production controls include these closures. Concurrency-one automatic backgrounding remains supported because its root-agent turns are sequential and whole-job settlement still gates the result. None of these controls claims a bound on arbitrary OS subprocess counts or settlement of every command descendant between individual waves.

## Historical plugin 2.5.9 non-swarm certification — 2026-11-14

## Scope and decision

**Plugin 2.5.9 certifies exact CLI 2.6.2 for review, challenge, ask, rescue, review_gate and pursue only.** Read-only swarm and write swarm are not certified on 2.6.2 and refuse before model spawn. Exact 2.6.1, 2.6.3, and prerelease/build-suffixed versions are not covered. Exact 2.6.0 retains the same narrowed scope. Full eight-operation certification still ends at exact 2.5.3, with its inherited rate-limit limitation disclosed.

This is a deliberately narrowed production certification, not a waiver of the upstream scheduler defect and not a claim that candidate swarm protocol integration is production-certified. Choose 2.6.2 explicitly for non-swarm use; automatic full-swarm pin behavior does not move to this release.

Exact source: `@moonshot-ai/kimi-code@2.6.2`, commit `6a8493df3e1d796a63f7c7ca0de76c1e690cd943` (annotated tag object `cdd263d5451b6664b01956328287531117462c40`). The isolated npm binary reports 2.6.2; `dist/main.mjs` SHA-256 is `f07d4f0d28ba1dd3397cb070aa757f7b7610a51bb15164f1e158fad7809cb36a`.

## Enforced boundary

- `NATIVE_V2_NON_SWARM_VERSIONS` contains exact 2.6.0 and 2.6.2. `NATIVE_V2_ANY_OPERATION_VERSIONS` is the scoped union used by setup and engine selection; the per-operation map admits 2.6.2 only for the six operations above.
- `NATIVE_V2_CERTIFIED_VERSIONS` remains the all-operation export through 2.5.3. Consumers that intersect that export and select a full-swarm pin do not silently select either narrowed 2.6.x release.
- Both swarm operations omit 2.6.2. Fresh planning returns `KIMI_CAPABILITY_NOT_CERTIFIED` with `refusal_kind: "v2-swarm-not-certified"` and `certification_scope: "non-swarm"`; the persisted-plan spawn boundary rejects the same pairs. Excluded swarm operations never fall back to legacy-v1.
- Setup reports the six-operation scope and the reason for swarm refusal. The same execution-plan gate covers Claude Code, Codex, DSH and MCP. Compiled tests execute both scoped versions through all three emitted runtimes and preserve test-only candidate selection and the all-operation export.
- Write-swarm may create and remove a temporary worktree during execution planning before returning the refusal; no model session is created. The user tree, worktree directories and Git worktree administrative list must remain unchanged after cleanup.

## Source and upstream scheduler evidence

- Exact 2.6.2 source scan: **19 tests / 216 assertions**, exit 0 (`source-scan.log`). Exact 2.5.3 regression: **19 tests / 153 assertions**, exit 0. The new pins cover mutable participant replay, loop-journal freezing, turn projection and additive feedback APIs. Restore still reads the same two wire-journal chains, with no second durable plan-state source and no new final `.allow()`.
- The executor, external-hook schema, before-execute population, plan guard, print/local-environment and authenticated direct-subscription contracts pass the reviewed 2.6.x assertions. The new feedback service has an empty constructor; session/codebase upload requires an explicit submit call and is not part of the plugin's prompt path.
- Exact-binary controls passed with fresh isolated homes. Plan OFF denied an ordinary Write on the same call and created no file. Deliberately armed plan mode wrote a **1,304-byte** plan file without a plan-Write hook, while Glob reached the deny hook; this proves the no-plan closures remain load-bearing. A scripted `call_enter_forced` returned `Tool "EnterPlanMode" not found` on the same call ID before any hook, with no plan state. Real activation/deactivation passed with an explicit local binding; a remote default, disabled workspace trust and resumed remote binding all refused before launcher/spawn.
- The scheduler file `features/swarm/session/agentRunBatch.ts` is byte-identical to 2.6.0, SHA-256 `339dbd7962c3b9bac145aff83aee06d6e5f3c6b9e8c472d4f4f94d7fb26390fc`.
- Fresh deterministic controls against an untouched exact 2.6.2 worktree fail both cap tests (`unpatched-cap-controls.log`): cap 1 has three cumulative attempts after the initial retry, rather than two, and cap 4 reaches five active attempts. The settle-and-continue control is part of the same suite. The local reference correction at `52e21c7bf25d102efb0b8b7af28f575519b38d3b`, based on upstream `8d939f7dc76adde3d68a1d489eea3e8ea57e2b9a`, passes all **56 focused upstream swarm tests** (`patched-focused-swarm.log`). The unpatched base differs from exact 2.6.2 only in its `TokenUsage` import and otherwise has the same scheduler logic. The correction intentionally changes that logic; it is not byte-identical to 2.6.2, a released fix, or certification evidence.
- [Upstream issue #4926](https://github.com/MoonshotAI/kimi-code/issues/4926) remains open without maintainer approval or a released fix. No upstream PR has been opened before the project's required approval. The local correction is not certification evidence or a shipped plugin patch.

## Candidate and production evidence

The earlier credential-resolution stall never started a test. The authorized credential-only probe succeeded without a model call before this run; the initial failure log is retained separately as `monitor-candidate-initial.log`.

The retained candidate run is `daily-monitor/smoke/2026-11-14-2.6.2-candidate.log`, with SHA-256 `e83f6ba03f38111108da0bb1386eaf61a7ebfd14c4f1af07950bafb120b94b4a`:

- **24 passed / 2 intentional production-refusal exclusions / 0 failures / 201 assertions in 327.41 seconds**, terminal exit 0.
- Real read-only fan-out produced distinct child journals with managed denials. Write-swarm produced a 278-byte child-authored patch with a clean user tree and removed worktree, and denied out-of-root child writes.
- Candidate swarm behavior and activation are integration evidence only; they do not grant production swarm certification.

The retained production run is `daily-monitor/smoke/2026-11-14-2.6.2-production.log`, launched without `KIMI_PLUGIN_CC_SMOKE_V2_CANDIDATE`, with SHA-256 `70593fbd3d98e17d302c585645ee745e1fb958449eb63f67a83c33ab6144c091`:

- **23 passed / 3 intentional exclusions / 0 failures / 171 assertions in 219.98 seconds**, terminal exit 0.
- Review, challenge, ask and review_gate each produced a same-call managed Write denial. Real rescue landed only its confined write and persisted certified native-v2 operation/version/session/artifact evidence. The separate absolute `Bash.cwd` attempt was denied on the same call.
- Default-plan, unsafe-experimental and plan-tainted resume refusals passed. The multi-turn goal control recorded **2,975 durable started turns, 2,975 turns with same-call managed denials and 2,982 denial results**, with no target file. Both pursue terminal-status controls passed.
- Both real swarm command paths returned `v2-swarm-not-certified` before creating a model session. Write-swarm left no retained worktree and no user-tree or Git-worktree-administration change.
- The only skipped tests are read-only swarm confinement, write-swarm patch capture and write-swarm out-of-root confinement. They are explicitly outside this certification scope and are not represented as passing evidence. No other skip is accepted.

The focused candidate suite passed **353 tests / 4,850 assertions**. The expanded activation suite passed **127 tests / 431 assertions**, including exact 2.6.2 invalid agent-state, local-binding and cleanup controls. The schema suite passed **45 tests / 3,645 assertions**. Production-focused routing, emitted-JavaScript and setup checks passed **68 tests / 4,369 assertions**.

## Final validation and publication

- Definitive isolated full gate (`final-full-check.log`): **1,503 passed / 36 expected opt-in skips / 0 failures / 20,086 assertions in 433.07 seconds**, terminal exit 0. Frozen dependency installation and generated-surface/drift checks passed. The corrected frozen snapshot is identified by `review-fixes.diff`, SHA-256 `7e9385ad4f74849b7be0242505f9543049623462960097388044fa30e0be186f`; later changes are documentation-only evidence corrections. The first workspace run found only two ignored-iCloud-conflict mirror failures; a separate isolated run had one unrelated MCP identity-race failure, which passed unchanged in isolation with 12 assertions in 6.49 seconds. No assertion was removed to obtain the final green run.
- Final package validation (`final-package.log`): **334 files**, all three compiled distributions, isolated setup/check/version refusal, patched DSH host/profile with seven providers/tools and Web boot, terminal exit 0. Isolated npm consumer security (`final-consumer.log`) passed with exit 0.
- Codex's final incremental verification returned **NO FINDINGS / APPROVE**, exit 0. Claude's returned **NO FINDINGS / APPROVE**, exit 0. Their findings drove the README and guidance updates, direct 2.6.2 assertions, explicit base-commit provenance and correction of the erroneous byte-identity claim. Both confirmed that full-swarm certification remains at 2.5.3 and 2.6.1/2.6.3 are excluded.
- The required release-commit rerun passed **23 tests / 171 assertions in 225.87 seconds**, with exactly the three intentional swarm-lane exclusions and terminal exit 0. It ran on immutable release commit `1625858bf8851a26eee5f19ae6eb5bfe7666e97b`, whose runtime/test bytes are identical to the passing final gate. Both real swarm command paths again refused before model spawn. The retained log is `daily-monitor/smoke/2026-11-14-2.6.2-production.log`, SHA-256 `9d224c8063e80ea7fe02eeb672b4e44963790329e40243a2f52ffdceafce86fc`; its header records that release commit. The pre-release log is retained separately as `production-pre-release.log`.
## Publication receipt

Release commit `1625858bf8851a26eee5f19ae6eb5bfe7666e97b` contains the certified runtime; the immutable [v2.5.9 tag and GitHub release](https://github.com/linxule/kimi-plugin-cc/releases/tag/v2.5.9) is anchored at evidence commit `6f9eaa6e145d62e7f35e5ff38d317bd7e3a673c5`. [Final CI run 43585425445](https://github.com/linxule/kimi-plugin-cc/actions/runs/43585425445) passed the full check/package pipeline and Windows spawn controls. [OIDC publication run 43585933931](https://github.com/linxule/kimi-plugin-cc/actions/runs/43585933931) passed build and publication.

npm published `kimi-plugin-cc@2.5.9` at **2026-11-14T10:43:34.167Z**, and npm `latest` is 2.5.9. The 334-file registry tarball is byte-identical to the validated CI artifact:

- SHA-1: `2158551b73d3408af14e2061c29e40dc60622947`
- SHA-256: `d5c43b95c708468393f357c353c180488ae83edb56cae93e840d08ee2b3dc520`
- Signed SLSA provenance: sigstore log index `3876002731`
- Publish attestation: sigstore log index `3876057720`

A fresh registry installation has zero production advisories and no invalid or missing signatures. Isolated setup and `setup --check` pass with the explicit non-swarm warning; the installed runtime preserves full-swarm pins through 2.5.3 and enforces the six non-swarm admissions and both swarm refusals on exact 2.6.2. The new certification record is present in the package. `DSH_PUBLISH_TIMESTAMP` is `1794653014`, recording the actual npm publication time. No installed host or operator CLI pin was changed.
