# Follow-ups

Single source of truth for open gaps, deferred work, and tracked follow-ups. The plugin is feature-complete and stable — v0.1.8 is tagged. Nothing here is urgent, and nothing here blocks production use. This file exists so future contributors (and future Claude sessions) don't have to reconstruct the known-open list from memory.

**Resolved in 0.1.8** (2026-04-15): rescue hardening items 1/2/6/7 (setup leak, worker spawn failure surfacing, writeArtifact + writeInvocationLogHeader classification, NODE_BIN fast-path validation), 0.1.5 audit Lows L1 (dead 200-char session-title guard), L2 (AbortController timeout test coverage), L3 (URL path concatenation double-slash). Shipped as three parallel /batch PRs (#4, #5, #6) and a release commit.

Items are grouped by scope. Each item links to the relevant spec section or ADR where available, and to memory-level context where the item is Claude-facing. Priority tags are suggestions, not commitments.

---

## Rescue hardening (post-0.1.8)

Items 1, 2, 6, 7 from the original 0.1.7-verification list shipped in 0.1.8 (PR #6). The three items below remain open as lower-priority polish.

### 3. `RESCUE_RESULT_MISSING` does not include cause

**Priority**: low. Identified by verification run 4.

When `parsed.wait` is true and the background job reaches a terminal state without a `final_output_path`, the code throws `RESCUE_RESULT_MISSING`. The error says *that* the job finished without a result but not *why*. If the worker crashed or was cancelled, the user has to run `/kimi:status` separately to find out.

**Fix**: look up the completed job record in that branch and, if `job.status` is `failed` or `cancelled`, include `job.error?.code`, `job.error?.message`, and `job.summary` in the thrown error.

### 4. Cancellation race hardening

**Priority**: low. Identified by verification run 4 + cross-checked in the 0.1.7 ship review.

`executeRescueJob` registers `process.once("SIGTERM", ...)` and `process.once("SIGINT", ...)` with closures created inside the function. Concurrent rescue executions (possible in tests or unusual CLI usage) stack multiple global handlers. The `clientClosed` boolean flag is a simple guard but races with cancellation signals are possible.

**Fix**: switch to an `AbortController`-style pattern or a per-invocation cleanup registry so each invocation has an isolated cancellation token. Wrap `client.close()` in a try/finally that tracks the promise to ensure we never attempt to close twice.

Note: 0.1.8's Unit A work reshaped parts of this territory (new spawn-failure helpers open short-lived JobStores in the parent; listener cleanup paths are tighter). Revisit this item against the post-0.1.8 code before starting — the race may have narrowed, or the fix may be smaller now.

### 5. Phase-specific failure classification

**Priority**: low. Identified by verification run 4.

`classifyManagedCommandFailure` collapses all rescue runtime errors into the stage `"rescue.runtime"`. If `client.start()` fails, the original error carries stage `"wire.start"`; if `client.initialize()` times out, it carries `"rescue.initialize"`. The deepest stage is lost.

**Fix**: extend the failure classification so the final persisted `JobError` preserves the deepest available stage (or at least appends it to the message). Makes post-mortem debugging significantly easier.

Note: 0.1.8's Unit A introduced several new stages (`rescue.setup`, `rescue.log-header`, `rescue.artifact`, `rescue.worker.spawn`) that bypass `classifyManagedCommandFailure` entirely. The scope of this item is now narrower — it's specifically about the inner Wire-initialization errors that still route through `classifyManagedCommandFailure`.

---

## Rescue approval allowlist widening

**Priority**: medium. Tracked in memory under `project_rescue_allowlist_gaps`.

The 0.1.7 verification runs exposed that rescue's current shell allowlist rejects several commands that the plugin itself needs or that Kimi naturally reaches for:

- **Compound shell syntax**: `&&`, `||`, pipes, subshells, backticks are all rejected. Run 5 of the 0.1.7 verification failed with `APPROVAL_REJECTED` when Kimi tried `ls -la tests/runtime/ && ls -la tests/wire/`. The current rescue system prompt explicitly warns against this, but the allowlist rejection is the load-bearing enforcement. Worth permitting `&&` between two individually-approved commands (the security argument is weaker than it first looks — if both sides are allowlist-permitted individually, the chain adds no capability).
- **Plugin self-verification commands** not on the allowlist: `bun run check`, `node node_modules/typescript/bin/tsc --noEmit`, `git diff --exit-code -- dist`. Rescue cannot run the plugin's own verification workflow against itself without allowlist help. This bit us during the 0.1.6 rename dispatch, where rescue had to fall back to `bun test` alone.
- **Narrow fs operations**: `rm`, `mv`, `cp`, `touch`. Rescue already has write access to files under the workspace root via the approval policy, so scoping these to plugin source tree paths is a natural extension and closes the gap where rescue had to "delete a file" via truncation-to-0-bytes.

**Scope to design**: how narrowly to define "plugin source tree" (the `kimi-plugin-cc` repo root? any directory containing a `.claude-plugin/` dir? the `${CLAUDE_PLUGIN_ROOT}`?). The answer determines whether a future rescue run in a non-plugin repo inherits the looser allowlist.

---

## 0.1.5 audit Lows (remaining after 0.1.8)

L1, L2, L3 shipped in 0.1.8 (PRs #5 and #4). The one remaining item is L6, which still lacks a concrete repro.

### L6 — Ctrl-C stall (verify)

**Priority**: unclear — no concrete repro documented.

The 0.1.5 audit flagged a Ctrl-C stall concern, but no specific failure mode has been reproduced. `runtime/commands/rescue.ts` registers `SIGINT` and `SIGTERM` handlers and cleans them up in `finally`; 0.1.8's Unit A reshaped parts of this territory without introducing new race surfaces. The item may be a shade of cancellation race hardening (rescue item 4 above) or an outdated note.

**Fix**: either reproduce the stall with a specific command sequence and file it as a concrete bug, or close this item out. Consider re-checking after rescue item 4 (cancellation race hardening) lands, since both touch the same signal-handling region.

---

## 0.1.9 candidates

### Ask refactor

**Priority**: medium. Mentioned as followup in [ADR 004](./adr/004-rescue-pass-through.md) and the 0.1.7 ship memo. Was in 0.1.8 scope but deferred in favor of rescue hardening.

Apply the same Model B treatment to `/kimi:ask` that rescue got in 0.1.7:

- Delete `runtime/prompts/ask-system.md` (current content is entirely redundant with `exclude_tools` + Kimi defaults).
- Drop `system_prompt_path` from `runtime/agents/ask.yaml`.
- **Second scope question**: Codex's 0.1.7 consult noted that `buildAskPrompt` is still opinionated at the per-call level (not just via the system prompt). The ask refactor needs to decide whether `buildAskPrompt` stays as-is, or whether its per-call prompt shaping also gets simplified.
- Run the same empirical verification pattern (3–5 real asks with the system prompt stripped) before committing to deletion.

### Smoke-test installed plugin

**Priority**: low. Tracked in the 0.1.7 ship memo.

The 0.1.7 test suite covers the runtime via `bun test` but does not exercise the installed-plugin command surface end-to-end: `/kimi:status`, `/kimi:result`, `/kimi:cancel`, `/kimi:replay`, `/kimi:challenge`. These are each a thin `scripts/companion.sh` wrapper, but the full invocation chain (slash command → companion → runtime → rendered output in Claude's chat) has never been manually tested against an installed plugin build. Worth a 30-minute manual session that exercises each command against a real Kimi instance.

### Terminal phase gap for non-rescue commands

**Priority**: cosmetic. 0.1.7 closed the rescue-specific terminal phase gap (failed and cancelled rescue rows now get `phase` terminal values via the threaded optional `options.phase` on `markJobFailed`/`markJobCancelled`). Non-rescue commands still leave `phase` as `NULL` because they never wrote to `phase` in-flight either — so there's no "stale in-flight value" to worry about. If a future command grows `phase` semantics, the terminal helpers are already ready.

---

## Upstream requests (external)

### Moonshot: `--session-title TEXT` on `kimi --wire`

**Priority**: low. Deferred since 0.1.5.

0.1.5 ships a workaround: the runtime calls `PATCH /api/sessions/{id}` on the local `kimi web` server (`http://127.0.0.1:5494`) to set human-readable session titles after Wire session creation. This works because `kimi web` exposes a documented API, but it adds a second moving part and fails silently if `kimi web` isn't running.

**Ask**: file a feature request with Moonshot for a native `--session-title TEXT` flag on `kimi --wire` so the plugin can set the title in-band during session creation, eliminating the PATCH call. See `runtime/kimi-web-client.ts` for the current workaround and `reference_kimi_web_api.md` in memory for the discovered API shape.

---

## Documentation cleanup (partially addressed 2026-04-15)

The 0.1.7 doc cleanup pass updated CLAUDE.md, README.md, docs/spec.md, runtime READMEs, added ADR 004, refreshed `docs/references.md`, `docs/test-plan.md`, `docs/review/checklist.md`, and added the archive banner to `docs/implementation-plan.md`. These remaining items are optional polish:

- **Full rewrite of `docs/implementation-plan.md`** — the archive banner points forward to CLAUDE.md, but a full rewrite as a retrospective would be more valuable to new contributors. Skip unless someone wants the writing exercise.
- **`docs/review/checklist.md`** — the 0.1.7 pass added a Model B invariant section at the top, but the original phase-0 questions in the rest of the file are still forward-looking. A second pass to rewrite them as present-tense review-aid questions would improve scan-ability. Low priority.
- **Consolidated architectural overview** — `CLAUDE.md`, `docs/spec.md`, and the ADRs overlap in places. A once-over to deduplicate and consolidate references would help new contributors. Low priority.

---

## How to close items

When picking up an item from this list:

1. Verify the item is still open (the code may have drifted; git log and grep first).
2. Update the relevant memory file (in `~/.claude/projects/-Users-xulelin-Documents-Apps-kimi-plugin-cc/memory/`) if the item's context has shifted.
3. Land the fix as a scoped commit with a clear message tying it back to this followups doc.
4. Remove the item from this file (or mark it resolved with the fix commit's hash) as part of the same commit.
5. If the item's fix reveals adjacent work that should be tracked, add it to this file in the same commit.

Items are deleted from this file when they're fixed, not when they're merely "addressed." The goal is that `docs/followups.md` always reflects the actual open set.
