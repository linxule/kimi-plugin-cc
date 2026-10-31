# Kimi Code 2.4.1 certification evidence — 2026-10-31

## Status and exact source

**Exact CLI 2.4.1 is certified for all eight operations by plugin 2.4.5.** The exact-source gate, non-vacuous plan and swarm controls, expanded candidate and production matrices, literal standard `bun run check`, final edited-byte package, and independent Codex/Kimi reviews all passed. CI, commit, push, tag, publication, installed-host rollout, and operator CLI pin changes are not performed in this certification slice.

Candidate: `@moonshot-ai/kimi-code@2.4.1`, release commit `2c73f3f50af4fa7f2540ca0d2e33b07a1408e3a7`, compared with certified 2.4.0 (`f26e4d91ef8d5d233f6c20b42a150f96924d4f5e`). npm published the candidate at 2026-10-30T09:55:26.630Z; its npm tarball SHA-1 is `660debae9ff145564c670fcc32444aed5cc7ab79`. A temporary isolated npm installation and its executable both report 2.4.1. The clean exact source checkout is `.claude/kimi-code-research/kimi-code-2.4.1-audit`.

## Source review

Codex's 2026-10-31 monitor supplied seven scoped diffs as leads. The main-thread certification review also covered every changed production TypeScript file, the complete release delta, Read's token helpers, profile composition, goal injection, DI and OS backends, wire reload/migrations, KAP activation dependencies, alternate final-allow spellings, and indirect plan entry. The synthesis is retained at `.claude/kimi-code-research/reports/2026-10-31-2.4.1-source-synthesis.md`.

- The exact-tag scan passed **15 tests and 96 assertions**. All 15 load-bearing files are byte-identical to 2.4.0. The plan-file guard remains the sole production final allow; executor/subscriber order, hook schema/aggregation, eager child hooks, Write/Edit `path`, Bash `command`/`cwd`, stream shapes, CLI argv, and AgentSwarm behavior remain compatible.
- Plan changes are reminder/profile prompts only. `EnterPlanMode` remains removed, fresh print still cancels configured default plan, and resumed plan sessions remain possible. The plugin retains its config preflight, Enter/ExitPlanMode deny policy, and every-agent journal-taint refusal.
- Goal injection adds full/sparse reminder selection using context history, not another goal tool, executor route, terminal exit, or budget mechanism. Read lowers the default maximum to 100,000 characters and adds estimated-token-aware pagination. Write/Edit success notes and Bash rendered guidance do not change their input schemas or execution gates.
- DI scope creation, OS backends, wire reload/migrations, KAP source, and the CLI/web activation surfaces are unchanged. No early session announcement or tool execution outcome was added; existing recovery and detection ambiguity remain.

## Exact-binary controls

Controls used a task-authorized dedicated Agent Key in process memory/environment and empty isolated homes, except the forced removed-tool control, which used a loopback scripted provider and a dummy key. No personal config or OAuth store was read, copied, or symlinked. All live controls ran sequentially. The plan and removed-tool controls install a custom deny-all control hook; the plugin's managed hook is separately installed and proved by the operation smoke. Raw evidence is under `.claude/kimi-code-research/cert-2.4.1-live/`.

- **Plan OFF Write:** the exact 2.4.1 marker was first; Write reached the custom deny-all control hook and was denied on the same call ID. No target file or plan state was created.
- **Plan ON:** an authenticated loopback session was explicitly placed in plan mode, shut down cleanly in 5.638 seconds, and resumed with a deny-all hook. The exact marker and `plan_mode.enter` were present. Glob and ExitPlanMode reached the deny hook; a **1,831-byte** plan file was written without a plan-Write hook invocation. The workspace remained empty.
- **Removed EnterPlanMode:** the offered tools included Write but not EnterPlanMode. A scripted provider forced `call_enter_forced`; the exact binary returned `Tool "EnterPlanMode" not found` on that ID before any hook call and returned the rejection to the provider. No plan state or files appeared.
- **Swarm OFF:** a real AgentSwarm call returned the inactive-mode result with zero child journals and no probe files.
- **Swarm ON:** after adding the reviewed exact 2.4.1 activation selector and rebuilding, compiled activation produced `agent-0` and `agent-1`; each child attempted its assigned Write with a matching managed-denial result under the same toolCallId. The coordinator did not substitute writes, no probes landed, and deactivation verified `swarm_mode.exit`. Parent `KIMI_CODE_SESSION_IDLE_RECLAIM_MS=1` confirmed the child environment's `0` override remains effective.
- Focused activation passed **36 tests and 130 assertions**. The focused setup/engine/activation set after the production row passed **142 tests and 2,282 assertions**.

### Invalid setup attempts, not accepted as evidence

- The first forced removed-tool run passed every safety assertion but failed `noWorkspaceFiles` because a relative artifact root made the child create its relative Kimi home beneath the workspace. A fresh run with an absolute artifact root passed all checks; the fixture failure is not counted.
- The first combined swarm control passed OFF, then ON refused before any model call because `PREACTIVATION_VERSIONS` did not yet include 2.4.1. The unchanged KAP source justified adding only that exact activation selector. The focused activation suite and fresh ON control then passed. The refused attempt is not ON evidence.

