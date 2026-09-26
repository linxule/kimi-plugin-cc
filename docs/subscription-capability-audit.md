# Subscription capability audit — September 19, 2026

Status: implementation blocked by upstream interfaces. Neither subscription selection nor automatic fallback is enabled. This audit completes the capability spike in the [specification](subscription-switching-spec.md); it does not certify the proposed feature.

## Reviewed source

The latest released CLI at audit time was [Kimi Code 2.0.1](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai%2Fkimi-code%402.0.1), commit `caf7d4e2fef06967280b325da06e44a4b0516eba`. The source archive matched all 4,466 tracked blobs and symlinks at that commit. Two independent reviews covered routing (D1) and failure/recovery (D2/D3).

Unreleased main at `7d3f88faa44d6d0294fc4964f235735e03582967` was six commits ahead. Its changed-file comparison did not change the identified routing or print/recovery functions; the OAuth change added `goods_version` parsing. That comparison is not certification of main.

## D1: routing cannot be selected atomically

The OAuth resolver honors the regional environment pair, but model endpoint resolution continues to prefer configured model/provider URLs. With a mainland configuration and global overrides, the credential resolver selects the global credential slot while the model endpoint stays mainland. Reversing the regions produces the corresponding mismatch.

This is a source-level counterexample to treating the environment pair as a supported subscription switch. The audit did not send any token or HTTP request.

