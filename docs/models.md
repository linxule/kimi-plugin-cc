# Models and provider setup

The plugin uses your configured Kimi model by default. You can ask for a different
configured model for one task without changing that default.

## See configured models

In Claude Code, run `/kimi:setup --models`. In Codex, ask `$kimi-setup` to list
models. In DSH, run `/kimi-setup --models` (or `--models --json`). The underlying command is:

```sh
"<plugin-root>/scripts/companion.sh" setup --models
"<plugin-root>/scripts/companion.sh" setup --models --json
```

This lists local model aliases, provider IDs/types, the saved default, and any
`KIMI_MODEL_NAME` default overlay inherited by the companion. It also reports
whether secondary-model settings exist. It does not contact providers, read the
OAuth store, write configuration, or test authentication. Configured entries
are not a guarantee of working credentials, model access, or tool support.
Provider catalogs refreshed by Kimi may add models not yet present locally.

## Choose a model for a task

Say “review this with my configured fast model” or pass its exact alias:

```text
/kimi:review -m 'my-provider/my-model' review this diff
/kimi:ask -m 'my-provider/my-model' explain the cache
```

The Claude agents and Codex skills list models when you request a model in
natural language. They select a unique configured match, ask when there are
several, and guide setup when there is none. They do not guess model IDs or
silently substitute the default after an error. An explicit `-m` remains a
pass-through alias, so upstream can resolve it or report an error.

DSH activations are one-shot and do not expose per-call model fields. Set `model` in the bundle's `kimi-plugin-cc` profile row to use one exact configured alias for every delegation from that profile; omit it to use the native Kimi default. This does not change the saved default or add fallback selection.

Omitting `-m` uses the default for a **fresh** session. A resumed session keeps
its previous model unless you supply `-m`. The optional review gate also uses
the default unless `KIMI_PLUGIN_CC_REVIEW_GATE_MODEL` explicitly selects an alias.
Swarm `-m` selects the coordinator; upstream `[secondary_model]` settings can
select different models for its children.

## Add a provider or change the saved default

Open native `kimi` using the same `KIMI_CODE_HOME` as the plugin:

1. For a Kimi subscription, use `/login`.
2. For an API key or another provider, use `/provider` and follow its native
   prompts. Enter credentials there, never in the host conversation. Provider
   setup may offer a default-model picker; select a new saved default only if
   you want that persistent change.
3. To explicitly change your saved default later, use native `/model`.
4. Return to the plugin, list models again, then run `setup --check` to verify
   hook readiness. If it requests re-pinning, run the host's setup command.

Kimi supports its managed account, Anthropic, OpenAI-compatible services,
OpenAI Responses, Google GenAI, and Vertex AI protocols. Available models and
authentication requirements depend on the provider. See the upstream
[provider setup guide](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers).
The plugin does not switch Claude Code or Codex's own authentication.

For a one-off connection test, explicitly request a small task with the chosen
alias. That makes a provider call under your account and the usual plugin
safety gates. Listing alone is offline. An authentication or unsupported-model
error is surfaced without retrying a different model.

## Implementation boundary

`setup --models [--json]` is mutually exclusive with hook setup flags. It parses
the complete TOML in memory and emits an explicit field allowlist; it never
serializes providers, keys, headers, environment maps, endpoints, OAuth
references, or raw parse errors. Do not substitute `kimi provider list --json`:
upstream 2.0.0 includes credential-bearing provider objects in that output.
Names in the inventory are untrusted configuration data and must be passed as
one correctly shell-quoted argument, never evaluated as shell instructions.

The model list is a routing aid, not a second implementation of Kimi's config
validator. Every task still uses the existing exact-version, hook, workspace,
and no-plan checks. Source review is against kimi-code 2.0.0 (`1b89e4b0`),
including `kosongConfig/configSection.ts`, `envOverlay.ts`, and
`cli/v2/run-v2-print.ts`.

## Requested thinking effort

`--thinking <effort>` requests per-run effort through `KIMI_MODEL_THINKING_EFFORT`, never a CLI flag or saved-default change; omitted flags preserve the operator-owned ambient variable, and resume does not inherit a previous job's request. Providers that are not trait-driven silently ignore it, as does a base level already `off`; an `alwaysThinking` model receives `off` unnormalized. Stream-json carries no thinking deltas (`writeThinkingDelta() {}`), so the plugin cannot verify whether the request was honoured.

Use `--thinking off`, `--thinking high`, or `--thinking=<effort>` before the prompt. Values are lowercased and must match `/^[a-z][a-z0-9-]{0,31}$/` (a plugin-owned syntax bound; a future upstream token outside it is rejected before upstream sees it); upstream per-model `supportEfforts`, not a plugin enum, determines supported values. `--no-thinking` is an error: use `--thinking off`. In CLI 2.2.0 only the three Moonshot `kimi*` provider definitions are trait-driven. BYO providers ignore the request silently; an always-thinking model may remain thinking.

DSH forwards the profile's `thinkingEffort` value as `--thinking <effort>` on every delegation. Omission preserves the ambient operator value; the same provider and observability limits apply.

Jobs persist nullable `thinking_effort`; status and `result --json` expose `thinking_effort_requested`, not observed effort. Detached ask/rescue workers replay the request. A resume without `--thinking` exports no new override (any ambient operator value remains). No config.toml write occurs.

The review gate requests `off` by default. `KIMI_PLUGIN_CC_REVIEW_GATE_THINKING=inherit` exports no override; another non-empty value is lowercased and must match the same regex. Unset or empty means `off`; an invalid value makes the gate skip visibly. The gate remains fail-open on its 8 s timeout: a BYO provider or always-thinking model can ignore the request, and even an honoured request does not guarantee completion within the budget.
