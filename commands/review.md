---
description: Run a read-only Kimi review over the current working tree changes or a base ref diff.
argument-hint: "[--base <ref>] [-m <model>] [--no-thinking] [extra prose]"
disable-model-invocation: true
---

Run the companion with any user-supplied flags appended after `review`:

`${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh review <args>`

Supported flags:

- `--base <ref>` — review against a branch/commit diff instead of the working tree
- `-m`, `--model <name>`
- `--thinking` — enable Kimi's extended reasoning (on by default; kept for explicit intent)
- `--no-thinking` — disable Kimi's extended reasoning
- trailing text — optional focus hint for the review

Review runs foreground-synchronously; it does not support `--background` or `--wait`.

Return the companion stdout verbatim.
