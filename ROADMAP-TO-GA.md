# Roadmap to v1.0.0 GA

Snapshot updated at **v1.0.0-alpha.4 candidate** (2026-05-25, post-user-directive). Captures everything surfaced by three audit rounds + production smoke testing + the user's reset of the thinking-on default. Each item has a triage decision: severity, effort, GA-blocker status, and the proposed approach.

Cross-references:
- `CHANGELOG.md` for what's already shipped (alpha.1 → alpha.4)
- `docs/safety.md` for the safety model
- `AGENTS.md` for invariants

## How alpha.3 actually performed

End-to-end smoke testing against kimi-code 0.1.1 confirmed:
- All 9 slash commands work
- PreToolUse hook + setup + check + uninstall lifecycle clean
- `/kimi:cancel` reaps the full kimi → bash chain (this was the alpha.2 regression — fixed)
- Strict-by-default verifier correctly rejected the stale block when the plugin upgraded paths
- 357 tests + drift gate clean

Smoke-test gap that alpha.4 closes: review hung past the timeout budget under default `kimi -p` flags because the budget was sized for the non-thinking path. User directive: keep thinking on everywhere — fix the budget, not the flag.

## What alpha.4 closes

- **G1 (UX blocker for review/challenge)** — raised KIMI_REVIEW_PROMPT_TIMEOUT_MS 600s→1800s, KIMI_ASK 300s→900s, introduced KIMI_RESCUE_PROMPT_TIMEOUT_MS=1800s. Removed `--no-thinking` from `commands/*.md`, `agents/*.md`, `runtime/parsing.ts` SUPPORTED_FLAGS and error templates. The parser now **hard-rejects** `--thinking` and `--no-thinking` with INVALID_ARGS — no escape hatch. (Round 2 multi-agent review caught the parser still advertising the flags after the doc removal; this iteration closes the gap.) Cleaned `kimi-errors.ts` nextStep hints that recommended `--no-thinking`.
- **G3 (functional gap)** — Added `warnIfSessionIdMissing` in `runtime/commands/cli-helpers.ts` and wired it into review/challenge/ask/rescue end-of-job paths. When kimi finishes a job but never announces a session id, the user sees a loud stderr warning that resume/replay won't work for that job. Hypothesis (a) — that `--no-thinking` suppressed the stderr announce — is moot now that thinking is the only documented path. If the warning ever fires in practice we have evidence to investigate hypothesis (b) (capture race) with a real reproducer.
- **L2 (helper duplication)** — Already-fixed-in-alpha.3 (the descendant-tree hotfix incidentally rewrote the cancel path and eliminated the helper duplication round-3 review had flagged).
- **G2 (verifier soft-recovery for nvm/asdf)** — Deferred to v1.1 (see H4 below). The user has not hit this in real workflow; current strict-equality behavior is correct safety-wise and the "Run /kimi:setup" remedy is documented in `docs/safety.md`.
- **G4 (TOCTOU)** — Ships GA with the known-limitation note in `docs/safety.md`. Upstream kimi-code issue still pending.

## GA blockers (must close before tagging 1.0.0)

**Empty as of v1.0.0.** Tagged 2026-05-26. Pre-GA closure sequence:

1. alpha.4 closed the original G1/G3 set (thinking-on budgets + loud session-id warning).
2. alpha.5 work (rolled into the GA tag directly) closed the kimi-code 0.2.0 stream-json session-meta compat gap (G6 — `runtime/stream-json.ts` + `runtime/cli-client.ts` consume the new `role:"meta", type:"session.resume_hint"` record).
3. H6 (wire-protocol version probe, formerly v1.0.x deferred) shipped with GA — `runtime/kimi-version-probe.ts` is wired into `/kimi:setup` to loud-warn on out-of-tested-range kimi versions.
4. Three convergent reviews (Claude opus + Codex via codex-rescue + a kimi 0.2.0 review-smoke under thinking-on) returned consistent verdicts: session-meta is the only 0.1.1→0.2.0 break that affects the plugin; hook contract, exit-code semantics, cancellation behavior, config schema, and output framing are byte-identical between kimi-code 0.1.1 and 0.2.0. Review-smoke additionally caught two issues in the candidate (stderr regex over-widening, missing challenge test), both fixed before the tag.

## High-priority but not GA-blocking (close before 1.1)

### H1 — Hook fail-open on runtime drift (Challenge Finding 1)
**Severity:** Architectural — affects the safety story under environmental change
**Effort:** Large (~2-3 days)

