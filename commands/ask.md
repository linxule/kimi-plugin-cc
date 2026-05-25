---
description: Ask Kimi a read-only question in free-form prose mode.
argument-hint: "[--background] [--wait] [-r | --resume <id>] [--fresh] [-m <model>] [--no-thinking] <prompt>"
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
- `--thinking` — enable Kimi's extended reasoning (on by default; this flag is a no-op now, kept for explicit intent)
- `--no-thinking` — disable Kimi's extended reasoning (opt out of the new default)

Return the companion stdout verbatim.