| Path at the exact commit | Finding |
| --- | --- |
| [Managed OAuth resolver, lines 363–382](https://github.com/MoonshotAI/kimi-code/blob/caf7d4e2fef06967280b325da06e44a4b0516eba/packages/oauth/src/managed-kimi-code.ts#L363-L382) | Environment selects the runtime OAuth ref and base URL. |
| [Model endpoint resolver, lines 163–178](https://github.com/MoonshotAI/kimi-code/blob/caf7d4e2fef06967280b325da06e44a4b0516eba/packages/agent-core-v2/src/llm-adapter/model/model-auth.ts#L163-L178) | Configured model and provider URLs take precedence independently. |
| [Search service, lines 60–86](https://github.com/MoonshotAI/kimi-code/blob/caf7d4e2fef06967280b325da06e44a4b0516eba/packages/agent-core-v2/src/app/auth/webSearch/webSearchService.ts#L60-L86) and [fetch service, lines 40–80](https://github.com/MoonshotAI/kimi-code/blob/caf7d4e2fef06967280b325da06e44a4b0516eba/packages/agent-core-v2/src/app/web/webService.ts#L40-L80) | Configured service/provider URLs are paired with independently resolved OAuth token providers. |
| [File endpoint, lines 12–18](https://github.com/MoonshotAI/kimi-code/blob/caf7d4e2fef06967280b325da06e44a4b0516eba/packages/agent-core-v2/src/human/llm-kimi/files.ts#L12-L18) | Files use the resolved model URL. |
| [CLI commands](https://github.com/MoonshotAI/kimi-code/blob/caf7d4e2fef06967280b325da06e44a4b0516eba/apps/kimi-code/src/cli/commands.ts) | Regional selection belongs to login; print has no equivalent selector or regional status/usage command. |

Usage, catalog and title paths use the regional runtime-auth resolver, but that does not correct the other consumers. The existing server usage/status routes operate on its active configured route, without a request-level regional selector. SDK status reports cached-token presence rather than verified authentication and remaining allowance.

Native login also changes saved state: [SDK login](https://github.com/MoonshotAI/kimi-code/blob/caf7d4e2fef06967280b325da06e44a4b0516eba/packages/node-sdk/src/auth.ts#L136-L155) provisions configuration, and [provisioning](https://github.com/MoonshotAI/kimi-code/blob/caf7d4e2fef06967280b325da06e44a4b0516eba/packages/oauth/src/managed-kimi-code.ts#L585-L641) updates the managed provider, model catalog, defaults/thinking and search/fetch services. It cannot implement the proposed credential-only login while preserving saved routing.

## D2: quota failure is not a terminal protocol result

[Print event dispatch](https://github.com/MoonshotAI/kimi-code/blob/caf7d4e2fef06967280b325da06e44a4b0516eba/apps/kimi-code/src/cli/v2/run-v2-print.ts#L681-L726) ignores `turn.ended`; failed turns become a formatted, thrown `Error`. The stream does not provide the specification's region, subscription scope, failed-turn identifier or recovery status.

The [internal quota classifier](https://github.com/MoonshotAI/kimi-code/blob/caf7d4e2fef06967280b325da06e44a4b0516eba/packages/agent-core-v2/src/human/llm-kimi/errors.ts#L40-L64) recognizes both structured provider codes and message wording such as a recharge request. A generic 429 alone is insufficient, and the internal quota classification is not proof of subscription allowance exhaustion.

## D3: failed-turn continuation is not established

- [Session announcement](https://github.com/MoonshotAI/kimi-code/blob/caf7d4e2fef06967280b325da06e44a4b0516eba/apps/kimi-code/src/cli/v2/run-v2-print.ts#L317-L327) follows successful turn completion. A fresh failed generation bypasses that announcement.
- Print mode flushes partial assistant output before checking the failure result. Ordinary resume then submits a new user message; it is not a failed-turn continuation operation.
- Journal restore retains tool context, but this does not prove exclusion of failed partial generations or prevent replay during a new turn.
- Session-manager and lifecycle maps coordinate within a process. No cross-process exclusive ownership guard was found along the native resume/write path. A plugin-only lease cannot exclude Desktop or direct CLI writers.

These are source findings and controlled function probes, not a live subscription recovery test. No live test would establish the missing interface merely by succeeding once.

## Reproduce without authentication

Export the reviewed source into an otherwise disposable directory, then run:

```sh
bun scripts/audit-subscription-routing.ts /path/to/exact-2.0.1-source
bun scripts/audit-subscription-recovery.ts /path/to/exact-2.0.1-source
```

The probes verify SHA-256 pins before extracting and executing selected upstream functions. They use synthetic configuration/events with no host environment, credentials or provider requests. Exit zero means the documented blockers reproduced; it does not mean fallback is supported. Changed source pins must be reviewed, never blindly updated.

Routing evidence: two unchanged-route controls and four cross-region counterexamples covering provider-level and model-level endpoints. This probe demonstrates the resolver mismatch; search/fetch/file findings come from the separate source review, not an HTTP test.

Recovery evidence: the extracted print writer receives no terminal event and flushes failed partial text on finish; four quota cases distinguish structured quota, generic 429, wording-only 429 and non-429 wording. The extracted context fold seals nonempty failed text while dropping whitespace. These probes do not execute full session resume or prove concurrency behavior.

Validation: both offline probes reproduced their documented results; the routing probe received an independent review. `bun run check` passed with 898 tests, 28 opt-in skips, zero failures and 2,965 assertions. Installed hosts and subscription authentication were unchanged.

Tooling update, September 26: the probes now use the TypeScript 7 async parser and Bun's transpiler. Both reproduced the same findings against the pinned 2.0.1 source. The full check passed with 906 tests, 28 opt-in skips and zero failures, including a regression check for declaration selection and source-hash refusal. This updates the audit tooling; it does not assess a newer CLI version.

## Required upstream work

1. Provide a process-local region selector shared by all credential, refresh and endpoint consumers, including tools and file/title services. Reject conflicting overrides. Add regional status/catalog/usage and credential-only login that preserve saved defaults and hook configuration.
2. Announce session identity before generation. Emit a versioned terminal failure envelope with validated subscription scope, selected region, turn identity and recovery state. Keep transient rate limits and generic errors distinct from subscription exhaustion.
3. Provide explicit failed-turn recovery and native cross-process session ownership. Demonstrate completed-tool preservation, failed-generation handling, cancellation and concurrent-writer refusal with real subprocess lifecycle tests.

Only after these interfaces exist should Stage A/B production adapters be implemented and the exact upstream binary certified. The plugin must not infer a switch from stderr, rewrite shared login between attempts, clone authentication, or load installed private upstream modules. No production flags, preference files or dormant attempt tables were added. No upstream message was sent.
