# Exact CLI 2.7.3 certification — plugin 2.7.3

## Scope and decision

**Status: certified and published for all eight operations.** Exact `@moonshot-ai/kimi-code@2.7.3` passed the source, exact-binary, deterministic stock-binary, real-provider candidate and production-table operation gates. Certification was completed before release authorization. The release commit, immutable GitHub release, npm OIDC publication and fresh registry/attestation verification are now complete. Neither certification nor publication updates installed hosts or operator pins.

Exact source commit: `a8f643ad2e7f197d6ec4409b7cdad8a544afad86` (annotated tag object `f27c2321c7eabafc00ad8581b12a4d60138bc6ac`). A fresh isolated npm binary reports 2.7.3; `dist/main.mjs` SHA-256 is `747dbb1fd3ad0789194e0181cfaf036a795c8c6d6b3a9204c152aee8db10de16`. npm `latest` was rechecked as 2.7.3 during certification.

## Monitor verification and correction

The 2026-11-24 Codex monitor correctly held the production pin at 2.7.2 after its authorized 2.7.3 candidate smoke exited 1 with **23 pass / 6 skip / 3 fail / 217 assertions**. It observed no hook bypass or user-worktree write. The three failures were missing real-child or child-patch evidence, not a demonstrated upstream scheduler regression.

The cause was candidate-harness coverage: candidate-only operation admission included 2.7.3, but preactivation and bounded-policy selectors did not. Fresh sessions therefore remained swarm-off, and the four bounded single-worker/wave cases skipped. The separate certification pass reviewed the changed KAP behavior, corrected those selectors, and reran the complete matrix. The monitor smoke itself was not retried.

## Source audit

The pristine exact 2.7.3 source was archived from the verified tag and compared with exact 2.7.2 through all nine playbook scopes plus related auth/attribution and upstream-test diffs. CLI print, before-execute/permissions, external hooks, plan/restore, session bootstrap/config, tools/fan-out/SDK, and OS/remote/DI scopes are byte-empty. Only KAP/web activation and loop attribution changed.

The review establishes:

- the active-plan guard remains the only production final `allow()` across agent-core, shared core, CLI, KAP, SDK, Klient and ACP;
- executor construction/order, eager per-child hooks, first-block-wins aggregation, tool input fields and local/trust boundaries are unchanged;
- no new model-reachable plan entry exists; host-only plan entry and raw resume journal closures remain mandatory;
- optional `replyModel` and `modelSteps` extend the existing `TurnEnded` journal payload without changing print-mode stream-json;
- authenticated feedback routes and the optional `/meta` feedback capability are host-only additions on the short-lived activation server, which shuts down before print;
- missing configured main-agent models are reported as unset, with a `model.not_configured` notice after history; activation's existing expected-model check therefore fails closed, while other config errors and subagent errors still throw;
- native scheduler/recovery behavior is unchanged, so no upstream concurrency fix is claimed.

The unmodified scan reproduced **18 pass / 15 skip / 5 fail / 72 assertions**: one missing pin row, four stale exact-version branches, and the omitted bounded suite. The final row has **159 pins**, updating all eight changed inherited files and adding six reviewed attribution/model/conversation helpers. Final exact 2.7.3 scan: **38 pass / 0 fail / 0 skip / 533 assertions**. Exact 2.7.2 regression: **38 pass / 0 fail / 0 skip / 527 assertions**.

## Exact-binary controls

All controls ran sequentially against the fresh isolated binary. Real-model controls used the dedicated Agent Keys environment-model route and fresh absolute-path homes; personal config and credential stores were neither read nor linked.

