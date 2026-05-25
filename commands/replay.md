---
description: Re-render a stored Wire event log for a completed plugin-managed Kimi job.
argument-hint: "<job-id>"
disable-model-invocation: true
---

Run the companion with any user-supplied flags appended after `replay`:

`${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh replay <args>`

This command also reconciles stale jobs whose recorded worker or Kimi process has disappeared before replaying the stored log.

Return the companion stdout verbatim.
