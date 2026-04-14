# kimi-plugin-cc

Planning and review bundle for a Codex-grade Claude Code plugin backed by Kimi CLI.

This repository is intentionally **docs-first**. It defines the product, architecture, runtime contracts, review process, and implementation phases for `kimi-plugin-cc` before any runtime code is written.

## Current phase

This repo is in the **planning bundle** phase:

- the source of truth is the documentation under [docs](./docs)
- the plugin/runtime directories are present only as a skeleton
- no Kimi transport, job runtime, or Claude command implementation is included yet

## Project goal

Build the Kimi equivalent of OpenAI's Codex Claude Code plugin at the same quality bar:

- native Claude Code plugin UX
- thin plugin shell
- rich local runtime
- Kimi Wire as the primary transport
- explicit job lifecycle
- safe read-only review path
- write-capable rescue path
- phased delivery with review gate later in v1

## How to review this repo

Start here:

1. Read [docs/spec.md](./docs/spec.md)
2. Read the ADRs in [docs/adr](./docs/adr)
3. Read [docs/implementation-plan.md](./docs/implementation-plan.md)
4. Use the prompts in [docs/review/prompts](./docs/review/prompts)
5. Validate against [docs/test-plan.md](./docs/test-plan.md) and [docs/review/checklist.md](./docs/review/checklist.md)

## Repository layout

Documentation:

- [docs/spec.md](./docs/spec.md): canonical product and technical spec
- [docs/adr/001-wire-first-transport.md](./docs/adr/001-wire-first-transport.md): why Wire is the primary transport
- [docs/adr/002-plugin-runtime-shape.md](./docs/adr/002-plugin-runtime-shape.md): why the runtime mirrors Codex's plugin/runtime split
- [docs/implementation-plan.md](./docs/implementation-plan.md): phased implementation plan
- [docs/test-plan.md](./docs/test-plan.md): acceptance and failure-mode coverage
- [docs/review/checklist.md](./docs/review/checklist.md): human/AI review checklist
- [docs/references.md](./docs/references.md): primary source links for Codex plugin and Kimi docs
- [docs/research](./docs/research): synthesized repo/doc notes used to ground the design

Planned implementation skeleton:

- [.claude-plugin/plugin.json](./.claude-plugin/plugin.json)
- [commands](./commands)
- [agents](./agents)
- [skills](./skills)
- [hooks](./hooks)
- [scripts](./scripts)
- [runtime](./runtime)
- [tests](./tests)

Planned v1 command surface:

- `/kimi:setup`
- `/kimi:ask`
- `/kimi:review`
- `/kimi:adversarial-review`
- `/kimi:rescue`
- `/kimi:status`
- `/kimi:result`
- `/kimi:cancel`

## Scope boundary

This repository does **not** implement the plugin yet. It packages the planning artifacts needed for:

- review by Claude Code and other agents
- design iteration
- implementation in a later phase without reopening core decisions

Note:

- `.claude-plugin/plugin.json` is intentionally minimal. Command, agent, hook, and skill behavior is defined by repo layout and the corresponding files, not by manifest-only metadata.