- **Plan OFF:** ordinary Write reached the deny hook, returned `cert-control: denied` on the same call, created no file, recorded no plan state, and emitted exact first-line `system.version` 2.7.3.
- **Deliberately armed plan ON:** authenticated JSON/KAP activation armed an isolated session. Glob was denied; Write created a **1,762-byte plan file without a plan-Write hook**. No workspace file was created, proving the no-plan closures remain load-bearing.
- **Forced EnterPlanMode:** the tool was absent from offered tools. Scripted `call_enter_forced` returned `Tool "EnterPlanMode" not found` before any hook, was returned to the provider, and created no plan journal or file.
- **Environment:** real JSON activation/deactivation passed. A configured remote default refused before its launcher ran, disabled workspace trust refused, and a resumed nonlocal binding refused.

Receipts are `write-off-absolute/summary.json`, `plan-on/summary.json`, `enter-off-forced/summary.json`, and `environment-controls/summary.json` under `.claude/kimi-code-research/cert-2.7.3-live/`.

## Deterministic and real-provider operation evidence

The deterministic untouched-binary suite passed **23 tests / 138 assertions in 615.18 seconds**. It covers real new/resumed/odd waves, child-authored writes and patches, explicit/automatic background controls, direct workers, nested-profile refusal, timeout and cancellation tails, and both long recovery controls. `recovery-429` took 201.66 seconds; `recovery-context` took 201.01 seconds. Both recovery controls produced four children, peaked at three active child turns and settled all turns. Implementation fingerprints were unchanged at launch and settlement.

The real-provider candidate matrix passed **30 tests / 402 assertions in 407.70 seconds**, with only the two inapplicable narrowed-refusal skips. The production-table matrix independently passed **30 tests / 402 assertions in 411.76 seconds**, with the same skips and no candidate override. Both used dedicated environment-model authentication and empty temporary seed homes.

Evidence includes:

- same-call managed Write denials for review, challenge, ask and review_gate;
- confined rescue writing and separate absolute out-of-root `Bash.cwd` denial;
- unsafe experimental, default-plan and plan-tainted resume refusals;
- real multi-turn goal denials and both pursue terminal controls;
- real read-only child denials and write-swarm child edits with a **278-byte patch**, clean user tree and cleaned worktree;
- real out-of-worktree child Write denials;
- direct single-worker read/write with no children or web activation, including **348-byte** candidate and production direct-write patches;
- directed recovery from an oversized wave, then two bounded waves with four children and candidate/production patches of **708/680 bytes**;
- uncoached five-target work at width four: one accepted wave, three children, peak three, zero coordinator-authored targets, and candidate/production patches of **899/843 bytes**. Grouping multiple targets into one child is valid; one child per target is not required.

All retained bounded jobs contain exact 2.7.3 version/marker evidence, terminal completion, no hook-escape findings and verified cleanup. Candidate evidence is under `candidate-live-evidence/`; production evidence is under `production-live-evidence/`.

## Focused implementation and emitted-runtime checks

- Candidate source/type checks: **403 focused runtime tests / 1,449 assertions**, plus typecheck; the 21 skips are ordinary opt-in real-binary lanes outside that unit run.
- Promoted engine/setup/compiled policy/recovery suites: **180 pass / 6,094 assertions**, including exact 2.7.3 schema acceptance, neighboring-version refusal, all three emitted runtime maps and durable hard-kill recovery.
- Contract-size and generated-surface checks: PASS.

Exact 2.7.2 and 2.7.3 use `web --json` with an in-memory ephemeral token, strict loopback origin and matching `/api/v1/ws`, KAP 1.0.0 and WebSocket capability, exact server version, and no auth bypass or legacy backend field. Older ready/meta formats are unchanged. Fresh print explicitly selects `--environment local`; resume never receives that flag. Bounded policy, preactivation, direct-worker selection, additive schema acceptance and durable recovery use exact versions with no 2.7.x range inheritance. Exact 2.7.0, 2.7.1 and 2.7.4 remain excluded.

## Certification validation

