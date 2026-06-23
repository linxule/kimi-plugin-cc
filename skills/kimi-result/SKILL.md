---
name: kimi-result
description: "Return the stored rendered result for the latest or selected terminal Kimi job. Use when the user explicitly asks for a Kimi job result or artifact body."
---

# Kimi Result

Forward this request to the local kimi-code companion runtime by shell. Do not use MCP for this skill.

## Invocation

- Resolve the plugin root from this skill source path: use the parent directory of the `skills/` directory that contains this `SKILL.md`. If `PLUGIN_ROOT` is already set, use that value.
- Launch the shell command from the user's current workspace directory so `scripts/companion.sh` captures the intended workspace cwd.
- Run: `PLUGIN_ROOT="<plugin-root>" "<plugin-root>/scripts/companion.sh" result <args>`
- If the plugin host provides `PLUGIN_DATA` instead of `CLAUDE_PLUGIN_DATA`, the shell wrapper exports the Claude-compatible alias for the runtime.

## Arguments

Pass through: `[<job-id>] [--type <review|challenge|rescue|review_gate|ask>] [--json]`

## Handling

- Preserve any job id, `--type`, and `--json` flag.
- Return companion stdout verbatim; `--json` is the structured automation surface.
