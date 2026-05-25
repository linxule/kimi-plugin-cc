---
description: Run a read-only Kimi review over the current working tree changes or a base ref diff.
argument-hint: "[--base <ref>] [-m <model>] [extra prose]"
disable-model-invocation: true
---

Run the companion with any user-supplied flags appended after `review`:

`${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh review <args>`

Supported flags:

- `--base <ref>` — review against a branch/commit diff instead of the working tree
- `-m`, `--model <name>`
- trailing text — optional focus hint for the review

Kimi's extended reasoning is always on for `review`. Budget is 30 min so a real workspace-wide analysis has headroom. Review runs foreground-synchronously; it does not support `--background` or `--wait`.

Return the companion stdout verbatim.
