# Exact CLI 2.7.2 certification — plugin 2.7.2

## Scope and decision

**Status: certified and published for all eight operations.** Exact `@moonshot-ai/kimi-code@2.7.2` passed the source, exact-binary, deterministic stock-binary, real-provider candidate and production-table operation gates. Certification was completed before release authorization. Plugin 2.7.2 release commit `e2bba0e2d4e1745e4155eb5c6ddf3f4dabaffb66` passed release CI `44799772434`; the immutable GitHub release, recovery npm OIDC run `44803040496`, and fresh registry/attestation verification are complete. Neither certification nor publication updates installed hosts or operator pins.

Exact source commit: `56145f849caa305d42acd09b67fb65d11146f887` (annotated tag object `1781dbd74bc7fabf23ac4721a570397f278817f1`). The isolated npm binary reports 2.7.2; `dist/main.mjs` SHA-256 is `dafef22f56c4c1fff755eb3af5e42a76d32d09a9dc858ebdc055a6d1a6008e67`. npm `latest` was rechecked as 2.7.2 during the production gate.

## Monitor verification and corrections

The 2026-11-20 Codex monitor correctly held certification at 2.6.3, but stable upstream subsequently advanced to 2.7.2. Its exact 2.7.0 tag commit `a5e355e2718a2ebf70d8229fa5a05fe35d5f98a1` was independently verified, and its source scan reproduced **14 pass / 12 skip / 5 fail / 72 assertions**. The candidate log reproduced **23 pass / 6 skip / 3 fail / 205 assertions**.

The three failed 2.7.0 swarm lanes were candidate-harness failures, not evidence of an upstream scheduler regression. Candidate-only certification admitted execution, but bounded-policy and preactivation selectors rejected 2.7.0, leaving fresh swarm-off sessions. No real children or child-authored patch could result. The old ready URL remains available upstream; choosing the reviewed ephemeral JSON mode was not a required repair for that format.

The other four failures beyond the missing hash row were stale exact-version audit branches, not four new upstream safety regressions. Removed EnterPlanMode, `legacyHooks`, modern subscriber registration, and restore normalization already existed in the 2.6.x audit construction. The genuinely new structural issue was the move of the generic executor and loop into `packages/core`, outside the original seven scoped diffs. The adversarial reviewer separately identified the real `/api/v1/meta` break: 2.7.x removes `backend: "v2"`, which current activation required.

## Source audit

The pristine exact 2.7.2 tree was reviewed with nine scopes: the original CLI/executor/hooks/plan/bootstrap/tools/KAP scopes plus shared core execution and OS/remote/DI/host boundaries. The expanded core scope includes the moved tool executor, loop actor, tool/LLM retry and settlement code, structured error conversion, Klient facade, and ACP plan entry.

Final exact 2.7.2 scan: **38 pass / 0 fail / 0 skip / 527 assertions**. Exact 2.6.3 regression: **38 pass / 0 fail / 0 skip / 404 assertions**. The final row has **153 pins**: 62 unchanged inherited files, 53 modified inherited files, one moved loop actor, and additional reviewed core/KAP/CLI/Klient/ACP files.

The scan and human review establish:

- the active-plan guard remains the only production final `allow()` across agent-core, shared core, CLI, KAP, SDK, Klient, and ACP;
- every generic executor is constructed inside the managed agent composition, with starting, optional permitting, before-execute, then real execution in that order;
- no new model-reachable plan entry exists; host-only KAP/Klient/ACP entry remains explicit, while fresh print cancels the configured default and raw resume scans remain mandatory;
- restore still derives both views from each agent's `wire.jsonl`, with normalization unable to hide or synthesize plan records;
- external hooks remain eager in every child scope and first-block-wins aggregation and the strict hook schema remain unchanged;
- real moved implementations and compatibility re-exports are both pinned, including retry, settlement, recovery, rate-limit classification, and host-only task detachment;
- native normal-launch and rate-limit capacity remain distinct, so no upstream scheduler fix is claimed.

Four independent source reviews completed: hook contract, stream-json, and CLI surface returned COMPAT-PRESERVED; the adversarial review returned COMPAT-BROKEN on the KAP/meta and audit-coverage blockers later repaired here. Two initial investigators independently traced the harness and KAP causes. A later runtime-review lane exceeded its 15-minute budget and was stopped; its partial findings about omitted Klient/ACP and rate-limit evidence were verified and incorporated. Its partial output identified no runtime blocker, but it issued no final verdict.

## Exact-binary controls

All controls ran sequentially against the isolated exact binary. Real-model controls used the dedicated Agent Keys environment-model route and fresh absolute-path homes; personal config and credential stores were neither read nor linked.

