---
name: kimi-ask
description: "Ask Kimi a read-only free-form question about the current repository. Use for prose explanations, flow tracing, module comparisons, or conceptual reasoning where Codex should delegate the answer to local kimi-code rather than perform implementation."
---

# Kimi Ask

Forward this request to the local kimi-code companion runtime by shell. Do not use MCP for this skill.

## Invocation

- Resolve the plugin root: prefer `$PLUGIN_ROOT` if the host sets it; otherwise use the directory that CONTAINS the `skills/` directory (i.e. two levels up from this `SKILL.md`).
- Sanity check: `<plugin-root>/scripts/companion.sh` must exist — it is the bundled entrypoint that resolves Node and runs the compiled runtime from `<plugin-root>/dist/`.
- Launch the shell command from the user's current workspace directory so `scripts/companion.sh` captures the intended workspace cwd.
- Run: `PLUGIN_ROOT="<plugin-root>" "<plugin-root>/scripts/companion.sh" ask <args>`
- If the plugin host provides `PLUGIN_DATA` instead of `CLAUDE_PLUGIN_DATA`, the shell wrapper exports the Claude-compatible alias for the runtime. If neither is set, the wrapper uses a Codex data directory under `$CODEX_HOME/plugins/data/kimi-marketplace-kimi`, `~/.codex/plugins/data/kimi-marketplace-kimi`, or `/tmp/kimi-plugin-cc-codex-data/kimi-marketplace-kimi` in a fully sanitized environment.

## Arguments

Pass through: `[--background] [--wait] [-r | --resume <id>] [--fresh] [-m <model>] <prompt>`

## Handling

- Preserve the user's question and supplied flags exactly; use `-r` only for explicit resume intent unless `--fresh` is requested.
- Choose `--background` for broad or long-running questions and return the job id that the companion prints.
- If the companion reports ASK_HOOK_NOT_INSTALLED, tell the user to run Claude Code /kimi:setup or Codex $kimi-setup, then retry; do not suggest the skip env.
- Return companion stdout verbatim; do not summarize or re-voice Kimi's prose.
