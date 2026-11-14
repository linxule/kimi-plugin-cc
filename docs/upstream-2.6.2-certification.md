# Exact CLI 2.6.2 non-swarm certification — 2026-11-14

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
- Before tagging, rerun the narrowed production matrix on the exact release commit and record its commit SHA and log hash here; the earlier production run records only its base HEAD. Publication receipts are recorded below after publication. Publication does not update installed hosts or operator CLI pins.
