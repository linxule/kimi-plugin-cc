---
description: Return the stored rendered result for the latest or selected terminal Kimi job.
argument-hint: "[<job-id>] [--type <review|challenge|rescue|review_gate|ask>] [--json]"
disable-model-invocation: true
---

Run the companion with any user-supplied flags appended after `result`:

`${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh result <args>`

This command also reconciles stale jobs whose recorded worker or Kimi process has disappeared before looking up a terminal result.

Return the companion stdout verbatim.
