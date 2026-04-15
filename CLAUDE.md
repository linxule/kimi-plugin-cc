# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

**0.1.7 shipped.** The plugin has been feature-complete since phase 3b and has since shipped a sequence of targeted releases: 0.1.1 (release tooling + version constant), 0.1.2–0.1.3 (post-phase-3 audit cleanup), 0.1.4 (migration + drop-in install prep + `node:sqlite` swap), 0.1.5 (session-title integration with kimi web), 0.1.6 (`adversarial-review → challenge` rename), **0.1.7 (rescue pass-through refactor)**. Each release landed on `main`; 0.1.7 is the first with a `v*` tag.

The source of truth is `docs/spec.md` plus the ADRs. Runtime code lives under `runtime/` and is built against the spec. `commands/`, `agents/`, `hooks/`, `skills/`, and `scripts/` hold the Claude-facing shell. Do not reopen locked decisions from `docs/spec.md` without raising them explicitly — the spec is the contract the whole runtime was built against.

## Commands

- `bun run check` — rebuilds `dist/`, runs `tsc --noEmit`, the full `bun test` suite (109 tests / 18 files as of 0.1.7, covering wire client, allowlist, command handlers, replay, review gate, job lifecycle, installed-script wrappers, session-title integration, rescue pass-through, phase migration), then runs `git diff --exit-code -- dist` as a drift gate. If the rebuild produced unstaged changes in `dist/`, check fails — stage the rebuilt files and retry. This catches forgotten rebuilds before they ship.
- `bun test <path>` — run a single test file
- `bun run build` — compile `runtime/**/*.ts` → `dist/**/*.js` via `tsc -p tsconfig.build.json` (preserves directory structure; no bundling). `dist/` is committed so installed plugins don't need a build step.
- The companion is launched via `scripts/companion.sh <subcommand> <args>`, which cd's to `${CLAUDE_PLUGIN_ROOT}`, resolves `node` via `KIMI_PLUGIN_CC_NODE_BIN` or `command -v node` (fails with an actionable error if neither is available), and runs `node dist/companion.js`. Slash commands and the Stop hook both route through that wrapper. The runtime is pure JavaScript post-install — no `tsx` required at runtime.
- Dev tests run from source via bun's native TypeScript loader. The `rescue.ts` background worker spawn checks `import.meta.url` to pick the right entrypoint — `runtime/companion.ts` in dev, `dist/companion.js` in production.
- **Workflow**: edit `runtime/**/*.ts`, then `bun run check`. The drift gate will tell you if you forgot to stage the rebuilt `dist/`.

Toolchain: Node >= 22.5, TypeScript, **bun** (not npm/yarn). Python work (if any) uses **uv**.

## Architecture (locked decisions)

The plugin mirrors `codex-plugin-cc`'s split:

- **Claude plugin layer** (`.claude-plugin/plugin.json`, `commands/`, `agents/`, `hooks/`) — thin policy and routing. Command markdown must not reimplement lifecycle logic.
- **Local runtime layer** (`runtime/`, `scripts/`) — owns Kimi Wire sessions, job store, prompt rendering, parsing, cancellation, and resume. Exposes stable companion subcommands: `setup`, `review`, `task`, `status`, `result`, `cancel`.

Flow: `slash command → companion entrypoint → runtime command → Kimi Wire session → job store → rendered result`.

Non-negotiables (see `docs/spec.md` and `docs/adr/` for full detail — these are the 13 locked decisions that the phase 1 Codex dispatch is building against):

