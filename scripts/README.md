# scripts

Shell entry points that wrap the Node+tsx companion so Claude Code plugin commands launch from `${CLAUDE_PLUGIN_ROOT}` (where `tsx` and `better-sqlite3` are installed) regardless of the user's cwd.

- `companion.sh` — launches `runtime/companion.ts` for all slash commands. Passes the user's original cwd via `KIMI_PLUGIN_CC_WORKSPACE_CWD` so the runtime still operates on the caller's repo.
- `review-gate-hook.sh` — same pattern, dedicated entry point for the Claude Code `Stop` hook.
- `lib/` — shared test fixtures for the companion scripts (not runtime code).

Both shell scripts default `CLAUDE_PLUGIN_ROOT` to the repo checkout when run outside of an installed plugin context, so local development via `bun run check` still works.
