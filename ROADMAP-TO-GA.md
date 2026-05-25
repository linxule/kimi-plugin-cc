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

**Empty.** alpha.4 closes the original G1/G3 set. Multi-agent review on the alpha.4 diff is the only step gating the GA tag.

If multi-agent review surfaces new critical/high findings, treat them as alpha.4→alpha.5 hotfixes and re-spin.

## High-priority but not GA-blocking (close before 1.1)

### H1 — Hook fail-open on runtime drift (Challenge Finding 1)
**Severity:** Architectural — affects the safety story under environmental change
**Effort:** Large (~2-3 days)

kimi-code's hook protocol treats exit-code-not-0-and-not-2 as ALLOW. If the hook crashes (Node ABI mismatch after upgrade, MODULE_NOT_FOUND, syntax error after a botched rebuild), if `/bin/sh` can't resolve the canonical Node path (LaunchAgent with sanitized PATH), or if it exceeds the 15s timeout, kimi-code silently allows every tool.

Setup's probe validates the install moment; nothing guards runtime drift.

**Decision (for v1.1):** Runtime-side allowlist post-validation. The cli-client receives `tool_calls` records from kimi-code's stream-json; before the model's text response is finalized, re-validate that every emitted tool call is consistent with the current command's read-only allowlist. If a tool call lands that the hook should have blocked, hard-fail the job and surface a loud error. Belt-and-suspenders: hook stays as the primary gate, runtime catches hook escape.

### H2 — Session-id stderr format coupling (Challenge Finding 3)
**Severity:** External-dependency fragility
**Effort:** Negotiation with kimi-code team + small parser change

`extractSessionIdFromStderr` matches a regex against an undocumented human-facing stderr line. A future kimi-code release that adds a timestamp, localizes the message, or changes formatting would break resume silently.

**Decision (for v1.1):** File an upstream kimi-code issue proposing a machine-readable session record (`{"event":"session","id":"..."}`) in the stream-json output. Until upstream lands, the alpha.4 loud-warning surface (added in G3) gives users immediate signal when capture fails.

### H3 — Stream-json parser coupled to kimi-code internals (Challenge Finding 5)
**Severity:** Maintainability
**Effort:** Medium

`runtime/stream-json.ts` has hard-coded source line references to kimi-code's `apps/kimi-code/src/cli/run-prompt.ts` and treats unknown record types as malformed instead of safely ignoring them.

**Decision (for v1.1):** Refactor to forward-compatible — unknown `type` field values are logged at debug level but treated as "skip and continue", not malformed. Remove the hard-coded line references; they'll go stale across kimi-code versions.

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

## Ship-or-fix gate for GA

**GA = alpha.4 + multi-agent-review-clean.**

If multi-agent review surfaces new critical/high findings → tag alpha.4, hotfix to alpha.5, re-review, then GA. If reviews clean → skip alpha.4 tag and go straight to 1.0.0.

Estimated remaining effort: multi-agent review dispatch + finding triage (~1-2 hours).
