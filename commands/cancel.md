---
description: Cancel an active plugin-managed Kimi job for the current repository.
argument-hint: "[<job-id>]"
disable-model-invocation: true
---

Run the companion with any user-supplied flags appended after `cancel`:

`${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh cancel <args>`

Cancellation uses the recorded companion and Kimi process ids, so it can cancel foreground jobs launched by detached agent runs as well as background ask/rescue jobs.

Return the companion stdout verbatim.