- **Plan OFF:** ordinary Write reached the deny hook, returned `cert-control: denied` on the same call, created no file, recorded no plan state, and emitted exact first-line `system.version` 2.7.2.
- **Deliberately armed plan ON:** authenticated JSON/KAP activation armed an isolated session. Glob was denied; Write created a **1,310-byte plan file without a plan-Write hook**. No workspace file was created. This proves the no-plan closures remain load-bearing.
- **Forced EnterPlanMode:** the tool was absent from offered tools. The scripted call returned `Tool "EnterPlanMode" not found` on `call_enter_forced` before any hook, was returned to the provider, and created no plan journal or file.
- **Environment:** real JSON activation/deactivation passed. A configured remote default refused before its launcher ran, disabled workspace trust refused, and a resumed nonlocal binding refused.

One early OFF attempt was invalid: a relative artifact root caused upstream to resolve `KIMI_CODE_HOME` away from the deny-hook config, and the target was created only inside the ignored control workspace. It is retained as a harness diagnostic, not classified as an upstream bypass or valid evidence. All control scripts now resolve roots to absolute paths before spawning; the corrected fresh-home OFF control passed.

Receipts are `write-off-absolute/summary.json`, `plan-on/summary.json`, `enter-off-forced/summary.json`, and `environment-controls/summary.json` under `.claude/kimi-code-research/cert-2.7.2-live/`.

## Deterministic and real-provider operation evidence

The deterministic untouched-binary suite passed **23 tests / 138 assertions in 627.51 seconds**. It covers real new/resumed/odd waves, child-authored writes and patches, background denial, direct read/write workers, nested-profile refusal, timeout and cancellation tails, and both long recovery controls. `recovery-429` took 201.73 seconds; `recovery-context` took 199.72 seconds and reached peak four at width four with no remaining active turns. Implementation fingerprints were unchanged at launch and settlement.

The real-provider candidate matrix passed **30 tests / 406 assertions in 519.71 seconds**, with only the two inapplicable narrowed-refusal skips. The production-table matrix independently passed **30 tests / 406 assertions in 482.91 seconds**, with the same two intentional skips. Both used no personal home or credential store, and production used no candidate override.

Evidence includes:

- same-call managed Write denials for review, challenge, ask, and review_gate;
- confined rescue writing and a separate absolute out-of-root `Bash.cwd` denial;
- unsafe experimental, default-plan, and plan-tainted resume refusals;
- real multi-turn goal denials and both pursue terminal controls;
- real read-only child denials and write-swarm child edits with a **278-byte patch**, clean user tree, and cleaned worktree;
- real out-of-worktree child Write denials;
- direct single-worker read/write with no children or web activation, including a **292-byte candidate patch** and a **348-byte production patch**;
- directed recovery from an oversized wave, then two bounded waves with four children and candidate/production patches of **596/708 bytes**;
- uncoached five-target production work at width four: two accepted waves, five candidate children and four production children, peak three/two, zero coordinator-authored targets, and patches of **759/871 bytes**. Grouping multiple targets into one child is valid; one child per target is not required.

Candidate retained evidence is under `candidate-live-evidence/`; production retained evidence is under `production-live-evidence/`.

## Focused implementation and emitted-runtime checks

- Activation and policy: **260 pass / 944 assertions**, plus typecheck.
- Promoted engine/setup/CLI suites: **261 pass / 5,833 assertions**.
- Setup alone before promotion: **134 pass / 4,811 assertions**, including exact schema acceptance and neighboring-version refusal.
- Emitted-JS policy and durable recovery: **19 pass / 186 assertions**, including exact 2.7.2 hard-kill recovery.
- Compiled distributions' operation scope: **2 pass / 5 assertions**.
- Generated-surface check: PASS.

Exact 2.7.2 uses `web --json` with an in-memory ephemeral token, strict loopback origin and matching `/api/v1/ws`, KAP 1.0.0 and WebSocket capability, exact server version, and no auth bypass or legacy backend field. Older ready/meta formats are unchanged. Fresh print explicitly selects `--environment local`; resume never receives that flag. Bounded policy, preactivation, direct-worker selection, additive schema acceptance, and durable recovery all use exact versions with no 2.7.x range inheritance. Exact 2.7.0, 2.7.1, and 2.7.3 remain excluded.

## Certification validation and review

Full repository, package, consumer-security, and final independent code/documentation review results are recorded below. They are not inferred from the operation matrices.

- **Frozen install and full repository gate:** PASS. `bun install --frozen-lockfile` completed with no changes. The definitive `bun run check` passed **1,848 tests / 83 expected opt-in or platform skips / 0 failures / 24,260 assertions in 615.90 seconds**, covering 1,931 tests across 96 files, including emitted-JavaScript and generated-drift gates.
- **Package and DSH:** PASS, exit 0. `bun run check:package` verified the **341-file** `kimi-plugin-cc@2.6.3` archive, all three compiled distributions, isolated hook setup/check and version refusal, the patched DSH host/profile, seven live providers/tools, and Web boot. Receipt: `.claude/kimi-code-research/cert-2.7.2-live/package-check.log`.
- **Consumer security:** PASS, exit 0. `bun run check:consumer-security` verified the isolated npm consumer security of `kimi-plugin-cc@2.6.3`. Receipt: `.claude/kimi-code-research/cert-2.7.2-live/consumer-security.log`.
- **Final independent code and documentation review:** PASS. Both reviewers returned documentation findings only; no blocker or major runtime/code defect. Activation, checklist, publication-boundary and update-suppression wording was corrected, and narrow re-review of both lanes returned NO FINDINGS.

