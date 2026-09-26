# Subscription selection and automatic fallback

Status: proposed specification, September 17, 2026; published September 19, 2026. No feature in this document is implemented in plugin 2.0.3. Target release number is unassigned.

Implementation spike, September 19: exact CLI 2.0.1 does not meet D1, D2 or D3. The [capability audit and offline probes](subscription-capability-audit.md) reproduce routing separation and missing terminal failure evidence. Both stages remain blocked on the upstream interfaces described there.

## Outcome

Use the user's normal Kimi subscription by default. Let them select their kimi.com or kimi.ai subscription for a task. After they enable automatic fallback, an eligible task can continue on the other subscription when the first exhausts its allowance.

Keep the saved model and subscription default unchanged. Show which subscription handled each attempt. Login remains in native Kimi; the plugin never collects, reads, copies, or rotates tokens itself.

The first automatic-fallback release covers read-only `ask` sessions on macOS and Linux. It does not promise an uninterrupted model request: fallback stops one process and resumes the local session in another.

## Scope and release gates

| Stage | Included | Gate |
| --- | --- | --- |
| A: explicit selection | Subscription inventory, native login guidance, per-task selection for ask, review and challenge | Atomic upstream routing and safe status interface, D1 below |
| B: automatic fallback | Opt-in fallback for text-only ask, including sessions with completed read-only tools | Stage A, structured quota evidence D2, verified continuation D3 |
| Later | Write-capable tasks, swarm, review-gate fallback, attachment transfer, multiple accounts in one region | Separate design and certification |

Neither stage ships through an unreviewed workaround. Kimi Code 2.0.0 supplies regional credential storage, but does not establish D1 to D3. A newer upstream version must pass the existing exact-version certification gates before use.

Existing commands continue unchanged when this feature is unused. Explicit subscription flags on unsupported operations fail before spawning. A saved fallback preference applies only to ask; it does not change other operations.

API-key providers are outside this feature. They remain selectable with the existing model option. Exhausting a subscription never starts a paid API request automatically.

## User-facing contract

These are proposed companion commands, not commands available in plugin 2.0.3. Claude wrappers and Codex skills expose the same behavior through existing setup and ask/review/challenge surfaces.

```sh
companion.sh setup --subscriptions --json
companion.sh setup --subscriptions --check kimi.ai --json
companion.sh setup --subscription-fallback kimi.com,kimi.ai
companion.sh setup --subscription-fallback off

companion.sh ask --subscription kimi.ai "Explain this module"
companion.sh review --subscription kimi.com "Review this diff"
companion.sh ask --subscription auto "Explain this module"
companion.sh ask --subscription default "Use my usual subscription for this task"
```

`--subscription` accepts exactly `default`, `kimi.com`, `kimi.ai`, or `auto`. Unknown values, duplicate flags and unsupported combinations raise `INVALID_ARGS`.

`auto` is supported only by ask. Review and challenge accept named regions or `default`, and retain their existing fresh-session behavior. In Stage A, an ask resume may select a region only when recorded provenance proves it is unchanged. Changing the region of an existing session requires D3, even when the user selects the alternate manually.

`setup --subscription-fallback` accepts exactly the 2 distinct regional IDs in either order, or `off`. A one-element list, duplicate region, arbitrary URL, or API provider is invalid. Configuration commands are mutually exclusive with hook setup flags.

### Selection rules

1. `default` explicitly disables fallback for this invocation and preserves native routing.
2. A named region selects only that region. It overrides a saved fallback preference and never falls through to the other region.
3. `auto` requires an enabled saved list. If absent, return `SUBSCRIPTION_FALLBACK_NOT_CONFIGURED`.
4. Without a flag, ask uses the saved fallback preference if enabled; otherwise all commands preserve native routing.
5. In auto mode, a fresh task starts with the current native regional default. The saved order selects the remaining candidate. A continuation starts with the region last used by its session.
6. If the native default cannot be identified as one of the 2 managed subscriptions, auto mode refuses. It does not replace an API-key or custom-provider default.

The initial default means the default of the Kimi home used by the plugin. It does not mean the browser account, installation region marker, or whichever website the user last visited.

