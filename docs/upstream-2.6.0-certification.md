# Exact CLI 2.6.0 non-swarm certification — 2026-11-13

## Scope and decision

**Plugin 2.5.8 certifies exact CLI 2.6.0 for review, challenge, ask, rescue, review_gate and pursue only.** Read-only swarm and write swarm are not certified on 2.6.0 and refuse before model spawn. Exact 2.6.1 and prerelease/build-suffixed versions are not covered. Full eight-operation certification still ends at exact 2.5.3, with its inherited rate-limit limitation disclosed.

This is a deliberately narrowed production certification, not a waiver of the upstream scheduler defect and not a claim that the candidate swarm protocol integration is production-certified. Choose 2.6.0 explicitly for non-swarm use; automatic full-swarm pin behavior does not move to this release.

Exact source: `@moonshot-ai/kimi-code@2.6.0`, commit `740d6c0bdd777cd8ed0d91eb3d62766910401173`. The isolated npm binary reports 2.6.0; `dist/main.mjs` SHA-256 is `cb912b23358e7b3160e95dc29a82bf5ddd3847cd6f287b34c00c80d80284b620`.

## Enforced boundary

- `NATIVE_V2_NON_SWARM_VERSIONS` contains exact 2.6.0. `NATIVE_V2_ANY_OPERATION_VERSIONS` is the scoped union used by setup and engine selection; the per-operation map admits 2.6.0 only for the six operations above.
- `NATIVE_V2_CERTIFIED_VERSIONS` remains the all-operation export through 2.5.3. Existing consumers that intersect that export and select a full-swarm pin do not silently select non-swarm-only 2.6.0.
- Both swarm operations omit 2.6.0. Fresh planning returns `KIMI_CAPABILITY_NOT_CERTIFIED` with `refusal_kind: "v2-swarm-not-certified"` and `certification_scope: "non-swarm"`; the persisted-plan spawn boundary rejects the same operation/version pairs.
- A version certified for another operation selects native-v2 and then receives the scoped refusal. Excluded swarm operations never fall back to legacy-v1. Candidate-only operation admission still selects native-v2 for the candidate smoke without extending production certification.
- Setup reports the six-operation scope and the reason for swarm refusal. The same execution-plan gate covers Claude Code, Codex, DSH and MCP.
- Write-swarm may create and remove a temporary worktree during execution planning before returning the refusal; no model session is created. Its contract is refusal before model spawn, not an absence of temporary planning side effects. Tests assert the user tree, worktree directories and Git worktree administrative list are unchanged after cleanup.

## Candidate and source evidence

- Exact 2.6.0 source scan: **19 tests / 225 assertions**, exit 0 (`non-swarm-source-scan.log`). Exact 2.5.3 regression: **19 tests / 153 assertions**, exit 0 (`non-swarm-source-regression.log`). Both were rerun for this scoped certification with fresh retained logs. `non-swarm-source-provenance.json` binds each log to its exact version, source commit and log SHA-256.
- The full-scope candidate matrix passed **24 tests / 201 assertions / no skips in 343.76 seconds**. It exercised candidate swarm behavior but does not grant production swarm certification. It predates the canonical execution-cwd and recovery changes; later targeted and compiled controls cover those changes.
- All seven exact-binary controls passed, including ordinary Write denial, armed-plan bypass, removed EnterPlanMode rejection, environment refusals, swarm OFF/ON, and out-of-root child denials. Armed plan mode wrote a 1,294-byte plan file without a plan-Write hook, proving that the no-plan closures remain load-bearing.
- Live-root, mixed/multi-batch and nested-swarm controls passed. Strengthened cancellation and deterministic budget teardown used real disjoint Bash producers, verified owner identities, zero descendants and stable retained patches/files for nine seconds. Those are candidate integration controls, not production 2.6.0 swarm claims.
- The candidate protocol uses authenticated direct `subscribe` / `response` state proof. Canonical execution roots and recovery deactivation fixes are included. The narrowed production scope does not certify that activation or recovery path on 2.6.0.

## Production-table evidence

The retained production run is `daily-monitor/smoke/2026-11-13-2.6.0-production.log`, launched without `KIMI_PLUGIN_CC_SMOKE_V2_CANDIDATE` and using the exact binary and hash above:

- **23 passed / 3 intentional exclusions / 0 failures / 170 assertions in 241.67 seconds**, terminal exit 0.
- Review, challenge, ask and review_gate each produced a same-call managed Write denial. Real rescue landed only its confined write and persisted certified native-v2 operation/version/session/artifact evidence. The separate absolute `Bash.cwd` attempt was denied on the same call.
- Default-plan, unsafe-experimental and plan-tainted resume refusals passed. The multi-turn goal control recorded **3,002 durable started turns, 3,001 turns with same-call managed denials and 3,004 denial results**, with no target file. Both pursue terminal-status controls passed.
- Both real swarm command paths returned `v2-swarm-not-certified` before creating a model session. Write-swarm left no retained worktree and no user-tree change. The follow-up exact-binary refusal control additionally asserts the Git worktree administrative list is unchanged; its result is `non-swarm-refusal-controls.log`.
- The only skipped tests are read-only swarm confinement, write-swarm patch capture and write-swarm out-of-root confinement. They are explicitly outside this certification scope and are not represented as passing evidence. No other skip is accepted.
- The matrix's runtime/test diff is `non-swarm-production-runtime.diff`, SHA-256 `4531239acccb8b01c58b40a663958191a7da750a42ba5f475f01aaf1218f96a0`. Subsequent runtime deltas are the version string, restoration of candidate-only native-v2 selection, and the full-operation versus any-operation export split that preserves existing pin behavior. Production 2.6.0 scope is unchanged; current compiled controls verify it. Other deltas are documentation and test-only coverage, including the Git-admin assertion.

