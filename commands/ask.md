---
description: Ask Kimi a read-only question in free-form prose mode.
argument-hint: "[--background] [--wait] [-r | --resume <id>] [--fresh] [-m <model>] <prompt>"
disable-model-invocation: true
---

Run the companion with any user-supplied flags appended after `ask`:

`${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh ask <args>`

Supported flags:

- `--background` — spawn as a background job and return `{job_id}` immediately
- `--wait` — combined with `--background`, block until terminal state and return the rendered answer
- `-r` — resume the latest ask session for the current repo; any trailing text becomes the next prompt
- `--resume <job-id-or-session-id>` — resume a specific prior ask session without a new prompt payload
- `--fresh` — force a new ask session id instead of reusing a prior session
- `-m`, `--model <name>`

Kimi's extended reasoning is always on for `ask`. Budgets are sized for the thinking-on path (15 min) so a real session has headroom.

Return the companion stdout verbatim.
