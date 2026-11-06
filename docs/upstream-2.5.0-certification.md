# Kimi Code 2.5.0 certification evidence — 2026-11-05

## Status and exact source

**Exact CLI 2.5.0 is certified for all eight operations by the plugin 2.5.2 working tree.** The exact-source audit, non-vacuous plan and swarm controls, local-environment controls, candidate matrix, and production-table matrix passed. Repository and package validation results are recorded below as they complete. Commit, push, tag, publication, installed-host rollout, and operator CLI pin changes are outside this certification slice and were not performed.

Candidate: `@moonshot-ai/kimi-code@2.5.0`, release commit `41c341434ae24e45bfe0f2232ec11b80531ac717`, compared with certified 2.4.1 (`2c73f3f50af4fa7f2540ca0d2e33b07a1408e3a7`). The monitor recorded npm publication at 2026-11-04T11:59:13.163Z. A temporary isolated npm installation and its executable both report 2.5.0. The clean exact source checkout was verified at that commit; the seven scoped 2.4.1→2.5.0 diffs are retained under `.claude/kimi-code-research/daily-monitor/2026-11-05-2.5.0-diffs/`.

## Source and integration review

Four independent source lanes reviewed hooks/plan, CLI/bootstrap, tools/fan-out, and activation adversarially. The hook/plan lane returned COMPAT-PRESERVED. Other lanes identified the removed status route, remote execution defaults/bindings, and the workspace-trust bypass; those findings drove fail-closed repairs rather than certification by assertion. A separate runtime diff review returned APPROVE with no correctness defects.

- The expanded exact-tag scan passed **18 tests and 153 assertions across 40 pinned files**, including the SDK, remote-environment implementation, workspace trust/MCP, upgrade authentication, and WebSocket state surfaces. The sole final allow remains active-plan-gated, every model tool execution retains the managed before-execute path, and EnterPlanMode remains removed.
- Exact 2.5.0 activation uses authenticated protocol-v2 WebSocket main-agent state with unique request IDs, an accepted subscription, and the latest frame through intentional bounded close. Earlier certified versions retain `/status`. Focused activation passed **67 tests with 228 assertions**, including wrong identities, request IDs, optional fields, malformed/oversized frames, contradictory state, timeouts, and local-binding failures.
- Fresh 2.5.0 print selects `--environment local`; resume never receives that flag. Launcher environment selectors are refused. Remote defaults and disabled workspace trust refuse before spawn. Resume inspection covers persisted metadata and every agent journal, requiring local execution and the expected root, including omitted-metadata-`environmentId` and swarm-write worktrees. Activation and deactivation independently re-read the authenticated local binding before either profile mutation.

## Exact-binary controls

Controls used a task-authorized Agent Key in process memory/environment and empty isolated homes, except the forced removed-tool control, which used a loopback scripted provider and a dummy key. No personal config or OAuth store was read, copied, or symlinked. Controls ran sequentially; completed evidence homes had credential-bearing config removed afterward. Raw evidence is under `.claude/kimi-code-research/cert-2.5.0-live/`.

- **Plan OFF Write:** the exact 2.5.0 marker was first; Write reached the custom deny-all control hook and was denied on the same call ID. No target file or plan state was created.
- **Plan ON:** authenticated agent state independently proved `plan_mode:true`, auto permission, and the env-model alias before resume. Glob reached the deny hook; a **1,459-byte** plan file was written without a plan-Write hook invocation. The workspace remained empty.
- **Removed EnterPlanMode:** the offered tools included Write but not EnterPlanMode. A scripted provider forced `call_enter_forced`; the exact binary returned `Tool "EnterPlanMode" not found` on that ID before any hook call and returned the rejection to the provider. No plan state or files appeared.
- **Environment:** real activation and deactivation passed with the explicit local binding. A configured remote default refused before its command launcher ran, disabled workspace trust refused before spawn, and a resumed remote binding refused before spawn. The implementation also passes focused omitted-id and wrong-root checks.
- **Swarm OFF:** a real AgentSwarm call returned the inactive-mode result with zero child journals and no probe files.
- **Swarm ON:** preactivation produced `agent-0` and `agent-1`; each child attempted its assigned Write with a matching managed-denial result under the same toolCallId. No probes landed, and deactivation verified `swarm_mode.exit` with the idle-reclaimer override.
- **Out-of-root control:** an evidence-preserving run correlated two distinct child Writes with rescue denials on their assigned call IDs, created no files, and verified deactivation.