The retained focused suite (`non-swarm-focused.log`) passed **186 tests with 17 expected opt-in skips and 4,336 assertions**, exit 0. Compiler and build checks passed before the production run. `tests/runtime/cli-error-compiled.test.ts` additionally executes scoped acceptance/refusal, full-operation export compatibility and candidate selection under Node against root, Codex and DSH emitted JavaScript.

## Remaining limitation and follow-up

Upstream `AgentRunBatch` can exceed `maxConcurrency` during rate-limit recovery: two active attempts at cap 1 and five at cap 4. The defect is inherited from 2.5.3. Existing full-operation rows retain that disclosed limitation; this release does not claim it is fixed.

[Upstream issue #4926](https://github.com/MoonshotAI/kimi-code/issues/4926) tracks the correction. Local commit `52e21c7bf25d102efb0b8b7af28f575519b38d3b` passes 56 focused upstream swarm tests, typecheck, lint and package build, including cap-1/cap-4 and settle-and-continue controls. It is not an upstream release and is not certification evidence. Restoring swarm on a later exact release requires the released correction, fresh cap controls, candidate and production matrices, and independent review.

## Final release validation and publication

- Definitive isolated full gate (`non-swarm-release-final-check.log`): **1,472 passed / 36 expected skips / 0 failures / 19,530 assertions in 402.26 seconds**, terminal exit 0. Frozen dependency installation and the generated-surface/drift gates passed. `non-swarm-release-validation-root.txt` identifies the unsynced worktree and its exact staged diff SHA-256 `d1a1ffea3f4c23820b6f5bd4b13d60f5a62fbc2c917eca17a9f13605270b2fc6`, including this certification record. An earlier run failed only the host-scoping setup test's five-second timeout (`non-swarm-release-check.log`); the unchanged test passed in isolation in 3.62 seconds (`non-swarm-orphan-test-isolated.log`). Its I/O allowance alone was raised to 30 seconds with every assertion preserved before the passing rerun. Subsequent evidence-wording updates changed no runtime or test bytes.
- Final package validation (`non-swarm-release-final-package.log`): **333 files**, all three compiled distributions, isolated setup/check/version refusal, patched DSH host/profile with seven providers/tools and Web boot, terminal exit 0. `non-swarm-release-final-consumer.log` passed isolated npm consumer security with exit 0.
- Codex's final review returned **APPROVE with no blocker or major findings**, after verifying persisted-plan refusals, candidate selection, 2.6.1 refusal and intersection-based full-swarm pins staying at 2.5.3. Its publication-metadata note is handled by recording the actual DSH publication timestamp at publication, as in the preceding release.
- Claude's final review returned **APPROVE — no blockers, no majors**. Its remaining schema-scope contradiction, environment/plan lists, translated remedy text and new-swarm-certification wording were corrected, and the schema comment's compiled mirrors were regenerated. Initial findings also drove the candidate fix, complete staged snapshot, export compatibility split, evidence corrections and Git-admin assertion. Subsequent CI/publication receipts are recorded below before completion. Publication does not update installed hosts or operator CLI pins.

## Publication receipt

Release commit `887958d7de39cf388ebc3faaffd31cabe76c5a99` passed [release-commit CI run 43452771909](https://github.com/linxule/kimi-plugin-cc/actions/runs/43452771909), including both the full check/package pipeline and Windows spawn controls. The immutable [v2.5.8 tag and GitHub release](https://github.com/linxule/kimi-plugin-cc/releases/tag/v2.5.8) are live. [Release-event publication run 43453807099](https://github.com/linxule/kimi-plugin-cc/actions/runs/43453807099) passed build and OIDC publish.

npm published `kimi-plugin-cc@2.5.8` at **2026-11-13T15:41:45.145Z**. The registry tarball contains 333 files and is byte-identical to the validated CI artifact:

- SHA-1: `65145489591e6873556f85a06506d0d276880441`
- SHA-256: `6fc5f44aacafa92671f5aea8e2343e6323116f81d4456dee47181481050af5f4`
- Signed SLSA provenance: sigstore log index `3857088726`
- Publish attestation: sigstore log index `3857133123`

A fresh registry installation has zero production advisories and no invalid or missing signatures. Isolated setup and `setup --check` pass with the explicit non-swarm warning; the installed runtime preserves the full-swarm pin list and enforces all six non-swarm admissions and both swarm refusals. The new certification record is present in the package. The DSH discovery timestamp is updated to the npm publication time. No installed host or operator CLI pin was changed.