An explicit `-m` must resolve to a managed subscription model available on the selected region. Auto mode preserves the same model ID and required capabilities across attempts. Missing access produces `SUBSCRIPTION_MODEL_UNAVAILABLE`; there is no silent model substitution.

### Setup and login

The ordinary inventory is offline. It reports the 2 supported region IDs, the active configured region if known, the saved fallback preference, and capability support. Authentication and remaining allowance stay `unknown` unless a separate check establishes them.

`--check <region>` is an explicit network operation through the reviewed upstream interface. It requests status, catalog availability and usage, with no model generation. It has a 15-second total deadline and makes no automatic retry after a failed check.

Allowlisted results include `auth: valid | login_required | unknown`, `quota: available | exhausted | unknown`, `checked_at`, and a nullable `reset_at`. Keep quota windows distinct. A timeout is `unknown`, never proof that an account is exhausted. Do not expose account names, emails, tokens, raw endpoints, or upstream response bodies.

If login is needed, guide the user into native Kimi's regional login flow. Do not open login from a background worker. Stage A requires that the login flow can retain both regional credentials without changing the saved default as a side effect. Current native login can update managed configuration, so do not claim this flow is ready on 2.0.0.

Enabling fallback is the user's standing choice to send eligible session context to either selected regional service. Explain that once during setup. It authorizes bounded attempts for later user-requested tasks, not polling or unattended work between tasks.

### Visible behavior

Keep model prose as prose. Record the switch in persisted status and the final artifact so it does not depend on a human reading stderr.

Example notice:

> kimi.com reached its subscription limit. Continuing this session with kimi.ai. Your saved default is unchanged.

Example final metadata:

> Subscription: kimi.ai. Continued from kimi.com after quota exhaustion. Attempts: 2.

If both subscriptions fail, retain partial output and report both attempt outcomes. If authentication, routing, or recovery is uncertain, stop with the specific reason.

## Runtime design

### D1: one immutable routing choice per process

Require an upstream-supported process-local selector for `mainland-cn` or `global`. The exact upstream command spelling must be reviewed before implementation; this specification does not invent an existing CLI flag.

The selector must bind credential lookup, token refresh, model requests, catalog requests, usage, search, fetch, file services, and title generation to the same regional profile. It must not change config.toml, model defaults, hook tables, session location, or the parent environment.

Keep one absolute `KIMI_CODE_HOME` throughout a task. The same home retains local session history and native-owned regional credentials. Both endpoints must come from the certified built-in profile, not user-supplied URLs. Refuse conflicting ambient routing or model-auth overrides before spawn. Ordinary default-mode invocations retain existing behavior.

The plugin creates an immutable `SubscriptionExecutionPlan` containing the requested mode, initial region, eligible alternate, resolved model, absolute home, policy revision, and overall deadline. Persist and pass this plan to detached workers. Workers must not reload a changed preference and redirect an in-flight task.

Continue to re-probe the binary, verify the hook, check configuration and session lineage, and enforce no-plan mode at every spawn. The routing overlay must be restricted to authentication routing; it must not introduce a second effective safety configuration.

Do not implement D1 by switching the shared login between attempts, cloning config or credential files, importing internal upstream modules from an installed bundle, or setting only the OAuth endpoint variables.

### D2: structured failure evidence

Require a machine-readable terminal result from the upstream process. The adapter normalizes it into the following plugin-owned contract. These fields are a requirement for the adapter, not a claim about today's stream-json format.

```ts
type SubscriptionFailure = {
  schemaVersion: 1;
  kind: "quota_exhausted" | "rate_limited" | "auth" | "other";
  scope: "subscription" | "other" | "unknown";
  region: "kimi.com" | "kimi.ai";
  sessionId: string | null;
  turnId: string | null;
  resetAt: string | null; // validated UTC timestamp
  continuation: "safe" | "unsafe" | "unknown";
};
```

Only `quota_exhausted` with `scope=subscription` can trigger a switch. Generic 429s, network errors, invalid authentication, overload, and budget exhaustion cannot. Internal SDK retries against transient throttling remain inside the same attempt and deadline.

The event must agree with the selected region and announced session. Accept it only from the subprocess protocol, outside model/tool content, with the certified version marker and reviewed terminal ordering. Duplicate, contradictory, malformed or missing evidence prevents fallback. Human stderr matching and a bare nonzero exit cannot authorize a switch.

