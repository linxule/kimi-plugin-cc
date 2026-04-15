# hooks

Claude Code hook definitions. Currently one opt-in hook is shipped:

- `hooks.json` — registers a `Stop` hook that routes through
  `${CLAUDE_PLUGIN_ROOT}/scripts/review-gate-hook.sh` and launches the compiled review-gate
  runtime (`dist/hooks/review-gate-stop.js`). Disabled by default; toggle with
  `/kimi:setup --enable-review-gate` / `--disable-review-gate`. Fails open: malformed or
  timed-out gate output becomes a warning, never a silent block.