## Candidate and production matrices

- Expanded candidate matrix (`candidate-smoke-final.log`): **24 pass, 0 fail, 167 assertions, no skips**, 396.89 seconds. Real `runRescue` landed the confined sentinel and persisted operation/version/engine/session/artifact evidence. The absolute out-of-root Bash.cwd call received its exact same-call denial and created no file. Write-swarm produced a 278-byte child-authored patch, left the user tree clean, removed its worktree, and denied the out-of-root write.
- Expanded production-table matrix (`production-smoke.log`) with the candidate override explicitly unset: **24 pass, 0 fail, 167 assertions, no skips**, 326.30 seconds. The same confinement, provenance, resume, pursuit, fan-out, patch, and negative-write checks passed.
- Candidate and production goal controls produced same-call managed denials across distinct turns and left the workspace empty at settlement.
- The earlier candidate attempt passed 23 of 24 lanes but was rejected as incomplete. The fresh final candidate run above supersedes it. Invalid diagnostic fixtures using relative or symlink-alias cwd were also rejected as control evidence, not counted as product failures.

## Repository and package gates

Frozen dependency installation made no changes. The literal standard `bun run check` passed **1,404 tests with 33 expected opt-in skips, 0 failures, and 17,999 assertions across 82 files in 336.44 seconds**, including the generated-distribution drift gate. Package validation passed **329 files**, all three compiled distributions, isolated hook setup/check and version refusal, a patched DSH host/profile with seven live providers/tools, and Web boot. An isolated npm consumer-security audit also passed. The certification record is included in the archive. Independent documentation fidelity review identified nine documentation corrections and, after verifying the corrected files, returned **APPROVE** with no remaining must-fix findings. The fresh tag-scan log is retained at `.claude/kimi-code-research/cert-2.5.0-live/tag-scan-final.log`.

## Preserved boundaries

Certification remains exact and per-operation. Legacy-v1 ends at 0.41.x. Plan mode and unsafe experimental selectors remain refused. Local execution and workspace trust are mandatory, and resumed nonlocal or wrong-root bindings fail closed. Hook verification, trusted-root confinement, concurrency/defaults, one print runner, memory-only web tokens, finite budgets, process/session identity checks, deactivation, and recovery ownership are preserved. Existing Git trust and hook-process failure residuals remain documented; this release does not make the hook an OS sandbox. Publication does not install or re-pin either host.

## Release clean-close hardening

After the original certification, Linux release CI exposed a platform-specific early WebSocket close event that could be accepted as valid final agent state. The final runtime now requires `CloseEvent.wasClean` before accepting that state, and the mock performs a protocol-correct close handshake while retaining the timeout case. Focused activation validation passed **71 tests with 244 assertions**. On the exact 2.5.0 binary, direct OFF again produced no children, preactivated ON produced two children with correlated managed denials and verified deactivation, and the out-of-root control passed. The final full repository check passed **1,412 tests with 18,282 assertions and zero failures in 360.79 seconds**; 330-file package validation and isolated consumer security also passed. These results supplement the original certification evidence and cover the final release behavior.

A subsequent CI attempt showed that native WebSocket close scheduling and `wasClean` semantics vary by platform and cannot supply a deterministic no-close-event precondition. That timeout case now uses a controlled socket which completes the protocol exchange but never emits `close`, and asserts the exact `Kimi web agent-state verification timed out.` message. The refusal is therefore tested without relying on incidental host close timing; production behavior is unchanged by this test-only follow-up.

**Follow-up correction:** a later normal activation/deactivation fixture showed that `wasClean` can also reject a valid close. The production condition has been reverted on `main`, restoring the original certified bounded-close settlement; the controlled no-close-event test and protocol-correct mock handshake remain. The immutable 2.5.3 artifact contains the trial condition, so carrying this revert requires a new patch artifact rather than a re-tag or republish.
