# Implementation Plan

> **Historical document.** This plan was written before any code landed. All referenced phases (0 through 3b) shipped between April 14–15, 2026, and the plugin has since landed targeted post-phase releases 0.1.1 through **0.1.7** (rescue pass-through refactor, tagged as `v0.1.7`). See [CLAUDE.md](../CLAUDE.md) §Phasing for the authoritative shipped-state timeline and [ADR 004](./adr/004-rescue-pass-through.md) for the most recent architectural decision. The content below is preserved for historical reference and is not a roadmap.

This document was the build-order plan for the original implementation phase. It assumed the product and architecture decisions in [spec.md](./spec.md) and the ADRs were locked.

## Phase 0: Planning bundle

Deliverables:

- canonical spec
- ADRs
- implementation plan
- test plan
- review checklist
- review prompts
- research notes
- repo skeleton

Exit criteria:

- another agent can review the repo without asking for missing architectural decisions

## Phase 1: Runtime foundation and read-only review

Build:

- Node/TypeScript runtime shell
- companion entrypoint command dispatcher
- Kimi Wire client foundation
- one-Kimi-process-per-job topology
- setup command
- ask command
- review command
- challenge command
- `kimi-review` Claude skill
- author and validate `runtime/agents/*.yaml` against the current Kimi `--agent-file` schema

Decisions already locked:

- Wire-first transport
- Wire is experimental and must be re-verified before implementation starts
- phase-1 re-verification includes `--session <id>` create-if-missing semantics
- review commands use fresh isolated sessions
- review commands use a restricted Kimi agent profile
- parse failure is a hard review failure

Exit criteria:

- `setup`, `ask`, `review`, and `challenge` are implementable without revisiting architecture

## Phase 2: Rescue and job lifecycle

Build:

- plugin-managed job store
- SQLite-backed state plus file-backed logs/artifacts
- background worker model
- status/result/cancel commands
- rescue command
- rescue session persistence and resume behavior
- `kimi:rescue` subagent with explicit trigger guidance

Exit criteria:

- foreground and background rescue flows are coherent
- job lifecycle is the source of truth

## Phase 3: Review gate and hardening

Build:

- stop-hook review gate
- persistent enable/disable behavior via `/kimi:setup`
- explicit block/allow rendering contract
- replay and transcript hardening
- cancellation edge-case hardening

Exit criteria:

- review gate can be enabled safely
- runtime degrades gracefully when Kimi is unavailable

## Recommended file ownership in implementation

- command markdown and agent markdown remain thin
- runtime modules own parsing, state, and transport
- prompts and schemas are versioned alongside the runtime

## Implementation review checkpoints

Before merging each phase:

- architecture check against Codex shape
- Kimi runtime feasibility check against current docs
- challenge review of safety boundaries
- acceptance test review against [test-plan.md](./test-plan.md)
