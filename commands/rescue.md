---
description: Run a write-capable Kimi rescue against the current repository with optional background execution and resume behavior.
argument-hint: "[--background] [--wait] [-r | --resume <id>] [--fresh] [-m <model>] <prompt>"
disable-model-invocation: true
---

Run the companion with any user-supplied flags appended after `task rescue`:

`${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh task rescue <args>`

Supported flags:

- `--background` — spawn as a detached background job and return `{job_id}` immediately
- `--wait` — combined with `--background`, block until terminal state and return the rendered result
- `-r` — resume the latest rescue session for the current repo; any trailing text becomes the next prompt
- `--resume <job-id-or-session-id>` — resume a specific prior rescue session without a new prompt payload
- `--fresh` — force a new rescue session id instead of reusing a prior session
- `-m`, `--model <name>`

Kimi's extended reasoning is always on for `rescue`. Budget is 30 min for multi-step apply/test/verify loops; use `--background` for sessions that need to run longer.

Return the companion stdout verbatim.
