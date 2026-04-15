# References

Primary source links for reviewers validating the `kimi-plugin-cc` planning bundle.

## Codex plugin references

- Codex plugin repository: [https://github.com/openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
- Codex plugin README: [https://raw.githubusercontent.com/openai/codex-plugin-cc/main/README.md](https://raw.githubusercontent.com/openai/codex-plugin-cc/main/README.md)

Useful repository paths to inspect (current `openai/codex-plugin-cc` layout; also mirrored in the installed plugin cache at `~/.claude/plugins/cache/openai-codex/codex/<version>/`):

- `scripts/lib/app-server.mjs`
- `scripts/codex-companion.mjs`
- `scripts/lib/render.mjs` — especially `renderTaskResult` and `firstMeaningfulLine` (the 4-line pass-through pattern kimi-plugin-cc's rescue was refactored toward in 0.1.7; see [ADR 004](./adr/004-rescue-pass-through.md))
- `scripts/lib/state.mjs`
- `scripts/lib/job-control.mjs`
- `agents/codex-rescue.md`
- `hooks/hooks.json`
- `prompts/` — contains only `adversarial-review.md` and `stop-review-gate.md`; Codex task has no system prompt file

## Kimi CLI references

- Kimi Wire mode: [https://moonshotai.github.io/kimi-cli/en/customization/wire-mode.html](https://moonshotai.github.io/kimi-cli/en/customization/wire-mode.html)
- Kimi command reference: [https://moonshotai.github.io/kimi-cli/en/reference/kimi-command.html](https://moonshotai.github.io/kimi-cli/en/reference/kimi-command.html)
- Kimi sessions and context: [https://moonshotai.github.io/kimi-cli/en/guides/sessions.html](https://moonshotai.github.io/kimi-cli/en/guides/sessions.html)
- Kimi interaction guide: [https://moonshotai.github.io/kimi-cli/en/guides/interaction.html](https://moonshotai.github.io/kimi-cli/en/guides/interaction.html)
- Kimi agents and subagents: [https://moonshotai.github.io/kimi-cli/en/customization/agents.html](https://moonshotai.github.io/kimi-cli/en/customization/agents.html)
- Kimi slash commands: [https://moonshotai.github.io/kimi-cli/en/reference/slash-commands.html](https://moonshotai.github.io/kimi-cli/en/reference/slash-commands.html)

## Claude Code plugin references

- Claude Code plugin docs: [https://code.claude.com/docs/en/plugins](https://code.claude.com/docs/en/plugins)
- Claude Code hooks overview: [https://code.claude.com/docs/en/features-overview](https://code.claude.com/docs/en/features-overview)

## Suggested review order

1. Read [spec.md](./spec.md)
2. Open the Codex plugin repo and compare the runtime/plugin split
3. Read the Kimi Wire, command, sessions, and agents docs
4. Cross-check the ADRs and implementation plan against those primary sources
5. Verify the review-gate expectations specifically against the Claude Code hooks docs
