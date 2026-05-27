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

> **2026-05-27 follow-up**: 0.3.0 and 0.4.0 were audited (reports 31-35). `KIMI_TESTED_MINORS` still ships at `[{0,1}, {0,2}]` — extending it is deferred to H7/H9 since the audit recommends a real-binary CI smoke (H7) as the prerequisite for asserting a tested range, and a pinned upper bound + setup-time warning above 0.4.x (H9) as the user-visible surface.

### H7 — Real-binary CI smoke against pinned kimi-code releases (new for v1.1)
**Severity:** Architectural — closes the structural-fragility concern from the 2026-05-27 audit's adversarial review (report 34 §1)
**Effort:** Medium (~1 day)

Today `bun test` stubs the kimi process — no test exercises the full policy queue end-to-end against a real `kimi -p` binary. PR #26's policy queue refactor made our hook position (index 0) source-code-position-dependent with no upstream invariant test. A future upstream PR could reorder the queue and silently bypass our safety hook with no test failure on either side.

**Decision (for v1.1):** Add a CI job that installs a pinned kimi-code release (start with 0.4.0), configures the managed block, and spawns `kimi -p --output-format stream-json` against a fixture prompt that requests `Write`. Assert the call is denied with our reason string. Repeat the smoke for review/challenge/ask/review_gate paths. The job catches policy-queue reordering, hook contract drift, and stream-json shape drift in one swoop. Once H7 lands, H6's `KIMI_TESTED_MINORS` can be extended with confidence.

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

If multi-agent review surfaces new critical/high findings → tag alpha.4, hotfix to alpha.5, re-review, then GA. If reviews clean → skip alpha.4 tag and go straight to 1.0.0.

Estimated remaining effort: multi-agent review dispatch + finding triage (~1-2 hours).
