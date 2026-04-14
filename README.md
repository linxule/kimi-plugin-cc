# kimi-plugin-cc

A [Claude Code](https://claude.ai/code) plugin that gives Claude a second brain — [Kimi](https://kimi.ai), Moonshot AI's reasoning model, running entirely on your local machine.

No cloud round-trips. No API keys to share between models. No waiting for a multi-model orchestration protocol to mature. Just two models collaborating through a local CLI, right now.

## Why this exists

AI coding agents work better when they can get a second opinion. But today, multi-model collaboration usually means cloud orchestration layers, custom API plumbing, or waiting for standards like ACP to ship.

This plugin takes a different approach: it builds on top of [Kimi CLI](https://github.com/MoonshotAI/kimi-cli)'s **Wire mode** — an experimental streaming protocol (JSON-RPC over stdio) that gives programmatic access to a full Kimi agent session, including tool use, file edits, shell commands, approvals, and session resume. The plugin wraps Wire with a TypeScript runtime that handles session lifecycle, job persistence, approval policy, and result rendering — then exposes it all through Claude Code's slash commands.

The architecture is modeled after OpenAI's [codex-plugin-cc](https://github.com/openai/codex-plugin-cc), which does the same thing for Codex. Both follow the same pattern: thin plugin shell, rich local runtime, one process per job. If you've used the Codex plugin, this will feel familiar.

## What it does

**Read-only modes** — get Kimi's perspective without it touching your code:

- `/kimi:ask` — free-form Q&A. Fresh session by default, `-r` to resume a conversation.
- `/kimi:review` — structured code review of your working-tree or branch diff. Returns JSON findings that Claude can act on.
- `/kimi:challenge` — adversarial review with a custom focus. Same structured output, different angle.

**Write-capable mode** — delegate real work to Kimi:

- `/kimi:rescue` — hand off an implementation task, bug hunt, or refactor. Kimi gets file write and shell access, bounded by a [companion-side approval allowlist](./runtime/rescue-approval.ts). Sessions persist and can be resumed across Claude Code restarts.

**Job lifecycle** — track what Kimi is doing:

- `/kimi:status`, `/kimi:result`, `/kimi:cancel`, `/kimi:replay` — inspect, retrieve, cancel, or re-render any plugin-managed Kimi job.

**Automation** — the plugin also ships a `kimi-rescue` subagent (proactive delegation trigger), a `kimi-review` skill (proactive second-opinion reviews), and an opt-in stop-time review gate that asks Kimi to sanity-check Claude's work before it stops.

## How it works

```
  Claude Code session
       │
       ├─ /kimi:review "check the auth flow"
       │       │
       │       └─ scripts/companion.sh review ...
       │               │
       │               └─ node dist/companion.js
       │                       │
       │                       ├─ spawns: kimi --wire --session <uuid> --agent-file review.yaml
       │                       ├─ JSON-RPC over stdio (Wire protocol)
       │                       ├─ buffers turn events, captures final output
       │                       ├─ persists job state to SQLite
       │                       └─ returns structured review findings to Claude
       │
       └─ Claude reads the findings and acts on them
```

Key design decisions:

- **Wire-first transport.** Kimi Wire gives real-time streaming, tool-use approvals, and session resume. Print mode is fallback only.
- **One process per job.** No shared broker. Each `/kimi:review` or `/kimi:rescue` spawns a fresh `kimi --wire` process with its own session. Cancel kills one job, not all of them.
- **Plugin owns transport, Kimi owns content.** The plugin handles sessions, approvals, job state, and rendering. Kimi handles reasoning, tool use, and prose. System prompts are minimal — just enough to steer Kimi away from shell patterns the allowlist rejects.
- **Precompiled for zero-build install.** `dist/` is committed. Install the plugin and it works — no `tsx`, no native dependencies, just Node >= 22.5.

## Install

### Via the Claude Code marketplace (recommended)

```
/plugin marketplace add linxule/kimi-plugin-cc
/plugin install kimi@kimi-marketplace
/kimi:setup
```

### From a local clone

```bash
git clone https://github.com/linxule/kimi-plugin-cc ~/kimi-plugin-cc
claude --plugin-dir ~/kimi-plugin-cc
```

Then run `/kimi:setup` to verify the local `kimi` CLI is reachable and authenticated.

## Prerequisites

- **Kimi CLI** on `PATH` — the plugin requires `--wire`, `--session`, and `--agent-file` support (available in recent versions). Set `KIMI_PLUGIN_CC_KIMI_BIN` to override.
- **Node >= 22.5** — for built-in `node:sqlite`. Set `KIMI_PLUGIN_CC_NODE_BIN` to override.
- **bun** — only needed for contributor tooling (`bun run check`, `bun test`). Not required at runtime.

## Development

```bash
bun run check    # rebuild dist/, typecheck, run 132 tests, drift gate
bun test <path>  # run a single test file
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full contributor workflow.

## How this was built

This plugin was itself built through multi-model collaboration — the same kind of collaboration it enables. Every design decision, implementation, and review involved at least two models:

- **Phase 0** (planning): Claude and Codex co-authored the spec through five review rounds, with Kimi verifying claims against its own CLI documentation.
- **Implementation**: Claude drove primary development. Codex handled tightly-coupled refactors via delegated rescue sessions. Independent work units ran as parallel agents in isolated git worktrees.
- **Review**: Every release went through dual-model review — Kimi and Codex independently auditing the same changeset, then their findings cross-calibrated before shipping.
- **This pre-public release**: Four independent reviewers (Kimi, Codex, Claude security reviewer, Claude code quality reviewer) audited the repo in parallel, producing a 25-item punch list that was triaged by Kimi and Codex, fixed by six parallel agents, and verified by Codex post-fix review.

The development memos are preserved in the project's [memex vault](https://github.com/linxule/memex) for anyone interested in the full arc.

## Acknowledgments

- **[Kimi](https://kimi.ai)** (Moonshot AI) — the reasoning model this plugin delegates to, and a design/review collaborator throughout development
- **[Codex](https://openai.com/index/codex/)** (OpenAI) — architecture consults, parallel implementation, and independent pre-ship reviews via the [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) companion plugin
- **[Claude Code](https://claude.ai/code)** (Anthropic) — the host environment, primary development agent, and the platform this plugin extends

## License

[Apache-2.0](./LICENSE)
