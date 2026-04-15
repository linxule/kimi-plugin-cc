#!/usr/bin/env bash
set -euo pipefail

# Entry point for slash commands. Launches the Node+tsx companion from the plugin root so
# that tsx and its runtime dependencies resolve against the plugin's node_modules, while
# preserving the user's working directory via KIMI_PLUGIN_CC_WORKSPACE_CWD.
#
# Required env: CLAUDE_PLUGIN_ROOT (set by Claude Code when the plugin is installed).
# When running from the repo checkout, CLAUDE_PLUGIN_ROOT is unset — default to the script's
# parent directory so `bun run` style local invocation still works.

: "${CLAUDE_PLUGIN_ROOT:=$(cd "$(dirname "$0")/.." && pwd)}"
export KIMI_PLUGIN_CC_WORKSPACE_CWD="${KIMI_PLUGIN_CC_WORKSPACE_CWD:-$PWD}"

cd "${CLAUDE_PLUGIN_ROOT}"
exec node --import tsx runtime/companion.ts "$@"
