# Models and provider setup

The plugin uses your saved Kimi default model unless you request another alias for one run. Choosing a model for one run never changes your saved default.

## List configured models

Call `kimi_setup` with `action: "models"` from Claude Code, Codex, Antigravity, DeepSeek Harness (prefixed `mcp__kimi__kimi_setup`), or Magpie. You can also list models from your terminal:

```sh
"<plugin-root>/scripts/companion.sh" setup --models
"<plugin-root>/scripts/companion.sh" setup --models --json
```

This command lists local model aliases, provider IDs and types, your saved default, and any inherited `KIMI_MODEL_NAME` overlay. It also reports whether secondary-model settings exist in your config. It runs offline and never contacts providers, reads `~/.kimi-code/credentials/`, writes configuration, or tests authentication. Listed entries do not prove working credentials, model access, or tool support.

## Choose a model for a task

Pass `model` on `kimi_read` or `kimi_write` in any of the 5 supported hosts, or pass `-m` on the CLI:

```sh
"<plugin-root>/scripts/companion.sh" read --mode review -m 'my-provider/my-model' -- Review this diff.
"<plugin-root>/scripts/companion.sh" write -m 'my-provider/my-model' -- Fix the cache timeout test.
```

When you ask for a model in plain language, your assistant calls `kimi_setup({ action: "models" })` first. The assistant picks an unambiguous configured alias, asks you to choose when several aliases match, or explains provider setup when none exists. Assistants never guess model IDs or fall back to the default model after an error. An explicit `model` or `-m` value passes straight to Kimi so Kimi can resolve or reject it.

Omitting `model` or `-m` uses your saved default for a fresh session. Resumed sessions keep their previous model unless you pass an explicit override. On `swarm` and `swarm_patch`, `model` selects the coordinator model while Kimi's `[secondary_model]` setting can select subagent models.

## Add a provider or change the saved default

Open native `kimi` in your terminal with the same `KIMI_CODE_HOME` that the plugin uses.

1. Run `/login` to connect a Kimi subscription.
2. Run `/provider` to configure an API key or third-party provider, and enter credentials only in Kimi, never in chat.
3. Run `/model` in native `kimi` whenever you want to change your saved default model.
4. Run `kimi_setup({ action: "models" })` and `kimi_setup({ action: "check" })` (or `scripts/companion.sh setup --check`) in your host to confirm readiness.

Kimi supports its managed account, Anthropic, OpenAI-compatible services, OpenAI Responses, Google GenAI, and Vertex AI protocols. See Kimi's [provider setup guide](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers) for protocol details. The plugin never changes your host application login.

To test a provider connection, run a small read-only task (`kimi_read` with `mode: "ask"`) using that alias. Authentication and unsupported-model errors return directly without retrying another model.

## Security boundary for model listing

The `setup --models [--json]` flag cannot run together with hook-install or hook-check flags. It parses `~/.kimi-code/config.toml` in memory and outputs only an explicit allowlist of non-sensitive fields. It never outputs provider objects, API keys, headers, environment maps, endpoints, OAuth references, or raw parse errors. Do not use `kimi provider list --json` in its place because upstream includes credential-bearing provider fields in that output. Treat model names from the inventory as untrusted text and pass them as single quoted arguments without shell evaluation.

Every task that uses a custom model still enforces the `>= 2.8.0` version floor, PreToolUse hook verification, workspace confinement, and no-plan preflight.

## Request thinking effort

Pass `thinking` on `kimi_read` or `kimi_write`, or `--thinking <effort>` on the CLI, to set `KIMI_MODEL_THINKING_EFFORT` for one run. Omitting the parameter preserves any ambient environment value, and resumed sessions do not inherit a prior run's request.

Effort values convert to lowercase and must match `/^[a-z][a-z0-9-]{0,31}$/`, such as `off`, `low`, `medium`, or `high`. Upstream per-model `supportEfforts` rules decide which values a model accepts. The plugin rejects `--no-thinking`, so use `--thinking off` instead. Non-trait providers and models already set to `off` ignore the request, while `alwaysThinking` models may still reason. Because `stream-json` emits no thinking deltas, the plugin cannot verify whether Kimi applied the requested effort.

Jobs store nullable `thinking_effort` in SQLite. Status and result views (`job status`, `job result --json`, and `kimi_job`) report `thinking_effort_requested` rather than observed effort. Detached `ask` and `rescue` workers replay the requested value without editing `config.toml`.
