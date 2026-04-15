#!/usr/bin/env bash
set -euo pipefail

# Entry point for the Claude Code Stop hook. Same cwd/env dance as companion.sh — launches
# Node+tsx from the plugin root so tsx resolves, while preserving the user's workspace cwd.

: "${CLAUDE_PLUGIN_ROOT:=$(cd "$(dirname "$0")/.." && pwd)}"
export KIMI_PLUGIN_CC_WORKSPACE_CWD="${KIMI_PLUGIN_CC_WORKSPACE_CWD:-$PWD}"

cd "${CLAUDE_PLUGIN_ROOT}"
exec node --import tsx runtime/hooks/review-gate-stop.ts