- **Wire-first transport.** Kimi Wire (experimental per Kimi docs) is the primary runtime protocol. Print mode is fallback only — never the default. Phase 1 re-verifies Wire shape before coding.
- **One Kimi Wire process per plugin job.** No shared broker, no pooled connection. Kimi's one-turn-per-connection limit is contained to a single job, and `cancel` blast radius is local.
- **Client-assigned session ids.** Every Wire launch passes a plugin-generated UUID via `--session <id>` and persists it to the job record *before* the Wire connection opens. Rescue resume depends on this.
- **Four read-only command types enforced by agent-file profile, not prompt wording**: `review`, `challenge`, `ask`, `review_gate`. Agent-file excludes write/shell/nested/external/background tools.
- **Rescue is the only write-capable profile.** Separate `--agent-file` with writes and shell enabled, bounded by a Wire-client allowlist — not blanket auto-approval. See §Approval policy for file-edit containment rules and shell allowlist (check tools in read-only mode only, package-manager `run <script>` with stop-list, `find` restricted, pipelines bounded).
- **`/kimi:ask` stays read-only forever.** If a use case wants write/shell, it belongs in rescue — v1 does not grow a fourth capability tier.
- **Git mutation is out of scope for rescue.** Rescue may read git state but not stage, commit, branch, stash, push, pull, or reset. The main Claude thread or user owns branch/commit ceremony around a rescue dispatch.
- **Wire client owns approvals**, not `--agent-file`. Kimi YAML cannot pre-declare selective auto-approvals; all approval-response logic lives in TypeScript per `command_type`.
- **Review sessions are always fresh and isolated.** Rescue sessions persist per repo and are resumable via stored client-assigned session ids. Ask uses a fresh session by default and only resumes when `--resume` is explicit.
- **Jobs are the source of truth** for `status`/`result`/`cancel`, stored in SQLite at `${CLAUDE_PLUGIN_DATA}/kimi-plugin-cc/state.db` in WAL mode with `busy_timeout`. No concurrency cap in v1. Follow the job schema in `docs/spec.md` §Job model exactly. Terminal states (`completed`/`failed`/`cancelled`) are permanent; `cancel` on a terminal job is a no-op.
- **Parse failure policy by command type.** The runtime buffers text `ContentPart` payloads after the last `ToolResult` of the turn and commits on `TurnEnd`; interrupted turns (no `TurnEnd`) fail as malformed rather than parsing partial buffers. No repair pass. For `review` and `challenge`, malformed JSON is a hard failure. For `review_gate`, malformed output becomes a warning (fail-open), never a silent block. **`rescue` has no JSON schema** since 0.1.7 — rescue output is pass-through prose. Empty or whitespace-only final output is rendered with a fallback artifact (`"Kimi did not return a final message."`), the summary falls back to `"Rescue did not return a final message."`, and the job still lands as `completed`.
- **Review gate** is a `Stop` hook (phase 3, disabled by default, persisted in plugin config). On `decision=BLOCK` + `confidence=high` it prevents Claude from stopping and injects corrective context for a follow-up turn. It does not retract the already-generated assistant message from the transcript. Defaults to `--no-thinking` + small model inside an 8s budget.
- **Claude-permission pass-through for rescue is deferred to v2.** V1 enforces safety via a companion-side allowlist instead of routing through Claude Code's own tool permissions — true pass-through would require an IPC path from detached plugin subprocesses back into Claude's session that Claude Code does not currently expose. The trade-off and revisit point are documented in `docs/spec.md` §Approval policy → Deferred architecture option.

## Output shape by command

`review`, `challenge`, and `review-gate` emit fixed JSON schemas defined in `docs/spec.md` §Output schemas — these are real transport contracts that Claude's main thread consumes programmatically. Review findings are one-file-per-finding; multi-file issues must be split.

