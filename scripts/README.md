# scripts

Shell entry points that wrap the Node companion so Claude Code plugin commands launch from `${CLAUDE_PLUGIN_ROOT}` regardless of the user's cwd.

- `companion.sh` — launches `dist/companion.js` for all slash commands. Passes the user's original cwd via `KIMI_PLUGIN_CC_WORKSPACE_CWD` so the runtime still operates on the caller's repo. Resolves `node` via `KIMI_PLUGIN_CC_NODE_BIN` or `command -v node`.
- `review-gate-hook.sh` — same pattern, dedicated entry point for the Claude Code `Stop` hook.
- `smoke-rescue-drift.sh` — operator-run drift detection script for verifying rescue behavior after Kimi CLI upgrades.

Both shell scripts default `CLAUDE_PLUGIN_ROOT` to the repo checkout when run outside of an installed plugin context, so local development via `bun run check` still works.
