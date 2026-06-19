# Upstream compatibility audit playbook

How to verify a new kimi-code release against kimi-plugin-cc without breaking the safety guarantees we ship.

This document captures the routine that ran on 2026-05-27 for `@moonshot-ai/kimi-code@0.4.0` (reports 31-35 in `.claude/kimi-code-research/reports/`, commit `b67263c`, tag `compat-verified-kimi-code-0.4.0`). Repeat it whenever a new kimi-code minor or major lands. (Most recent worked examples: the 2026-06-12 0.12.0→0.14.1 multi-minor catch-up, reports 72-76 → v1.2.3; and the 2026-06-16 0.15.0 new-minor checkup, report 78 → v1.2.4.)

## When to run

- A new `@moonshot-ai/kimi-code` minor (e.g., 0.5.0) or major (1.0.0) ships
- An adversarial finding in a different audit suggests a contract we depend on may have moved
- The `/kimi:setup` version probe starts firing "outside tested range" warnings for a version users are actually running
- Quarterly even if none of the above triggered, just to catch silent drift

> **kimi-code self-upgrades by default since 0.8.0** (PR #334, `autoInstall: true`). The installed binary is now *fluid* — a user's interactive TUI can silently move ahead of the verified range out-of-band (the plugin's own `-p` spawns never swap the binary, but they then run against whatever the TUI upgraded to). Expect this trigger to fire more often than the old "user manually updated" cadence. Don't assume `kimi --version` today is the same as last week. (Worked example of a 3-minor catch-up: the 2026-06-03 0.7→0.9 audit, reports 52-60.)

**Skip** for patch releases unless the changelog explicitly touches:
- `apps/kimi-code/src/cli/run-prompt.ts` (stream-json output, session pinning)
- `packages/agent-core/src/session/hooks/` (hook engine — input/output contract; live since 0.5.0, `agent/hooks/` is a legacy copy — diff both)
- `packages/agent-core/src/agent/permission/` (policy queue ordering)
- `apps/kimi-code/src/cli/commands.ts` / `options.ts` (argv surface)

### Forward-scan mode (no release, but `origin/main` moved)

When the routine fires but **nothing new has shipped** — npm `latest`, GitHub `Latest`, and the local binary are all still the version we already verified — do **not** run the full Phase 1 four-agent audit, extend `KIMI_TESTED_MINORS`, or cut a tag. There's no release to certify. Instead run the *forward-scan*: a free look at what the next release will contain.

1. Generate the four scoped diffs exactly as in Phase 0, but with `NEW='origin/main'` (after `git fetch`) and `PREV` = the last verified tag's referent.
2. Read them yourself in the main thread (no agent dispatch). The same 0-byte signal applies: **0-byte `02-permission.diff` + 0-byte `03-hooks.diff` means the two surfaces the safety model rests on are untouched** — that alone covers most of the risk.
3. Triage the non-empty diffs against the surface table below. Anything internal-only (record types not emitted to `-p` stdout, provider/model plumbing, internal abort-reason propagation) is benign for us; flag only changes to the stream-json **output shape**, argv, or the deny chain.
4. Log a one-bullet entry in `ROADMAP-TO-GA.md`'s Post-GA audit log dated and explicitly marked **"forward-scan, not a triggered audit"**, with the scanned `main` SHA, the per-surface result, a provisional verdict, and the specific items to re-confirm with `bun run smoke:real` when the release actually lands.
5. **No commit beyond the log bullet, no tag, no version bump** — the scanned code is unreleased and will change before shipping. (The 2026-06-01 entry is the worked example.)

The forward-scan is the lightweight discharge of the "quarterly drift" trigger above: it catches a contract moving *before* the release forces a turnaround, without spending the full ceremony on code that isn't final.

## What we depend on (the surfaces to audit)

These are the kimi-code surfaces kimi-plugin-cc consumes. If any one breaks, our safety guarantees break.

| Surface | Where in kimi-code | What we depend on | Where in kimi-plugin-cc |
|---|---|---|---|
| `kimi -p` permission mode | `apps/kimi-code/src/cli/run-prompt.ts` | hard-coded `permission: 'auto'`; `installHeadlessHandlers` auto-approves; resumed sessions force-overridden to `'auto'` | `runtime/cli-client.ts` invokes `-p`; safety relies on the hook firing |
| PreToolUse hook engine | `packages/agent-core/src/session/hooks/` (live since kimi-code 0.5.0; `agent/hooks/` is a legacy copy — diff both) | stdin JSON shape (`{tool_name, tool_input, session_id, cwd, ...}`), exit-2-as-deny semantics, empty matcher means all tools, fail-open on internal error | `runtime/hooks/approval-hook.ts`, `runtime/hooks/approval-policy.ts` |
| Permission policy queue order | `packages/agent-core/src/agent/permission/policies/index.ts` | `PreToolCallHookPermissionPolicy` runs **before** `auto-mode-approve` / `yolo-mode-approve` | implicit — entire safety model assumes hook fires first |
| Stream-json output | `apps/kimi-code/src/cli/run-prompt.ts` (`PromptJsonWriter`, `writeResumeHint`) | NDJSON record shapes for assistant/tool/tool_result; `role:"meta", type:"session.resume_hint"` carries session id | `runtime/stream-json.ts` parser, `runtime/cli-client.ts` session pinning |
| CLI argv | `apps/kimi-code/src/cli/commands.ts`, `options.ts` | `-p`, `-r <id>`, `--output-format stream-json`, `-m`, `--skills-dir` all accepted with current semantics | `runtime/cli-client.ts::buildArgs` |
| Process / exit / lifecycle | `apps/kimi-code/src/cli/run-prompt.ts` and OS-level | stdout = stream-json only; stderr = humans-only; SIGTERM lands; process group enumerable | `runtime/cli-client.ts` cancellation; `runtime/background-spawn.ts` |

## The routine

### Phase 0 — Setup (5 min)

The upstream clone lives at `.claude/kimi-code-research/kimi-code-repo/`. It's gitignored.

```bash
cd .claude/kimi-code-research/kimi-code-repo
git fetch --tags origin
git checkout '@moonshot-ai/kimi-code@<NEW_VERSION>'
git describe --tags --always  # confirm
```

Generate scoped diffs against the previous audited version (typically the last tag's referent — check `tags/compat-verified-kimi-code-*` to find it):

```bash
mkdir -p /tmp/kimi-<NEW>-diff
PREV='@moonshot-ai/kimi-code@<PREV_VERSION>'
NEW='@moonshot-ai/kimi-code@<NEW_VERSION>'

git diff "$PREV".."$NEW" -- \
  apps/kimi-code/src/cli/run-prompt.ts \
  apps/kimi-code/src/cli/options.ts \
  apps/kimi-code/src/cli/commands.ts \
  > /tmp/kimi-<NEW>-diff/01-cli-prompt-mode.diff

git diff "$PREV".."$NEW" -- \
  packages/agent-core/src/agent/permission/ \
  packages/agent-core/src/session/permission/ \
  > /tmp/kimi-<NEW>-diff/02-permission.diff

# Scope BOTH agent/hooks AND session/hooks. The LIVE hook engine relocated
# to session/hooks/ in kimi-code 0.5.0 (agent/hooks/ is now a byte-identical
# legacy copy). Diffing only agent/ would MISS a change to the engine that
# actually runs in -p mode — the 0-byte signal would be a false negative.
# (If a copy no longer exists in a given release, its diff is simply empty.)
git diff "$PREV".."$NEW" -- \
  packages/agent-core/src/agent/hooks/ \
  packages/agent-core/src/session/hooks/ \
  > /tmp/kimi-<NEW>-diff/03-hooks.diff

git diff "$PREV".."$NEW" -- \
  packages/agent-core/src/agent/records/ \
  packages/agent-core/src/session/ \
  > /tmp/kimi-<NEW>-diff/04-wire-records.diff
```

A 0-byte `03-hooks.diff` (now covering **both** `agent/hooks/` and the live `session/hooks/`) is the canonical "hook engine unchanged" signal. The other three need real reading. (Note: `04-wire-records.diff` scopes the whole `session/` dir, so it re-includes `session/hooks/`+`session/permission/` — that overlap is intentional belt-and-suspenders, not a bug.)

### Phase 1 — Multi-agent compat review (4 parallel agents)

Dispatch four reviewers in parallel via the Agent tool with `run_in_background: true`. Each gets one surface and produces one report under `.claude/kimi-code-research/reports/NN-upstream-<scope>.md`.

Reviewer 1 — **PreToolUse hook contract** (`general-purpose` agent)
- Question: did the JSON-in / exit-code-out contract change? Did matcher semantics change? After any permission-system refactor, does our hook still fire first in `-p` mode?
- Output: `reports/NN-upstream-<ver>-hook-contract.md`

Reviewer 2 — **Stream-json output** (`general-purpose` agent)
- Question: did NDJSON record shapes change? Is `session.resume_hint` still emitted with the same field name and position in stream? Any new top-level role or meta-type our parser would warn-on?
- Output: `reports/NN-upstream-<ver>-stream-json.md`

Reviewer 3 — **CLI surface** (`general-purpose` agent)
- Question: did our flags survive byte-identical? Any new flags affecting prompt mode? Is auto-approve still hard-coded?
- Output: `reports/NN-upstream-<ver>-cli-surface.md`

Reviewer 4 — **Adversarial** (`general-purpose` agent — the `kimi:kimi-challenge` subagent is risky for this because its foreground job can disappear)
- Brief: "Three other reviewers say COMPAT-PRESERVED. Attack the claim. Find the cases where it breaks. If you can't, earn the conclusion adversarially."
- Output: `reports/NN-upstream-<ver>-adversarial.md`

All four agents must save a structured report to disk and reply with a verdict + short summary. The full report is the deliverable; the chat reply is just a teaser.

Verdicts to use (consistent across reports):
- `COMPAT-PRESERVED` — no action needed
- `COMPAT-AT-RISK` — narrow specific concern flagged, may or may not require code
- `COMPAT-BROKEN` — actual breakage, runtime change required

### Phase 1b — Assertion check: real-binary smoke (10 min)

Source-reading proves the *contract* looks unchanged; the smoke proves it *behaves* unchanged. Run it against the actual new release:

```bash
# Install / activate the new kimi-code release so `kimi` on PATH is <NEW_VERSION>
kimi --version                  # confirm it reports <NEW_VERSION>
bun run smoke:real              # KIMI_PLUGIN_CC_SMOKE=1 bun test tests/runtime/real-binary-smoke.test.ts
```

It spawns the real `kimi -p` in an isolated `KIMI_CODE_HOME` (seeded from your authenticated home — never mutates the real config or session store) and asserts, for review / challenge / ask / review_gate, that a forced write attempt is denied by the hook and no file lands. A green run is direct evidence that the policy-queue-index-0 / hook-deny chain still holds end-to-end on the new release — the single highest-signal check in this whole routine. If it goes red, the source-reading verdict is *probably* wrong somewhere — but first rule out the operator-auth false alarm below; once that's excluded, treat as `COMPAT-BROKEN` until reconciled.

Prereqs: a kimi binary + an authenticated `~/.kimi-code` (config + `credentials/` + `oauth/`). Skipped automatically without them, so note in the synthesis whether the smoke actually ran or was skipped — a skipped smoke is not a passed smoke.

**Smoking a release without touching the operator's install (the temp-binary technique).** `kimi upgrade` is unreliable on some installs (e.g., the 2026-06-03 run reported a bogus "native (windows)" source on macOS and refused to update, leaving the binary at 0.8.0 while certifying through 0.9.0). The smoke resolves its binary from `KIMI_PLUGIN_CC_KIMI_BIN` (falling back to `kimi` on PATH — see `runtime/kimi-command.ts::resolveKimiCliCommand`), so you can certify the exact target release without mutating `~/.kimi-code/bin`:

```bash
D=/tmp/kimi-<NEW>; rm -rf "$D"; mkdir -p "$D"; cd "$D"
echo '{"name":"smoke","private":true}' > package.json
bun add @moonshot-ai/kimi-code@<NEW>
"$D/node_modules/.bin/kimi" --version    # confirm <NEW>
cd -  # back to the plugin repo
KIMI_PLUGIN_CC_SMOKE=1 \
  KIMI_PLUGIN_CC_KIMI_BIN="$D/node_modules/.bin/kimi" \
  bun test tests/runtime/real-binary-smoke.test.ts
```

Auth still seeds from the real `~/.kimi-code` (`KIMI_PLUGIN_CC_SMOKE_HOME`) into an isolated `KIMI_CODE_HOME`, so a previously-green smoke proves the token is valid. This is how the 0.9.0 cert earned "tested end-to-end" without altering the operator's 0.8.0 install.

**Operator-auth false alarm (seen on the 2026-05-31 0.6.0 run).** The skip-gate only checks that `config.toml` + `credentials/` *exist*, not that the token inside is *still valid*. An expired OAuth token sails past the gate, so the smoke **runs** (not skipped) and goes **red** with every label failing at `auth.login_required: OAuth provider "managed:kimi-code" requires login` — `records` is `[]` and the deny marker never appears because kimi dies before any tool call. This looks alarmingly like a hard break but is pure machine state: re-login (`kimi` interactive auth) and re-run. Distinguish it from a real break by the error string — a true compat break would show the model *attempting* a write and the hook *not* denying, not an auth abort with empty records. Don't pin `COMPAT-BROKEN` on an `auth.login_required` red. Related gotcha: don't pipe the smoke through `... | tail -N` and trust the reported exit code — the pipe's status is `tail`'s, not bun's, so a red suite can look like exit 0. Read the body, or run `bun run smoke:real; echo $?` unpiped.

### Phase 2 — Synthesis (15 min, main thread)

Read all four reports. Write a synthesis to `reports/NN-upstream-<ver>-synthesis.md`. Decide one of three outcomes:

| Findings | Outcome | Commit shape |
|---|---|---|
| Nothing load-bearing | Docs-only update + lightweight compat-marker tag | `docs: verify kimi-code <ver> compat — no runtime changes required` |
| Minor adjustments (e.g., extend `KIMI_TESTED_MINORS`, tighten a comment) | Patch release | Bump 5 version files, tag `vX.Y.Z`, gh release |
| Real breakage | Real fix + minor release | Bump 5 version files to the next minor, tag, gh release |

"Load-bearing" means runtime code changes. Doc tightening alone is not load-bearing.

### Phase 3 — Edits (variable)

Surgical only. Common doc edits even when no code changes:
- `AGENTS.md`: extend the "Upstream compat" line with the verified version
- `AGENTS.md`: update the dual-source session-meta paragraph's verified-through range
- `runtime/stream-json.ts`: update the source-of-truth comment's verified-through range
- `ROADMAP-TO-GA.md`: append an audit log entry with date, verdict, and findings

If extending `KIMI_TESTED_MINORS` (`runtime/kimi-version-probe.ts`), that's a runtime change — bump to patch release.

### Phase 4 — Multi-reviewer pass on the audit commit

The audit reports reviewed kimi-code. The reviewers in this phase review **your edits** to confirm they accurately reflect the audit.

Dispatch two reviewers in parallel:

1. **code-reviewer** agent on the working-tree diff — checks for correctness, cross-references the report citations, flags overclaims or wrong file paths
2. **general-purpose** agent doing "doc fidelity" — verifies every factual claim in the docs is supported by a specific report; checks numerical claims; flags marketing language

Apply must-fix findings before commit. Nits are at your discretion.

> Why not use `code-reviewer` for both: independence. The fidelity audit specifically grades the writing against the source reports, which is a different question than the code-reviewer's "is this commit correct."

### Phase 5 — Commit, tag, push

**Docs-only outcome** (most common — no breakage):
```bash
git add AGENTS.md ROADMAP-TO-GA.md runtime/stream-json.ts dist/stream-json.js
git commit -m "docs: verify kimi-code <ver> compat — no runtime changes required" \
  -m "<audit summary>"
git push origin main
git tag -a "compat-verified-kimi-code-<ver>" -m "<audit verdict + reports>"
git push origin "compat-verified-kimi-code-<ver>"
```

**Patch release outcome** (something load-bearing):
```bash
# Bump runtime/version.ts, package.json, .claude-plugin/plugin.json,
#                 .claude-plugin/marketplace.json, AGENTS.md
bun run check       # must be green
git add -A
git commit -m "release: <new-version> — kimi-code <ver> compat"
git tag -a "v<new-version>" -m "..."
git push origin main "v<new-version>"
gh release create "v<new-version>" --notes-file <(echo "<audit body>")
```

The compat-marker tag (`compat-verified-kimi-code-<ver>`) is independent of the plugin version tag (`v<X.Y.Z>`). Both can coexist.

## Anti-patterns

- **Don't use the `kimi:kimi-challenge` subagent for the adversarial pass**. It invokes `kimi -p` under the hood; its foreground job can disappear (`FOREGROUND_PROCESS_DISAPPEARED`) leaving the wrapper agent unsure whether the work completed. Use `general-purpose` with an adversarial brief instead.
- **Don't extend `KIMI_TESTED_MINORS` on source-reading alone — run the Phase 1b smoke against the new release first.** The probe is the user's only signal that we tested against their version. The local real-binary smoke (`bun run smoke:real`) now exists (H7 partial), so "tested" should mean "smoke ran green against this release", not just "four agents read the diff". Until the smoke runs in per-push CI against a pinned release (H7 remaining — blocked on an OAuth-credentials secret), it stays a manual pre-release gate; record in the synthesis whether it ran or was skipped.
- **A headless/cloud-prepared catch-up DEFERS its smoke — treat the PR as smoke-pending until you run it locally against that branch.** A catch-up prepared in a cloud/CI session with no kimi binary cannot run Phase 1b (`PREREQS_OK` is false; the suite skips — installing the binary doesn't help, the smoke needs valid Moonshot OAuth creds). Before merging such a PR, run `bun run smoke:real` **locally against the actual PR branch**, then flip the "smoke pending" docs (`CHANGELOG`, `kimi-version-probe.ts` comment, `ROADMAP`) to GREEN so the tagged commit is accurate. Do **not** substitute the daily-checkup routine's `report-NN` green smoke for this if the PR added code the report's smoke didn't cover: the 2026-06-19 v1.2.6 PR bundled the `/kimi:swarm --cap` env-wiring feature, but report 81's green smoke *predated* that code (report 81 had explicitly said the feature should NOT be bundled), so it certified only the pre-feature tree. Re-running locally against the branch is what actually closed the gate. (Same run: watch for the cwd-persisted-into-the-clone trap — `bun run check` piped through `tail` reported exit 0 while actually failing "Script not found check" because a prior `cd` had left the shell in `.claude/kimi-code-research/kimi-code-repo`; run gates unpiped from the plugin root.)
- **Don't tag a plugin version (`vX.Y.Z`) for zero-code-change audits.** Reserve patch and minor releases for actual changes. Use the compat-marker tag for verification-only events.
- **Don't skip the multi-reviewer pass on the audit commit.** The 2026-05-27 run caught a `~/.kimi/plugins/installed.json` path error (correct path: `~/.kimi-code/plugins/installed.json`) propagated from the source audit reports into the roadmap — exactly the kind of detail one reader misses.

## Reference: the 2026-05-27 0.4.0 audit

For a worked example see:
- Commit: `b67263c` (`git show b67263c`)
- Tag: `compat-verified-kimi-code-0.4.0` (`git show compat-verified-kimi-code-0.4.0`)
- Reports (gitignored): `.claude/kimi-code-research/reports/31-upstream-04-hook-contract.md` ... `35-upstream-04-synthesis.md`
- Roadmap audit log: `ROADMAP-TO-GA.md` § "Post-GA audit log"
