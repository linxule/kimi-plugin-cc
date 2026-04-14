# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Repository status

**Docs-first planning bundle.** No runtime code exists yet. The source of truth is `docs/`; `commands/`, `agents/`, `hooks/`, `runtime/`, `scripts/`, and `tests/` are skeleton directories with placeholder READMEs only. Do not invent implementation that contradicts the locked spec — review `docs/spec.md` and the ADRs first.

## Commands

The only script is `bun run check`, which currently prints a placeholder. There is no build, lint, or test yet. `tsconfig.json` targets ES2022 / NodeNext / `strict` with `noEmit`, scoped to `scripts/`, `runtime/`, `tests/` — use it as the baseline when implementation work begins.

Toolchain: Node >= 18.18, TypeScript, **bun** (not npm/yarn). Python work (if any) uses **uv**.

## Architecture (locked decisions)

The plugin mirrors `codex-plugin-cc`'s split:

- **Codex plugin layer** (`.Codex-plugin/plugin.json`, `commands/`, `agents/`, `hooks/`) — thin policy and routing. Command markdown must not reimplement lifecycle logic.
- **Local runtime layer** (`runtime/`, `scripts/`) — owns Kimi Wire sessions, job store, prompt rendering, parsing, cancellation, and resume. Exposes stable companion subcommands: `setup`, `review`, `task`, `status`, `result`, `cancel`.

Flow: `slash command → companion entrypoint → runtime command → Kimi Wire session → job store → rendered result`.

Non-negotiables (see `docs/adr/`):

- **Wire-first transport.** Kimi Wire is the primary runtime protocol. Print mode is a fallback for setup/probing only — never the default.
- **Review is read-only by profile, not by prompt.** `/kimi:review` and `/kimi:adversarial-review` use a restricted Kimi agent profile with no write/shell/nested-agent/external tools. Enforce via profile, not instruction wording.
- **Rescue is write-capable** via a separate profile (read, write, shell enabled; external tools and nested agents off in v1).
- **Review sessions are always fresh and isolated.** Rescue sessions persist per repo and are resumable.
- **Jobs are the source of truth** for `status`/`result`/`cancel`. Required fields and state transitions are specified in `docs/spec.md` under "Job model" — follow that schema exactly. Terminal states (`completed`/`failed`/`cancelled`) are permanent; `cancel` on a terminal job is a no-op.
- **Parse failure is a hard failure.** Malformed structured output never degrades to a fake empty review; review-gate malformed output becomes a warning, never a silent block.
- **Review gate** is a `Stop` hook, phase 3, disabled by default, persisted in plugin config, and on `decision=BLOCK` + `confidence=high` it prevents Codex from stopping and injects corrective context for a follow-up turn. It does not retract the already-generated assistant message from the transcript.

## Output schemas

Review and rescue commands emit fixed JSON schemas defined in `docs/spec.md` ("Output schemas"). Review findings are one-file-per-finding; multi-file issues must be split. Review gate uses its own `decision/confidence/summary/issues` schema. Keep prompts and schemas versioned alongside the runtime when implementation begins.

## Phasing

- Phase 0 (current): planning bundle only.
- Phase 1: runtime shell, Wire client, `setup` / `review` / `adversarial-review`.
- Phase 2: rescue, job store, background workers, `status`/`result`/`cancel`, rescue subagent.
- Phase 3: review gate, hardening.

Do not pull phase-2 or phase-3 work forward without an explicit request.

## When editing

- Changes to product/architecture belong in `docs/spec.md` or a new ADR, not scattered across READMEs.
- `docs/references.md` and `docs/research/` are grounding material — prefer updating them over inventing behavior from memory.
- Validate proposed changes against `docs/test-plan.md` and `docs/review/checklist.md`.
