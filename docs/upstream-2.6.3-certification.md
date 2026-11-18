# Exact CLI 2.6.3 certification — plugin 2.6.3

## Scope and decision

**Status: certified and published for all eight operations.** Exact `@moonshot-ai/kimi-code@2.6.3` passed the source, exact-binary, real-provider candidate, deterministic stock-binary, production-table operation, full repository, package, consumer-security and post-edit review gates. Plugin 2.6.3 release commit `597210fe888e045c15577dbfc112188075bf1ac5` passed exact-commit validation and release CI `44406363750`; immutable tag `v2.6.3` and the GitHub release are published. npm OIDC run `44407749059` published plugin 2.6.3, and fresh registry/archive/signature/attestation verification passed.

Plugin 2.6.3 is the latest published plugin release. Certification and publication do not change an installed host cache or move an operator CLI pin.

Exact source: `@moonshot-ai/kimi-code@2.6.3`, commit `b0de2fbd2de04d87689225aafd3912e5d193b62d` (annotated tag object `a9df46689649824abfdfff1528d7708a23fd3cf3`). The isolated npm binary reports 2.6.3; `dist/main.mjs` SHA-256 is `a360023b6814ffdf05bc87e40925df5e0442ae3076ad9e7b6ea6f771e2a1857c`.

## Monitor correction and candidate-harness diagnosis

The November 18 monitor correctly held certification after its candidate smoke failed three swarm lanes. The failure was not positive evidence of an upstream swarm regression:

- Candidate admission added 2.6.3 to the in-memory operation map, but `requiresSwarmPreactivation()` and `usesBoundedSwarmPolicy()` still recognized only 2.6.2.
- A deterministic retained control reproduced zero child journals. Its main journal showed every `AgentSwarm` call receiving the same-call `Swarm mode is off` result, so the engine was never asked to start children.
- Adding exact candidate activation/policy integration without adding the production certification row made the same read control pass with six children, peak four at width four. The write control passed with four children and a 600-byte patch.
- The real candidate matrix then passed all three originally failed lanes, including distinct child journals, child-authored work and out-of-root denials.

The monitor's seven scoped diffs also omitted changed loop, subagent, shell-command, tool-selection and agent-lifecycle files outside those filters. The full exact-tag diff was reviewed for this certification; those omissions are corrected in the evidence rather than treated as upstream defects.

The pre-diagnosis monitor log is retained as `.claude/kimi-code-research/cert-2.6.3-live/monitor-candidate-initial.log`. The corrected candidate log is `daily-monitor/smoke/2026-11-18-2.6.3-candidate.log`.

## Source audit

The pristine exact-tag clone has no uncommitted files or sync-conflict copies. The exact 2.6.3 scan passed **31 tests / 404 assertions / no skips**; the exact 2.6.2 regression scan passed **31 tests / 393 assertions / no skips**.

The 2.6.3 pin row inherits the reviewed 2.6.2 pins and replaces all 15 changed pinned file hashes. The scan proves:

- the plan-file guard remains the sole final `allow()` in the engine, CLI and SDK;
- the before-execute subscriber set, 2.6 executor ordering and managed veto path remain intact;
- restore still folds only the same two views of the wire journal, with no second durable plan source;
- fresh print cancels the default plan and EnterPlanMode remains absent;
- the external-hooks agent service remains eager in every agent scope and hook aggregation remains first-block-wins;
- tool schemas retain `path`, `command` and `cwd` where the managed policy reads them;
- fresh children remain swarm-off, owned resumes retain their session boundary, and native TaskStop disablement still closes Bash backgrounding.

`features/swarm/session/agentRunBatch.ts` is byte-identical to 2.6.2, SHA-256 `339dbd7962c3b9bac145aff83aee06d6e5f3c6b9e8c472d4f4f94d7fb26390fc`. No swarm scheduler, swarm web endpoint, DI child-scope or OS backend diff exists between exact 2.6.2 and 2.6.3. The upstream scheduler is not represented as fixed.