A proactive usage check can inform the user, but does not prove that a failed turn can be resumed. Stage B switches only after the generation attempt supplies the required terminal evidence.

### D3: continuation without resubmitting the task

The first process must have ended and its descendants must be quiescent before the second starts. Hold a session lease across both attempts. Resume the same local session; never submit the original task as fresh work.

The upstream continuation adapter must preserve completed tool results, identify the failed turn boundary, and exclude a partial failed generation from the successful result. A reviewed fixed continuation prompt is acceptable only if real lifecycle tests prove its semantics. A `safe` field alone does not establish recovery correctness.

Stage B admits text-only ask sessions without uploaded files, remote resource handles, pending tools, active subagents, or unverified durable effects. Missing session ID or uncertain recovery returns `SUBSCRIPTION_CONTINUATION_UNSAFE`.

Resuming an old terminal job remains a new job linked through `resumed_from_job_id`. Older jobs without subscription provenance can resume on the existing default path; they cannot automatically switch until a verified attempt establishes the required provenance.

### Attempt lifecycle

Keep one public job ID for automatic fallback. Add attempt records beneath that job. This replaces the earlier research suggestion of exposing each automatic attempt as a separate job: one ID keeps status, cancellation and result lookup stable.

```text
preflight -> attempt 1 -> success ----------------------> completed
                    -> other failure -----------------> failed
                    -> confirmed quota exhaustion
                         -> settle process tree
                         -> validate continuation and alternate
                         -> attempt 2 -> success ------> completed
                                      -> any failure -> failed
any nonterminal state -> cancellation ----------------> cancelled
```

No third attempt, wraparound, or fallback to the original subscription occurs within a job. A named-region invocation has one attempt. Missing login on the alternate ends the job; the worker does not interactively reauthenticate.

Use one monotonic deadline for the full job, based on the operation's existing timeout. Preflight, status/catalog requests, teardown, retry delays and both attempts consume it. A switch never resets the budget. Cancellation overrides any pending switch and forbids a later spawn.

Stage B keeps no cross-job quota cache and starts no background usage monitor. This deliberately avoids stale account identity and quota-reset guesses. Exhausted regions are excluded for the remainder of the current job. Later jobs begin under the normal selection rules; persistent cooldowns are later work.

### Persistence and concurrency

Add a versioned `subscriptions.json` under the resolved host-specific plugin state directory. Store only the fallback preference, a revision, and its absolute Kimi-home binding. Use an atomic 0600 write and a bounded adjacent lock; invalid contents fail closed. Do not alter the existing review-gate config writer as part of this feature.

```json
{
  "schemaVersion": 1,
  "revision": 1,
  "kimiHome": "/absolute/path/to/kimi-home",
  "fallback": {
    "enabled": true,
    "order": ["kimi.com", "kimi.ai"]
  }
}
```

No file means fallback is off. A successful setup write increments the revision. Reject unknown schema versions, invalid field types and a nonabsolute home. This is a user/host preference; repository content and model output cannot enable it.

Changing `KIMI_CODE_HOME` invalidates automatic-policy matching; never apply a different home's preference silently. Disabling fallback affects new jobs. Cancel an existing job to prevent an already authorized in-flight switch.

Add subscription provenance to jobs and a `job_attempts` table with this minimum data:

| Field | Meaning |
| --- | --- |
| `job_id`, `attempt_index` | Composite primary key; indexes 1 and 2 |
| `region`, `resolved_model` | Actual selected subscription and model |
| `status` | `prepared`, `running`, `completed`, `failed`, or `cancelled` |
| `started_at`, `ended_at` | Attempt timing |
| `session_id`, `turn_id` | Upstream continuity identifiers when established |
| `failure_kind`, `reset_at` | Allowlisted structured failure evidence |
| `stream_log_path`, `output_path` | Separate artifacts for each attempt |
| `intended_engine`, `observed_engine`, `kimi_version`, `system_version` | Evidence for this process, not merely the first attempt |

