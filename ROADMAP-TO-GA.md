# Roadmap to v1.0.0 GA

Snapshot taken at **v1.0.0-alpha.3** (2026-05-25). Captures everything surfaced by the three audit rounds + production smoke testing that we deliberately deferred. Each item has a triage decision: severity, effort, GA-blocker status, and the proposed approach.

Cross-references:
- `CHANGELOG.md` for what's already shipped (alpha.1 → alpha.3)
- `docs/safety.md` for the safety model
- `AGENTS.md` for invariants

## How alpha.3 actually performed

End-to-end smoke testing against kimi-code 0.1.1 confirmed:
- All 9 slash commands work
- PreToolUse hook + setup + check + uninstall lifecycle clean
- `/kimi:cancel` reaps the full kimi → bash chain (this was the alpha.2 regression — fixed)
- Strict-by-default verifier correctly rejected the stale block when the plugin upgraded paths
- 357 tests + drift gate clean

## GA blockers (must close before tagging 1.0.0)

### G1 — `/kimi:review` times out without `--no-thinking` (UX)
**Severity:** UX (functional but unusable as documented)
**Effort:** Trivial (~1 hour)
**Evidence:** Alpha.3 smoke test, test 4. Default `kimi -p` invocation with the review prompt hung past the timeout budget. Worked immediately after retrying with `--no-thinking`.

**Decision:** Auto-pass `--no-thinking` for review/challenge by default (these are evaluative, not reasoning-heavy) UNLESS user passes `--thinking`. Ask remains thinking-default (free-form reasoning benefits from it). Document the asymmetry in `commands/*.md`.

**Open question:** Does `--no-thinking` suppress the session-id stderr announce? If yes, G3 below is partly self-inflicted by this fix.

### G2 — Exact-command verifier breaks on Node version manager switch
**Severity:** UX-pain (most users have nvm/asdf/mise)
**Effort:** Medium (~half day)
**Evidence:** Challenge Finding 2.

`evaluateInstalled` does exact equality between installed `command = "..."` and the canonical command rebuilt from `process.execPath`. A routine `nvm use` changes `process.execPath` from `/Users/.../v22/.../node` to `/Users/.../v26/.../node` and the verifier rejects a perfectly valid block. User has to re-run `/kimi:setup` after every Node switch.

**Decision:** Two-pronged.

1. **Short term (in G2 scope):** Add a soft-recovery path — when the installed block's Node binary path differs from canonical but everything else matches AND the installed binary exists at its declared path, emit a stderr warning and auto-refresh the block (call setup install logic from verify path). This preserves strict-by-default but adds an explicit "we noticed your Node moved, refreshing the hook" UX.
2. **Long term (defer to post-GA):** Hash-based verification — store SHA256 of `dist/hooks/approval-hook.js` in the managed block, verify the hash matches regardless of Node path. Adds compute on every kimi-p invocation; acceptable.

For GA, only option 1 is required. Option 2 is GA-quality polish.

### G3 — Session-id capture race / null kimi_session_id
**Severity:** Functional gap (no resume → silent loss of feature)
**Effort:** Investigation first; fix depends on root cause
**Evidence:** Alpha.3 smoke test, test 5 (`kimi_session_id: null` after a completed challenge job).

Two candidate root causes:
- (a) `--no-thinking` suppresses the "To resume this session: kimi -r <uuid>" stderr announce
- (b) Capture race even with incremental stderr handler (announce arrives, gets parsed, but somehow not pinned)

**Decision:** Investigate before fixing. Reproduce with both flags and inspect raw stderr. If (a), document the tradeoff (review/challenge get no-thinking + no-resume, ask gets thinking + resume). If (b), find the race and patch. Either way: when capture fails, surface a loud warning in stderr ("session id not captured; resume will not work for this job").

### G4 — TOCTOU in rescue path check (documented, currently shipped)
**Severity:** Security defense-in-depth gap
**Effort:** Cannot be unilaterally fixed (needs kimi-code-side O_NOFOLLOW or fd-based write)
**Evidence:** Challenge Finding 6, comment in `runtime/rescue-approval.ts:checkApprovedPath`.

The path is realpath'd at hook time; the actual write happens later under kimi-code's control. An attacker with workspace write access can swap a symlink between check and write.

**Decision:** File an upstream kimi-code issue requesting `O_NOFOLLOW` on Bash tool writes (or an fd-based API the hook can inspect). Document the limitation prominently in `docs/safety.md`. **Threat model note**: the attacker already has workspace write access in this scenario, which means a rescue session was approved against a compromised workspace — the TOCTOU is not the weakest link. Acceptable to ship GA with the upstream-issue link in docs.