The additional lifecycle changes add tool origins, queued Stop hooks and task reconciliation. In 2.6.3, child fresh/retry completion shares `awaitRunCompletion`; `awaitQuiescent` waits for loop settlement and active tasks, while cancellation stops child tasks and suppresses their notifications. The tag scan asserts this implementation separately from 2.6.2 rather than merely accepting new hashes.

## Exact-binary controls

All controls ran sequentially against the isolated exact binary. Real-model controls used the dedicated Agent Keys environment-model route and empty temporary homes; personal config and credential stores were neither read nor linked.

- **Plan OFF:** ordinary Write reached the deny hook, returned `cert-control: denied` on the same call, created no file and recorded no plan state.
- **Deliberately armed plan ON:** Glob reached the deny hook; Write created a 1,678-byte plan file without a plan-Write hook. No workspace file was created. This proves the no-plan closures remain load-bearing; plugin execution never arms this path.
- **Forced EnterPlanMode:** the scripted call was absent from offered tools, returned `Tool "EnterPlanMode" not found` on `call_enter_forced` before any hook, returned that result to the provider, and created no plan journal/file.
- **Local execution:** real activation/deactivation passed. A configured remote default refused before its launcher ran, disabled workspace trust refused, and a resumed nonlocal binding refused.

Receipts are `write-off/summary.json`, `plan-on/summary.json`, `enter-off-forced/summary.json` and `environment-controls/summary.json` under the evidence root.

## Candidate operation and bounded-swarm evidence

The corrected real-provider candidate matrix passed **30 tests / 2 intentional narrowed-refusal skips / 0 failures / 390 assertions in 564.04 seconds**, terminal exit 0 at `2026-11-18T18:53:07Z`. The two skipped tests assert narrowed non-swarm production refusals that do not apply to a full-scope candidate; no execution lane skipped.

Evidence includes:

- same-call managed Write denials for review, challenge, ask and review_gate;
- real confined rescue writing and separate absolute out-of-root `Bash.cwd` denial;
- unsafe experimental, default-plan and plan-tainted resume refusals;
- 2,534 started goal turns, 2,533 turns with managed denials and no target file, plus both pursue terminal controls;
- real read-only child denials and write-swarm child edits with a 306-byte patch, clean user tree and cleaned worktree;
- real out-of-worktree child Write denials;
- direct single-worker read/write with no children or activation, including a 348-byte write patch;
- directed recovery from an oversized wave, then two bounded waves with four children and a 596-byte patch;
- uncoached five-target production work at width four: two accepted waves, five children, peak three, zero coordinator-authored targets and a 759-byte patch.

The deterministic untouched-binary suite passed **23 tests / 0 failures / 138 assertions in 616.19 seconds**. It covers new/resumed waves, odd target grouping, both nested profiles, invalid resumes, read/write cancellation, active HTTP/tool budget expiry, native background-policy closure, direct-worker background behavior and 429/context recovery beyond the native 180-second interval. Every case runs in an isolated process with a scripted local provider and verifies process/provider quiescence before teardown.

The expanded activation fixture initially timed out all new 2.6.3 cases because the mock still routed 2.6.3 to the older hello/`subscribe_v2` protocol. Updating the fixture to the reviewed direct-subscription protocol passed all **24 focused 2.6.3 tests / 76 assertions**. This was a test-fixture correction, not a runtime workaround.

## Production and release validation

The production-table matrix passed **30 tests / 2 intentional narrowed-refusal skips / 0 failures / 390 assertions in 529.18 seconds**, terminal exit 0 at `2026-11-18T19:31:03Z`. It ran with `candidate=(production table)` and no `KIMI_PLUGIN_CC_SMOKE_V2_CANDIDATE` override. Real evidence includes a 278-byte child-authored patch, out-of-root child denials, direct-worker read/write, two directed bounded waves, and an uncoached five-target run with two grouped children, peak two, no coordinator-authored targets and an 899-byte patch. Grouping multiple targets into one child is valid; it is not a requirement that each target have a separate child. The log is `daily-monitor/smoke/2026-11-18-2.6.3-production.log`.

