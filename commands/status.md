---
description: Show the latest or selected plugin-managed Kimi job for the current repository.
disable-model-invocation: true
---

Run the companion with any user-supplied flags appended after `status`:

`${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh status <args>`

This command also reconciles stale jobs whose recorded worker or Kimi process has disappeared.

Return the companion stdout verbatim.
