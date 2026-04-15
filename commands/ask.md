---
description: Ask Kimi a read-only question in free-form prose mode.
disable-model-invocation: true
---

Run the companion with any user-supplied flags appended after `ask`:

`${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh ask <args>`

Supported flags:

- `-r`, `--resume` — resume the latest ask session for the current repo
- `--resume <job-id-or-session-id>` — resume a specific prior ask session
- `--fresh` — force a new ask session id instead of reusing a prior session
- `-m`, `--model <name>`
- `--thinking`
- `--no-thinking`

Return the companion stdout verbatim.
