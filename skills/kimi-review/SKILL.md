---
name: kimi-review
description: "Run an independent read-only Kimi review over the current working tree or a branch diff. Use when the user wants a second reviewer for defects, regressions, or implementation risks, not edits."
---

# Kimi Review

Forward this request to the local kimi-code companion runtime by shell. Do not use MCP for this skill.

## Invocation

- Resolve the plugin root from this skill source path: use the parent directory of the `skills/` directory that contains this `SKILL.md`. If `PLUGIN_ROOT` is already set, use that value.
- Launch the shell command from the user's current workspace directory so `scripts/companion.sh` captures the intended workspace cwd.
- Run: `PLUGIN_ROOT="<plugin-root>" "<plugin-root>/scripts/companion.sh" review <args>`
- If the plugin host provides `PLUGIN_DATA` instead of `CLAUDE_PLUGIN_DATA`, the shell wrapper exports the Claude-compatible alias for the runtime. If neither is set, the wrapper uses a Codex data directory under `$CODEX_HOME/plugins/data/kimi-marketplace-kimi`, `~/.codex/plugins/data/kimi-marketplace-kimi`, or `/tmp/kimi-plugin-cc-codex-data/kimi-marketplace-kimi` in a fully sanitized environment.

## Arguments

Pass through: `[--base <ref>] [-m <model>] [extra prose]`

## Handling

- Forward `--base <ref>`, `-m`/`--model <name>`, and any trailing focus text only.
- Do not invent file/path flags; review's payload is the git diff plus optional focus text.
- Return companion stdout verbatim and leave any fixes to a separate user request.