Final validation receipts:

- **Frozen install and full repository gate:** PASS. `bun install --frozen-lockfile` exited 0. The definitive `bun run check` passed **1,797 tests / 76 expected opt-in or platform skips / 0 failures / 23,469 assertions**, covering 1,873 tests across 96 files in 623.26 seconds, including emitted-JavaScript and generated-drift gates. The first workspace attempt stopped on 23 ignored iCloud-style ` 3.js`/`LICENSE 3` generated-output conflict copies; they were reversibly quarantined under the evidence root and the same standard gate rerun. No assertion was removed or skipped to obtain the final result.
- **Package and DSH:** PASS. The 341-file package contains the new certification record, all three compiled distributions, isolated setup/check, unsupported-version refusal and MCP checks. Patched DSH host/profile auditing, seven providers/tools and Web boot passed.
- **Consumer security:** PASS. `bun run check:consumer-security` verified an isolated npm consumer installation without host credentials or model calls.
- **Post-edit review:** PASS. The independent runtime/test reviewer returned NO FINDINGS. The documentation reviewer returned two major and three minor findings; all were verified and corrected, and narrow re-review found all five resolved with no new must-fix. Final source/docs diff review preserved the pre-existing user edit in the 2.6.2 historical record.

## Release and registry receipt

The exact release commit `597210fe888e045c15577dbfc112188075bf1ac5` passed the isolated full gate with **1,797 passes / 76 expected skips / 0 failures / 23,469 assertions in 580.54 seconds**, the 341-file package/DSH and consumer-security gates, and the production real-provider matrix with **30 passes / 390 assertions in 481.45 seconds**. Release CI run `44406363750` passed both Linux and Windows jobs.

The immutable [v2.6.3 GitHub release](https://github.com/linxule/kimi-plugin-cc/releases/tag/v2.6.3) is published at that commit. OIDC run `44407749059` passed build and publication; npm `latest` is 2.6.3, published at `2026-11-18T22:14:06.914Z`. The 341-file registry tarball is byte-identical to the Actions artifact, and every published file matches the release tag:

- SHA-1: `63047ceab5c0b84da362788609e6f644b56a3414`
- SHA-256: `a64386f3cebf0f77d40f8d767f5533652f2fa91ba647b816876d8935bb2b1721`
- SHA-512: `37f68e1e0f53fe658a9801418d748067eb84849be76e53988231e2b81efdac18cc4a9eea0496677e9f6af584a1e5709ca6aeba7a1198135d1b12910245017e90`

SLSA provenance log index `3979478928` and publish attestation log index `3979539697` match the package subject, SHA-512, `refs/tags/v2.6.3`, release commit and publish workflow run. Fresh registry installation has zero production advisories and no invalid or missing signatures. Isolated Claude Code, Codex and DSH setup/check pass against stock CLI 2.6.3, and all three installed runtime maps enforce full 2.6.3 certification with 2.6.0 non-swarm-only scope. Verification made no model calls and changed no installed host or operator pin.

The DSH Discover timestamp is `1795040046`, recording the actual npm publication time. No installed-host setup or operator pin change is implied by certification or publication.

## Residual boundaries

The bound covers simultaneous Kimi child-agent turns, excluding the coordinator and OS subprocess counts. `--cap` remains a soft lifetime-total hint and a finite time budget is not a spend cap. Parallel sessions retain the native TaskStop restriction after deactivation; later external interactive resume is outside the managed-job certification. Stream-json still lacks a general execution-outcome field, so hook-escape findings remain detection evidence rather than a failure signal.