Keep parent job status `running` while switching, with `phase=subscription-switching`. Terminal job and attempt states are permanent. Claim the next attempt transactionally, with a unique active-attempt constraint. Persist validated session metadata even when an attempt fails; currently ask stores the session ID after its success assertion.

Use the existing host-specific SQLite store for jobs. Use a separate shared-home session lease for coordination between plugin hosts: `<KIMI_CODE_HOME>/.kimi-plugin-cc/session-locks/<session-id-hash>.lock`. Store only owner host, job, process identity and a random ownership token. Apply no-follow reads, bounded acquisition and ownership-checked stale recovery. Never create locks in the credential directory.

Lease a known session before resume; lease a fresh session as soon as its ID is announced. A busy or uncertain lease refuses. Different sessions may use different regional profiles concurrently. This lease coordinates plugin invocations; direct native Kimi writers require upstream exclusive-session protection or a documented recovery refusal before Stage B can ship.

On worker loss or crash during a switch, mark the job failed after existing process reconciliation. Do not restart attempts automatically. A prepared row is not evidence that a request did or did not reach the provider.

## Errors and output compatibility

Use structured `RuntimeError.details` for the selected region, failed attempt, capability and next action. Never put tokens, raw configuration, or raw provider responses into those fields.

| Error | User action |
| --- | --- |
| `SUBSCRIPTION_CAPABILITY_UNAVAILABLE` | Use default routing or a separately certified supporting CLI |
| `SUBSCRIPTION_FALLBACK_NOT_CONFIGURED` | Enable fallback explicitly or select one region |
| `SUBSCRIPTION_ROUTING_CONFLICT` | Resolve the conflicting routing setting |
| `SUBSCRIPTION_POLICY_HOME_MISMATCH` | Configure the preference for the intended home |
| `SUBSCRIPTION_LOGIN_REQUIRED` | Log into the named region in native Kimi |
| `SUBSCRIPTION_MODEL_UNAVAILABLE` | Explicitly choose an available model |
| `SUBSCRIPTION_CONTINUATION_UNSAFE` | Inspect the partial result; decide how to continue |
| `SUBSCRIPTION_SESSION_BUSY` | Wait for or cancel the session's existing task |
| `SUBSCRIPTION_FALLBACK_EXHAUSTED` | Wait for allowance to reset or run a separate explicitly chosen route |

All original safety refusals, timeout and cancellation errors retain their current codes. `/kimi:setup` is not the remedy for account quota or login errors.

Add a `subscription` object and attempt summaries to status and `result --json`. Retain every existing top-level field and the existing meaning of completed/failed/cancelled. The ordinary result remains prose with deterministic metadata. Keep failed-attempt output separate; do not concatenate it into the successful answer.

## Implementation work packages

| Work | Files or responsibility | Completion evidence |
| --- | --- | --- |
| Capability spike | Upstream routing, safe status, terminal event, resume contract | D1 to D3 demonstrated against exact source; unsupported versions refuse |
| Policy and parsing | New `runtime/subscriptions.ts`, `runtime/commands/subscriptions.ts`; `runtime/parsing.ts`, `runtime/commands/setup.ts`, `runtime/paths.ts` | Strict enum parsing, atomic preference storage, safe inventory |
| Execution adapter | `runtime/cli-client.ts`, `runtime/stream-json.ts`, engine capability table | Atomic route, failure envelope validation, unchanged safety preflight |
| Attempt coordinator | New `runtime/subscription-attempts.ts`; ask execution, `runtime/background-spawn.ts`, `runtime/job-store.ts`, `runtime/jobs.ts` | Durable attempts, single deadline, cancellation and crash behavior |
| User output | Status, result, renderer, Claude surfaces and `scripts/surface-registry.ts` | Same choices and visible switch evidence in both hosts |
| Release contracts | `docs/models.md`, `docs/invariants.md`, AGENTS.md, README translations | Update present-tense contracts only when behavior ships |

Generated `dist/` and `plugins/kimi-codex/` are rebuilt from sources. Stage A does not require the Stage B coordinator or attempt schema. No runtime feature flags or empty stubs are added by this documentation change.

## Acceptance tests

