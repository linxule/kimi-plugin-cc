# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

**Phase 0 closed, phase 1 dispatched.** The planning bundle in `docs/` is locked and internally consistent. Phase 1 implementation (Wire client, companion dispatcher, read-only commands including `/kimi:ask`) is running in a separate Codex dispatch with a five-checkpoint structure — checkpoint 0 is the phase-1 re-verification gate against current Kimi docs.

The source of truth remains `docs/`; runtime code belongs under `runtime/` and is built against the spec, not designed ad-hoc. `commands/`, `agents/`, `hooks/`, `skills/`, and `scripts/` hold the Claude-facing shell. Do not reopen locked decisions from `docs/spec.md` without raising them explicitly — the spec is the contract the Codex implementation dispatch is building against.

Key planning artifacts already authored (do not treat as placeholders):

- `agents/kimi-rescue.md` — subagent with trigger-oriented description and runtime contract; body is rewritten by phase 2
- `skills/kimi-review/SKILL.md` — proactive-discovery skill wrapping `/kimi:review`

## Commands

The only script is `bun run check`, which currently prints a placeholder. There is no build, lint, or test yet. `tsconfig.json` targets ES2022 / NodeNext / `strict` with `noEmit`, scoped to `scripts/`, `runtime/`, `tests/` — use it as the baseline when implementation work begins.

Toolchain: Node >= 18.18, TypeScript, **bun** (not npm/yarn). Python work (if any) uses **uv**.

## Architecture (locked decisions)

The plugin mirrors `codex-plugin-cc`'s split:

- **Claude plugin layer** (`.claude-plugin/plugin.json`, `commands/`, `agents/`, `hooks/`) — thin policy and routing. Command markdown must not reimplement lifecycle logic.
- **Local runtime layer** (`runtime/`, `scripts/`) — owns Kimi Wire sessions, job store, prompt rendering, parsing, cancellation, and resume. Exposes stable companion subcommands: `setup`, `review`, `task`, `status`, `result`, `cancel`.

Flow: `slash command → companion entrypoint → runtime command → Kimi Wire session → job store → rendered result`.

Non-negotiables (see `docs/spec.md` and `docs/adr/` for full detail — these are the 13 locked decisions that the phase 1 Codex dispatch is building against):

- **Wire-first transport.** Kimi Wire (experimental per Kimi docs) is the primary runtime protocol. Print mode is fallback only — never the default. Phase 1 re-verifies Wire shape before coding.
- **One Kimi Wire process per plugin job.** No shared broker, no pooled connection. Kimi's one-turn-per-connection limit is contained to a single job, and `cancel` blast radius is local.
- **Client-assigned session ids.** Every Wire launch passes a plugin-generated UUID via `--session <id>` and persists it to the job record *before* the Wire connection opens. Rescue resume depends on this.
- **Four read-only command types enforced by agent-file profile, not prompt wording**: `review`, `adversarial-review`, `ask`, `review_gate`. Agent-file excludes write/shell/nested/external/background tools.
- **Rescue is the only write-capable profile.** Separate `--agent-file` with writes and shell enabled, bounded by a Wire-client allowlist — not blanket auto-approval. See §Approval policy for file-edit containment rules and shell allowlist (check tools in read-only mode only, package-manager `run <script>` with stop-list, `find` restricted, pipelines bounded).
- **`/kimi:ask` stays read-only forever.** If a use case wants write/shell, it belongs in rescue — v1 does not grow a fourth capability tier.
- **Git mutation is out of scope for rescue.** Rescue may read git state but not stage, commit, branch, stash, push, pull, or reset. The main Claude thread or user owns branch/commit ceremony around a rescue dispatch.
- **Wire client owns approvals**, not `--agent-file`. Kimi YAML cannot pre-declare selective auto-approvals; all approval-response logic lives in TypeScript per `command_type`.
- **Review sessions are always fresh and isolated.** Rescue sessions persist per repo and are resumable via stored client-assigned session ids. Ask is stateless in v1.
- **Jobs are the source of truth** for `status`/`result`/`cancel`, stored in SQLite at `${CLAUDE_PLUGIN_DATA}/kimi-plugin-cc/state.db` in WAL mode with `busy_timeout`. No concurrency cap in v1. Follow the job schema in `docs/spec.md` §Job model exactly. Terminal states (`completed`/`failed`/`cancelled`) are permanent; `cancel` on a terminal job is a no-op.
- **Parse failure is a hard failure.** The runtime buffers text `ContentPart` payloads after the last `ToolResult` of the turn and commits on `TurnEnd`; interrupted turns (no `TurnEnd`) fail as malformed rather than parsing partial buffers. No repair pass. Review-gate malformed output becomes a warning, never a silent block.
- **Review gate** is a `Stop` hook (phase 3, disabled by default, persisted in plugin config). On `decision=BLOCK` + `confidence=high` it prevents Claude from stopping and injects corrective context for a follow-up turn. It does not retract the already-generated assistant message from the transcript. Defaults to `--no-thinking` + small model inside an 8s budget.
- **Claude-permission pass-through for rescue is deferred to v2.** V1 enforces safety via a companion-side allowlist instead of routing through Claude Code's own tool permissions — true pass-through would require an IPC path from detached plugin subprocesses back into Claude's session that Claude Code does not currently expose. The trade-off and revisit point are documented in `docs/spec.md` §Approval policy → Deferred architecture option.

## Output schemas

Review and rescue commands emit fixed JSON schemas defined in `docs/spec.md` ("Output schemas"). Review findings are one-file-per-finding; multi-file issues must be split. Review gate uses its own `decision/confidence/summary/issues` schema. Keep prompts and schemas versioned alongside the runtime when implementation begins.

## Phasing

- Phase 0 (complete, 2026-04-14): planning bundle locked.
- Phase 1 (dispatched, checkpoint-based): runtime shell, Wire client, `setup` / `review` / `adversarial-review` / `ask`, `kimi-review` skill. Split into 1a (Wire client + dispatcher) and 1b (commands + profiles + skill).
- Phase 2: rescue, SQLite job store, background workers, `status`/`result`/`cancel`, rescue session persistence, `kimi:rescue` subagent body rewritten as runtime system prompt.
- Phase 3: review gate Stop hook, runtime hardening, replay tooling.

Each phase exits via a hard checkpoint with a structured report and human+Claude review. Do not pull phase-N+1 work forward into phase N without an explicit strategic decision.

## When editing

- Changes to product/architecture belong in `docs/spec.md` or a new ADR, not scattered across READMEs.
- `docs/references.md` and `docs/research/` are grounding material — prefer updating them over inventing behavior from memory.
- Validate proposed changes against `docs/test-plan.md` and `docs/review/checklist.md`.