`ask` and `rescue` are prose pass-through. `ask` has always been prose. `rescue` was refactored from a JSON round-trip to pass-through in 0.1.7 — summary derives from the first meaningful line of the raw output (mirroring `codex task`'s `firstMeaningfulLine` pattern). The architectural principle behind the refactor: **the plugin owns transport, session, workspace, tool scope, approval policy, and job lifecycle; Kimi owns content, reasoning, and prose.** See `docs/adr/004-rescue-pass-through.md` for the rationale.

Keep prompts and schemas versioned alongside the runtime.

## Phasing (historical)

- Phase 0 (2026-04-14, commit `3fac238`): planning bundle locked.
- Phase 1a (`ecebd23`): Wire client + companion dispatcher + setup.
- Phase 1b (`297ffa9`): ask + review + challenge + read-only agent profiles + Node+tsx ADR.
- Phase 2 (`0ab032f`): SQLite job store + rescue + background workers + rescue allowlist + subagent rewrite.
- Phase 3a (`a13c914`): stop-hook review gate end-to-end.
- Phase 3b (`a9edbcd`): replay tooling + graceful degradation + cancellation hardening.
- Post-phase-3 audit cleanup: closed allowlist escapes (backticks, sed prefix forms, find action escapes, ruff format, package-manager `run <script>`), hardened Wire client approval dispatching and stdout ordering, added command timeouts, fixed `--base` argument injection, consolidated plugin manifest for real-world install.
- Drop-in install prep: precompile `runtime/**/*.ts` → `dist/**/*.js` via `tsc -p tsconfig.build.json`, ship `dist/` in the repo, switch `scripts/companion.sh` and `scripts/review-gate-hook.sh` to launch `node dist/companion.js` and `node dist/hooks/review-gate-stop.js`. `tsx` becomes dev-only. Matches the codex-plugin-cc "no runtime compilation" philosophy. Added `LICENSE` (Apache-2.0).
- 0.1.1 (`a60d1a2`): release tooling + centralized version constant in `runtime/version.ts`.
- 0.1.4 (`3eea162` etc.): swap `better-sqlite3` for Node 22.5's built-in `node:sqlite` (eliminates native dep), idempotent migration for orphaned `running` rows from old schema, vendor `shell-quote` LICENSE into `dist/`.
- 0.1.5: kimi web session-title integration — runtime derives `Kimi Task: <prompt excerpt>` titles and announces them via the documented `PATCH /api/sessions/{id}` API on `http://127.0.0.1:5494`, with `KIMI_PLUGIN_CC_DISABLE_WEB_ANNOUNCE=1` kill switch. Re-seats plugin sessions into kimi web alongside terminal-started sessions.
- 0.1.6 (`bb3b982`): rename `/kimi:adversarial-review → /kimi:challenge` (dispatched via /kimi:rescue as a plugin self-test); rename migration in job-store; `Task:` prefix collision fix in session-title builder.
- **0.1.7 (`b5706f5` core + `9f8b193`/`f49bd39`/`d943cd8` parallel PRs + `a7eddf5` version bump + `v0.1.7` tag)**: rescue pass-through refactor. Delete rescue JSON schema, parser, and bespoke renderer (-519 lines); add nullable `phase TEXT` column to the jobs schema with idempotent migration; rewire rescue lifecycle telemetry to `phase` so `summary` stays stable as the semantic result field; rescue summary derives from `firstMeaningfulLine(rawOutput)` with empty-output fallback. Rescue prompt collapsed from 7 opinionated lines (forced JSON output) to 3 empirically-justified sub-invocation hints (commit-to-interpretation, one-line-summary lead, single-command shell guidance). `system_prompt_path` dropped from `runtime/agents/rescue.yaml` — rescue inherits `extend: default`. Added `scripts/smoke-rescue-drift.sh` operator-run drift detection script. Runtime READMEs cleaned of rescue-JSON references. Orchestration: hybrid save-plan-then-paste to Codex desktop for the tightly-coupled core refactor + /batch fan-out of three parallel workers in isolated git worktrees for the independent side quests. Pre-shipping empirical verification ran 5 real rescues with the system prompt stripped to confirm Kimi's default `--wire` behavior before committing to deletion. Full rationale in `docs/adr/004-rescue-pass-through.md`.

Any further changes should be scoped as a new ADR or a targeted fix commit, not a new phase.

## When editing

- Changes to product/architecture belong in `docs/spec.md` or a new ADR, not scattered across READMEs.
- `docs/references.md` and `docs/research/` are grounding material — prefer updating them over inventing behavior from memory.
- Validate proposed changes against `docs/test-plan.md` and `docs/review/checklist.md`.
