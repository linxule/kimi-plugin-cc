---
description: Fan out a READ-ONLY parallel review across the workspace using Kimi's AgentSwarm tool, bounded by a hard wall-clock budget. Read-only — enforced by the same PreToolUse hook as review, applied to every subagent.
argument-hint: "[--budget <30m|1h>] [--cap <N>] [--max-concurrency <N>] [-m <model>] <what to review across the workspace>"
disable-model-invocation: true
---

Run the companion with any user-supplied flags appended after `task swarm`:

`${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh task swarm <args>`

`/kimi:swarm` is a **read-only parallel review**: Kimi uses the `AgentSwarm` tool to fan the work out across subagents (one per file/module/question), each inspecting the workspace with read tools only, then consolidates their findings into one markdown report. It is **read-only and enforced by the same PreToolUse hook as `/kimi:review`** — the hook runs under the `swarm` label, which allows the read-only tool set plus `AgentSwarm`, and **every spawned subagent inherits that label and fires the same hook** (policy index 0), so a subagent's write/edit/shell call is denied exactly like a single-turn review's.

Supported flags:

- `--budget <duration>` — HARD wall-clock ceiling (e.g. `30m`, `1h`, `90s`; bare number = minutes). Default 30m. Read-only swarm opens no write surface, so this is the bound on COST/runaway from N parallel model runs.
- `--cap <N>` — SOFT cap on TOTAL subagent count: injected into the prompt as a model instruction. Advisory, not hook-enforced (the hook is stateless and can't count subagents), so the model may exceed it. Bounds lifetime total, not peak parallelism.
- `--max-concurrency <N>` — HARD ceiling on how many subagents run AT ONCE, on kimi-code **0.18.0+** (exported as `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY`; older binaries ignore it). Distinct from `--cap`: concurrency (simultaneous) ≠ total count (lifetime). Use it to throttle peak model spend; the `--budget` wall-clock ceiling remains the bound on total cost.
- `-m`, `--model <name>`

Prototype limitations (v1.2):

- **Foreground only.** No `--background` yet — watch the run; cancel with Ctrl+C or `/kimi:cancel <job-id>`.
- **Read-only only.** No `--write` mode yet (a write-capable swarm needs per-subagent worktree isolation to be safe — deferred). For writes, use `/kimi:rescue`.
- Requires kimi-code **>= 0.12.0** (the `AgentSwarm` tool) and the `/kimi:setup` PreToolUse hook. Unlike single-turn review, swarm **refuses** without the hook (a fan-out with no enforcement is an N-fold blast radius).

Return the companion stdout verbatim.