- **Frozen install:** PASS. `bun install --frozen-lockfile` completed with no changes.
- **Full repository gate.** `bun run check` exited 0, including the generated-file drift check. The suite reported **1,878 passed, 83 skipped, 0 failed and 24,758 assertions** across 96 files in 997.07 seconds. See `full-check-04.log` under `.claude/kimi-code-research/cert-2.7.3-live/`.
- **Earlier failures.** Three full runs stopped in the 2.3.2 swarm cleanup test. The one-second whole-job deadline could expire before the mock server received the deactivation request. The same assertion failed on unmodified HEAD. The corrected cleanup test allows time for process startup and uses print and status delays whose sum exceeds the job budget. The print-timeout test also allows time for activation. The error-precedence test now forces a cleanup REST failure after print exits with code 7. All three passed together and in the full suite. The original failures are in `full-check-01.log` through `full-check-03.log`, with the focused verification in `cleanup-three-focused.log`.
- **Package and DSH:** PASS. `bun run check:package` verified the **343-file** `kimi-plugin-cc@2.7.3` archive, all three compiled distributions, isolated hook setup/check and version refusal, the patched DSH host/profile, seven live providers/tools, and Web boot. Receipt: `package-check.log`.
- **Consumer security:** PASS. `bun run check:consumer-security` verified the isolated npm consumer security of `kimi-plugin-cc@2.7.3`. Receipt: `consumer-security.log`.
- **Final diff review:** no runtime defect, stale current exclusion, duplicate version list or generated-surface drift was found.

## Release and registry receipt

Release commit `8e2187d1826952440e18f870eaae52bb765f385b` passed CI run `45418692870`, including Linux/full-package and Windows jobs. The immutable [v2.7.3 GitHub release](https://github.com/linxule/kimi-plugin-cc/releases/tag/v2.7.3) is anchored at that commit with annotated tag object `bb019411da1deb73c8a17ba8eba314004a610377`.

OIDC run `45420498664` validated the same immutable tag and published npm `latest` 2.7.3 at `2026-11-24T15:13:17.012Z`. The **343-file** registry tarball is byte-identical to the successful Actions artifact, and every published file matches the release tag:

- SHA-1: `bbb42f48fe2f620be6a89b588561905c235a715f`
- SHA-256: `d23e4742d6c5c5337e5ae98c1d8435c3c3409b6cf4f7b36bd61054327c41836f`
- SHA-512: `21b30f741417c117c95f7afdef0fe11368d30fbe21ec3489509d9a4bb543851b35cc83f24ae6db1dfe90ad6cd58a4b4bb1af1ee7ab83d804a9271c7e52e497a3`

SLSA provenance log index `4080883768` and publish attestation log index `4080953677` match the package subject, SHA-512, release commit, run and `refs/tags/v2.7.3`. Fresh registry installation has zero production advisories and no invalid or missing signatures. Isolated Claude Code, Codex and DSH setup/checks pass against exact stock CLI 2.7.3, and all three installed runtime maps enforce full 2.7.3 certification with 2.6.0 non-swarm-only scope. Verification made no model calls and changed no installed host or operator pin. Receipts are under `.claude/kimi-code-research/release-2.7.3/registry/`.

The post-publication DSH Discover timestamp is `1795533197`, recording actual npm publication.

## Residual boundaries

The concurrency bound covers simultaneous Kimi child-agent turns, excluding the coordinator and OS subprocess counts. `--cap` remains a soft lifetime-total hint, and a finite time budget is not a spend cap. Upstream rate-limit recovery can still exceed its native setting; the plugin-owned bound is required. Parallel sessions retain the native TaskStop restriction after deactivation, and later external interactive resume is outside this certification. Stream-json still lacks a general execution-outcome field, so hook-escape findings remain detection evidence rather than a failure signal. `KIMI_CODE_NO_AUTO_UPDATE=1` suppresses passive updates but does not prevent every manually staged native replacement; exact probe and first-line marker checks remain the mismatch backstop, not rollback. Trusted operator config/journals, upstream hook-runner fail-open behavior, host-only plan routes and repository Git helpers retain their existing boundaries.
