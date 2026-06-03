---
description: Hand Kimi an objective to pursue AUTONOMOUSLY across multiple turns (experimental goal mode), bounded by a hard wall-clock budget. Write-capable, gated by the same PreToolUse hook as rescue.
argument-hint: "[--budget <30m|1h>] [--turns <N>] [-m <model>] <objective>"
disable-model-invocation: true
---

Run the companion with any user-supplied flags appended after `task pursue`:

`${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh task pursue <args>`

`/kimi:pursue` is **autonomous goal mode**: Kimi keeps working toward the objective across continuation turns until it completes, blocks itself, or the budget expires. It is write-capable and runs under the **same PreToolUse hook + workspace allowlist as `/kimi:rescue`** (the hook gates every tool call in every turn), and like rescue it **cannot mutate git state** — the main thread owns branch/commit.

Supported flags:

- `--budget <duration>` — HARD wall-clock ceiling (e.g. `30m`, `1h`, `90s`; bare number = minutes). Default 45m. This is the only guaranteed bound on an autonomous run.
- `--turns <N>` — SOFT cap: injected into the objective as a model instruction to call `SetGoalBudget`. Advisory, not enforced.
- `-m`, `--model <name>`

Prototype limitations (experimental):

- **Foreground only.** No `--background` yet — watch the run; cancel with Ctrl+C or `/kimi:cancel <job-id>`.
- **No `--resume`.** Goal mode emits a goalId distinct from the session id; resuming the session would not reliably re-enter the goal. The goalId is shown in the result for when resume lands.
- Requires kimi-code **>= 0.8.0** (headless goal mode) and the `/kimi:setup` PreToolUse hook (refuses without it).

Terminal outcomes are surfaced as status, not errors: `complete` (done), `blocked` (Kimi or a budget stopped it), `paused` (interrupted). The result headlines the goal status, reason, and turns/tokens/wall-clock usage.

Return the companion stdout verbatim.
