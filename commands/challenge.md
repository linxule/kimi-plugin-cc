---
description: Run a read-only Kimi challenge review that challenges assumptions and surfaces safer alternatives.
argument-hint: "[--base <ref>] [-m <model>] [extra prose]"
disable-model-invocation: true
---

Run the companion with any user-supplied flags appended after `task challenge`:

`${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh task challenge <args>`

Supported flags:

- `--base <ref>` — challenge against a branch/commit diff instead of the working tree
- `-m`, `--model <name>`
- trailing text — adversarial focus or framing to steer the challenge

Kimi's extended reasoning is always on for `challenge`. Budget is 30 min so adversarial review has time to dig. Challenge runs foreground-synchronously; it does not support `--background` or `--wait`.

Return the companion stdout verbatim.
