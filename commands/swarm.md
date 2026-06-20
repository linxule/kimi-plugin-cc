---
description: Fan out a parallel review across the workspace using Kimi's AgentSwarm tool, bounded by a hard wall-clock budget. Read-only by default (enforced by the same PreToolUse hook as review, applied to every subagent); --write fans out edits in a throwaway worktree and returns a patch.
argument-hint: "[--write] [--budget <30m|1h>] [--cap <N>] [--max-concurrency <N>] [-m <model>] <objective>"
disable-model-invocation: true
---

Run the companion with any user-supplied flags appended after `task swarm`:

`${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh task swarm <args>`

`/kimi:swarm` is a **parallel fan-out**: Kimi uses the `AgentSwarm` tool to fan the work out across subagents (one per file/module/question), then consolidates into one markdown report. **By default it is read-only**, enforced by the same PreToolUse hook as `/kimi:review` — the hook runs under the `swarm` label (read-only tool set plus `AgentSwarm`), and **every spawned subagent inherits that label and fires the same hook** (policy index 0), so a subagent's write/edit/shell call is denied exactly like a single-turn review's.

**`--write` (v1.4)** turns it into a write-capable fan-out: the coordinator and `coder` subagents run inside an **ephemeral throwaway git worktree off your HEAD**, edit disjoint targets there, and the result is captured as a **reviewable patch** (written to a `.patch` file whose path is printed in the report). Writes are confined to that worktree by the `swarm-write` hook label (rescue-grade allowlist, scoped to a forge-proof trusted worktree root — not the payload cwd); git mutation and out-of-worktree writes are denied; **the plugin never applies or commits — you own the merge.** Your real working tree is never touched.

Supported flags:

- `--write` — fan out EDITS (not just review). Requires kimi-code **>= 0.18.0**, a git repo with a committed HEAD, and the PreToolUse hook. Bases the worktree on HEAD: **uncommitted changes are NOT included** (you'll get a warning) — commit or stash first if the swarm needs them.
- `--budget <duration>` — HARD wall-clock ceiling (e.g. `30m`, `1h`, `90s`; bare number = minutes). Default 30m. The always-on bound on cost/runaway.
- `--cap <N>` — SOFT cap on TOTAL subagent count: injected into the prompt as a model instruction. Advisory, not hook-enforced (the hook is stateless and can't count subagents), so the model may exceed it. Bounds lifetime total, not peak parallelism.
- `--max-concurrency <N>` — HARD ceiling on how many subagents run AT ONCE, on kimi-code **0.18.0+** (exported as `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY`; older binaries ignore it). **Defaults to 4 for read, 1 for `--write`** (writes serialize by default since disjoint-target partitioning is prompt-only) — pass a value to widen or throttle. Distinct from `--cap`: concurrency (simultaneous) ≠ total count (lifetime).
- `-m`, `--model <name>`

Prototype limitations:

- **Foreground only.** No `--background` — watch the run; cancel with Ctrl+C or `/kimi:cancel <job-id>`.
- **`--write` also has a model-invocable agent (v1.5):** the `kimi-swarm-write` subagent lets the main Claude thread dispatch a write fan-out on its own judgement, with strict triggering (many disjoint write targets AND explicit fan-out intent). Auto-dispatch widens no write surface — it is **patch-only** (edits stay in the throwaway worktree; the plugin never applies or commits; the user owns the merge) and keeps every bound (`--budget`, `--max-concurrency` default 1, hook required). The slash command itself stays human-only (`disable-model-invocation: true`, the blanket convention for all commands).
- Read-only swarm requires kimi-code **>= 0.12.0** (the `AgentSwarm` tool); `--write` requires **>= 0.18.0** (the hard concurrency cap). Both **refuse** without the `/kimi:setup` PreToolUse hook (a fan-out with no enforcement is an N-fold blast radius).

Return the companion stdout verbatim.