## High-priority but not GA-blocking (close before 1.1)

### H1 — Hook fail-open on runtime drift (Challenge Finding 1)
**Severity:** Architectural — affects the safety story under environmental change
**Effort:** Large (~2-3 days)

kimi-code's hook protocol treats exit-code-not-0-and-not-2 as ALLOW. If the hook crashes (Node ABI mismatch after upgrade, MODULE_NOT_FOUND, syntax error after a botched rebuild), if `/bin/sh` can't resolve the canonical Node path (LaunchAgent with sanitized PATH), or if it exceeds the 15s timeout, kimi-code silently allows every tool.

Setup's probe validates the install moment; nothing guards runtime drift.

**Decision (for v1.1):** Runtime-side allowlist post-validation. The cli-client receives `tool_calls` records from kimi-code's stream-json; before the model's text response is finalized, re-validate that every emitted tool call is consistent with the current command's read-only allowlist. If a tool call lands that the hook should have blocked, hard-fail the job and surface a loud error. Belt-and-suspenders: hook stays as the primary gate, runtime catches hook escape.

Not GA because (a) it's a defense-in-depth layer, and (b) every observed crash mode in G2/G3 is a fail-safe (block missing → rescue refuses; verifier rejects → rescue refuses). The fail-open is theoretical until proven exploitable.

### H2 — Session-id stderr format coupling (Challenge Finding 3)
**Severity:** External-dependency fragility
**Effort:** Negotiation with kimi-code team + small parser change

`extractSessionIdFromStderr` matches a regex against an undocumented human-facing stderr line. A future kimi-code release that adds a timestamp, localizes the message, or changes formatting would break resume silently.

**Decision (for v1.1):** File an upstream kimi-code issue proposing a machine-readable session record (`{"event":"session","id":"..."}`) in the stream-json output. Until upstream lands, add a loud warning when capture returns nothing and ship-as-is.

### H3 — Stream-json parser coupled to kimi-code internals (Challenge Finding 5)
**Severity:** Maintainability
**Effort:** Medium

`runtime/stream-json.ts` has hard-coded source line references to kimi-code's `apps/kimi-code/src/cli/run-prompt.ts` and treats unknown record types as malformed instead of safely ignoring them.

**Decision (for v1.1):** Refactor to forward-compatible — unknown `type` field values are logged at debug level but treated as "skip and continue", not malformed. Remove the hard-coded line references; they'll go stale across kimi-code versions.

## Low-priority polish (open backlog)

### L1 — `dist/` drift hazard for developers who skip `bun run check` (Challenge Finding 7)
The drift gate catches forgotten rebuilds when developers run `bun run check`. Developers who only run `bun test` would miss it. The gate IS the safety net; rely on it.

**Decision:** Document in `AGENTS.md` (already done). Add a `.husky` pre-commit hook in a follow-up if the gate ever silently fails.

### L2 — Helper duplication: `waitForPidExit` vs `waitForPidToExit`
From round-3 review feedback on the alpha.2 fix. Trivial rename + dedupe pass.

**Decision:** Cleanup PR pre-GA.

### L3 — alpha.3 hotfix invariant note in `runtime/cli-client.ts`
Comment block at the start of the cancellation section should explain WHY we have both per-pid kill AND per-pid negative-pid kill AND the (now removed... wait, we kept it for defense-in-depth) root group-kill. A future maintainer might think the per-pid PGID kill is redundant with the root group-kill — explain the kimi-code spawn-shape reasoning.

**Decision:** Documentation polish.

## Anti-roadmap (deliberately out of scope)

- **Windows process-group reaping.** kimi-code 0.1.1 effectively doesn't support Windows with the same robustness; targeting POSIX-first is correct.
- **Reverting to in-band approval policy (v0.4 wire-style).** The cutover decision is firm — kimi-code dropped Wire transport. Defense-in-depth via H1 covers the same risk surface.
- **Adding a `--thinking` flag to /kimi:review/challenge to match the ask default.** G1 fixes the inverse (auto-`--no-thinking` for review/challenge); allowing users to flip back is more surface than warranted unless requested.

## Ship-or-fix gate for GA

GA = G1 + G2 (option 1 only) + G3 closed, plus L2 cleanup. G4 ships with a known-limitation note + upstream issue link.

H1-H3 ship in v1.1 unless a real exploit forces earlier. L1, L3 ship whenever.

Estimated effort: G1 (1h) + G2-short (4h) + G3 investigation (2h, possibly + 2h fix) + L2 (30min) ≈ **1 working day** to GA tag.