## Candidate and final gates

- Expanded candidate matrix (`candidate-smoke.log`): **21 pass, 0 fail, 154 assertions, no skips**, 410.84 seconds. Real `runRescue` landed the confined sentinel and persisted operation/version/engine/session/artifact evidence. The absolute out-of-root Bash.cwd call received its exact same-call denial and created no file. Eight goal turns produced none of the three named goal files. Write-swarm produced a 278-byte child-authored patch, left the user tree clean, removed its worktree, and denied the out-of-root write.
- Frozen dependency installation made no changes; `bun audit` found no vulnerabilities. Typecheck, contract-size, and generated-surface checks passed before the production matrix.
- Compiled acceptance/refusal controls passed under Node and Bun against both root and Codex distributions: every operation accepts exact 2.4.1 and normalized `v2.4.1`; 2.4.2, prereleases, build metadata, and mismatched hook-schema components refuse.
- Expanded production-table matrix (`production-smoke.log`) with the candidate override explicitly unset: **21 pass, 0 fail, 154 assertions, no skips**, 453.88 seconds. Real rescue and deterministic Bash.cwd passed the same confinement and provenance assertions. Twelve goal turns produced none of the three named goal files. Write-swarm captured a 278-byte child-authored patch, left the user tree clean, and removed its worktree.
- Initial full repository check passed **1,315 tests with 30 expected opt-in skips, 0 failures and 17,073 assertions across 79 files** in 320.46 seconds. Initial package validation passed **232 files**. Subsequent iCloud-style `* 2` duplicates in root `dist/vendor` were verified byte-identical to canonical generated files and quarantined; the runtime mirrors match again.
- Earlier review iterations (`production-review-smoke.log` and `goal-final-smoke.log`) passed **23 tests and 163 assertions** and a goal-only test respectively, but their Bash-inclusive goal evidence is **not accepted for certification**. The final edge-hardened matrix below supersedes those goal claims. Other operation evidence from those runs remains useful.
- Clean full repository check (`check-review-final.log`) after review fixes: **1,317 pass, 30 expected opt-in skips, 0 fail, 17,314 assertions across 79 files**, 321.00 seconds. Clean package validation (`package-review-final.log`) passed **233 files**, both compiled distributions, isolated hook setup/check, version refusal, and modern/legacy MCP controls. `docs/upstream-2.4.1-certification.md` is confirmed in the archive.
- Codex's targeted re-review requested genuine error results, legacy-compatible turn starts, and a whole-workspace settlement assertion. A subsequent review added marker-prefix, call-derived turn-ID, and directory-entry requirements. The final production matrix (`production-prefix-smoke.log`) passed **24 tests and 167 assertions with no skips in 440.66 seconds**. All seven call-derived turn IDs had same-call Write denials with `isError: true` and the managed-message prefix, and the entire workspace was empty at settlement.
- Literal standard `bun run check` (`check-standard-final.log`): **1,318 pass, 30 expected opt-in skips, 0 fail, 17,319 assertions across 79 files**, 358.83 seconds. Earlier parallel attempts hit timing-sensitive lifecycle failures; the focused suites and a complete serial run passed before the literal standard gate also passed. Codex's final targeted re-review returned **APPROVE**, closing all original and subsequent findings. Final edited-byte package validation (`package-standard-final.log`) passed **233 files** and includes this record.

## Release and publication

Plugin 2.4.5 was committed as `de8c195c2986443a088b674717133b164d2e4ef2` and pushed to `main`. [Release-commit CI 41226096281](https://github.com/linxule/kimi-plugin-cc/actions/runs/41226096281) passed the full check/package and Windows spawn jobs. Annotated tag `v2.4.5` and [GitHub release](https://github.com/linxule/kimi-plugin-cc/releases/tag/v2.4.5) were created. [Publish workflow 41226438326](https://github.com/linxule/kimi-plugin-cc/actions/runs/41226438326) passed its build and npm publish jobs.

The registry tarball has SHA-1 `39f97a6de4b26ad51ac77305054682fcd5cd0164`, contains 233 files, and matches the CI artifact byte-for-byte. Fresh npm registry installations passed isolated setup/check and unsupported-version refusal for both hosts, and the compiled mirrors are byte-identical to the release checkout. Structured proof is retained at `.claude/kimi-code-research/release-2.4.5/registry-verification.json`. Installed hosts and operator CLI pins remain unchanged.

## Preserved boundaries

Certification remains exact and per-operation. Legacy-v1 ends at 0.41.x. Plan mode and unsafe experimental selectors remain refused. Hook verification, trusted-root confinement, concurrency/defaults, one print runner, memory-only web tokens, finite budgets, process/session identity checks, deactivation, and recovery ownership are unchanged. Existing Git trust and hook-process failure residuals remain documented; this release does not make the hook an OS sandbox. Publication does not install or re-pin either host.
