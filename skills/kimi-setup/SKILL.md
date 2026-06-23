---
name: kimi-setup
description: "Verify local Kimi companion readiness and manage the kimi-code PreToolUse hook plus optional review gate state. Use when explicitly requested to install, check, enable, disable, or uninstall the integration."
---

# Kimi Setup

Forward this request to the local kimi-code companion runtime by shell. Do not use MCP for this skill.

## Invocation

- Resolve the plugin root from this skill source path: use the parent directory of the `skills/` directory that contains this `SKILL.md`. If `PLUGIN_ROOT` is already set, use that value.
- Launch the shell command from the user's current workspace directory so `scripts/companion.sh` captures the intended workspace cwd.
- Run: `PLUGIN_ROOT="<plugin-root>" "<plugin-root>/scripts/companion.sh" setup <args>`
- If the plugin host provides `PLUGIN_DATA` instead of `CLAUDE_PLUGIN_DATA`, the shell wrapper exports the Claude-compatible alias for the runtime.

## Arguments

Pass through: `[--check | --uninstall | --enable-review-gate | --disable-review-gate]`

## Handling

- Run setup from the user's workspace so the companion records the intended workspace cwd.
- Use `--check` for read-only verification and `--uninstall` only when explicitly requested.
- Report setup stdout verbatim because it contains hook and probe status.
