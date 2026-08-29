# Native v2 certification and engine-provenance contract

**Approved:** 2026-08-28
**Current production state:** native v2 disabled; every model-spawning operation is forced to `legacy-v1`.

This contract defines what must be true before kimi-plugin-cc can route any
production operation to kimi-code's native `agent-core-v2` engine. It also
defines the provenance that must survive process, background-worker, job-store,
and session boundaries. The first implementation slice is intentionally a
legacy-v1 no-op at the model/tool level: it makes routing explicit and auditable
without making native v2 reachable.

Tower mode, subagent fork, Remote Control, and other experimental feature work
are outside this contract. A possible upstream retirement of v1 is not evidence
that v2 is safe and does not waive any gate below.

## 1. Terms

- **Operation kind** is the real user-visible operation: `review`, `challenge`,
  `ask`, `rescue`, `review_gate`, `pursue`, `swarm`, or `swarm-write`. It is not
  the reused SQLite `command_type` lineage (`pursue` and `swarm-write` currently
  reuse `rescue`; `swarm` reuses `review`).
- **Intended engine** is the engine selected by the plugin-owned execution plan:
  `legacy-v1` or `native-v2`.
- **Observed engine** is an engine established by positive runtime evidence. It
  is never filled from wishful defaults or a blanket historical migration.
- **Exact command tuple** is the subprocess command plus ordered prefix argv.
  The version probe and the prompt run must use the same tuple and cwd.
- **Capability certification** is per operation, engine, and tested kimi-code
  version. One green operation does not certify another.

## 2. Non-negotiable native-v2 entry gate

Native v2 remains unavailable until an exact released kimi-code tag guarantees
that the managed external `PreToolUse` veto runs before **every** final allow.
The guarantee must cover the plan-file guard's `event.allow()`, not merely say
that external hooks run before ordinary tool execution.

The current source fails that gate: the plan service registers before external
hooks and final-allows exact plan-file writes. A fresh session can reach it via
`default_plan_mode=true`; a resumed session can restore plan state. The writes
are under `KIMI_CODE_HOME`, not the user's worktree, but bypassing the managed
hook violates the every-tool safety contract.

An acceptable upstream change must be a genuinely additive ordering API or a
released fixed ordering. Passing an options-shaped value as the second argument
to `Event<T>` is not acceptable: that argument is `thisArg`, not listener
priority. In-verifier auto-repin, hook skipping, and relaxed verification are
not migration mechanisms.

## 3. Certification gate for one operation

After the upstream ordering gate is released, each operation may enter the
native-v2 capability matrix only after all of these pass against the exact
candidate binary:

1. **Scoped source audit** using `docs/upstream-compat-audit.md`: prompt mode,
   permission ordering, hook runner/payload/aggregation, stream records and
   session bootstrap/config.
2. **Pre-spawn plan:** exact command tuple and exact version resolve; the version
   is inside a reviewed minor; the requested operation is present in the
   engine-specific capability matrix.
3. **Hook-order lifecycle proofs:** both a fresh
   `default_plan_mode=true` session and a separately restored plan-state session
   attempt the exact plan-file `Write`/`Edit`; the managed external hook runs
   and its deny wins. A green test whose plan precondition did not hold is not
   evidence.
4. **Operation smoke:** a temp-installed exact binary runs the real operation
   through `KIMI_PLUGIN_CC_KIMI_BIN` and `bun run smoke:real`. Read-only,
   write-confinement, cancellation, budgets, concurrency, session-id capture,
   and output semantics must remain unchanged.
5. **Resume compatibility:** fresh and resumed cases use engine-sticky lineage.
   Native-v2-touched protocol-1.5 sessions never silently fall back to v1; v1
   protocol-1.4 sessions move only through an explicitly certified transition.
6. **Full repository gate:** generated surfaces, build, typecheck, complete test
   suite, and drift gate are green.

Only then may that single operation/version pair be added to the native-v2
matrix. Certification does not itself change the default engine. Enabling or
expanding routing is a separate human decision and release slice.

## 4. Current capability matrix

| Engine | Operation | Production state |
|---|---|---|
| `legacy-v1` | review, challenge, ask, rescue, review_gate | certified within `KIMI_TESTED_MINORS` |
| `legacy-v1` | pursue | certified from kimi-code 0.8 within `KIMI_TESTED_MINORS` |
| `legacy-v1` | swarm | certified from kimi-code 0.12 within `KIMI_TESTED_MINORS` |
| `legacy-v1` | swarm-write | certified from kimi-code 0.18 within `KIMI_TESTED_MINORS` |
| `native-v2` | **none** | fail-closed unavailable |