kimi-code's hook protocol treats exit-code-not-0-and-not-2 as ALLOW. If the hook crashes (Node ABI mismatch after upgrade, MODULE_NOT_FOUND, syntax error after a botched rebuild), if `/bin/sh` can't resolve the canonical Node path (LaunchAgent with sanitized PATH), or if it exceeds the 15s timeout, kimi-code silently allows every tool.

Setup's probe validates the install moment; nothing guards runtime drift.

**Decision (for v1.1):** Runtime-side allowlist post-validation. The cli-client receives `tool_calls` records from kimi-code's stream-json; before the model's text response is finalized, re-validate that every emitted tool call is consistent with the current command's read-only allowlist. If a tool call lands that the hook should have blocked, hard-fail the job and surface a loud error. Belt-and-suspenders: hook stays as the primary gate, runtime catches hook escape.

### H2 — Session-id stderr format coupling — **CLOSED in v1.0.0**

**Status:** Closed by upstream + GA hotfix. kimi-code 0.2.0 shipped exactly the machine-readable session record this item prescribed: a `role:"meta", type:"session.resume_hint"` stream-json record on stdout (PR #47). The plugin consumes it directly in `runtime/stream-json.ts::validateMeta` + `runtime/cli-client.ts::consumeOutcomes`. The stderr regex remains as a 0.1.x compatibility fallback, anchored to full-UUID payload shape so a malformed line can't pin a garbage id (review-smoke caught the loose form during GA candidate testing).

### H3 — Stream-json parser coupled to kimi-code internals — **partially closed in v1.0.0**

**Status (closed pre-GA):**
- Hard-coded line references removed from the doc-comment header of `runtime/stream-json.ts` (the kimi-code 0.2.0 work touched the relevant source lines and proved the line references stale).
- Unknown `meta.type` values are forward-compat: the parser surfaces them via the malformed channel for diagnostics but doesn't crash. This is the same posture H3 prescribed for "unknown record types": skip and continue.

**Remaining for v1.1:** Treating unknown top-level **roles** (not meta types — full unknown `role` strings) as forward-compat. Currently still flagged as malformed because consumers' assumptions about what `records[]` can contain are baked in. Changing this requires a sweep through the command handlers to confirm none of them break on an unrecognized role landing in their iteration.

### H5 — Per-spawn thinking control via kimi-code CLI (was alpha.4 internal bug)
**Severity:** Functional — review-gate's 8s budget assumes thinking-off but cannot enforce it
**Effort:** Negotiation with kimi-code team + tiny buildArgs wiring on our side

kimi-code 0.1.1 has no `--no-thinking` / `--thinking` CLI flag. Thinking is controlled by `default_thinking` in `~/.kimi-code/config.toml` plus optional `[thinking].mode` override. The Round 2 Codex review caught alpha.4's broken attempt to emit `--no-thinking` in argv (kimi-code uses `allowUnknownOption(false)` and would crash the spawn).

The `CliClientOptions.thinking` field stays in the runtime contract as a reserved seam. When upstream lands a CLI flag, `buildArgs` translates it.

**Decision (for v1.1):** File an upstream kimi-code issue requesting `--thinking-mode <auto|on|off>` (or equivalent). Until upstream lands, review-gate behaves correctly only when the user has `default_thinking = false` or selects a non-thinking-capable model — documented in `docs/safety.md`.

### H4 — Verifier soft-recovery for Node version manager switches (was G2)
**Severity:** UX-pain for users on nvm/asdf/mise/fnm
**Effort:** Medium (~half day)

Promoted from GA-blocker to v1.1 candidate in alpha.4 triage. Current strict-equality verifier rejects a managed block whose Node binary path no longer matches `process.execPath` — correct safety posture but forces a re-run of `/kimi:setup` after every Node version switch. Documented in `docs/safety.md` under "Known limitation."

**Decision (for v1.1):** Two-pronged.
1. **Short-term:** Add a soft-recovery path — when the installed block's Node binary path differs from canonical but everything else matches AND the installed binary still exists, emit a stderr warning and auto-refresh the block (call setup install logic from verify path). Preserves strict-by-default but adds an explicit "we noticed your Node moved, refreshing the hook" UX.
2. **Long-term:** Hash-based verification — store SHA256 of `dist/hooks/approval-hook.js` in the managed block, verify the hash matches regardless of Node path.

### H6 — Wire-protocol version guard for future kimi-code minors — **CLOSED in v1.0.0**

**Status:** Shipped with GA via `runtime/kimi-version-probe.ts` + `/kimi:setup` integration. `KIMI_TESTED_MINORS = [{0,1}, {0,2}]` is the current tested range. The setup probe spawns `kimi --version`, parses output, and pushes a loud warning to setup's warnings array when the version is outside the tested range. Soft-fail policy: probe failures (kimi missing, spawn error, unparseable output) record nothing — the hook probe surfaces those failures more directly. Override: `KIMI_PLUGIN_CC_SKIP_VERSION_PROBE=1` skips the probe entirely.

When kimi-code 0.3.x lands, the only release-engineering step is to extend `KIMI_TESTED_MINORS` after end-to-end verification.

> **2026-05-27 follow-up (initial)**: 0.3.0 and 0.4.0 were audited (reports 31-35). `KIMI_TESTED_MINORS` deliberately held at `[{0,1}, {0,2}]` pending H7 (real-binary CI smoke) as the actual claim-enforcer.
>
> **2026-05-27 follow-up (v1.0.1 release)**: extended `KIMI_TESTED_MINORS` to `[{0,1}, {0,2}, {0,3}, {0,4}]` and shipped as v1.0.1 (tag `v1.0.1`). The trigger was a user-visible UX gap: `/kimi:setup` was warning users on 0.3.0/0.4.0 — versions we had explicitly audited — which read as a contradiction. Decision was to bump the constant now (manual audit is the claim-enforcer for this release) and let H7 retroactively strengthen the assertion. The "user-visible signal beats H7-first sequencing" call lives in the corresponding memo at `projects/kimi-plugin-cc/memos/2026-05-27-first-post-ga-upstream-compat-audit-playbook.md` (memex vault).

### H7 — Real-binary smoke against the installed kimi-code (local smoke DELIVERED 2026-05-28; CI wiring pending)
**Severity:** Architectural — closes the structural-fragility concern from the 2026-05-27 audit's adversarial review (report 34 §1) and the 0.5.0 `rpc`-undefined tripwire (report 39 F1)
**Effort:** Medium (~1 day) — local smoke done; CI job remaining

Today `bun test` stubs the kimi process — no test exercises the full policy queue end-to-end against a real `kimi -p` binary. PR #26's policy queue refactor made our hook position (index 0) source-code-position-dependent with no upstream invariant test. A future upstream PR could reorder the queue and silently bypass our safety hook with no test failure on either side.

**Delivered (2026-05-28):** `tests/runtime/real-binary-smoke.test.ts` spawns the real `kimi -p --output-format stream-json` in an isolated `KIMI_CODE_HOME` (seeded from the operator's config + OAuth/credentials so it never mutates the real config or session store), installs the managed block via the real `runSetup` path, and for each of review / challenge / ask / review_gate forces a write attempt. It asserts (a) the target file is NOT created in the workspace and (b) the hook deny marker appears in the run — proving the model *attempted* a write and the hook *blocked* it, not that the model declined. Opt-in: skipped unless `KIMI_PLUGIN_CC_SMOKE=1` plus a resolvable binary + authenticated seed home, so `bun run check` stays green in CI/fresh clones. Run via `bun run smoke:real`. Verified green across all four labels against kimi-code 0.5.0 (≈10–12s per label).

**Remaining (CI wiring):** A CI job that installs a *pinned* kimi-code release and runs the smoke on every push would catch policy-queue reordering / hook-contract drift / stream-json shape drift automatically. Blocker: kimi-code authenticates via a `managed:kimi-code` OAuth credential store (`~/.kimi-code/credentials/` + `oauth/`), not a single API-key env var, so the CI runner needs a seeded credentials bundle as a secret (not a trivial `MOONSHOT_API_KEY`). Until that's provisioned, the smoke is a documented pre-release manual gate (`bun run smoke:real`) rather than per-push CI. Once CI runs it against a pinned release, H6's `KIMI_TESTED_MINORS` can be extended with that release verified by assertion rather than by-eye audit.

### H8 — `/kimi:setup` surfaces installed kimi-code plugins (new for v1.1)
**Severity:** UX — closes the turn-waste concern from the 2026-05-27 audit's adversarial review (report 34 §4)
**Effort:** Small (~half day)

kimi-code 0.4.0 (PR #119) added user-global plugin installation. Plugin-provided MCP tools register on every session creation. Our PreToolUse hook denies any unrecognized tool name for review/challenge/ask/review_gate, so plugins don't escalate privilege — but they DO add tool calls that get denied silently inside the kimi turn, wasting model turns. Users would file confused "kimi did nothing useful" bugs.

**Decision (for v1.1):** During `/kimi:setup`, probe `~/.kimi-code/plugins/installed.json` (kimi-code's home dir is `~/.kimi-code/`, not `~/.kimi/`; confirmed against `packages/agent-core/src/plugin/store.ts` + `docs/en/configuration/data-locations.md` in 0.4.0) and emit a non-blocking notice listing any installed kimi-code plugins, with a one-liner explaining that their MCP tool calls will be denied under review/challenge/ask. Don't block setup. Don't mutate the plugin list. Just set the user's expectations.

### H9 — Pin known-good kimi-code version range at setup (new for v1.1, extends H6)
**Severity:** Architectural — completes the H6/H7 pair
**Effort:** Small (~quarter day, once H7 lands)

H6 ships a "warn if version outside tested range" probe. H7 makes "tested" a real assertion (CI-enforced). H9 closes the loop by pinning a known-good upper bound (`>=0.2.0 <0.5.0` once 0.4.0 ships through H7) and emitting a setup-time warning above the upper bound. Adversarial review (report 34 §1) specifically called out that the hook-policy-index-0 contract is undocumented upstream — pinning a tested upper bound is the user-facing signal that we have verified the contract holds for this range.

**Decision (for v1.1):** Once H7 lands, extend `KIMI_TESTED_MINORS` with each newly-verified minor and add an `UPPER_BOUND` constant. Setup-time warning when `kimi --version` reports anything above the upper bound.

## Low-priority polish (open backlog)

### L1 — `dist/` drift hazard for developers who skip `bun run check` (Challenge Finding 7)
The drift gate catches forgotten rebuilds when developers run `bun run check`. Developers who only run `bun test` would miss it.

**Decision:** Document in `AGENTS.md` (already done). Add a `.husky` pre-commit hook in a follow-up if the gate ever silently fails.

### L3 — alpha.3 hotfix invariant note in `runtime/cli-client.ts`
Comment block at the start of the cancellation section should explain WHY we have both per-pid kill AND per-pid negative-pid kill AND the (now removed... wait, we kept it for defense-in-depth) root group-kill. A future maintainer might think the per-pid PGID kill is redundant with the root group-kill — explain the kimi-code spawn-shape reasoning.

**Decision:** Documentation polish; can ship any time.

## Anti-roadmap (deliberately out of scope)

- **Windows process-group reaping.** kimi-code 0.1.1 effectively doesn't support Windows with the same robustness; targeting POSIX-first is correct.
- **Reverting to in-band approval policy (v0.4 wire-style).** The cutover decision is firm — kimi-code dropped Wire transport. Defense-in-depth via H1 covers the same risk surface.
- **Reintroducing `--thinking` / `--no-thinking` as documented user flags.** User directive in alpha.4: thinking is always on for user-facing commands. The parser **hard-rejects** both flags with `INVALID_ARGS` (`THINKING_FLAG_REMOVED_MESSAGE`); there is no escape hatch. review-gate's runtime caller pins thinking-off via `CliClientOptions.thinking` as a reserved internal seam (currently a no-op since kimi-code 0.1.1 has no per-spawn CLI control — see Codex Round 2 finding).

## Ship-or-fix gate for GA — **MET**

**v1.0.0 tagged 2026-05-26.** Pre-tag state:
- alpha.4 closure scope (G1 + G3 + L2) ✓
- kimi-code 0.2.0 stream-json session-meta hotfix ✓
- H6 wire-protocol version probe ✓
- H2 closed by upstream + plugin consumption ✓
- H3 partially closed (unknown meta types forward-compat; unknown top-level roles deferred to v1.1) ✓
- Codex post-hotfix audit clean ✓
- Claude opus audit clean ✓
- kimi 0.2.0 review-smoke clean (8m 37s under 1800s thinking-on budget) ✓
- 391 tests pass, drift gate clean ✓

Remaining v1.1 items: H1 (hook fail-open runtime drift), H3 partial (unknown top-level roles), H4 (Node version manager soft-recovery), H5 (per-spawn thinking control via kimi-code CLI, upstream-blocked), H7 (real-binary CI smoke), H8 (surface installed kimi-code plugins at setup), H9 (pin known-good kimi-code version range — extends H6).

## Post-GA audit log

- **2026-05-27** — kimi-code 0.3.0 (released 2026-05-26) and 0.4.0 (released 2026-05-27) audited by 4 independent reviewers (hook contract, stream-json, CLI surface, adversarial). Verdict: COMPAT-PRESERVED. No runtime changes required. Findings:
  - `packages/agent-core/src/agent/hooks/` byte-identical 0.2.0→0.4.0
  - `apps/kimi-code/src/cli/run-prompt.ts` byte-identical 0.2.0→0.4.0
  - PR #26's policy queue refactor places `PreToolCallHookPermissionPolicy` at index 0, before `auto-mode-approve` (4) and `yolo-mode-approve` (13) — our hook still fires first
  - All argv flags we use (`-p`, `-r`, `--output-format stream-json`, `-m`, `--skills-dir`) unchanged
  - `kimi -p` still hard-codes `permission: 'auto'`; resumed sessions still force-overridden to `'auto'`
  - Adversarial finding: hook-policy-index-0 is convention-only with no upstream invariant test → tracked as H7 (real-binary CI smoke) and H9 (pin upper bound)
  - New plugin system (PR #119) introduces silent turn-waste for users with kimi-code plugins installed → tracked as H8
  - Edits applied: AGENTS.md compat-range framing, `runtime/stream-json.ts` source-of-truth comment widened to "verified through 0.4.0", H7-H9 backlog added here.
  - Reports: `.claude/kimi-code-research/reports/31-upstream-04-hook-contract.md`, `32-upstream-04-stream-json.md`, `33-upstream-04-cli-surface.md`, `34-upstream-04-adversarial.md`, `35-upstream-04-synthesis.md`.

- **2026-05-28** — kimi-code 0.5.0 (released same day) audited by the same 4-reviewer playbook. Verdict: COMPAT-PRESERVED (unanimous). Patch release **v1.0.2** extends `KIMI_TESTED_MINORS` to include `{0, 5}` and tags `compat-verified-kimi-code-0.5.0`. Findings:
  - Hook engine relocated `packages/agent-core/src/agent/hooks/` → `packages/agent-core/src/session/hooks/` (commit `74e867a`) with byte-identical file contents; PreToolUse contract preserved end-to-end
  - `apps/kimi-code/src/cli/run-prompt.ts` and `packages/agent-core/src/rpc/events.ts` byte-identical 0.4.0→0.5.0 — stream-json wire format unchanged
  - `PreToolCallHookPermissionPolicy` still at policy index 0; queue order byte-identical to 0.4.0
  - Argv unchanged; new `--auto` flag is rejected when combined with `-p` (`options.ts:43–45` throws `OptionConflictError`) so it cannot bypass hook-based read-only enforcement
  - `--continue` resume + `forcePromptPermission` still override resumed-session permission to `'auto'`
  - The 1580-line `04-wire-records.diff` is internal persisted-AgentRecord changes (blobref offloading, migration v1.3) that do not surface through `kimi -p --output-format stream-json`
  - Adversarial finding (latent, does not bite in 0.5.0): `AgentOptions.rpc` downgraded from required to `SDKAgentRPC | undefined`; `PermissionManager.requestToolApproval` now silently auto-approves `'ask'` outcomes when `agent.rpc === undefined`. Every Agent constructor site in 0.5.0 production passes a non-undefined `rpc` proxy, so the branch is dead code, but type safety has weakened. Tracked as a v1.1 tripwire: re-verify rpc-supplied-at-every-callsite in future audits and check whether `installHeadlessHandlers` is still wired into prompt mode
  - Edits applied: `runtime/kimi-version-probe.ts` (`KIMI_TESTED_MINORS` extended), `runtime/stream-json.ts` (verified-through range extended to 0.5.0, resume-hint emission position clarified as session end), `runtime/hooks/approval-hook.ts` (path breadcrumb updated to `session/hooks/runner.ts`), AGENTS.md (Upstream compat paragraph, dual-source paragraph clarified), 5-file version bump 1.0.1 → 1.0.2
  - Reports: `.claude/kimi-code-research/reports/36-upstream-05-hook-contract.md`, `37-upstream-05-stream-json.md`, `38-upstream-05-cli-surface.md`, `39-upstream-05-adversarial.md`, `40-upstream-05-synthesis.md`.

- **2026-05-28 (follow-up to the 0.5.0 audit)** — H7 local real-binary smoke **delivered** in response to the report 39 F1 `rpc`-undefined tripwire. The finding is structurally unreachable through our subprocess path (our hook returns only `allow`/`deny` at policy index 0, never an `'ask'` outcome; `kimi -p`'s own auto-approve resolves the rest before any `'ask'` fallback — so the auto-approve-on-undefined-`rpc` branch is dead code for us twice over). No code fix is possible or needed on our side; the gap was that the index-0/deny chain was convention-verified, not test-verified. `tests/runtime/real-binary-smoke.test.ts` now asserts it end-to-end against the real binary (review/challenge/ask/review_gate each force a write → hook denies → no file written + deny marker present). Verified green across all four labels against kimi-code 0.5.0. Opt-in (`bun run smoke:real`); skipped under `bun run check`. CI wiring remains pending on an OAuth-credentials secret (see H7). No runtime changes; test + `package.json` `smoke:real` script + docs only.

- **2026-05-31** — kimi-code 0.6.0 (npm `latest`) audited by the same 4-reviewer playbook. Verdict: COMPAT-PRESERVED (unanimous), and for the first time **backed by a green real-binary smoke against the audited release** (`bun run smoke:real` vs the installed 0.6.0: 5 pass / 0 fail, all four read-only labels deny the forced write end-to-end). Patch release **v1.0.4** extends `KIMI_TESTED_MINORS` to include `{0, 6}` and tags `compat-verified-kimi-code-0.6.0`. Findings:
  - Hook engine (`session/hooks/`), policy queue order (`policies/index.ts`, hook still index 0 / `AutoModeApprovePermissionPolicy` at index 4 — the 5th policy), `pre-tool-call-hook.ts`, and `auto-mode-approve.ts` all byte-identical 0.5.0→0.6.0
  - CLI argv (`options.ts`/`commands.ts`) byte-identical (blob-SHA verified); `--auto` still rejected with `-p`; stream-json resume-hint writer (`writeResumeHint`/`PromptJsonWriter`) byte-identical by content — `session.resume_hint` unchanged
  - `run-prompt.ts` gained a +17-line resume-session workDir guard (`resolvePromptSession`, resume branch only); it runs *before* `forcePromptPermission` as a fail-closed gate and **structurally cannot fire for the plugin** — both resume sites (`ask.ts`, `rescue.ts`) spawn with `cwd: job.cwd`, the same SQLite value the session token was created under, so `target.workDir !== workDir` is always false. Invariant to preserve: never resume a captured token from a different cwd
  - The 0.5.0 latent tripwire evolved: `permission/index.ts` inverted the auto-approve fallback to `if (rpc?.requestApproval) {requestApproval} else {approved}` (and `agent/index.ts` widened `rpc` to `Partial<SDKAgentRPC>`). This is a genuinely new silent-approve branch when `rpc` exists but `requestApproval` is absent — but it is **dead code in `-p` mode** (only the `'ask'` path reaches it, shadowed by `AutoModeApprovePermissionPolicy` at index 4; and `requestApproval` is a required `SDKAgentAPI` member, always present in the CLI host). A hook `{kind:'deny'}` routes through `case 'deny' → {block:true}` with no rpc involvement. Confirmed structurally inert by the green smoke
  - Large internal `runtime.kaos → agent.kaos`/`session.kaos` plumbing refactor (CHANGELOG "Split RuntimeConfig into Kaos and ToolServices") preserves `agent.config.cwd === agent.kaos.getcwd() === workDir` — rescue cwd-confinement and pathClass unchanged. `provider-manager.ts` `ModelProvider`/`SingleModelProvider` extraction is internal (auth/model selection only)
  - `records/` removed `context.mark_last_user_prompt_blocked` — UserPromptSubmit-hook plumbing only (the plugin installs only a PreToolUse hook); never serialized to stream-json; cross-version resume is safe (`restoreAgentRecord` has no throwing `default`)
  - Two doc-only findings (NOT write bypasses): PR #186 removed the default 1000-step/turn cap (compute guardrail; bounded by the plugin's AbortController) and PR #212 added an opt-in `KIMI_MODEL_*` inherited-env channel (never touches hook config, stripped on config write-back). Both noted in `docs/safety.md` § "What this safety story does NOT cover". Experimental-flags infra (`flags/registry.ts`) ships with `FLAG_DEFINITIONS = []` — no flag can disable the hook
  - Smoke caveat (recorded per playbook): the first smoke run died at `auth.login_required` because the operator's local OAuth token had expired (machine state, not a 0.6.0 regression); after re-login it ran green. A skipped/auth-failed smoke is not a passed smoke — the green run is the one that counts
  - Edits applied: `runtime/kimi-version-probe.ts` (`KIMI_TESTED_MINORS` extended to `{0,6}`), `runtime/stream-json.ts` (verified-through range widened to 0.6.0, qualified that the run-prompt.ts change is the resume guard outside the writer), AGENTS.md (Version, Upstream-compat paragraph, dual-source paragraph), `docs/safety.md` (two findings), 5-file version bump 1.0.3 → 1.0.4
  - Reports: `.claude/kimi-code-research/reports/47-upstream-06-hook-contract.md`, `48-upstream-06-stream-json.md`, `49-upstream-06-cli-surface.md`, `50-upstream-06-adversarial.md`, `51-upstream-06-synthesis.md`.

- **2026-06-01 (forward-scan, not a triggered audit)** — Routine upstream check found **no new release**: npm `latest` is still `0.6.0` (published 2026-05-29, no `next`/`beta` dist-tags), GitHub `Latest` is `0.6.0`, local `kimi --version` is `0.6.0` — all already covered by v1.0.4 / `compat-verified-kimi-code-0.6.0`. No 4-reviewer audit, version bump, or tag warranted. As a free look at the *next* release, diffed `origin/main` (`a580cd3`, 12 commits ahead of the `@moonshot-ai/kimi-code@0.6.0` tag) against the six consumed surfaces. Provisional verdict on unreleased main: **COMPAT-PRESERVED**. Findings:
  - **Hook engine** (`session/hooks/`) and **permission policy queue** (`permission/`): **0-byte diffs** — byte-identical. The two surfaces the entire safety model rests on are untouched.
  - **CLI argv** (`options.ts`, `commands.ts`): byte-identical — no diff. `run-prompt.ts` gained only +2 lines adding `cron.fired` and `warning` to the *ignored*-events switch in `runPromptTurn`; both fall through to `return` (filtered, never written as stream-json records). Forward-compat-benign.
  - **Wire/records** (5.5 KB diff): internal-only. New `micro_compaction.apply` record type (#219, MicroCompaction) with restore-time stamping (`_restoring` widened from `boolean` to `RestoringContext | null`); `adaptiveThinking` provider plumbing (#232, `KIMI_MODEL_ADAPTIVE_THINKING`); `cancelAll(reason)` now propagates an abort reason to in-flight subagent tools (#236). `AGENT_WIRE_PROTOCOL_VERSION` stays `1.3` (gained a clarifying comment that new feature record types do not require a bump). None of this changes the stream-json **output shape** our parser consumes, and our cancellation is OS-signal / process-group based — independent of kimi's internal abort-reason plumbing.
  - **Re-confirm at next release (likely 0.7.0):** (1) `warning`/`cron.fired` stay filtered out of `-p` stdout (not surfaced as parseable records); (2) the stream-json parser shrugs off `micro_compaction.apply` if it ever reaches stdout. Both expected to pass; both are exactly what `bun run smoke:real` + the stream-json reviewer will verify when the release actually lands.
  - No edits to runtime, docs, or version files; no commit or tag (per the "don't tag for zero-code-change audits" anti-pattern — and the scanned code is still unreleased and will change before shipping). This bullet is the only artifact.

- **2026-06-03** — kimi-code shipped **three minors in five days** (0.7.0 + 0.8.0 on 2026-06-02, 0.9.0 on 2026-06-03), a 61-commit catch-up from the verified 0.6.0. Certified the whole jump in one cumulative 0.6.0→0.9.0 pass via the playbook's 4-reviewer audit **plus an independent cross-model (codex) adversarial pass**. Verdict: **COMPAT-PRESERVED** (unanimous across all 5 review streams), backed by a GREEN `bun run smoke:real` against **both** the installed 0.8.0 binary and a temp-installed 0.9.0 binary (via the `KIMI_PLUGIN_CC_KIMI_BIN` override — auth seeded from the real home; never mutated the operator's install). Patch release **v1.0.5** extends `KIMI_TESTED_MINORS` to `{0,7}`, `{0,8}`, `{0,9}` and tags `compat-verified-kimi-code-0.9.0`. Findings:
  - The 2026-06-01 forward-scan predictions all held: `warning`/`cron.fired` stay filtered out of `-p` stdout; the parser shrugs off internal feature records (`micro_compaction.apply` etc.) — none reach the `-p` stream-json surface. Hook engine (`session/hooks/engine.ts`, `runner.ts`) and the stream-json writer (`writeResumeHint`/`PromptJsonWriter`) are byte-identical 0.6.0→0.9.0; `policies/index.ts` still puts `PreToolCallHookPermissionPolicy` at index 0 (auto-approve index 4).
  - **Permission approval hooks (#336, 0.8.0)** — `PermissionRequest`/`PermissionResult` added to `HOOK_EVENT_TYPES`. Fire-and-forget OBSERVABILITY only (`fireAndForgetTrigger` + leading `void`, never call `blockDecision`), emitted only inside the `rpc.requestApproval`/ask branch — dead in `-p` auto mode (shadowed by auto-mode-approve), structurally incapable of denying. No enforcement migration; keep PreToolUse-deny as-is (report 57).
  - **Headless goal mode (#270, 0.8.0)** — `kimi -p "/goal ..."` → `runHeadlessGoal`, double-gated behind the experimental flag `goal-command` (default false, env `KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND`) AND a `/goal`-prefixed prompt. Unreachable for the plugin (sets no `KIMI_CODE_EXPERIMENTAL_*`, never sends `/goal`). Confirmed by report 58 that even *inside* the continuation loop the PreToolUse hook fires on every tool call (index 0) — no autonomous-continuation approval bypass. Goal mode also writes a `{"type":"goal.summary",...}` stdout line (no `role`) before the resume hint; it routes to the parser's malformed channel (fail-safe), and is only emitted in goal mode anyway.
  - **`deny-all` policy (#338, 0.9.0)** — `unshift`-ed only onto SUBAGENT policy stacks (`subagent-host.ts:199`) for the `/btw` side-channel; a deny (more restrictive), never the main `-p` agent. The sole `policies` mutation in the 0.9.0 tree.
  - **Default-approve set grew** — `GetGoal`/`SetGoalBudget`/`UpdateGoal` added (`CreateGoal` is NOT). No fs/git/config side effects; the plugin's read-only enforcement is allow-list/deny-by-default, so new upstream tools can't slip through.
  - **New sibling subcommands** (`provider`/`acp`/`login`/`upgrade`) and `KimiHarness`→`createKimiHarness` factory: do not alter `-p` parsing or permission/hook defaults. ACP (#368) is an IDE transport the plugin never spawns.
  - **Doc-only finding (NOT a write bypass):** background auto-upgrade (#334, 0.8.0) is on by default; the plugin's own `-p` spawns never swap the binary (source forced `unsupported`), but a user's interactive TUI can drift to an unaudited version out-of-band. The version probe is the net; raises priority of **H9**. Added to `docs/safety.md` § "What this safety story does NOT cover" (plus a note that the new permission hook events are observability, not a decision surface).
  - Edits applied: `runtime/kimi-version-probe.ts` (`KIMI_TESTED_MINORS` → `{0,7}/{0,8}/{0,9}`), `runtime/stream-json.ts` (verified-through widened to 0.9.0), AGENTS.md (Version, Upstream-compat paragraph, dual-source paragraph), `docs/safety.md` (auto-upgrade drift + permission-hook-events items), `docs/upstream-compat-audit.md` (self-upgrade note), this log entry, 5-file version bump 1.0.4 → 1.0.5.
  - Reports: `.claude/kimi-code-research/reports/52-upstream-09-hook-contract.md`, `53-…-stream-json.md`, `54-…-cli-surface.md`, `55-…-adversarial.md`, `56-…-feature-parity-map.md`, `57-…-permission-hooks-deep-dive.md`, `58-…-goal-mode-feasibility.md`, `59-…-codex-adversarial.md`, `60-…-synthesis.md`.
  - **Feature track (new this audit, for v1.1 decision — NOT shipped in v1.0.5):** the 0.6→0.9 wave is largely Claude-Code-parity, but almost all of it is TUI-only or internal model-quality plumbing invisible to a `kimi -p` wrapper. Exactly one feature creates new plugin surface — **headless goal mode → a flagged `/kimi:pursue` command** (report 58: GO-for-prototype; safe because the PreToolUse hook gates every continuation turn; the real risk is unboundedness, bounded by a mandatory plugin-side AbortController wall-clock ceiling), paired with an S-effort **`goal.summary` parser hardening** (report 56 §2). MONITOR: auto-upgrade drift (→ H9), repeated-tool-call loop detection (#364, free quality win), `kimi provider` CLI (#313). IGNORE: TODO injection, MicroCompaction, ACP, background-ask, `/btw`, `/undo`, adaptive-thinking, flag logging, app_version metadata. See report 60 Part B.

If multi-agent review surfaces new critical/high findings → tag alpha.4, hotfix to alpha.5, re-review, then GA. If reviews clean → skip alpha.4 tag and go straight to 1.0.0.

Estimated remaining effort: multi-agent review dispatch + finding triage (~1-2 hours).