| ID | Test | Required result |
| --- | --- | --- |
| A1 | No preference and no flag, fresh and resumed sessions | Existing default and model behavior unchanged |
| A2 | Named region plus saved auto policy | One region, one attempt; saved config unchanged |
| A3 | Unknown region, API-key model, conflicting endpoints, unsupported operation/version | Refusal before provider request |
| A4 | Both profiles, concurrent sessions, mock token refresh | Every endpoint and credential belongs to the chosen profile; no shared config mutation |
| A5 | Inventory, status timeout, malformed upstream response | No secret leakage; unknown never becomes authenticated or exhausted |
| A6 | Missing login, stale login, user cancels native login | Clear named-region result; no login from a worker |
| B1 | First region reports confirmed subscription exhaustion | One alternate attempt, same session/model, one public job ID |
| B2 | Transient 429, 403, network error, overload, malformed or spoofed quota text | No account switch |
| B3 | Quota failure after a completed tool result | Context and result survive; original task and completed tool are not replayed by recovery |
| B4 | Partial generation, missing session, unsafe journal, attachment or active tool | Refuse uncertain continuation; preserve partial evidence |
| B5 | Second region exhausted or unavailable | Both attempt results retained; no third attempt |
| B6 | Cancellation before, during and after teardown; budget expiry | No later spawn; controlled descendants stop within existing teardown bounds |
| B7 | Two workers or two hosts claim the same continuation | One session owner; no overlapping attempts |
| B8 | Crash before/after attempt claim, spawn, failure persistence or result write | No unattended replay; terminal states never reopen |
| B9 | Plan mode, hook drift, version drift, tainted/unknown lineage on alternate | Original fail-closed safety refusal |
| B10 | Policy changed while worker runs, different home, legacy job rows | Snapshot remains stable; mismatch and unknown provenance are explicit |

Run deterministic tests with fake credentials and mock providers first. Include real node subprocess tests and both installed host layouts. Tests must keep the existing host-environment scrubber.

For a later live validation request, propose exactly 3 user-authorized, short subscription generations: one fresh `.com` ask, its `.ai` continuation, and an `.ai` fresh ask. Use a harmless context marker to verify recall. This initial live test validates routing and continuation, not natural quota exhaustion. Test exhaustion with injected protocol fixtures; never deliberately spend an account's allowance to reach its limit. Further calls require a new stated purpose and authorization.

Release requires `bun run check`, source and lifecycle evidence for D1 to D3 as applicable, and affected-operation smoke. Broader upstream certification still follows the existing full certification process. Do not widen `NATIVE_V2_CERTIFIED` merely because a feature probe succeeds.

## Evidence and remaining decisions

The September 17 research baseline was plugin 2.0.1 at `11f960a`, with Kimi Code 2.0.0 source at `1b89e4b039f052d10f258464413b2047acca12ba`. The GitHub release API reported 2.0.0 during that research. Plugin 2.0.3 subsequently certified CLI 2.0.1 for existing operations; that certification does not establish the subscription-routing and recovery capabilities required here. No user credentials or live subscription state were inspected.

Upstream source establishes separate regional slots and a single managed provider configuration. It does not establish a ready process-local subscription selector. [Credential routing and provisioning](https://github.com/MoonshotAI/kimi-code/blob/1b89e4b039f052d10f258464413b2047acca12ba/packages/oauth/src/managed-kimi-code.ts).

Print-mode resume exists, but terminal failures are formatted into errors rather than a dedicated quota envelope. Mid-task cross-subscription recovery remains untested. [Print-mode lifecycle](https://github.com/MoonshotAI/kimi-code/blob/1b89e4b039f052d10f258464413b2047acca12ba/apps/kimi-code/src/cli/v2/run-v2-print.ts).

Configured model endpoints take precedence independently of OAuth selection. That is why endpoint variables alone are not accepted as D1. [Model endpoint resolution](https://github.com/MoonshotAI/kimi-code/blob/1b89e4b039f052d10f258464413b2047acca12ba/packages/agent-core-v2/src/llm-adapter/model/model-auth.ts#L143-L160).

The first work package must settle the upstream interface, classify actual subscription-window exhaustion, and prove exclusive-session recovery. If any dependency remains unmet, leave the relevant stage unshipped and record the exact gap. Product defaults and scope are decided here; the remaining uncertainties are technical evidence, not reasons to guess at implementation.
