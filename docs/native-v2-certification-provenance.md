# Native v2 certification and engine-provenance contract

**Approved:** 2026-08-28 · **Amended:** 2026-09-09 (§2 alternate basis, §4 matrix, §5 fields)
**Current capability (plugin 2.4.1, published):** native v2 is certified at exact kimi-code `0.42.0`, `0.43.0`, `0.43.1`, `2.0.0`, `2.0.1`, `2.0.2`, `2.1.0`, `2.1.1`, `2.2.0`, `2.3.0`, `2.3.1` and `2.3.2` for every operation under the §2 construction. `legacy-v1` remains selectable only for a pinned binary ≤ 0.41.x.

For the dated upstream evidence and follow-up, see [Native v2 status](native-v2-status.md).

Plugin 2.4.1 certifies exact 2.3.2 with host-preactivated swarm sessions. Publication does not update installed hosts. Evidence: [certification record](upstream-2.3.2-certification.md). Plugin 2.3.1 added CLI 2.3.1 certification; plugin 2.4.0 preserved it while adding MCP transport.

Exact 2.1.0/2.1.1 evidence: [certification record](upstream-2.1-certification.md).
The known active-plan bypass remains; only the no-plan construction is
certified. Bounded smoke covers live resume and goal behavior, not exhaustive
compaction or crashed-turn recovery. Aggregate hook-denial markers across a
goal run do not establish a separate denial count on every turn.

This contract defines what must be true before kimi-plugin-cc can route any
production operation to kimi-code's native `agent-core-v2` engine. It also
defines the provenance that must survive process, background-worker, job-store,
and session boundaries. The first implementation slice recorded legacy-v1 provenance without enabling v2. The runtime routes only the versions listed in its capability table to native v2 under the no-plan construction below. Installed hosts retain their existing tables until explicitly updated.

Tower mode, subagent fork, Remote Control, and other experimental feature work
are outside this contract. The removal of v1 in kimi-code 0.42.0 did not waive any gate below.

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

## 2. Native-v2 entry gate

Two bases are admissible. The first is preferred and would permit native plan
mode; the second is the one in force since kimi-code 0.42.0 deleted the v1
engine, and it excludes native plan mode from plugin-managed sessions.

**Basis A — released ordering guarantee (original, preferred, not available).**
An exact released kimi-code tag guarantees that the managed external
`PreToolUse` veto runs before **every** final allow, including the plan-file
guard's `event.allow()`. Passing an options-shaped value as the second argument
to `Event<T>` is not acceptable (that argument is `thisArg`). #3431 tracks this.

**Basis B — reachability by construction (amended 2026-09-09, in force).**
For an exact candidate tag, all of the following are established by source
audit, a mechanized tag scan, and live control, and re-established for every
later certified tag:

1. The engine contains exactly one chain-breaking final allow, and it is gated
   on plan mode being active (`features/plan/planService.ts`).
2. Every route by which plan mode can become active in a `kimi -p` session is
   enumerated, and each is either unreachable from the plugin's spawn or closed
   by the plugin before spawn: the `default_plan_mode` config key under every spelling upstream normalizes to `defaultPlanMode` (pre-spawn
   parse of the same file, `runtime/native-v2-preflight.ts`), the
   `EnterPlanMode`/`ExitPlanMode` tools (managed hook deny), and restored plan
   state (own native-v2 lineage only, raw journal scan of every agent journal).
3. Every tool execution passes the executor path that fires the external hook,
   including subagent, swarm, and MCP tools; a hook veto beats every approve.
4. A live control on the exact binary shows the plan-file write bypassing the
   hook when plan mode IS armed (proving the refusals are load-bearing), and
   the managed hook denying an ordinary write and an `EnterPlanMode` attempt
   when it is not.

Under Basis B the headline claim is: *every executed tool call in a
plugin-managed session passes the managed hook, and the engine's sole final
allow is never armed.* It is NOT a claim that the hook precedes every final
allow. Certification is per exact version (not per minor) and per operation.

