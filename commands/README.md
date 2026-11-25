# Kimi task commands

These Markdown files expose Kimi's task, review, pursue, and swarm capabilities as Claude Code commands, routed through `scripts/companion.sh` to the Node runtime and local Kimi Code CLI. They also describe supported flags and model-selection rules. Codex uses the generated skills in `plugins/kimi-codex/skills/`.

| File | Purpose |
| --- | --- |
| `setup.md` | Install or check hooks, list models, install a certified Kimi Code CLI on request, guide provider setup, and manage the review gate |
| `task.md` | Answer repository questions without write tools, or use `--write` to make workspace changes, with background and resume support |
| `review.md` | Review code changes and return prose, or use `--challenge` to critique the design or approach |
| `pursue.md` | Run an experimental goal with a finite time budget |
| `swarm.md` | Run a read-only parallel review, or use `--write` to return an unapplied patch |
| `status.md`, `result.md`, `cancel.md`, `replay.md` | Follow, stop, or replay stored jobs |

After editing a command, update its hash in `CLAUDE_SURFACE_HASHES` in `scripts/surface-registry.ts`. Run `bun run generate:surfaces` and `bun run check` before considering the change complete.
