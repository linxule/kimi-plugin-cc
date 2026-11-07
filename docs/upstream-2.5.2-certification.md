# Kimi Code 2.5.2 certification evidence — 2026-11-07

## Status and exact source

**Exact CLI 2.5.2 is certified for all eight operations by plugin 2.5.6.** The exact-source audit, non-vacuous plan/environment/swarm controls, candidate matrix, production-table matrix, frozen install, full repository check, package validation and isolated consumer-security audit passed. An independent read-only Codex review raised no safety or bypass finding. It caught a too-strong sentence about pending tools, stale activation lists in `docs/ci.md` and `docs/safety.md`, and regenerated distributions still pending at review time; all are corrected here.

Candidate: `@moonshot-ai/kimi-code@2.5.2`, release commit `1c142a007c10e881602690def96057c23a2baa12`, compared with certified 2.5.1 (`1b02030d8c2c6b00131b23ebb67a231614877827`). npm publication: 2026-11-06T07:54:31.132Z. An isolated npm installation and its executable both report 2.5.2; its `dist/main.mjs` SHA-256 is `b158343c177414e2a615116a96e193b333ca183bb0ee9569e51b0f4569e3a23e`. The seven scoped 2.5.1→2.5.2 diffs and the out-of-scope diffs are retained under `.claude/kimi-code-research/daily-monitor/2026-11-07-2.5.2-diffs/`.

## Source and integration review

- All seven playbook scopes are empty: print/CLI, before-execute and permission gates, external hooks, plan/restore, session bootstrap/config/workspace, tools/fan-out/SDK, and swarm/web activation.
- Outside those scopes, 2.5.2 changes six agent-core-v2 files: MCP tool registration (`agent/mcp/mcpService.ts`), the tool registry's new active/pending split (`agent/toolRegistry/*`), tool-select reconciliation with a `tool_update_pending` reminder (`agent/toolSelect/*`), and signature helpers moved into `tool/toolContract.ts`. Web assets and the package version also change.
- A new name registers as active immediately. A registration becomes pending only when an active tool with the same name exists and its definition signature differs; a same-signature replacement swaps in place. The pending replacement is held outside the active map, and `ToolRegistryService.resolve()` reads only active tools, so a call by that name runs the existing active implementation until reconciliation promotes the replacement. Every active tool runs through the unchanged executor and its single `fireBeforeExecute` emitter, so the PreToolUse payload still carries the original call name. Tool names, and the field names the approval policy reads, are unchanged.
- All 40 pinned files are byte-identical to 2.5.1. The exact-tag scan passed **18 tests and 153 assertions** on 2.5.2, with the print, environment/workspace-trust and WebSocket checks executing. The 2.5.1 and 2.5.0 source scans pass again with the same counts.
- The exact-version branches now include 2.5.2: the production table, swarm preactivation and protocol-v2 agent state, fresh `--environment local`, and the reviewed hook schema. 2.5.3, prerelease and build-suffixed versions stay refused. Focused engine, activation, CLI, setup and version-probe tests passed **331 tests with 0 failures**.

## Exact-binary controls

Controls used the read-only Agent Keys API key, resolved only into each process, and empty isolated homes with absolute paths. The forced removed-tool control instead used a loopback scripted provider. No personal config or OAuth store was read, copied or symlinked. Controls ran sequentially, and a scan of the evidence tree found no key material. Raw evidence is under `.claude/kimi-code-research/cert-2.5.2-live/`.

- **Plan OFF Write:** the exact 2.5.2 marker came first. Write reached the custom deny-all hook and was denied; no target file or plan state was created.
- **Plan ON:** an armed plan journal let Glob reach the deny hook, and a **1,656-byte** plan file was written without a plan-Write hook invocation. This shows the bypass the no-plan closures exist to prevent. The workspace stayed empty.
- **Removed EnterPlanMode:** EnterPlanMode was absent from the offered tools. A forced call was rejected on the same call ID before any hook ran, and the rejection was returned to the provider. No plan state or files appeared.
- **Environment:** real activation and deactivation passed with the explicit local binding. A remote default, disabled workspace trust and a resumed remote binding each refused before spawn.
- **Swarm OFF:** a real AgentSwarm call returned the inactive-mode result with zero child journals and no probe files.
- **Swarm ON:** preactivation produced `agent-0` and `agent-1`. Each child's assigned Write was matched to a managed-denial result on the same toolCallId, no probes landed, and deactivation was verified with ambient idle reclamation set to 1 ms.
- **Out-of-root control:** child Writes outside the root were denied on their own call IDs, created no files, and deactivation was verified.

## Candidate and production matrices

Both matrices ran through the new pre-authorized monitor route, `~/.local/bin/kimi-plugin-cc-monitor-smoke`. It installs the exact binary once under `~/.cache/kimi-plugin-cc-monitor/` (same `dist/main.mjs` SHA-256 as above), uses the read-only Agent Keys API key, seeds from an empty temp home and redacts the log.

- **Candidate** (`candidate-smoke.log`, `KIMI_PLUGIN_CC_SMOKE_V2_CANDIDATE=2.5.2`): **24 tests with 167 assertions and no skips in 391.42 seconds**. Review, challenge, ask and review_gate each received a same-call managed Write denial. Real rescue confinement, the Bash.cwd denial, resume and plan-taint refusal, and both pursue outcomes passed. Six goal turns each had a managed Write denial, and the goal workspace was empty at settlement. Write-swarm captured a **278-byte** child-authored patch with a clean user tree and removed worktree, and denied the out-of-root write.
- **Production table** (`production-smoke.log`, candidate override unset): **24 tests with 167 assertions and no skips in 399.68 seconds**. It independently repeated the same evidence. Six of seven goal turns carried managed denials; the seventh was cut by the budget abort, and the workspace was empty at settlement. Write-swarm again captured a 278-byte patch.

A scan of both logs found no key material.

## Repository and package gates

Frozen dependency installation made no changes. The full `bun run check` passed **1,429 tests with 33 expected opt-in skips, 0 failures and 18,662 assertions across 82 files in 356.03 seconds**, including the generated-distribution drift gate. Package validation passed **331 files**, all three compiled distributions, isolated hook setup/check and version refusal, and a patched DSH host/profile with seven live providers/tools and Web boot. The isolated npm consumer-security audit passed. Logs: `check-standard.log`, `package-standard.log`, `consumer-security.log`, `tag-scan*.log` and `binary-sha256.txt` under `.claude/kimi-code-research/cert-2.5.2-live/`.