An exact version outside `KIMI_TESTED_MINORS` is likewise unavailable to
production model jobs, even when setup can parse and warn about it. This is a
deliberate fail-closed stop for out-of-band auto-upgrades: update the plugin to
a release that certifies the new minor, or select a certified binary with
`KIMI_PLUGIN_CC_KIMI_BIN`. There is no production override.

The code representation of the last row is intentionally an empty
`NATIVE_V2_CERTIFIED_OPERATIONS` set. A deserialized or forged v2 plan is
rejected again at the subprocess boundary.

## 5. Execution-plan and provenance contract

Every newly created model job persists:

- `operation_kind`
- `intended_engine`
- `observed_engine`
- `kimi_version`
- `system_version`
- `kimi_command`
- `kimi_prefix_args` (ordered JSON string array)
- `plan_certification`
- `resumed_from_job_id`

The plan is created before the job row and before model spawn. The prompt spawn
must byte-match its command tuple. Detached ask/rescue workers reload the plan
from the job instead of resolving ambient command settings again. Today every
production caller explicitly requests `legacy-v1`, and `buildEnv` overwrites the
child's `KIMI_CODE_LEGACY_FLAG` to `1`.

`KIMI_PLUGIN_CC_SKIP_VERSION_PROBE=1` produces a visible `test-bypass` plan with
`kimi_version=null`; it is a test/smoke seam, not production certification. A
persisted bypass is accepted at the final spawn boundary only while that same
explicit environment switch is still present, so a stale or forged job row
cannot carry the seam into an ordinary production worker.

On a successful forced-v1 run, absence of the native-v2-only pre-tool
`system.version` marker plus the plugin-owned legacy pin records observed
`legacy-v1`. If `system.version` appears under a legacy plan, cli-client stops
consuming records, tears down the owned process tree, and raises
`CLI_ENGINE_PROVENANCE_MISMATCH`. No later assistant/tool record is delivered to
the caller.

Write-capable launches also export the plugin-owned
`KIMI_PLUGIN_CC_WORKSPACE_ROOT`: rescue/pursue use the job cwd and swarm-write
uses the throwaway worktree. The hook never derives this trust boundary from the
upstream payload `cwd`; missing root denies writes.

## 6. Historical rows: unknown unless evidence proves otherwise

Schema migration adds nullable columns and does **not** backfill old rows as v1.
That restraint is required because released plugin v1.9.5 plus kimi-code
0.33/0.34 could route an unflagged prompt to native v2 before v1.9.6 added the
legacy pin.

Status/result inspection may make an evidence-only, monotonic backfill from the
saved log:

- stream `system.version` or wire protocol 1.5+ proves `native-v2`;
- a recorded `legacy_v1_forced:true` spawn paired with completed/stream evidence,
  or wire protocol through 1.4, proves `legacy-v1`;
- invocation metadata may recover the real operation kind;
- no positive signal remains `unknown`;
- conflicting signals remain `unknown` and are never overwritten;
- forensic inspection does not change `updated_at` or job ordering.

Exact kimi-code version is recovered only when the saved evidence states it.
It is not inferred from current npm state, the current binary, repository docs,
or another host's cache.

A resume source proven to have run on the other engine is refused with
`KIMI_SESSION_ENGINE_MISMATCH`; the operator must start fresh. Unknown historical
rows retain the pre-slice forced-v1 resume behavior for now so this provenance
slice does not strand old sessions. Before any native-v2 routing is enabled,
the canary policy must require proven same-engine lineage or a fresh session.

## 7. Rollout and rollback

The migration state machine is:

1. **Now:** explicit certified forced-v1 plans; v2 matrix empty.
2. **Certification candidate:** one exact v2 version and operation passes every
   gate, but routing remains off.
3. **Human-enabled canary:** a separate authorized change may route only that
   capability while preserving engine-sticky sessions and immediate mismatch
   teardown.
4. **Expansion:** add operations one at a time after their own gates.

Rollback removes a v2 capability/routing decision; it never resumes a v2-touched
session under v1. Starting a fresh forced-v1 session is the safe fallback. Hook
verification, read/write allowlists, swarm defaults/concurrency, finite budgets,
worktree confinement, and the explicit experimental-feature refusal remain
unchanged throughout.