Residual assumptions, accepted explicitly: (i) `<KIMI_CODE_HOME>/config.toml`
and the session journals are trusted operator state — an actor who can write
them could already delete the `[[hooks]]` entry, so the check-to-use window
adds no new trust class. In 2.3.0 and later, print mode can close/resume and retry once
on `session.stale`, replaying the same wire journals. This is another read of
trusted state, not an additional plan-state source. Do not concurrently edit
or operate on a plugin-managed session from another client; the parent cannot
atomically revalidate in-process reloads. Upstream session locks are not a
security boundary (publication errors fail open, stale detection compares
file lengths, and 2.3.1 adds ambient lock-disable and explicit takeover paths).
POSIX lock contention can also execute bare `ps` with inherited PATH and cwd,
so internal OS helpers are trusted too. Legacy workspace-trust migration in
2.3.1 recognizes more old path spellings and can enable project MCP for those
already trusted roots; trust-store read failure can suppress the initial MCP
load without granting trust; (ii) the upstream hook runner fails open on its own
internal errors (unchanged from v1); (iii) `writesOnlyPlanFile` compares
normalized strings without realpath — a symlink at the plan path would need a
prior hook-allowed write, which the construction denies; (iv) repository Git
configuration and executables are trusted. Internal Git context collection can
run subprocesses outside tool hooks, including read-only swarm startup (2.0.2
and 2.1.1). The 2.1.0 hardening is reverted in 2.1.1. See the
[Git trust boundary](safety.md#what-this-safety-story-does-not-cover).

In-verifier auto-repin, hook skipping, relaxed verification, and silent
rewriting of operator config remain forbidden migration mechanisms. A refusal
raised by the preflight is never hook drift and `/kimi:setup` is never its
remedy.

## 3. Certification gate for one operation

Under the current Basis B no-plan construction, each operation may enter the
native-v2 capability matrix only after these gates pass against the exact
candidate. Basis A would require separate ordering proofs before changing the
safety profile:

1. **Scoped source audit** using `docs/upstream-compat-audit.md`: prompt mode,
   permission ordering, hook runner/payload/aggregation, stream records and
   session bootstrap/config.
2. **Mechanized tag scan and pre-spawn plan:** audit and pin the exact source
   bytes, including reload paths; verify the exact binary tuple and first-line
   version marker. Before certification, use only the explicit candidate smoke
   seam, not a production capability row or a wider minor-version range.
3. **Non-vacuous no-plan controls:** with plan mode ON, the exact plan-file
   Write must still bypass the deny hook, proving the refusal is load-bearing.
   With plan mode OFF, separate ordinary Write and EnterPlanMode attempts must
   reach the deny hook. The plugin refuses default-plan config and plan-tainted
   resume journals before spawn. A green test without its precondition is not
   evidence. If the ON bypass disappears, re-audit the upstream ordering fix
   instead of silently keeping the old certification basis.
4. **Operation smoke:** a temp-installed exact binary runs the real operation
   through `KIMI_PLUGIN_CC_KIMI_BIN` and `bun run smoke:real`. Read-only,
   write-confinement, cancellation, budgets, concurrency, session-id capture,
   and output semantics must remain unchanged. For swarm, require distinct
   child journals and correlate each assigned Write/Edit `path` and `toolCallId`
   with its own result; unrelated denials and coordinator-only patches are not
   evidence. Versions requiring activation also need direct-OFF/preactivated-ON
   controls.
5. **Resume compatibility:** fresh and resumed cases use engine-sticky lineage.
   Native-v2-touched protocol-1.5 sessions never silently fall back to v1; v1
   protocol-1.4 sessions move only through an explicitly certified transition.
6. **Full repository gate:** generated surfaces, build, typecheck, complete test
   suite, and drift gate are green.

Only then may that single operation/version pair be added to the native-v2
matrix. The certification table controls routing in that checkout; shipping the
expanded production capability requires a separately authorized release.

## 4. Current capability matrix

| Engine | Operation | Production state |
|---|---|---|
| `native-v2` | review, challenge, ask, rescue, review_gate, pursue, swarm, swarm-write | certified at exact `0.42.0`, `0.43.0`, `0.43.1`, `2.0.0`, `2.0.1`, `2.0.2`, `2.1.0`, `2.1.1`, `2.2.0`, `2.3.0`, `2.3.1`, `2.3.2` for all eight operations (`NATIVE_V2_CERTIFIED` in `runtime/kimi-engine.ts`), safety profile `native-v2-no-plan/1` |
| `legacy-v1` | review, challenge, ask, rescue, review_gate | certified within `KIMI_TESTED_MINORS` (≤ 0.41) for an explicitly pinned binary |
| `legacy-v1` | pursue / swarm / swarm-write | certified from kimi-code 0.8 / 0.12 / 0.18 within `KIMI_TESTED_MINORS` |

Engine selection is plugin-owned (`selectIntendedEngine`): the probed exact
version picks `native-v2` when it is in that operation's certified list, else
`legacy-v1` when it is in the legacy tested minors, else the job refuses. A
new patch of a certified minor is NOT certified until its tag scan, live
control, and smoke pass; append it explicitly. `KIMI_TESTED_MINORS` is the
legacy table and never gains 0.42.

An exact version outside both tables is unavailable to production model jobs,
even when setup can parse and warn about it. Recovery is a plugin release that
certifies it, or `KIMI_PLUGIN_CC_KIMI_BIN` pointing at a certified binary.
`KIMI_PLUGIN_CC_SKIP_VERSION_PROBE` is tests/smoke only.

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
from the job instead of resolving ambient command settings again. Every production caller passes the engine chosen by `selectIntendedEngine`.
For `legacy-v1` plans `buildKimiCliEnvironment` overwrites the child's `KIMI_CODE_LEGACY_FLAG`
to `1`; for `native-v2` plans it does not set the flag (0.42.0 ignores it) and
the plan additionally persists `safety_profile = "native-v2-no-plan/1"`, which
the preflight re-validates at the final spawn boundary. Every spawn exports
`KIMI_CODE_NO_AUTO_UPDATE=1` and an absolute `KIMI_CODE_HOME`.

Exact 2.3.2 swarm activation is a same-job, plugin-owned fresh session, not an
arbitrary user resume. Authenticated loopback `/meta` supplies activation-time
backend/version evidence but never replaces the print marker. The job records
`kimi_session_id_source = "preactivated"` before model spawn; the returned print
session must match that ID and the source survives timeout metadata. The final
no-plan journal scan still applies before the resumed print spawn.

`KIMI_PLUGIN_CC_SKIP_VERSION_PROBE=1` produces a visible `test-bypass` plan with
`kimi_version=null`; it is a test/smoke seam, not production certification. A
persisted bypass is accepted at the final spawn boundary only while that same
explicit environment switch is still present, so a stale or forged job row
cannot carry the seam into an ordinary production worker.

On a successful forced-v1 run, absence of the native-v2-only pre-tool
`system.version` marker plus the plugin-owned legacy pin records observed
`legacy-v1`. If `system.version` appears under a legacy plan, cli-client stops
consuming records, tears down the owned process tree, and raises
`CLI_ENGINE_PROVENANCE_MISMATCH`. A `native-v2` plan REQUIRES the marker before
any assistant/tool record and requires its version to equal the probed
version; a missing, late, or disagreeing marker is the same mismatch and the
same teardown. No later assistant/tool record is delivered to the caller.

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
`KIMI_SESSION_ENGINE_MISMATCH`. A native-v2 plan additionally refuses an
unknown-provenance source (`KIMI_SESSION_LINEAGE_UNKNOWN`) and a source whose
journal holds any plan record (`KIMI_SESSION_PLAN_TAINTED`); the operator
starts fresh, and nothing saved is modified. Unknown rows still resume under a
legacy-v1 plan on a pinned ≤ 0.41 binary.

## 7. Rollout and rollback

The migration state machine:

1. Forced-v1 plans, v2 matrix empty (v1.9.x).
2. **v1.10.0:** every operation certified at exact 0.42.0 under Basis B;
   routing chooses v2 for 0.42.0 and v1 for a pinned ≤ 0.41 binary.
   **v1.10.3:** 0.43.0 and 0.43.1 appended after their own tag scan, plan-ON /
   plan-OFF live controls and per-operation smoke (2026-09-15).
3. Each later kimi-code version is appended per operation after its own tag
   scan, live control, and smoke.

Rollback removes a v2 capability/routing decision; it never resumes a v2-touched
session under v1. Starting a fresh session is the safe fallback. Hook
verification, read/write allowlists, swarm defaults/concurrency, finite budgets,
worktree confinement, and the explicit experimental-feature refusal remain
unchanged throughout.