## Plugin 2.7.2 release validation

- **Frozen install and full repository gate:** PASS. `bun install --frozen-lockfile` completed with no changes. The release `bun run check` passed **1,848 tests / 83 expected opt-in or platform skips / 0 failures / 24,260 assertions in 611.46 seconds**, covering 1,931 tests across 96 files, including emitted-JavaScript and generated-drift gates. Receipt: `.claude/kimi-code-research/release-2.7.2/full-check.log`.
- **Package and DSH:** PASS, exit 0. `bun run check:package` verified the **342-file** `kimi-plugin-cc@2.7.2` archive, all three compiled distributions, isolated hook setup/check and version refusal, the patched DSH host/profile, seven live providers/tools, and Web boot. Receipt: `.claude/kimi-code-research/release-2.7.2/package-check.log`.
- **Consumer security:** PASS, exit 0. `bun run check:consumer-security` verified the isolated npm consumer security of `kimi-plugin-cc@2.7.2`. Receipt: `.claude/kimi-code-research/release-2.7.2/consumer-security.log`.
- **Independent release-diff review:** PASS after correction. The reviewer found the stale 2.6.3 version headline in `docs/invariants.md`; it was corrected to 2.7.2. No other release-blocking finding was returned.

## Release and registry receipt

Release commit `e2bba0e2d4e1745e4155eb5c6ddf3f4dabaffb66` passed release CI run `44799772434`, including both Linux/full-package and Windows jobs. The immutable [v2.7.2 GitHub release](https://github.com/linxule/kimi-plugin-cc/releases/tag/v2.7.2) is anchored at that commit with annotated tag object `cdbd0d179a8fafd41019230a655887e035453670`.

Initial OIDC run `44801159950` passed the full tag build, package/DSH checks, consumer audit and artifact upload, but npm rejected publication with `TLOG_CREATE_ENTRY_ERROR`; registry inspection confirmed it published nothing. The documented manual-dispatch recovery [run 44803040496](https://github.com/linxule/kimi-plugin-cc/actions/runs/44803040496) validated the same immutable tag and published npm `latest` 2.7.2 at `2026-11-20T19:44:23.172Z`.

The **342-file** registry tarball is byte-identical to the successful Actions artifact, and every published file matches the release tag:

- SHA-1: `c78a89fa5ea199c6605c7453ca50b2c23ee3cb3f`
- SHA-256: `0a0bcba76513adac3448776d4f8df9ec73b60987edac0ca5e6535db428b91f33`
- SHA-512: `2e7dfe8043c2c05447a28dbfc17c6124c6b08444efb864c5b5f5f3f586f338ff4b77d35e3b769168b570a32c08bec48e8f78aa6e11b958e9f22257cda29616f1`

SLSA provenance log index `4028226284` and publish attestation log index `4028244850` match the package subject, SHA-512, recovery run and release commit. Their workflow ref is `refs/heads/main` because recovery used `workflow_dispatch`; the artifact and all published bytes independently match `refs/tags/v2.7.2`. Fresh registry installation has zero production advisories and no invalid or missing signatures. Isolated Claude Code, Codex and DSH setup/check pass against exact stock CLI 2.7.2, and all three installed runtime maps enforce full 2.7.2 certification with 2.6.0 non-swarm-only scope. Verification made no model calls and changed no installed host or operator pin. Receipts are under `.claude/kimi-code-research/release-2.7.2/registry/`.

The post-publication DSH Discover timestamp is `1795203863`, recording the actual npm publication time.

## Residual boundaries

The concurrency bound covers simultaneous Kimi child-agent turns, excluding the coordinator and OS subprocess counts. `--cap` remains a soft lifetime-total hint, and a finite time budget is not a spend cap. Upstream rate-limit recovery can still exceed its native setting; the plugin-owned bound is required. Parallel sessions retain the native TaskStop restriction after deactivation, and later external interactive resume is outside this certification. Stream-json still lacks a general execution-outcome field, so hook-escape findings remain detection evidence rather than a failure signal. `KIMI_CODE_NO_AUTO_UPDATE=1` suppresses passive updates but does not prevent every manually staged native replacement; exact probe and first-line marker checks remain the mismatch backstop, not rollback. Trusted operator config/journals, upstream hook-runner fail-open behavior, host-only plan routes, and repository Git helpers retain their existing boundaries.
