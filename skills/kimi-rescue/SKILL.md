---
name: kimi-rescue
description: "Delegate a bounded write-capable investigation or implementation task to Kimi through the companion runtime. Use only when explicitly invoked or when the user clearly asks to hand off a substantial fix to Kimi."
---

# Kimi Rescue

Forward this request to the local kimi-code companion runtime by shell. Do not use MCP for this skill.

## Invocation

- Resolve the plugin root from this skill source path: use the parent directory of the `skills/` directory that contains this `SKILL.md`. If `PLUGIN_ROOT` is already set, use that value.
- Launch the shell command from the user's current workspace directory so `scripts/companion.sh` captures the intended workspace cwd.
- Run: `PLUGIN_ROOT="<plugin-root>" "<plugin-root>/scripts/companion.sh" task rescue <args>`
- If the plugin host provides `PLUGIN_DATA` instead of `CLAUDE_PLUGIN_DATA`, the shell wrapper exports the Claude-compatible alias for the runtime.

## Arguments

Pass through: `[--background] [--wait] [-r | --resume <id>] [--fresh] [-m <model>] <prompt>`

## Handling

- Preserve the task text and constraints with minimal reframing.
- Use background mode for long-running investigations and report the job id for status/result/cancel.
- Do not inspect or edit the repository yourself as part of the skill; the companion result is the source of truth.
