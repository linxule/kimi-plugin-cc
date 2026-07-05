# Changelog

> **Post-1.0 release history (v1.0.1 -> present) lives in [ROADMAP-TO-GA.md § Post-GA audit log](./ROADMAP-TO-GA.md#post-ga-audit-log)** and the "Version" / "Upstream compat" lines of [AGENTS.md](./AGENTS.md). Docs-only kimi-code compat checkups that don't bump the plugin version (e.g. the 0.14.2 / 0.14.3 patches) are recorded there, not here. Notable releases are summarized below; the GA entry and full pre-GA detail follow.

## 1.6.4 — 2026-07-05

**kimi-code 0.22.3 compat: extend `KIMI_TESTED_MINORS` with `{0,22}` after a GREEN real-binary smoke.** A patch release that certifies the 0.21.1→0.22.3 minor and clears the H9 "newer than tested max" setup warning for operators on 0.22.x.

- **Probe extension** (`runtime/kimi-version-probe.ts`): added `{ major: 0, minor: 22 }` with the per-version audit comment.
- **Verdict: COMPAT-PRESERVED.** Reports 94 and 95 found the hook engine unchanged, policy order still hook-first (`PreToolCallHookPermissionPolicy` index 0, `AutoModeApprovePermissionPolicy` index 5), write-path field names intact (`path` / `command`), and plugin slash commands plus `runShellCommand` still host/RPC-only and off the `kimi -p` path.
- **New 0.22.x surfaces are benign for this plugin:** prompt-mode background drain happens after assistant-output flush and remains bounded by the plugin's AbortController budgets; shell output caps affect huge tool-result content only; image originals are stored under Kimi session state, not the user worktree; model/thinking/provider config changes do not alter permissions; server auth-bypass flags are a separate subcommand stack.
- **Smoke GREEN on a temp-installed `kimi --version` 0.22.3:** `bun run smoke:real` ran 9 pass / 0 fail on 2026-07-05. Read-only labels denied forced writes; pursue wrote zero files and parsed `goal.summary`; read-only swarm denied a spawned subagent write; write-swarm kept coder edits in the throwaway worktree (`userTreeClean=true`, `patchBytes=334`, `worktreeCleaned=true`) and denied an out-of-root absolute write.
- **Hook-missing UX:** swarm still refuses without the PreToolUse hook, but the refusal now names both repair commands: Claude Code `/kimi:setup` and Codex `$kimi-setup`. Codex swarm skill guidance surfaces the same repair path and no longer suggests the skip env.
- **Docs:** `AGENTS.md` (Version line + Upstream-compat "through 0.22.3"), `ROADMAP-TO-GA.md` (audit-log entry), and `runtime/stream-json.ts` (verified-through comment). Surface reports: `.claude/kimi-code-research/reports/94-upstream-0220-surface.md` and `95-upstream-0223-surface.md`. Tags: `v1.6.4` and `compat-verified-kimi-code-0.22.3`.

## 1.6.3 — 2026-07-01

**Deterministic post-run Kimi Code title sync for plugin-created sessions.** A patch release that restores human-readable session names in Kimi Code without reintroducing the old v0.4 Wire/web title-assignment path.

- **Automatic deterministic titles.** After a successful `kimi -p` run returns or resumes a usable session id, the runtime computes titles from plugin-owned command metadata (`Kimi <Command>: <summary>`) and updates Kimi Code session state best-effort. The model never writes titles.
- **Scoped to user-facing commands.** Title sync covers ask, review, challenge, rescue, pursue, swarm, and `swarm --write`; `review_gate` remains intentionally excluded to avoid noisy Stop-hook sessions.
- **Manual titles preserved.** Sessions with `isCustomTitle: true` are skipped, matching Kimi Code's manual-title behavior. The sync preserves other state fields and does not update `updatedAt`.
- **Metadata hardening.** The helper resolves `KIMI_CODE_HOME` consistently, validates `session_index.jsonl` entries under `<kimiHome>/sessions`, rejects unsafe symlink paths, caps metadata reads, skips oversized index lines, writes `state.json` atomically, preserves file mode, and logs only short best-effort warnings.
- **Docs/tests.** README and migration docs now describe post-run title sync and the loss of v0.4 pre-run Wire/web title assignment. Tests cover helper safety cases plus ask/review command-level sync and `review_gate` exclusion. `bun run check` green. Tag: `v1.6.3`.

## 1.6.2 — 2026-07-01

**kimi-code 0.21.1 compat: extend `KIMI_TESTED_MINORS` with `{0,21}` after a GREEN real-binary smoke.** A patch release that certifies the 0.20.x→0.21.1 minor and clears the H9 "newer than tested max" setup warning for operators whose binary auto-upgraded to 0.21.x.

- **Probe extension** (`runtime/kimi-version-probe.ts`): added `{ major: 0, minor: 21 }` with the per-version audit comment.
- **Verdict: COMPAT-PRESERVED.** Source audit report 93 found `02-permission.diff` and `03-hooks.diff` both 0 bytes across 0.20.2→0.21.1; `options.ts`, `agent/records/`, `workspace-local.ts`, and `tools/builtin/file/{write,edit}.ts` are also unchanged on the load-bearing axes. `run-prompt.ts` still hard-codes `permission:'auto'`; the only scoped `run-prompt.ts` change is a cleanup timeout after the writer flush.
- **New 0.21.0 surfaces are off-path or benign:** plugin slash commands are RPC/host-initiated and absent from `kimi -p`; the thinking-effort/model-catalog refactor is provider plumbing the plugin does not consume; compaction and record migrations are replay/history internals, not live stdout record-shape changes. The `runShellCommand`/`cancelShellCommand` RPC watch remains discharged: still RPC/TUI-only.
- **Smoke GREEN on `kimi --version` 0.21.1:** `bun run smoke:real` ran 9 pass / 0 fail on 2026-07-01. Read-only labels denied forced writes; pursue wrote zero files and parsed `goal.summary`; read-only swarm denied a subagent write; write-swarm kept coder edits in the throwaway worktree (`userTreeClean=true`, `patchBytes=334`) and denied an out-of-root absolute write.
- **Docs:** `AGENTS.md` (Version line + Upstream-compat "through 0.21.1"), `ROADMAP-TO-GA.md` (audit-log entry), `runtime/stream-json.ts` (verified-through comment), and `docs/upstream-compat-audit.md` (plugin-command watch surface). Surface reports: `.claude/kimi-code-research/reports/93-upstream-021-surface.md` and `93-upstream-021-adversarial.md`. `bun run check` green. Tags: `v1.6.2` and `compat-verified-kimi-code-0.21.1`.

## 1.6.1 — 2026-06-26

**kimi-code 0.20.0 compat: extend `KIMI_TESTED_MINORS` with `{0,20}` (source-audit certified; the real-binary smoke was quota-blocked).** A patch release that certifies the 0.19.x→0.20.0 minor. The only runtime change is the probe-array extension; there is no behavior change. Operators whose binary auto-upgraded past the `{0,19}` tested max (PR #334 background auto-upgrade; npm went straight 0.19.2→0.20.0, no 0.19.3) were tripping the H9 "newer than tested max" warning at `/kimi:setup`; this clears it for 0.20.x.

- **Probe extension** (`runtime/kimi-version-probe.ts`): added `{ major: 0, minor: 20 }` with the full per-version audit comment.
- **Verdict: COMPAT-PRESERVED**, by a byte-level source audit (not a green smoke — see below). `02-permission.diff` is 0 bytes AND `03-hooks.diff` is 0 bytes (both `agent/hooks/` and `session/hooks/`); `policies/index.ts`, `pre-tool-call-hook.ts`, `run-prompt.ts`, `options.ts`, and `agent/records/` are **all 0-byte** 0.19.1→0.20.0. `PreToolCallHookPermissionPolicy` is still index 0, `AgentSwarmExclusiveDeny` index 1, `AutoModeApprove` the first approve at index 5. A **broad-sweep risk scan over every file changed OUTSIDE the five scoped diffs** found ZERO new permission/approval decisions anywhere outside the (0-byte) permission+hooks dirs, and no swarm-subagent spawn/permission change — so read/write-swarm `coder` subagents are still gated solely by the index-0 hook. (Diffed against the 0.19.1 tag, the array's last narrative anchor; 0.19.1→0.19.2 was already 0-byte on every load-bearing surface — report 86 — so no signal is lost.)
- **The 0.20.0 changes are all compat-benign for a `kimi -p` wrapper:**
  - **#1040** AGENTS.md-oversized `warning` agent event: **swallowed on `-p`** (`run-prompt.ts:495 case 'warning': return;` — no `stdout.write`, shared with `subagent.*`/`compaction.*`/`goal.updated`). Invisible to the role-keyed `runtime/stream-json.ts` parser; reaches only the RPC `getSessionWarnings` accessor (TUI/kimi-web) + the logger.
  - **#1065** `Write` auto-creates missing parent dirs (`ensureParentDirectory` recursive `mkdir` on ENOENT). The `path` field name is **intact** (`WriteInputSchema = z.object({ path, content })`; `Bash` still `command`), so `rescue-approval.ts::extractFilePath` is unaffected (the v1.4.1 lesson). The `mkdir` runs on the parent of an **already-hook-approved** path → can only create dirs INSIDE a path the index-0 hook approved; no workspace escape.
  - **#1062** tool-result budget: adds a `truncated` flag to tool-result **content** (`loop/tool-call.ts` `normalizeToolResult`), NOT the serialized record **shape** (`records/` + `run-prompt.ts` 0-byte). It also persists tool results >50,000 chars to `<agent.homedir>/tool-results/<stem>-<uuid>.txt` (`agent/turn/tool-result-budget.ts`; `homedir = this.agent.homedir` = the **kimi home, not the workspace cwd**) — a kimi-internal artifact off the user's tree, same class as `~/.kimi-code/logs/`. Does NOT violate "read-only commands write zero files in the repo".
  - **`-C`→`-c` continue rename** (`commands.ts`, + hidden `-C` alias): off our flag set (`-p`/`-r`/`--output-format`/`-m`/`--skills-dir`); `run-prompt.ts`/`options.ts` 0-byte.
  - **New `runShellCommand`/`cancelShellCommand` RPC** (CoreAPI/SessionAPI): a **HOST-initiated** shell exec (TUI `!command` / kimi-web) that calls `bash.resolveExecution().execute()` directly, **bypassing the permission stack + PreToolUse hook** — but **not model-reachable** (not a model tool; absent from `installHeadlessHandlers` and the whole `apps/kimi-code/src/cli/` `-p` path), and the plugin never opens an RPC channel. Unreachable for the plugin today. **WATCH (next audit):** re-confirm it stays RPC/TUI-only — it is the first permission-bypassing shell-exec in agent-core.
  - **`forcePluginSessionStartReminder`** resume override (`rpc/core-impl.ts`): set ONLY via `reloadSession` (the `/reload` RPC flow); the plugin's `-p -r` resume uses plain `harness.resumeSession` → never set. `config/` is 0-byte (the 0.19.0/#812 workspace-local `additional_dir` auto-load is unchanged; `GitCwdWriteApprove`, its sole consumer at index 17, stays dead below auto-approve on `-p`).
  - **`kimi server`/`web` daemon stack** (`cli/sub/server/*`): a separate transport, never invoked; its new `stdout.write`s are off the `-p` path.
- **Smoke NOT run for this certification.** `bun run smoke:real` against the operator's 0.20.0 binary went **RED on a provider `403 "usage limit for this billing cycle"`** — `records:[]` on every label, the model never issued a single tool call (**0 hook-bypasses observed**). This is the **operator-billing-state false-alarm class** (cf. the `auth.login_required` note in `docs/upstream-compat-audit.md`), **not** a compat break — a true break shows the model *attempting* a write and the hook *not* denying. The operator elected to certify on the source audit (manual byte-level + multi-agent re-audit) and skip the quota-blocked smoke; **re-run `bun run smoke:real` once quota refreshes** to earn the end-to-end proof.
- **Docs:** `AGENTS.md` (Version line + Upstream-compat "through 0.20.0"), `runtime/stream-json.ts` (verified-through comment), surface report `.claude/kimi-code-research/reports/88-upstream-0200-surface.md`. `bun run check` green. Tags: `v1.6.1` and `compat-verified-kimi-code-0.20.0`.

## 1.6.0 — 2026-06-23

**Repackage the Codex plugin as a self-contained `plugins/kimi-codex/` subfolder to end Claude Code/Codex surface crossover.** The Codex sidecars added under v1.5.x placed `skills/` at the repo root — which is also the Claude Code plugin root — and Claude Code auto-discovers a top-level `skills/` directory by convention. So the 12 Codex skills were also loading as Claude Code skills, producing a triple commands+agents+skills surface and a safety asymmetry. This release isolates the Codex package without breaking the Claude Code surface or duplicating maintenance.

- **New self-contained Codex plugin root: `plugins/kimi-codex/`** — contains `.codex-plugin/plugin.json` (`skills: "./skills/"`), the 12 `skills/`, and a **byte-mirror of the runtime** (`scripts/companion.sh`, `scripts/review-gate-hook.sh`, `dist/**`). Codex copies a plugin root to `~/.codex/plugins/cache/$MARKETPLACE/$PLUGIN/$VERSION/` on install and forbids `../` escapes, so the package must bundle everything it needs. The repo root no longer has `skills/` or `.codex-plugin/`, so Claude Code is back to its intended **commands + agents** surface. `.agents/plugins/marketplace.json` stays at the repo root with `source.path → "./plugins/kimi-codex"`.
- **Closes a safety asymmetry.** The write-capable Codex skills (`kimi-rescue`, `kimi-pursue`, `kimi-swarm-write`, `kimi-setup`, `kimi-cancel`) declare `allow_implicit_invocation: false` only in `agents/openai.yaml`, which Claude Code ignores — so while they leaked into Claude Code they were model-invocable there, whereas the equivalent slash commands are deliberately human-only. Moving the skills out of the Claude Code scan root removes that exposure entirely.
- **Single-sourced version.** `scripts/surface-registry.ts` `PLUGIN_VERSION` now imports `KIMI_PLUGIN_CC_VERSION` from `runtime/version.ts` (it was a 7th hard-coded version source). A new test asserts `PLUGIN_VERSION === KIMI_PLUGIN_CC_VERSION === package.json` version.
- **Generator + gate hardening** (`scripts/generate-surfaces.ts`): write mode now mirrors the runtime payload into the subfolder (0755 on shell scripts) and prunes stale skill dirs + stale mirrored files; `--check` byte-compares the mirror against the freshly built root and detects orphaned generated files. `bun run check` now builds **before** the surface check, and the drift gate covers `dist` **and** `plugins/kimi-codex`.
- **New tests**: repo-root `skills/` absence (Claude Code skill-leakage guard) + subfolder presence; bundled `companion.sh` is a byte copy of root; `resolvePluginPaths` precedence (`CLAUDE_PLUGIN_DATA` wins over `PLUGIN_DATA` when both set).
- **Claude Code regression audit: none.** The v1.5.x shared-file edits (shell env-var alias dance in `companion.sh`/`review-gate-hook.sh`, the `paths.ts` `?? PLUGIN_DATA` fallback, the `review-gate.ts` inline-payload preference with transcript fallback) all short-circuit to the original behavior whenever the Claude environment variables are set, and the load-bearing PreToolUse approval hook + its strict-exact verifier are untouched.
- **Verified out-of-band by Codex** (not by `bun run check`): a live Codex install loading skills from `plugins/kimi-codex/skills/` and the manifest passing Codex's real schema — reinstall the marketplace + run the `$kimi-ask` product smoke. `bun run check` green locally.

## 1.5.1 — 2026-06-23

**kimi-code 0.19.1 compat: extend `KIMI_TESTED_MINORS` with `{0,19}` after a GREEN real-binary smoke.** A patch release that certifies the 0.18.0→0.19.1 jump. The only runtime change is the probe-array extension; there is no behavior change. Operators whose binary auto-upgraded past the 0.18 tested max (PR #334 background auto-upgrade) were tripping the H9 "newer than tested max" warning at `/kimi:setup`; this clears it for 0.19.x.

- **Probe extension** (`runtime/kimi-version-probe.ts`): added `{ major: 0, minor: 19 }` with the full per-version audit comment. Backed by a **GREEN `bun run smoke:real` (9 pass / 0 fail)** on the operator's 0.19.1 binary: review/challenge/ask/review_gate forced writes hook-denied; pursue multi-turn goal wrote zero files (`goal.summary` parsed cleanly, turnsUsed:2 tokensUsed:73631); a read-only swarm subagent's forced write hook-denied; and **both write-swarm assertions held on 0.19.1** — a `coder` subagent's edits landed only in the throwaway worktree (patchBytes=306, `userTreeClean=true`) and an out-of-trusted-root absolute write was hook-denied. "Tested" is earned end-to-end on 0.19.1, not source-reading-only.
- **The 0.18→0.19 minor (#812 `add-dir` support) is compat-benign.** It added a `--add-dir <dir>` flag, plumbed `additionalDirs` through `Session`, and widened `GitCwdWriteApprovePermissionPolicy` to approve writes within cwd OR any additional dir. It is a no-op for the plugin — **not** because `additionalDirs` is empty (#812 also wired an unconditional auto-load of project-local `.kimi-code/local.toml` `additional_dir` into the `-p` create+resume bootstraps via `rpc/core-impl.ts:238,363`, so it is **not** guaranteed empty even without `--add-dir`), but because: `GitCwdWriteApprovePermissionPolicy` is the **only** permission consumer of `additionalDirs` and it sits at **index 17**, below `AutoModeApprovePermissionPolicy` (index 5), so on the `-p` auto path it is structurally unreachable; read-only commands deny all writes at the index-0 hook; and our write commands confine to a single root via `rescue-approval.ts`, which never reads `additionalDirs`. The 0.19.1 smoke proves confinement empirically (write-swarm `userTreeClean=true`, out-of-root write hook-denied). (`isWithinWorkspace` with an empty list is byte-for-byte the old `isWithinDirectory(cwd)` for the non-`-p` modes where the policy actually runs.)
- **Safety chain re-verified intact.** `03-hooks.diff` is 0 bytes (both `agent/hooks/` and `session/hooks/` byte-identical 0.18.0→0.19.1); `policies/index.ts` is byte-identical (`PreToolCallHookPermissionPolicy` still index 0, `AutoModeApprovePermissionPolicy` still the first approve at index 5); `permission:'auto'` still hard-coded in `run-prompt.ts`.
- **Off-path / cosmetic only.** #963 adds a new `turn.ended` terminal `reason:'filtered'` (provider content filter) surfaced as a human string — a new failure *reason*, not a new stdout record *shape*, so the role-keyed stream-json parser is unaffected. 0.19.1 over 0.19.0 is `ci:`/`fix(acp)`/`fix(web)` only (0-byte load-bearing diff). #821 (detach-to-background) was already triaged in the forward-scans.
- **Next-audit note (no action):** #812 (0.19.0) — **not** #992 — wired `.kimi-code/local.toml` `additional_dir` auto-load into the `-p` create AND resume bootstraps for all transports (#992 only re-routed that read's kaos handle to fix an ACP bug). Persisted additional-dirs are upstream-auto-approvable via `GitCwdWriteApprove` but stay hook-bound for us; the "plugin never passes `--add-dir` ⟹ `additionalDirs` empty" assumption is now broken upstream. Re-confirm each audit that the index-0 hook still pre-empts `GitCwdWriteApprove`.
- **Docs:** `AGENTS.md` (Version line + Upstream-compat "through 0.19.1"), `runtime/stream-json.ts` (verified-through comment), `ROADMAP-TO-GA.md` (audit-log entry). Surface report: `.claude/kimi-code-research/reports/85-upstream-0191-surface.md`. `bun run check` green. Tags: `v1.5.1` and `compat-verified-kimi-code-0.19.1`.

## 1.5.0 — 2026-06-20

**Open-thread sweep: model-invocable `kimi-swarm-write` agent, a `--budget` safety ceiling, hardened write-swarm smoke, and a local-first CI decision.** A batch closing the threads left open after v1.4.1, each resolved to a concrete state.

- **New: `agents/kimi-swarm-write.md`** (write-capable, `color: red`; auto-discovered, no `plugin.json` change) — the v1.4 "human-only" deferral is **lifted**. The main Claude thread can now dispatch a write fan-out on its own judgement. This is a safe extension because auto-dispatch widens **no** write surface and removes **no** bound: the agent runs the identical `runSwarm --write` code, so edits still land only in the ephemeral throwaway worktree, the index-0 PreToolUse hook still gates every `coder` subagent (the `swarm-write` label's rescue allowlist scoped to the forge-proof trusted root), the result is still a **patch the user reviews and applies — the plugin never applies or commits**, and `--budget` + default `--max-concurrency` 1 + the hook requirement all still hold. It is in fact a *less* dangerous agent than the already-shipped write-capable `kimi-pursue`, which writes directly into the workspace; write-swarm's output is a patch that never reaches a real tree without a human merge. The field-proof gating this was the v1.4.1 real-binary write-swarm smoke (GREEN against 0.18.0). Strict triggering: the description demands BOTH signals — many disjoint write targets AND explicit fan-out intent — and steers single edits to `kimi-rescue`, read-only fan-outs to `kimi-swarm`, and autonomous loops to `kimi-pursue`. Default `--max-concurrency` stays **1**. The `/kimi:swarm --write` slash command stays human-only (`disable-model-invocation: true`). The plugin now ships **seven** subagents.
- **`--budget` gains a 24h ceiling** (`runtime/parsing.ts::MAX_DURATION_MS`). The budget is the SOLE hard wall-clock bound on pursue/swarm, so a typo'd or absurd value (`999999h`, a pasted nanosecond count) would effectively *disable* the one guarantee those modes rest on. `parseDurationMs` now hard-fails `INVALID_ARGS` above 24h rather than silently clamping (a wrapper LLM should see the rejection). 24h is far above any legitimate budget (pursue defaults to 45m, swarm to 30m) yet finite, so the AbortController always fires. Tests cover the boundary (24h / 1440m / 86400s accepted; 25h / 1441m / 86401s / 999999h rejected).
- **Hardened the write-swarm escape smoke (Test B).** The out-of-root deny assertion depended on a subagent quoting the rescue denial verbatim through the `agent_swarm_result` aggregation — a paraphrase made it absent even when the safety invariant held (flaky). Split into a deterministic, model-phrasing-independent structure: the **hard** non-vacuous guard is now "the coordinator emitted an `AgentSwarm` tool call" (`"name":"AgentSwarm"` in the records — a structural fact, not prose), proving the no-escape-file result reflects DENIAL rather than a swarm that never launched; the deny-reason string is downgraded to a **soft** `console.warn` diagnostic. The PRIMARY safety invariant (not one escape file landed outside the trusted root) is unchanged.
- **CI smoke: local-first, deliberately no schedule.** Resolved the "wire the smoke to CI" thread by deciding *against* a recurring CI run. The real-binary smoke's natural cadence is "before release", best run **locally against your own kimi-code subscription** — no secret, no recurring token bill (`docs/ci.md` now makes the local path the documented primary route, and clarifies that any CI API key lives in GitHub's *encrypted secret store*, never in the repo — the YAML references only the secret name). `smoke.yml` stays manual-dispatch and inert-until-configured; its default `kimi_version` bumped `0.15.0 → 0.18.0` (so a manual run exercises the write-swarm smoke) and the job timeout `20 → 30` min (the two real write-swarm fan-outs).
- **Deferred with rationale (not code).** **H1** (runtime-side allowlist post-validation as defense-in-depth behind the hook) stays a dedicated future effort — it is an explicitly ~2-3 day architectural change, and it sits *behind* a primary gate that is now field-proven by the real-binary smokes; rushing a safety mechanism into a batch is worse than a clean deferral. **H5** (per-spawn thinking control) remains upstream-blocked — kimi-code exposes no `--thinking`/`--no-thinking` CLI flag (only a read-only `alwaysThinking` capability flag), so there is nothing to wire.
- **Docs:** README (six → seven subagents), AGENTS.md (Version line + the v1.4 "human-only" clause lifted), `docs/safety.md` (the write-swarm agent rationale: patch-only, less dangerous than pursue), `commands/swarm.md`, `docs/ci.md` (local-first + encrypted-secret clarification). `bun run check` green.

## 1.4.1 — 2026-06-20

**Critical write-path fix (caught by the new write-swarm real-binary smoke): the rescue allowlist read the wrong path field, so `Write`/`Edit` were denied on every real run.** `runtime/rescue-approval.ts::extractFilePath` read `toolInput.file_path` (the Anthropic/Claude Code convention), but **kimi-code's `Write` and `Edit` tools name the field `path`** (`packages/agent-core/src/tools/builtin/file/{write,edit}.ts`: `z.object({ path })`; there is no `MultiEdit` and `file_path` appears nowhere as a tool param). So for **every** write-capable command — `/kimi:rescue`, `/kimi:pursue`, and the new `/kimi:swarm --write` — a real `Write`/`Edit` was denied with "rescue cannot evaluate … input with no path field" (fail-CLOSED — safe, but the file-edit tools simply never worked against kimi-code; only allowlisted Bash could mutate, and most write-shaped shell is rejected too). This was invisible to the unit suite, which mocks `file_path` everywhere — it only surfaced once the **first real-binary write test** ran. Fix: `extractFilePath` now reads `path` (preferred) and falls back to `file_path` (forward/backward compat). With the fix, in-workspace `Write`/`Edit` are allowed and out-of-workspace ones denied — the allowlist finally behaves as designed.

- **New: real-binary write-swarm smoke** (`tests/runtime/real-binary-smoke.test.ts`, gated by `KIMI_PLUGIN_CC_SMOKE=1`). The first POSITIVE real-binary proof (every prior smoke only asserted denial): **Test A** runs the real `runSwarm --write` and asserts a `coder` subagent's edits LAND in the throwaway worktree (captured `.patch` contains the sentinel, AgentSwarm actually fanned out), the **user's real tree is byte-identical + git-clean**, and the worktree is cleaned up; **Test B** asserts a subagent's absolute-path write OUTSIDE the trusted root is hook-denied with the rescue out-of-workspace reason. Both **GREEN against kimi-code 0.18.0** (patch=334 bytes, user tree untouched, worktree cleaned). This is the field-proof the v1.4.0 entry flagged as outstanding; it immediately paid for itself by catching the path-field bug.
- **Tests:** `rescue-approval.test.ts` adds a regression test that the kimi-code `path` field is evaluated (in-workspace `path` → allow; out-of-workspace `path` → deny) and that a missing path field denies with "no path field"; the existing `file_path` tests still pass (fallback). `bun run check` green.
- **Process note:** the bug also exposed that the PreToolUse hook runs from compiled `dist/` (the installed managed-block command), so a `runtime/*.ts` fix is inert in a real run until `bun run build` recompiles `dist/` — the first re-run after the source fix still failed for this reason. Documented for future write-path debugging.

## 1.4.0 — 2026-06-20

**Write-capable swarm (`/kimi:swarm --write`): parallel code-editing in a throwaway worktree → reviewable patch.** Adds the first WRITE mode to swarm. Where read-only swarm fans `explore` subagents out for review, `--write` runs the coordinator and `coder` (write-capable) subagents inside an **ephemeral detached git worktree off the user's HEAD**, lets them edit disjoint targets there, captures the result as an applyable `.patch` artifact, and removes the worktree. **The user's real working tree is never touched, and the plugin never applies or commits — the main Claude thread owns the merge** (the load-bearing "main thread owns git" invariant). Design A (one worktree for the whole swarm) — kimi-code's `AgentSwarm` spawns subagents in-process sharing the coordinator's cwd (`subagent-host.ts:362`), so per-subagent worktrees are impossible without abandoning `AgentSwarm`; the single throwaway worktree IS the blast radius. Human-only (`disable-model-invocation: true`); there is no `kimi-swarm-write` agent yet.

This shipped after a **3-way adversarial spec review** (safety / kimi-contract / convention lenses). Two reviewer blockers were resolved by direct verification against the vendored kimi-code 0.18.0 source: (1) the hook-payload `cwd` for an in-process subagent equals the coordinator spawn cwd (one `HookEngine` per session, `cwd: kaos.getcwd()`, `session/index.ts:178`), and (2) **swarm subagents use the standard permission stack — no deny-all** (the lone `DenyAllPermissionPolicy.unshift` is inside `startBtw()`, the side-question path, NOT the swarm spawn path), so a `coder` subagent's writes actually land and are gated solely by our hook. (Fixed a stale `kimi-version-probe.ts` comment that had mis-cited swarm subagents as inheriting deny-all.)

- **New hook label `swarm-write`** (`runtime/hooks/approval-policy.ts`): allows `AgentSwarm` + the read-only set; routes write/edit/shell through the **rescue allowlist verbatim** — but scoped to a **forge-proof trusted worktree root** (`KIMI_PLUGIN_CC_WORKSPACE_ROOT`, exported by the same plugin spawn that sets `KIMI_PLUGIN_CC_CMD`), NOT the hook payload `cwd`. The model inside kimi cannot set an env var on its own process, so confinement does not depend on upstream payload-cwd semantics. **Fail-closed**: a missing trusted root denies all writes. git mutation and the singular `Agent` tool stay denied.
- **Worktree lifecycle** (`runtime/git.ts`): `createEphemeralWorktree` (off HEAD, under the plugin's own `worktreesDir` — never inside the user repo), `captureWorktreePatch` (`git add -N` intent-to-add + `git diff --binary`, **untruncated**, so new files are captured WITHOUT writing loose objects into the shared object DB — keeping "plugin never mutates git state" literally true), `removeWorktree` (force, with prune + on-disk fallback), `pruneWorktrees`, `hasBornHead`, `isWorkingTreeDirty`. Patch captured on **every** terminal path (success/cancel/budget/failure) BEFORE the worktree is removed; a startup sweep reaps orphans left by a hard kill.
- **Bounds & gates.** `--write` requires kimi-code **≥ 0.18.0** (the hard `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` cap — below it a write fan-out has no peak bound), a git repo with a committed HEAD (clean `WRITE_SWARM_NOT_A_REPO` / `WRITE_SWARM_NO_HEAD` refusals), and the PreToolUse hook (refuses without it). Default `--max-concurrency` is **1 for write** (serialize — disjoint-target partitioning is prompt-only) vs 4 for read. Bases on HEAD: a **loud warning** fires when the working tree is dirty (uncommitted work is not in the worktree). The coordinator prompt forbids git mutation and nested `AgentSwarm`.
- **Lineage:** reuses `command_type:"rescue"` (write-capable, like pursue), `agent_profile "<swarm-write>"`; `/kimi:status` / `/kimi:result` / `/kimi:cancel` work unchanged. The result report prepends a patch-handoff header pointing at the `.patch` file (`git apply <path>`).
- **Runtime:** `runtime/parsing.ts` (`--write` boolean), `runtime/commands/swarm.ts` (`runWriteSwarm`, `executeSwarmJob` gains a `writeMode` seam threading the worktree spawn cwd + trusted root, `SWARM_WRITE_DEFAULT_MAX_CONCURRENCY` = 1, capture/cleanup/sweep), `runtime/cli-client.ts` (`swarmWriteWorkspaceRoot` → env), `runtime/paths.ts` (`worktreesDir`), `runtime/types.ts` (`swarm-write` log label).
- **Tests:** `swarm.test.ts` (`--write` parse + composition, write concurrency default = 1, write prompt), `approval-policy.test.ts` (swarm-write allows AgentSwarm/read, confines to the TRUSTED env root not payload cwd, fail-closes on a missing root, forwards deny, denies `Agent`), new `git-worktree.test.ts` (real-repo create → edit → capture-an-applyable-patch incl. new files → remove, main tree untouched). `bun run check` green. A gated real-binary write-swarm smoke (write-lands-in-worktree-only, user-tree-unchanged) is the remaining field-proof before any concurrency raise or write agent.

## 1.3.0 — 2026-06-20

**Model-invocable `kimi-swarm` + `kimi-pursue` agents (every command now mirrors to an agent) + enforced swarm concurrency default.** Adds the two remaining Claude Code subagents — `kimi-swarm` (read-only parallel review fan-out) and `kimi-pursue` (experimental autonomous goal mode) — so the main Claude thread can dispatch them autonomously, not only via the human-typed `/kimi:swarm` / `/kimi:pursue` slash commands. This completes the command↔agent mirror that review/challenge/ask/rescue already had (all commands carry `disable-model-invocation: true`; agents are the model-invocable path). **Auto-dispatch widens no safety surface:** the index-0 PreToolUse hook fires on every tool call of every turn for all agents — read-only labels (review/challenge/ask/swarm) deny writes; rescue/pursue apply the workspace allowlist and cannot mutate git state — and the two heavy modes keep their mandatory hard ceilings (swarm `--budget` + default `--max-concurrency`; pursue `--budget`) whoever launches them.

- **New: `agents/kimi-swarm.md`** (read-only, `color: green`; auto-discovered, no `plugin.json` change). Its description requires an explicit user breadth-with-parallelism intent plus an anti-trigger ("do not auto-promote a single, unscoped, or diff-shaped review into a per-file swarm — use kimi-review"), so Claude does not over-eagerly fan out. Foreground by default; refuses without the `/kimi:setup` hook.
- **New: `agents/kimi-pursue.md`** (write-capable autonomous, `color: red` — the highest-caution surface). Reuses the rescue trust boundary (workspace allowlist + index-0 hook on every continuation turn; no git mutation), bounded by the mandatory `--budget` (default 45m). Its description requires an explicit hands-off-autonomy request and steers single bounded tasks to `kimi-rescue`, so Claude never auto-promotes a fix or a question into a goal loop. Foreground-only, no `--resume` (goalId ≠ sessionId); refuses without the hook.
- **Enforced concurrency default (the real safety change).** Because the fan-out is now auto-dispatchable, an unbounded peak is no longer acceptable. `runtime/commands/swarm.ts` resolves `--max-concurrency` to a default of **4** (`resolveSwarmMaxConcurrency` → `SWARM_DEFAULT_MAX_CONCURRENCY`) when the user passes none, so `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` is **always** exported and every swarm run — agent-dispatched or human-typed — is peak-bounded by construction on kimi-code 0.18.0+ (older binaries still ignore the env var; the `--budget` wall-clock ceiling remains the always-on hard bound on total cost). Override with an explicit `--max-concurrency N`. This changes the prior behavior, where an unset value fell back to kimi-code's internal concurrency ramp. pursue needs no analogous change — its `--budget` ceiling is already mandatory and defaulted.
- **Adversarial review drove the hardening.** Each agent went through the same 4-lens review (contract fidelity / convention / auto-invocation safety / doc accuracy). For swarm it confirmed the zero-write-surface claim is load-bearing-correct and surfaced the cost/runaway gap — which produced the concurrency default, the tightened triggering, and restricting the background-detach hint to explicit user requests. pursue was reviewed against the same lenses with the focus on whether a model-invocable write-capable autonomous agent is acceptable given the rescue-allowlist + per-turn-hook + mandatory-budget bounds.
- **Runtime:** `runtime/commands/swarm.ts` adds `SWARM_DEFAULT_MAX_CONCURRENCY` + `resolveSwarmMaxConcurrency` (applied at the spawn call site; `executeSwarmJob` now takes a non-optional `maxConcurrency`); `runtime/parsing.ts` documents that swarm.ts owns the default. No runtime change for pursue — the addition is the agent file + docs only.
- **Tests:** `swarm.test.ts` asserts the default is applied when `--max-concurrency` is unset and that an explicit value overrides it. `bun run check` green.
- **Docs:** README (four → six subagents), AGENTS.md, `docs/safety.md`, and `commands/swarm.md` document both new agents, the uniform command↔agent safety model (auto-dispatch widens no write surface and removes no cost/autonomy bound), and the swarm concurrency default.

## 1.2.7 — 2026-06-19

**`/kimi:swarm`: split `--cap` into a soft total-count hint + a hard `--max-concurrency` ceiling.** A fast-follow surface correction to v1.2.6, which had overloaded a single `--cap N` to mean *both* a soft prompt-injected total-subagent-count hint *and* a hard concurrency ceiling (`KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY`). A `/kimi:ask` shape consult flagged the **"cap-as-total-count illusion"**: a user reading `--cap 5` (and the injected prompt's "≤5 subagents") reasonably expects a *total*-cost bound, but the env var only caps *peak concurrency* — a coordinator can still launch many subagents sequentially. Overloading one value onto two different risk levers (lifetime total vs. simultaneous spend) hid the real semantics.

- **`--cap N`** is now purely the SOFT total-subagent-count hint injected into `buildSwarmPrompt` (advisory; the hook is stateless and can't count subagents). It no longer touches any env var.
- **`--max-concurrency N`** (new) is the HARD ceiling on how many subagents run *at once*, exported as `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` on kimi-code **0.18.0+** (older binaries ignore the unknown env var). The two flags are independent: `--cap 20 --max-concurrency 4` means "aim for ≤20 total, never more than 4 running simultaneously".
- The always-on hard bound on the whole run remains the `--budget` wall-clock ceiling (default 30m). Concurrency ≠ total count, so `--budget` stays the real bound on total cost; `--max-concurrency` bounds peak parallelism.
- **Runtime:** `runtime/parsing.ts` adds `SwarmArgs.maxConcurrency` + a `--max-concurrency` case (sharing a `parsePositiveIntFlag` helper with `--cap`, so both apply the same `Number.isInteger && > 0` predicate upstream's `resolveSwarmMaxConcurrency` requires); `runtime/commands/swarm.ts` threads `--max-concurrency` (not `--cap`) into `CliClientOptions.swarmMaxConcurrency`. No compat change, no new write/permission surface — `--max-concurrency` only sets a concurrency-bounding env var; the `swarm` hook label and read-only allowlist are untouched.
- **Tests:** `swarm.test.ts` asserts the split — `--cap` does NOT set `maxConcurrency`, `--max-concurrency` is validated as a positive integer, and the two are independently parseable. `bun run check` green.

## 1.2.6 — 2026-06-19

**kimi-code 0.18.0 compatibility + `/kimi:swarm` hard concurrency cap.** Extends `KIMI_TESTED_MINORS` to `{0,17}` and `{0,18}` (the 0.16.0→0.18.0 jump — 0.17.0/0.17.1/0.18.0 — another out-of-band auto-upgrade past the tested 0.16 max, re-firing the H9 "newer than tested max" warning), and wires kimi-code 0.18.0's new `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` env var (PR #888) into `/kimi:swarm`.

- **Compat (COMPAT-PRESERVED, source-audit-reproduced).** `03-hooks.diff` is **0-byte** (both `agent/hooks/` and `session/hooks/`) and `pre-tool-call-hook.ts` is 0-byte 0.16.0→0.18.0; `PreToolCallHookPermissionPolicy` is **still index 0**, `AgentSwarmExclusiveDenyPermissionPolicy` index 1, `AutoModeApprovePermissionPolicy` index 5 (first approve). The only permission change is a NEW `GoalStartReviewAskPermissionPolicy` (#839, "guided goal authoring") at index ~10, *after* auto-mode-approve — an `ask` gated to a *model-issued* `CreateGoal` in NON-auto mode that returns early when `permission.mode === 'auto'`, so it is triple-dead on the `-p` auto path and (an `ask`) cannot approve a write; it does not affect `/kimi:pursue` (which uses the `/goal` command path under auto, hook-gated every turn). `options.ts` is **byte-identical** (argv intact); `run-prompt.ts` changes only in a telemetry refactor (the `started` event moved into harness `sessionStartedProperties`), with the permission-forcing chain and the stream-json writer (`PromptJsonWriter`/`resume_hint`/`goal.summary`) unchanged.
- **Off-path additions.** A new `kimi server`/`kimi web` subcommand stack **and** session ARCHIVE (`archived` flag + `archive()`/`includeArchive` in the session store + rpc core-api), both from PR #625 "Kimi web app + daemon gateway" — the **Kimi web** surface. The plugin owns its own SQLite job store, never invokes `kimi server`, and never reads kimi's session list, so this is off the `-p` path. Also: OAuth-error fidelity (provider-manager throws the original error instead of re-wrapping as `loginRequired`), git-context process disposal, a turn-counter restore fix (record-restore path) — all internal.
- **`/kimi:swarm` `--cap` is now a HARD concurrency ceiling on 0.18.0+.** `--cap N` was a soft prompt-injected subagent-count hint (the hook is stateless and can't count subagents). On kimi-code 0.18.0+, `swarm.ts` now also exports `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY=N` per-spawn (via `CliClientOptions.swarmMaxConcurrency` → `cli-client.ts::buildEnv`), so kimi-code's `SubagentBatch` runs at most N subagents concurrently. Older binaries ignore the unknown env var (the soft hint stays the only count bound there); the `--budget` wall-clock ceiling remains the always-on hard bound. Concurrency ≠ total count, so the cap bounds *peak* parallelism, not lifetime total.
- **Smoke (GREEN, against installed 0.18.0).** The 0.16.0→0.18.0 audit was *prepared* in a cloud session with no kimi binary, so its Phase 1b smoke was deferred to a pre-merge gate. It was then run locally against the operator's installed **0.18.0** binary before merge: **7 pass / 0 fail** — review/challenge/ask/review_gate forced writes hook-denied; pursue's multi-turn goal wrote **zero files** (`goal.summary` parsed cleanly, `turnsUsed:2`); a spawned swarm subagent's forced write hook-denied. A six-reviewer + independent adversarial re-verification of the 0.16.0→0.18.0 jump **and** the new `--cap` wiring (the one surface report 81's smoke didn't cover) all returned **CONFIRMED-SAFE** — the `--cap` → env value round-trips safely across 19 edge inputs against upstream's identical positive-integer validator, with zero new write surface. Tag `compat-verified-kimi-code-0.18.0`.

- **Runtime:** `runtime/kimi-version-probe.ts` adds `{0,17}` + `{0,18}`; `runtime/cli-client.ts` adds the `swarmMaxConcurrency` option (env-overlaid in `buildEnv`, recorded in the spawn diagnostics log); `runtime/commands/swarm.ts` threads `--cap` through `executeSwarmJob`; `runtime/parsing.ts` documents the two-tier `--cap`.
- **Tests:** `cli-client.test.ts` asserts `swarmMaxConcurrency` reaches the child as `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` (and stays unset when omitted), via a new `KIMI_MOCK_ECHO_ENV` capability in the stream mock.
- **Docs:** slimmed the AGENTS.md "Version" + "Upstream compat" lines to a lean current-state summary, relocating the per-version audit narrative here and to `ROADMAP-TO-GA.md` (the detailed per-version reasoning also lives in `runtime/kimi-version-probe.ts` comments).

## 1.2.5 — 2026-06-17

**kimi-code 0.16.0 compatibility.** Extends `KIMI_TESTED_MINORS` to `{0,16}`. The operator's binary auto-upgraded 0.15.0→0.16.0 within a day, re-firing the H9 "newer than tested max" warning. COMPAT-PRESERVED: `permission/`, the hook engine, and `run-prompt.ts` are **0-byte** vs 0.15.0; the only CLI argv change registers a new `kimi vis` subcommand (a visualization server — off the `-p` path; our flags are untouched), and the `records/`/`session/`/`replay/`/`agent/` churn (a compaction refactor, a new `llm-request-logger`, replay-build additions) is internal, off the `-p` stdout stream. Backed by a GREEN `bun run smoke:real` on the 0.16.0 binary (7 pass / 0 fail; read-only labels hook-denied, pursue wrote zero files, swarm subagent write denied). Tag `compat-verified-kimi-code-0.16.0`.

- **Runtime:** `runtime/kimi-version-probe.ts` adds `{ major: 0, minor: 16 }`.

## 1.2.4 — 2026-06-16

**kimi-code 0.15.0 compatibility.** Extends `KIMI_TESTED_MINORS` to `{0,15}` so the `/kimi:setup` version probe stops firing the H9 "newer than tested max" warning for operators whose kimi binary auto-upgraded to 0.15.0. COMPAT-PRESERVED: the four scoped diffs (0.14.3→0.15.0) leave the permission queue, hook engine, `run-prompt.ts`, and CLI argv **0-byte** (re-confirmed independently by `git diff` byte-count, not just the routine's report); the only scoped change is `records/`+`session/` persistence churn off the `-p` path (PR #786 drops `app_version`/`resumed` from the `.records/` metadata artifact, a `SessionSkillRegistry` rename, a static model-capability lookup) plus an additive `transport:'sse'` MCP config variant the plugin never writes. Backed by a GREEN `bun run smoke:real` on the 0.15.0 binary (7 pass / 0 fail; read-only commands hook-denied, pursue wrote zero files, swarm subagent write denied). A real patch bump (not docs-only) because extending the tested-minors array is a runtime change. Tag `compat-verified-kimi-code-0.15.0`.

- **Runtime:** `runtime/kimi-version-probe.ts` adds `{ major: 0, minor: 15 }`.
- **Docs currency pass:** revived this changelog (pointer banner above); corrected a stale `auto-mode-approve at index 4`→`5` parenthetical in `docs/safety.md` (drifted since kimi-code 0.14.1 inserted a policy at index 1); refreshed `CONTRIBUTING.md` (dead `tests/wire/` live-test reference → `bun run smoke:real`), the `smoke.yml` / `docs/ci.md` example kimi-code pin (0.9.0 → 0.15.0), and the `docs/upstream-compat-audit.md` playbook (hook diff-scope now names the load-bearing `session/hooks/`).

## Post-1.0 releases (summary — full detail in [ROADMAP-TO-GA.md](./ROADMAP-TO-GA.md#post-ga-audit-log))

- **1.2.3** — 2026-06-12 — verified kimi-code 0.12.0→0.14.1 compat (4-reviewer audit + adversarial pass + GREEN smoke); extended `KIMI_TESTED_MINORS`.
- **1.2.2** — 2026-06-09 — H3 closed: an unknown stream-json top-level role is forward-compat (surfaced out-of-band on `StreamJsonOutcome.unknownRecord`, no longer `malformed`).
- **1.2.1** — 2026-06-09 — hardening: H4 (actionable hook-drift diagnosis), H8 (installed kimi-code plugin notice at setup), H9 (out-of-range version warning flags "newer than tested max").
- **1.2.0** — 2026-06-09 — read-only `/kimi:swarm` parallel-review fan-out, built on kimi-code 0.12.0's `AgentSwarm` tool.
- **1.1.1** — 2026-06-09 — verified kimi-code 0.12.0 compat; corrected stale "double-gated goal mode" docs (0.12.0 removed the experimental-flag gate).
- **1.1.0** — 2026-06-03 — experimental `/kimi:pursue` autonomous goal mode + `goal.summary` stream-json parser.
- **1.0.5** — 2026-06-03 — verified kimi-code 0.7/0.8/0.9 compat.
- **1.0.4** — 2026-05-31 — verified kimi-code 0.6.0 compat.
- **1.0.3** — 2026-05-29 — **rescue allowlist flag hardening (critical RCE fix)** — exec-delegating / report-writer flags rejected.
- **1.0.2** — 2026-05-29 — kimi-code 0.5.0 compat.
- **1.0.1** — 2026-05-27 — extended `KIMI_TESTED_MINORS` to 0.3 + 0.4.

## 1.0.0 — 2026-05-26 (GA)

> **GA release.** Closes the kimi-code 0.2.0 stream-json session-meta compat gap discovered in alpha.4 production smoke, plus the alpha.4 Round-4 closeout polish items (parser `=value` rejection, safety.md template), plus H6 (kimi-code version probe) per the post-hotfix Codex audit, plus two review-smoke catches (stderr regex tightening, missing challenge test). Two parallel deep audits (Claude opus + Codex via codex-rescue) over the kimi-code 0.1.1→0.2.0 source diff converge: session-id capture is the only break that affects our plugin invariants; hook contract, exit-code semantics, cancellation behavior, config schema, and output framing are all byte-identical between kimi-code 0.1.1 and 0.2.0. Live review-smoke against kimi 0.2.0 (8m 37s) returns clean. **391 tests pass, drift gate clean.**

### Critical fix — kimi-code 0.2.0 compatibility

- **Session id capture now reads `role:"meta", type:"session.resume_hint"` from stdout stream-json** (the new transport kimi-code 0.2.0 introduced in [PR #47](https://github.com/MoonshotAI/kimi-code/pull/47)). In kimi 0.2.0 the resume hint moved off stderr — kimi-plugin-cc alpha.4 captured nothing under the new version, so `kimi_session_id` was `null` on every job. Resume/replay broken across the board. The loud `warnIfSessionIdMissing` stderr surface added in alpha.4 G3 caught this in production smoke before the GA tag — exactly the failure mode it was designed to catch.
- **Session id format widened.** kimi-code 0.2.0 emits `session_<uuid>` instead of bare `<uuid>`. The cli-client stores the token verbatim and round-trips it via `kimi -r <token>` — we treat it as opaque. The stderr-fallback regex accepts both formats so 0.1.x users on text-output mode keep working alongside 0.2.0+ users on stream-json.
- **Stream-json parser learned `role:"meta"`.** Previously meta records were rejected as "unknown role" malformed. Now `meta.session.resume_hint` produces a structured `SessionResumeHintRecord`; unknown meta types still surface to the malformed channel (forward-compat for 0.3.x — we won't crash on new meta types, just log them for diagnostics).
- **Meta record filtered from consumer-facing `records[]`.** Commands iterating `result.records` only see assistant/tool roles. The `onRecord` streaming callback also skips meta — wrappers wiring up live UI updates never see plumbing records.

### Review-smoke catches (kimi 0.2.0 review against the GA candidate)

- **Stderr fallback regex tightened to anchored full-UUID.** Initial widening to accept `session_<uuid>` used the loose pattern `session_[0-9a-f-]{8,}`, which would have accepted `session_--------` (8 dashes) or any 8+ char hex-dash token. The "anchored full-UUID regex" safety invariant documented in `AGENTS.md` is preserved by requiring both alternations to match a full UUID payload — `session_<uuid>` and bare `<uuid>` are now symmetric. Tests cover five malformed forms (too short, wrong length, missing dashes, non-hex chars) explicitly.
- **`parseChallengeArgs` `=value` rejection test added.** The `parseKnownFlags` shared helper makes the code correct transitively, but the test gap meant a future refactor could regress the challenge path undetected. All four forms (bare/assignment × thinking/no-thinking) now have explicit assertions under the `"challenge"` command label.

### H6 — kimi-code version probe (Codex post-hotfix audit Area 8, addressed pre-GA)

- **New `runtime/kimi-version-probe.ts`.** Spawns `kimi --version`, parses output, compares against a `KIMI_TESTED_MINORS` allow-list of `{major, minor}` pairs (currently `0.1.x`, `0.2.x`). Soft-fails — if the probe itself fails (kimi missing, spawn error, unparseable output), we record nothing because the hook probe will surface a clearer error. Only loud-warns when the version is **demonstrably** out of range.
- **Wired into `/kimi:setup` (install + check paths).** The warning shows up in setup's warnings array and surfaces on stdout for users. `KIMI_PLUGIN_CC_SKIP_VERSION_PROBE=1` opts out (useful for CI environments without kimi).
- **Why this matters.** kimi-code 0.2.0 is wire protocol `1.1`; a future 0.3.0 could replay older sessions with an invisible warning and produce flattened output we never capture (per Codex audit reading of `cf2227e` / `2004aed`). The version probe gives users early signal before a silent breakage bites them. Belt-and-suspenders with the alpha.4 `warnIfSessionIdMissing` (which fires *after* a job demonstrates capture failure) — H6 fires *before* any job, on the theory that "you're running an untested kimi" is worth knowing.
- Tests: parser cases (bare semver, `v` prefix, pre-release, garbage), tested-range membership, formatted warning content, probe behavior under missing-binary / timeout / non-zero-exit paths.

### Parser closeout (Codex Round 4)

- **`--thinking=value` / `--no-thinking=value` now produce the canonical removal message.** Previously the assignment form fell through to the generic "Unknown flag" path because the case statements only matched exact tokens. A wrapper agent reading the generic error would have thought the fix is to drop the `=value` rather than the flag itself. New `isRemovedThinkingFlag(token)` helper unifies the exact + assignment forms across all three parsers (ask, rescue, review/challenge).

### Docs

- **`docs/safety.md` managed-block template** now uses `vX.Y.Z` placeholder (no more drifting alpha.X strings) and shows the shell-quoted command shape that `runtime/hooks/install-paths.ts::buildHookShellCommand` actually writes, plus a footnote explaining the round-trip.
- **`AGENTS.md` invariant 1** rewritten for dual-source session capture (stdout meta record for 0.2.0+, stderr fallback for 0.1.x). Captured token semantics — verbatim round-trip — now explicit.
- **`README.md` Architecture** updated to reflect the stdout meta-record transport.
- **`ROADMAP-TO-GA.md`** adds H6 (wire-protocol version guard) per Codex post-hotfix audit finding Area 8: kimi-code 0.2.0 is wire protocol `1.1`; future minors may silently replay older sessions without surfacing warnings. Launch-time version-floor probe deferred to v1.0.x or v1.1.

### Tests

- `tests/runtime/stream-json.test.ts` — 3 new tests: parse `meta.session.resume_hint`, reject malformed meta with missing session_id, forward-compat reject unknown meta types as malformed (not crash). Stderr regex test extended to cover `session_<uuid>` form.
- `tests/runtime/cli-client.test.ts` — 3 new integration tests: stdout-only meta capture, both-channels first-announce-wins, onRecord callback skips meta.
- `tests/runtime/parsing.test.ts` — 3 new tests for `=value` form rejection across all three parsers.
- `tests/helpers/mock-kimi-stream.ts` — new `KIMI_MOCK_ANNOUNCE_VIA` env var (`stderr` | `stdout-meta` | `both`) so tests can exercise both 0.1.x and 0.2.0+ resume-hint transports without authoring separate fixtures.

**391 tests pass, drift gate clean.**

### Roadmap closures incidental to GA

- **H2 (session-id stderr format coupling) — closed by upstream + alpha.5 hotfix.** H2 prescribed a machine-readable session record in stream-json. kimi-code 0.2.0 shipped exactly this (`role:"meta", type:"session.resume_hint"`); the alpha.5 hotfix consumes it. The stderr regex remains as a 0.1.x fallback.
- **H3 (stream-json parser coupling to kimi-code internals) — partially closed.** The forward-compat behavior for unknown meta types (surface to malformed channel, never crash) is now in place. The hard-coded `apps/kimi-code/src/cli/run-prompt.ts:NNN` line references in the parser's doc comments have been replaced with file-only references — drift across kimi-code versions no longer points at stale line numbers. The remaining H3 work (treating unknown top-level roles as forward-compat instead of malformed) deferred to v1.1 — the current "malformed" treatment is conservative-safe and changing it requires a deeper review of consumer assumptions.
- **H6 (wire-protocol version guard) — closed.** See above section.

### Verified against real kimi 0.2.0

Production smoke (working-tree companion against the user's installed kimi 0.2.0):

- `/kimi:ask` happy-path → returns prose AND captures `kimi_session_id: "session_<uuid>"` from the stdout meta record.
- `/kimi:review main "spot any GA blockers"` → completed in **8m 37s** thinking-on (well under the 1800s budget); session id captured; review itself caught two real issues in this candidate (the loose stderr regex and the missing challenge test, both fixed in this commit).
- `warnIfSessionIdMissing` does NOT fire on successful jobs (no false-positive).
- `/kimi:cancel` reaps the descendant tree cleanly (alpha.3 invariant preserved).
- `/kimi:setup --check` strict-equality verifier catches stale hook paths from prior alpha versions (caught in this smoke — alpha.4 install was pointing at alpha.3's hook script). Re-install clean. New version probe surfaces no warning since kimi 0.2.0 is in `KIMI_TESTED_MINORS`.
- Parser hard-rejection of `--no-thinking foo` and `--no-thinking=true` both surface the canonical removal message.

### Acknowledgments

The kimi-code 0.2.0 compat break was found by the alpha.4 production smoke test loop. Two parallel audit agents (Claude opus + Codex via codex-rescue) ran independent change-surface audits against the kimi-code 0.1.1 → 0.2.0 diff and converged: the session-meta gap is the only break in the plugin's invariants. Codex additionally surfaced the wire-protocol-1.1 forward-compat risk now closed by H6. The kimi-driven review-smoke against the GA candidate caught two final issues (the stderr regex over-widening and the missing challenge-path test). Three layers of independent review (kimi, Claude opus, Codex), each catching things the others missed.

## 1.0.0-alpha.4 — 2026-05-26

> **Roadmap update**: alpha.4 closes G1 + G3 + L2. G2 deferred to v1.1 as H4 (Node version manager soft-recovery). New H5 added (per-spawn thinking control via kimi-code CLI, pending upstream). See [ROADMAP-TO-GA.md](./ROADMAP-TO-GA.md).

### User directive

Thinking is enabled for all user-facing commands (ask, review, challenge, rescue). Previous diagnosis — that review hung at the 10-minute default budget — was a budget-sizing problem, not a flag problem.

### Changed

- **Budget constants raised for the thinking-on workflow.** `KIMI_ASK_PROMPT_TIMEOUT_MS` 300s → 900s; `KIMI_REVIEW_PROMPT_TIMEOUT_MS` 600s → 1800s; new `KIMI_RESCUE_PROMPT_TIMEOUT_MS = 1800s` (rescue no longer shares the ask budget — it runs multi-step apply/test/verify loops under thinking-on and needs the full headroom). `KIMI_REVIEW_GATE_TIMEOUT_MS` unchanged at 8s; comment now honest about what it assumes (user has `default_thinking = false` or a non-thinking-capable model selected, since kimi-code 0.1.1 has no per-spawn CLI thinking control).
- **`--thinking` / `--no-thinking` removed from every user-facing surface.** Stripped from `commands/{ask,challenge,review,rescue}.md` (argument-hint + flag bullets), from `agents/{kimi-review,kimi-challenge}.md` strict allowlists, from `runtime/parsing.ts` `SUPPORTED_FLAGS` strings and error templates, and from `runtime/kimi-errors.ts` nextStep hints. The parser now **hard-rejects** both flags with `INVALID_ARGS` (`THINKING_FLAG_REMOVED_MESSAGE`) — no escape hatch. Multi-agent Round 1-3 review surfaced and closed five contradicting references across docs, agents, and source.
- **`RESPONSE_TIMEOUT` nextStep hint qualified for review/challenge.** Previous hint suggested `--background` as a universal retry; review and challenge explicitly reject `--background`. Hint now qualifies it as ask/rescue-only.
- **Hook-missing warning surfaces the nvm/asdf remediation explicitly.** Users who switch Node versions hit a strict-equality verifier rejection by design. The warning now points at re-running `/kimi:setup` after every Node version switch and links to `docs/safety.md`.

### Added

- **`warnIfSessionIdMissing` helper in `runtime/commands/cli-helpers.ts`.** When kimi finishes a job but never announces a session id, a loud stderr warning fires so the user learns resume/replay won't work for that job. Wired into review/challenge/ask/rescue end-of-job paths. Full unit coverage in `tests/runtime/cli-helpers.test.ts`.
- **`CliClientOptions.thinking` (reserved field, currently no-op).** Round 2 Codex review caught that emitting `--no-thinking` in argv crashes kimi-code 0.1.1 (`allowUnknownOption(false)`). The field stays as an intent contract — review-gate sets `thinking: false` to declare its requirement — and `buildArgs` will translate when upstream lands a per-spawn CLI flag (see ROADMAP H5).
- **Negative test assertions to lock the v1.0 thinking-on contract.** ask, rescue, and review-gate argv assertions now verify `--no-thinking` is NOT emitted; parseRescueArgs has a dedicated rejection test alongside parseAskArgs and parseReviewArgs.

### Fixed

- **Empty-string sessionId no longer poisons the SQLite row.** All four sessionId-capturing commands (review/challenge, ask, rescue, review-gate) tightened from `result.sessionId !== undefined` to `result.sessionId.length > 0`. Kimi Round 1 finding #3.
- **Orphan JSDoc above `warnIfSessionIdMissing` moved back above `assertCliResultSuccess` where it belongs.** Both kimi-review and code-reviewer flagged this in Round 1.
- **Redundant `RESCUE_PROMPT_TIMEOUT_MS` local alias dropped.** rescue.ts now imports `KIMI_RESCUE_PROMPT_TIMEOUT_MS` directly.

### Process

- Multi-agent review across 3 rounds: kimi-review + code-reviewer (Claude opus) + kimi-challenge + codex-rescue. Round 2 surfaced 1 Critical (kimi-code rejects `--no-thinking`) and 2 High (agent files still advertised removed flags). Round 3 found 4 release-blockers (version bump, AGENTS gate text, missing warnIfSessionIdMissing tests, missing alpha.4 CHANGELOG entry) — all addressed in this tag.

### Documentation

- `ROADMAP-TO-GA.md` reflects alpha.4 reality: G1+G3+L2 closed, G2→H4, new H5 (kimi-code upstream thinking-flag negotiation). Ship-gate updated.
- `docs/safety.md` "Known limitation: Node version manager switches" section added.
- `AGENTS.md` GA gate sentence updated.

---

## 1.0.0-alpha.3 — 2026-05-25

> **Roadmap to GA:** see [ROADMAP-TO-GA.md](./ROADMAP-TO-GA.md). The deferred items from the three audit rounds + production smoke testing are triaged into GA blockers (4), high-priority post-GA (3), and polish backlog (3). GA gate ≈ 1 working day of focused work.

### Fixed

- **Cancellation: grandchild orphan (CRITICAL, production-observed).** kimi-code 0.1.1's internal `LocalKaos` spawns every Bash tool subprocess with `detached: true` deliberately — so kimi-code can group-kill its own tools during cancellation. This gives bash subprocesses their own PGID (sibling to kimi-code's PGID, not nested). The alpha.2 process-group fix (`process.kill(-kimi_pid, ...)`) therefore only killed kimi-code itself; the bash grandchildren survived as orphans. Reproduced in production smoke testing — `/kimi:cancel` left `bun test` running indefinitely after the cancel completed.

  **Fix:** On POSIX, enumerate the descendant tree once at abort time (BFS over `/proc/*/status` on Linux, `ps -axo pid=,ppid=` snapshot on macOS, `pgrep -P` recursive as fallback; depth bounded at 8, pid count bounded at 512). The snapshot is reused for both SIGTERM and the SIGKILL escalation 1500ms later — re-enumerating at SIGKILL would miss any grandchildren whose parent (kimi) died from SIGTERM and reparented them to launchd, since the PPID-walk roots at kimi-code's now-dead pid. After per-pid kill, each descendant ALSO gets a negative-pid (process-group) kill as defense-in-depth, because each bash subprocess is itself a session leader and may have its own children that our enumeration missed (e.g. just-spawned pipeline kids). Win32 is unchanged — descendant reaping on Windows is a known limitation, documented in `runtime/cli-client.ts`.

  **Regression coverage:** New `tests/helpers/process-group-grandchild.ts` spawns its sleep grandchild with `{ detached: true }` to mirror kimi-code's actual production shape. New test in `tests/runtime/cli-client.test.ts` parses the grandchild PID via stdout, aborts the parent, waits for the SIGKILL escalation window, then asserts ESRCH on the grandchild. Confirmed to fail on the alpha.2 process-group-only path. Replaced an older sh-based test that could pass via shell SIGHUP cleanup semantics rather than actual descendant signaling.

  **Why this is a real safety regression rather than UX polish:** under `/kimi:rescue` an approved long-running tool (e.g. `bun test`, `cargo check`) kept consuming model tokens, file descriptors, and CPU after the user thought the job was cancelled. For build/test commands the workspace impact is bounded by the rescue allowlist's read-only-shape constraints, but the denial-of-cancellation is unacceptable for a write-capable surface. Surfaced by `/kimi:challenge` Finding 4 during smoke testing (challenge mode literally predicted this exact gap) and confirmed empirically.

### Investigation notes

- kimi-code 0.1.1's `detached: true` is a deliberate design choice in its `LocalKaos.exec` abstraction, paired with kimi-code-side `process.kill(-pid, ...)` cancellation. The behavior is structural and unlikely to change in the 0.1.x line. There is no env var or flag to disable it (confirmed by binary-strings inspection and source-level grep of the bundled Node binary at `~/.kimi-code/bin/kimi`).
- Production smoke testing observed a three-level PGID chain: plugin (own PGID from our `detached: true`) → kimi-code (own PGID from kimi-code's spawn shape) → bash (own PGID from kimi-code's `LocalKaos.exec`). All three are siblings, not nested. This is the shape the alpha.3 fix now handles.



## 1.0.0-alpha.2 — 2026-05-25

### Highlights

Same alpha.1 functionality; the rollback of the marketplace/plugin rename is the only meaningful change. v0.4 installs can now update in place to v1 (`/plugin update kimi`), so long as kimi-code is installed locally first.

### Reverted

- **Marketplace and plugin rename.** alpha.1 shipped with the IDs renamed to `kimi-marketplace-v1` / `kimi-v1` as a defensive measure against v0.4 users auto-upgrading into a kimi-code dependency they didn't have. For a plugin at this scale the friction of forcing a fresh marketplace registration + reinstall is more cost than the auto-upgrade risk is worth, so alpha.2 restores the original `kimi-marketplace` / `kimi` ids. The kimi-code prerequisite is now communicated through README + migration docs rather than the install path itself.

### Migration from alpha.1

If you installed `kimi-v1@kimi-marketplace-v1` during the brief alpha.1 window:

```
/plugin uninstall kimi-v1
/plugin marketplace remove kimi-marketplace-v1
/plugin marketplace update linxule          # or: marketplace add linxule/kimi-plugin-cc
/plugin install kimi@kimi-marketplace
```

Then reload Claude Code and re-run `/kimi:setup` (the managed block is keyed by version marker — alpha.1 markers will be detected as stale and refreshed).

## 1.0.0-alpha.1 — 2026-05-25

### Highlights

Hard cut from the Python Kimi CLI Wire transport to the kimi-code Node.js subprocess transport. v0.4.x stays available at the [`v0.4.0`](https://github.com/linxule/kimi-plugin-cc/releases/tag/v0.4.0) tag (with a `v0.4-maintenance` branch cut from that tag for ongoing fixes — see the tag if the branch is not yet pushed). alpha.1 briefly renamed the marketplace and plugin ids to `kimi-marketplace-v1` / `kimi-v1`; alpha.2 reverted that. Read the alpha.2 entry above for the upgrade path.

The alpha shipped after **two multi-agent audit rounds**: a comprehensive cross-PR pass over the five-commit cutover and a focused re-review of the audit-fix diff. Convergent findings from Claude code-reviewer + Codex closed before tag — exact-command hook verification, abort-race recovery, 0o600 config-mode preservation, an `--output=*` rescue-allowlist gap, and a TOML-decode false-fail for apostrophe-in-path installs. See [docs/safety.md](./docs/safety.md) for the hardened safety story.

See [docs/migration.md](./docs/migration.md) for the step-by-step upgrade.

### Architecture changes

- **Transport.** Spawns `kimi --output-format stream-json -p "<prompt>"` as a one-process-per-job subprocess; parses OpenAI-shaped NDJSON records (assistant content + tool_calls). Replaces the v0.4 Wire JSON-RPC client. (PRs 1–3)
- **Safety enforcement.** kimi-code's `kimi -p` mode hard-codes `permission: auto`. v1.0 enforces the read-only contract for review/challenge/review_gate/ask, and the workspace-bound rescue allowlist, via a PreToolUse hook installed in `~/.kimi-code/config.toml`. `/kimi:rescue` REFUSES to run when the hook is missing.
- **Setup.** `/kimi:setup` rewrites the kimi-code config with a marker-delimited managed block (idempotent), runs a two-layer probe (in-process Node + `/bin/sh -c` shape that mirrors kimi-code's hook runner), and reports failure with actionable detail. `--check` and `--uninstall` subcommands added.
- **Session id semantics.** kimi-code mints the session id and announces it on stderr; the runtime captures it via regex. Resume passes the captured id via `-r <id>`. The `(repo_id, command_type, kimi_session_id)` SQLite unique index still guards concurrent resumes; concurrent fresh runs are now distinct (NULL session ids until kimi announces).
- **Replay.** Now reads the v1.0 cli-client NDJSON log format (`{event, record}` lines). v0.4 Wire JSON-RPC logs surface as `REPLAY_LOG_UNREADABLE`. ([PR 4](#))

### Per-command policy (PreToolUse hook)

| `KIMI_PLUGIN_CC_CMD` | Allowed tools | Denied tools |
|---|---|---|
| `ask`, `review`, `challenge`, `review_gate` | `Read`, `Grep`, `Glob`, `ReadMediaFile`, `TaskList`, `TaskOutput` | everything else |
| `rescue` | workspace-bound shell + edit allowlist (see [docs/safety.md](./docs/safety.md)) | every shell command, file edit, or write the allowlist rejects |
| unset / out-of-plugin | everything | nothing — kimi-code is being driven directly |

`/kimi:ask` is read-only in v1.0. v0.4 ran ask under Kimi CLI agent profiles that allowed write tools; the hook tightens this to match the documented "narrative answer, not implementation" contract.

### Marketplace + plugin id (reverted in alpha.2)

alpha.1 renamed the marketplace and plugin ids (`kimi-marketplace` → `kimi-marketplace-v1`, `kimi` → `kimi-v1`) so existing v0.4 installs couldn't auto-pull v1. **alpha.2 reverted that rename**; see the alpha.2 entry above. For posterity the original intent was: kimi-code is a hard dependency in v1, and the rename was a defensive forcing function for users to acknowledge the new prerequisite before upgrading. The revert traded that defense for a much smoother upgrade UX, with the kimi-code prerequisite communicated through README + migration docs instead.

### Removed

- `runtime/wire/` — Wire JSON-RPC client, turn capture, approval dispatcher, think-stall guard. Replaced by `runtime/cli-client.ts` + `runtime/stream-json.ts`.
- `runtime/kimi-launch.ts` — Wire-client launch helper. Subsumed by `runtime/cli-client.ts` + `runtime/kimi-command.ts`.
- `runtime/kimi-web-client.ts` — Kimi web PATCH endpoint for session titles. kimi-code's vis-server doesn't expose PATCH; the title feature is gone in v1.0.
- `runtime/cancellation.ts` — Wire-client SIGTERM/SIGKILL handler. Replaced by `runtime/cli-cancellation.ts` + cli-client's built-in escalation.
- `runtime/agents/*.yaml` — Kimi CLI agent profiles. kimi-code doesn't load user profiles; per-command safety lives in the PreToolUse hook now.
- `runtime/prompts/*-system.md` — System prompts that were attached via agent profiles. Inlined into command preambles where still needed.
- `tests/wire/`, `tests/helpers/mock-kimi-cli.ts` (v0.4), `tests/helpers/mock-wire-server.ts`, and the Wire-client / Kimi-launch / Kimi-web / cancellation test files.

### Added

- `runtime/cli-client.ts` — subprocess wrapper with AbortController cancellation, SIGTERM→SIGKILL escalation (1500ms, matching v0.4), rolling stderr tail, NDJSON diagnostic log, log-drain timeout, pre-aborted signal check.
- `runtime/stream-json.ts` — pure parser for kimi-code's `--output-format stream-json` records.
- `runtime/cli-cancellation.ts` — AbortController-based cancellation handler.
- `runtime/hooks/approval-policy.ts` — pure per-command decision function (the heart of the safety policy).
- `runtime/hooks/approval-hook.ts` — entry script (`dist/hooks/approval-hook.js`) installed in `~/.kimi-code/config.toml`.
- `runtime/hooks/managed-block.ts` — shared parser for the managed block; used by both the installer and the verifier so the two cannot disagree.
- `runtime/hooks/install.ts` — `verifyHookInstalled` + `maybeWarnHookMissing` helpers used by ask/review/challenge/review_gate (warn-once) and rescue (refuse).
- `runtime/kimi-command.ts` — `KIMI_PLUGIN_CC_KIMI_BIN` / `KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS` env-var resolver.
- `tests/runtime/setup.test.ts` — managed-block install / check / uninstall lifecycle, orphan detection, duplicate detection, CRLF preservation, TOML-safe path enforcement.
- `tests/helpers/mock-kimi-cli-v1.ts` — stream-json mock for the cli-client path.
- `tests/helpers/sigterm-trap.ts` — child process that traps SIGTERM so SIGKILL escalation paths can be exercised deterministically.
- `docs/migration.md`, `docs/safety.md`.

### Review-driven hardening

The five-PR cutover landed with paired Claude code-reviewer + Codex codex-rescue adversarial reviews on every PR. Convergent and divergent findings applied before commit:

- **PR 2 / hook script compiled but never installed** — added `verifyHookInstalled` + one-time stderr warning so the gap is loud.
- **PR 2 / withTimeout left the subprocess running after the budget expired** — added `runCliPromptWithBudget` that ties the timeout to an internal AbortController.
- **PR 3 / rescue running write-capable without the hook** — rescue now refuses with `RESCUE_HOOK_NOT_INSTALLED`.
- **PR 3 / SIGKILL escalation race** — added `processClosed` flag distinct from `settled` so a timer queued during log-drain can't fire a redundant SIGKILL.
- **PR 4 / ask=allow contradicted read-only docs** — ask now shares the read-only allowlist with review/challenge/review_gate.
- **PR 4 / verifier was a substring check** — shared the managed-block parser with the installer; both gates reject the same shapes (orphan, duplicate, missing event, missing command, matcher present).
- **PR 4 / bare `node` in the managed block could silently fail-open** — installer writes `process.execPath` (absolute Node path).
- **PR 4 / TOML escape in the command field** — switched from shell-single-quoting to TOML basic-string escaping; rejects paths with characters that cannot safely round-trip.
- **PR 4 / writeConfigAtomic race on a fixed temp file** — unique random tmp filenames.
- **PR 4 / stripAllMarkers destroyed user content after an orphan BEGIN** — only marker lines removed; surrounding content preserved.
- **PR 4 / locateMarkerBlock only inspected the first BEGIN/END pair** — duplicate-block detection with `SETUP_DUPLICATE_BLOCKS`.
- **PR 4 / CRLF line endings mixed on write** — line-ending detection threaded through install/uninstall/splice.

### Pre-tag audit hardening

Two further multi-agent rounds (Claude code-reviewer + Codex codex-rescue, plus plugin-validator and claude-code-guide for spec compliance) found these classes during the pre-tag audit. All closed before tag:

- **rescue.ts skipped the hook-path drift gate** — the optional `expectedHookPath` parameter let a stale managed block silently re-enable kimi-code's auto-approve. Verifier is now strict-by-default and always reconstructs the canonical command via the shared `runtime/hooks/install-paths.ts` module.
- **Verifier substring match → exact equality** — `commandPath.includes(expectedHookPath)` accepted `command = "true # /path/to/approval-hook.js"` (`/bin/sh -c` parsed `#` as a comment, hook exited 0 = ALLOW). Equality on the full canonical shell command closes the bypass.
- **`await mkdir` race in cli-client** — if abort fired during the mkdir yield, the listener attached after meant SIGTERM/SIGKILL was never sent. Re-checks `signal.aborted` after attach. Mirrors kimi-code's own runner pattern.
- **`writeConfigAtomic` umask** — temp file inherited umask before rename. Now chmods 0o600 before rename so the user's existing API-key/token file mode is preserved.
- **`--output=*` workspace escape via Bash** — `git diff --output=/etc/passwd`, `curl --output /tmp/x`, `eslint --output-file=/tmp/x` all wrote outside the workspace through their own report-output mechanism. `--output`/`--output-file`/`--output-directory`/`--output-dir` (exact + `=` prefix) now live in `MUTATING_FLAGS`. `-o` is rejected per-tool where its semantics are write-shape (eslint).
- **TOML basic-string capture without decode** — `parseManagedBlock` captured raw, so apostrophe-in-path installs round-tripped through `\\` (TOML escape) → captured `\\` ≠ canonical `\` → false-fail. `decodeTomlBasicString` handles the six standard escapes.
- **Relative `KIMI_PLUGIN_CC_HOOK_SCRIPT` override** — kimi-code spawns hooks via `/bin/sh -c` with a cwd that may differ from the companion's. Override is now required to be absolute, matching the `KIMI_PLUGIN_CC_NODE_BIN` contract.

### Round 3 audit hardening

A third multi-agent audit pass (Claude code-reviewer + Codex + plugin-validator + claude-code-guide) found one High, four Medium, two Low, and several polish gaps. All closed before tag:

- **Process-group cancellation (HIGH)** — `runtime/cli-client.ts` spawned kimi-code with default process-group behavior, so `child.kill(SIGTERM/SIGKILL)` only hit the immediate process. kimi-code's Bash tool subprocesses ran as grandchildren and survived cancel — a denial-of-cancellation issue where long-running approved subprocesses kept consuming workspace state after the plugin reported cancellation. POSIX now spawns with `detached: true` (own process group) and signals the negative pid (`process.kill(-child.pid, ...)`). ESRCH/EPERM fall through to direct `child.kill()`. win32 keeps the original direct-kill path (negative-pid signaling does not exist there; grandchild reaping on Windows is a known gap).
- **Session-id capture: incremental + anchored (MEDIUM)** — `runtime/cli-client.ts` only parsed the session id from the final 8192-char `stderrTail` on close; if kimi-code emitted the announce line early and then wrote more than 8192 bytes of stderr, the id was evicted and resume/replay handles silently disappeared. `runtime/stream-json.ts` regex was unanchored and accepted any `[0-9a-f-]{8,}` token, so a hostile Bash command under `/kimi:rescue` could `echo 'To resume this session: kimi -r <fake>' >&2` and poison the captured id. Capture now runs in the stderr `data` handler (first announce wins, pinned), regex tightened to anchored line-bounded full-UUID shape (`/^To resume this session:\s+kimi\s+-r\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/im`), and `stderrTail` scan remains as a fallback.
- **Stream-json line size cap (MEDIUM)** — `StreamJsonParser.push()` appended every chunk into one in-progress buffer until `\n` appeared, with no upper bound; a single 1MB+ unterminated stdout line could land whole in `malformed[]` and the diagnostics log. New `MAX_STREAM_JSON_LINE_BYTES = 1_048_576` guard emits a malformed outcome with a truncated preview, clears the buffer, and continues parsing. `cli-client.ts` also truncates `entry.line` before storing for diagnostics.
- **Drift gate untracked-file gap (MEDIUM, convergent with code-reviewer)** — `bun run check`'s `git diff --exit-code -- dist` caught modifications but not untracked files. A new `runtime/foo.ts` whose compiled `dist/foo.js` was forgotten by `git add` would silently pass the gate. The check now additionally fails when `git ls-files --others --exclude-standard -- dist` is non-empty, and prints the offending files so the developer knows what to stage.
- **`buildManagedBlock` env divergence** — the installer's managed-block writer called `buildHookShellCommand(hookScriptPath, process.env)` while the verifier and `--check` path resolved the canonical command from a parameter `env`. Production masked this (context.env === process.env), but any future caller or test that passed divergent env would produce an unfixable "installed: false" loop. `buildManagedBlock` now takes `env: NodeJS.ProcessEnv` and the install path threads `context.env` through — single source of truth for the canonical command bytes stays in `runtime/hooks/install-paths.ts`.
- **Agent color collision** — `kimi-review`, `kimi-challenge`, and `kimi-ask` all declared `color: cyan`, defeating Claude Code's per-agent UI hint. `kimi-challenge` moved to `yellow` (adversarial framing → warning color); the read-only narrative trio (`kimi-review`, `kimi-ask`) keep cyan and `kimi-rescue` keeps magenta as the only write-capable surface.
- **Missing `argument-hint` on lifecycle commands** — `replay`, `result`, `status`, `cancel` accepted positional or flag arguments but exposed no hint in the slash-command palette. Added hints matching the actual parsers (`<job-id>` for replay; `[<job-id>] [--type <kind>] [--json]` for result; `[<job-id>] [--type <kind>]` for status; `[<job-id>]` for cancel).
- **Explicit `commands` array in plugin manifest** — `.claude-plugin/plugin.json` relied on auto-discovery from `commands/*.md`. Adding an explicit `commands` array (belt-and-suspenders) prevents the README.md in that directory from being mistakenly registered as a slash command and documents the surface in the manifest itself.
- **Setup side-effect doc note** — `commands/setup.md` description didn't mention that `/kimi:setup` writes to `~/.kimi-code/config.toml` (outside the plugin's own files). Description now spells out the side effect.
- **Docs drift** — `docs/safety.md` said "once per Claude Code session" for the missing-hook warning latch, but the companion is a fresh Node process per slash-command invocation, so the latch is actually per-companion-invocation. Docs corrected. Same file's unknown-label policy row listed only `Read`, `Grep`, `Glob` while `runtime/hooks/approval-policy.ts::READ_ONLY_TOOLS` and the unknown-label branch actually allow six tools (adds `ReadMediaFile`, `TaskList`, `TaskOutput`). Docs widened to match the code — the broader set is intentional and consistent with the named labels.

### Test surface

358 tests across 28 files. Drift gate (`git diff --exit-code -- dist && test -z "$(git ls-files --others --exclude-standard -- dist)"`) runs as part of `bun run check` to catch forgotten rebuilds and untracked compiled artifacts before commit.

### Versions

Synced version `1.0.0-alpha.1` across:

- `runtime/version.ts` (`KIMI_PLUGIN_CC_VERSION` — written into the managed-block marker by `/kimi:setup`)
- `package.json`
- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `AGENTS.md`

## Older releases

See the [`v0.4.0` tag](https://github.com/linxule/kimi-plugin-cc/releases/tag/v0.4.0) (and the `v0.4-maintenance` branch cut from it, once published) for the v0.4.x line. Notable releases:

- **0.4.0** — Eliminated stderr-as-correctness; structured result envelope.
- **0.3.7** — Loud failures across review/challenge/ask/rescue.
- **0.3.6** — Hard-error unknown flags on review/challenge.
- **0.3.5** — ApprovalRouter; outputMode invariant; command registry.

For pre-1.0 commit-level history see `git log v0.4.0..` on the v0.4-maintenance branch.
