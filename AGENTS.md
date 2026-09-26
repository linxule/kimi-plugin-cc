# AGENTS.md

Project context for coding agents working in this repository. This is the
**contract sheet**: each bullet states what must not regress, in present tense,
with a pointer to the full mechanics and rationale in
[docs/invariants.md](docs/invariants.md) (§ numbers below). Keep this file under
32 KB. `CLAUDE.md` imports it with `@AGENTS.md`, so there is one source
and nothing to mirror. Release history lives in
[CHANGELOG.md](./CHANGELOG.md) and [ROADMAP-TO-GA.md § Post-GA audit log](./ROADMAP-TO-GA.md#post-ga-audit-log), never here.

## Quick reference

- **Version**: 2.0.7 (kimi-code, subprocess transport, **native agent-core-v2**).
- **The native-v2 safety contract — do not regress** (§1): every executed tool call in a plugin-managed session passes the managed PreToolUse hook, and the engine's sole chain-breaking final allow (the plan-file guard, `features/plan/planService.ts`, active plan mode only) is NEVER armed. That is a plugin-owned construction, not an upstream ordering promise, resting on four closures that must all stay in place: (1) `runtime/native-v2-preflight.ts` refuses `default_plan_mode` under every spelling upstream's `snakeToCamel` normalizes (parsed from the same `<KIMI_CODE_HOME>/config.toml` the child reads, before spawn and at the spawn boundary, `KIMI_CODE_HOME` resolved against the child's cwd on every entry path incl. the Stop hook; `CLI_V2_PLAN_MODE_CONFIGURED`, remedy is the config key, never `/kimi:setup`); (2) the hook denies `EnterPlanMode`/`ExitPlanMode` for every label; (3) resume accepts only proven `native-v2` plugin lineage after a raw scan of every agent `wire.jsonl` for `plan_mode.*`/`plan.*` (`KIMI_SESSION_LINEAGE_UNKNOWN` / `KIMI_SESSION_ENGINE_MISMATCH` / `KIMI_SESSION_PLAN_TAINTED`); (4) v2-only experimental features (`tower`, `subagent_fork`) and `KIMI_CODE_EXPERIMENTAL_FLAG` refuse before spawn. Certification is per EXACT version and per operation (`NATIVE_V2_CERTIFIED` in `runtime/kimi-engine.ts`; `KIMI_TESTED_MINORS` is the legacy-v1 table and never gains 0.42): a version is appended only after `tests/audit/v2-tag-scan.test.ts` passes on its source tree, the plan-mode-ON live control still shows the bypass (proving the refusal is load-bearing), and the per-operation smoke is green. A v2 plan requires the `system.version` marker as the first stream-json line, equal to the probed version; a legacy plan refuses it (`CLI_ENGINE_PROVENANCE_MISMATCH`). `Bash.cwd` is validated against the trusted root before the command string (`runtime/rescue-approval.ts`). Basis and residuals: `docs/native-v2-certification-provenance.md` §2.
- **Hook-pin durability** (§1): the canonical hook command never embeds a version-stamped Node token; `preferStableNodePath` prefers `process.argv0` only when absolute and `realpath`-identical; `verifyHookInstalled` runs `access(nodeBin, X_OK)` fail-closed on the token parsed back from the built command (`refusal_kind:"node-bin-not-executable"` is the one refusal whose remedy is NOT /kimi:setup). Re-pin-recoverable refusals carry `retryable_after_setup`; agents re-pin via `${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh setup` and retry ONCE only when it is literally `true` and setup exits 0. **In-verifier auto-repin is REJECTED — do not re-propose.**
- **Test discipline** (§1): detached-worker hook-enforcement tests MUST run the companion as a real node subprocess through a symlink with NO `KIMI_PLUGIN_CC_NODE_BIN` override and NO `KIMI_PLUGIN_CC_SKIP_HOOK_CHECK`. A real-binary smoke MUST assert its own precondition when the behaviour depends on host state; never write a "plan-file write is denied under plan mode" smoke — that path is never armed, so green would be the vacuous-precondition failure.
- **Upstream compat** (§2): native-v2 certified at exact `@moonshot-ai/kimi-code@0.42.0`, `0.43.0`, `0.43.1`, `2.0.0`, `2.0.1`, `2.0.2`, `2.1.0`, `2.1.1` for all eight operations; legacy-v1 through **0.41.x** for an explicitly pinned binary only (0.42.0 deleted the v1 engine). Engine selection is plugin-owned (`selectIntendedEngine`): exact version in `NATIVE_V2_CERTIFIED` → v2; minor in `KIMI_TESTED_MINORS` → v1 with the child-only legacy pin; else refuse. The upstream ordering defect (plan registers before external hooks; sole `.allow()` at `planService.ts:110`) is unchanged through 2.1.1 and filed as MoonshotAI/kimi-code#3431 (open). Evidence: [docs/native-v2-status.md](docs/native-v2-status.md); audit routine: [docs/upstream-compat-audit.md](docs/upstream-compat-audit.md) + the tag scan. **Re-verify each audit** (full statements in §2): engine provenance persisted per job and trusted roots from `KIMI_PLUGIN_CC_WORKSPACE_ROOT` never the payload `cwd`; the before-execute channel's subscriber set and single `.allow()`; the external-hooks engine contract (exit 2 / `permissionDecision:"deny"` = deny, else allow, fail-OPEN on spawn error/timeout/bad JSON, first block wins, `tool_input` field names `path` for Write/Edit and `command`+`cwd` for Bash); `-p` mode argv (`--agent`/`--agent-file`/`--add-dir` exist and are NEVER passed; every spawn exports `KIMI_CODE_NO_AUTO_UPDATE=1` and an absolute `KIMI_CODE_HOME`); the exhaustive plan-arming vectors (config key, `EnterPlanMode`, journal replay — `restore()` folds only `agents/<id>/wire.jsonl`, since 0.43.0 via the undo-filtered view first, and since 2.0.1 both passes materialized by `readRestoreChains()` from that same file); plugin slash commands stay host-only and `-p` intercepts only `/goal`; custom agent profiles can steer work but not hooks/permission/cwd/plan; goal mode exits 0/3/6; `AgentSwarm` children run in-process with their OWN eager external-hooks service (no deny-all path), `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` unset = no cap so `swarm.ts` always exports it; background auto-upgrade drifts the operator's binary, each spawn probes the exact tuple; print-mode subagent timeouts are unbounded upstream, the plugin keeps finite `--budget` ceilings. Daily monitor reports: `.claude/kimi-code-research/daily-monitor/` (gitignored; read `LATEST.md` first; they never certify).
- **Toolchain**: Node >= 22.5, TypeScript, **bun** for development; npm CLI for registry operations, including package installation
- **Workflow**: edit `runtime/**/*.ts` → `bun run check` (build + typecheck + test + drift gate)
- **Installed-state verification**: For questions about what a host is actually running, resolve that host's active version-stamped install cache and run its bundled `scripts/companion.sh setup --check`. The checkout, package metadata, and another host's cache are not proof of active runtime state.
- **Credential-bearing config** (§3): `~/.kimi-code/config.toml` can hold a BYO-provider `apiKey`, and `~/.kimi-code/credentials/` is the real OAuth-token store (always has been — not a per-version migration). For routine checks never read, print, copy or retain either; use the sanitized `setup --check` or `setup --models [--json]` projection. Model listing internally parses config but emits only routing fields, never secrets or raw parser errors; it never reads the OAuth store or makes provider calls. An explicitly authorized diagnosis of config.toml is restricted to the managed hook block with credentials redacted; `credentials/` is never read or copied.

## Directory layout

```
.claude-plugin/     Claude Code plugin manifest (plugin.json, marketplace.json) — id stays as kimi/kimi-marketplace (no rename for v1); v0.4 users opt-in to v1 by updating the same install
.claude/            Gitignored local audit workspace. Upstream clones/reports live here, including daily monitor reports under kimi-code-research/daily-monitor/
.agents/            Codex repo marketplace sidecar (plugins/marketplace.json) — generated; source.path points at plugins/kimi-codex
commands/           Slash command markdown — thin wrappers over companion.sh (Claude Code surface)
agents/             Claude Code subagent definitions (kimi-rescue, kimi-review, kimi-challenge, kimi-ask, kimi-swarm, kimi-pursue, kimi-swarm-write)
hooks/              Stop hook for the review gate (kimi-code-side PreToolUse hook lives at runtime/hooks/)
scripts/            Shell entry points (companion.sh, review-gate-hook.sh) + dev-only surface generator (surface-registry.ts, generate-surfaces.ts)
plugins/kimi-codex/ SELF-CONTAINED Codex plugin root — GENERATED, do not hand-edit. Codex copies a plugin root to its install cache and forbids ../ escapes, so this dir bundles everything it needs:
  ├── .codex-plugin/plugin.json   Codex manifest (skills: "./skills/")
  ├── skills/                     12 Codex skills that shell out to companion.sh (no MCP). Lives HERE, not at repo root, so Claude Code does NOT auto-discover them
  ├── scripts/                    byte-mirror of companion.sh + review-gate-hook.sh (0755)
  └── dist/                       byte-mirror of the compiled runtime
runtime/            TypeScript source — the real runtime
  ├── background-spawn.ts  Shared detached-worker spawn helper (rescue + ask)
  ├── cli-client.ts        Subprocess wrapper around `kimi -p --output-format stream-json`
  ├── stream-json.ts       Pure parser for kimi-code's NDJSON output
  ├── cli-cancellation.ts  AbortController-based cancellation for long-running commands
  ├── rescue-approval.ts   Workspace-bound allowlist (called by the PreToolUse hook)
  ├── commands/            One file per companion subcommand
  ├── hooks/               PreToolUse approval hook (entry script + policy + install verifier)
  └── schemas/             Structured output contract for review_gate (review/challenge dropped theirs in v0.2.3)
dist/               Compiled JS — committed for zero-build install
tests/              bun test suite
```

## Commands

- `bun run check` — rebuild `dist/`, verify generated surfaces (`check:surfaces`: Claude hash gate + Codex sidecars + the `plugins/kimi-codex` runtime mirror/orphan checks), typecheck, run full test suite, then drift gate (`git diff --exit-code -- dist plugins/kimi-codex`). If `dist/` or the bundled Codex copy has unstaged changes, check fails — stage them and retry.
- `bun test <path>` — run a single test file
- `bun run build` — compile `runtime/**/*.ts` → `dist/**/*.js`

The companion runs via `scripts/companion.sh <subcommand>`, which resolves `node` and runs `dist/companion.js`. Subcommands: `setup`, `review`, `task` (`task rescue`, `task challenge`, `task pursue`, `task swarm`), `ask`, `status`, `result`, `cancel`, `replay`, `repair-sessions`.

## Architecture

**Thin plugin, rich runtime** — mirrors [codex-plugin-cc](https://github.com/openai/codex-plugin-cc):

- Plugin layer (commands/, agents/, hooks/) handles routing only
- Runtime layer (runtime/, scripts/) owns subprocess lifecycle, SQLite job store, hook-side approval policy, and rendering
- Flow: `slash command → companion.sh → companion.js → kimi -p --output-format stream-json → job store → artifact`

**Key invariants** (each in full in docs/invariants.md §4):

- **Subprocess-first.** One `kimi -p` process per job. Session-id capture is dual-source (stream-json `session.resume_hint` meta record on 0.2.0+; anchored stderr `kimi -r <uuid>` line on 0.1.x), first-announce-wins, pinned, idempotent; the meta record is filtered out of consumer `records[]`; the id is an opaque token round-tripped verbatim via `kimi -r`.
- **Every model-spawning command is enforced by the PreToolUse hook** in `~/.kimi-code/config.toml` (`kimi -p`'s auto-approve cannot be overridden via argv). On native v2 the hook is load-bearing under the no-plan construction; the preflight refuses `default_plan_mode`, tainted/unknown resume and unsafe experimental selectors before process creation. Ask/review/challenge/rescue/pursue/swarm refuse before spawning when hook verification fails; the review gate skips visibly. `KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1` is a tests/diagnostics bypass for hook-verification refusals only — never a repair path, and it does not bypass the v2 preflight.
- **Hook verification is strict-by-default and exact.** `verifyHookInstalled` rebuilds the canonical command from env (`install-paths.ts::tryBuildExpectedHookCommand`, the single source of the command bytes) and equality-checks the host's installed command. Setup/check parse the COMPLETE TOML with vendored `smol-toml@1.6.1` (+ GHSA-7w5x-hrqm-74c2 backport) and strictly validate every hook against kimi-code's schema before the managed-block grammar; unknown top-level tables are tolerated. Additive hook events use 0.x minimum minors or the reviewed exact 2.0.0/2.0.1/2.0.2/2.1.0/2.1.1 schemas (schema review alone does not certify execution); other nonzero versions fail closed. Substring/partial-parse paths are forbidden. **Markers are NOT durable** (kimi-code strips comments on every config write) — `evaluateInstalled` falls back, ONLY from the absent state, to a marker-less clean enforcing table, decided with the REAL parser (`hasCleanEnforcingHookEntry`): `event="PreToolUse"`, byte-exact `command`, NO `matcher` in any spelling, no keys beyond `{event,command,timeout}`. Never regress this to a line scanner. `findBareApprovalHookTables` is ONLY the conservative prune scanner. Re-verify each audit: installed check stays parser-based, matcher-rejecting, byte-exact, absent-state-only; the prune stays host-scoped.
- **Serialized config mutation.** Install/uninstall hold a private adjacent `config.toml.kimi-plugin-cc.lock` across the whole read-modify-write; publication is atomic; lock reads are no-follow/nonblocking/regular-file-only and capped; acquisition is bounded; live owners are never stolen; stale recovery is ABA-safe; inode/token ownership is rechecked before mutation. New kimi-code home `0700`, config and lock `0600`. Inline `hooks = [...]` is normalized to `[[hooks]]` with a comment-loss warning. `/kimi:setup --check` exits nonzero on any whole-file, hook-schema, managed-block, path or shell-probe failure.
- **Host-scoped managed blocks.** Claude Code and Codex install to different version-stamped paths but share one config.toml, so the managed block is keyed by host id (`# === BEGIN kimi-plugin-cc-managed:<host-id> (vX) ===`; `resolveHostId` derives it version-independently from the hook path, `KIMI_PLUGIN_CC_HOST_ID` overrides). **Never collapse back to one shared block** — the hosts overwrote each other. `parseManagedBlock`/`evaluateInstalled` are per-host and exact; `runInstall` upserts only this host's block and prunes only orphaned marker-less blocks whose command is strictly ours (`isOurApprovalHookCommand`; hand-rolled hooks are never touched); `runUninstall` is host-scoped (`--uninstall --all` sweeps every host). Coexistence is safe because kimi-code fires every `[[hooks]]` any-block-wins. Re-verify: scoped install/uninstall preserves other hosts' live blocks; `--uninstall --all` is the explicit exception.
- **Rescue defines the direct-workspace write allowlist** used by rescue and pursue (`runtime/rescue-approval.ts`, via `evaluateRescueHookRequest`): shell-quote parser, mutating-flag detector (`--fix`/`--write`/`--apply`/`--in-place`/`-i`/`-w` plus the output-to-file class `--output*`/`--output-dir*`, exact and `=` forms; per-tool `-o`), symlink reject, realpath check, a global `hasExecDelegatingFlag` (`--open-files-in-pager` — a CRITICAL RCE class — `-vettool`/`-toolexec`/`-exec`; git-local `-O`), and report-writer rejects (`mypy --junit-xml`/`--*-report`, `pytest --junitxml`/`--result-log`/`--report-log`). Test runners still execute repo code by design; internal Git context commands also trust repository Git configuration and can execute helpers outside tool hooks, including read-only swarm — explicit trust boundaries in `docs/safety.md` and `docs/invariants.md`.
- **Rescue cannot mutate git state.** The calling host owns branch and commit decisions.
- **`/kimi:pursue` (experimental) = autonomous goal mode** (`kimi -p "/goal ..."`, 0.8.0+; `KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1` kept for 0.8–0.11). Write-capable with the rescue workspace boundary (`commandLabel: "rescue"`, hook on every continuation turn, `command_type:"rescue"` lineage, no git mutation). Trusted `executionPlan.operationKind` is exported as `KIMI_PLUGIN_CC_OPERATION` on every spawn, replacing ambient values; only `pursue` plus a trusted root permits exact `GetGoal {}` and terminal `UpdateGoal {status:"complete"|"blocked"}`. Goal creation, reactivation and budget mutation stay denied; older coexisting hooks can still veto these tools. The only new risk is unboundedness, bounded by a **mandatory finite `--budget`** (default 45m; `--turns` is a soft hint). Runtime-foreground-only; the caller detaches its own shell call. No `--resume` (goalId ≠ sessionId). Exit 0/3/6 are terminal, not failures. `docs/safety.md` § "Autonomous goal mode".
- **`/kimi:swarm` = read-only parallel fan-out** (`AgentSwarm`, 0.12.0+). Label `swarm` allows the read-only set PLUS the exact tool name `AgentSwarm` (the singular `Agent` is denied); every subagent inherits the label and fires the same hook through its own eager external-hooks service → no additional direct tool-write permission; the internal Git trust boundary still applies. `command_type:"review"` lineage. Refuses without the hook. Bounded by mandatory `--budget` (default 30m); `--cap N` is a SOFT total-count hint, `--max-concurrency N` a HARD peak cap on 0.18.0+ (`KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY`, default 4, always exported). **Never re-merge the two flags.** The model-invocable `kimi-swarm` agent wraps it. `docs/safety.md` § "Read-only swarm".
- **`/kimi:swarm --write` = write-capable parallel fan-out.** Ephemeral detached git worktree off HEAD under the plugin's own `worktreesDir`; coordinator spawned with cwd = that worktree (`spawnCwd` seam; `job.cwd` stays the user's cwd); `subagent_type:"coder"`, disjoint targets, no git, no nested `AgentSwarm`. Label `swarm-write` routes writes through `evaluateRescueHookRequest` scoped to a **forge-proof trusted root** from `KIMI_PLUGIN_CC_WORKSPACE_ROOT` (never the payload `cwd`); fail-closed when missing. The user's real tree is never touched (subagents share the one worktree — re-verify that permission-stack claim each audit). The change set is captured as an untruncated applyable `.patch` (`git add -N` + `git diff --binary`) on EVERY terminal path before the worktree is removed; a startup sweep reaps orphans. **The plugin never applies or commits.** `command_type:"rescue"` lineage; refuses without the hook; requires kimi-code ≥ 0.18.0, a born HEAD, loud dirty-tree warning; default `--max-concurrency` 1. Runtime-foreground-only ≠ caller-foreground-only. **Cancellation is no-id** (`companion.sh cancel`; prefer it over Esc/TaskStop — a harness interrupt's ~1.35 s grace is shorter than the teardown + patch capture). Pursue is NOT swarm-write (real tree vs discardable patch). The model-invocable `kimi-swarm-write` agent wraps it under strict triggering. `docs/safety.md` § "Write-capable swarm".
- **`goal.summary`** (0.8.0+, role-less) is captured on `CliClientResult.goalSummary`; `turn.step.retrying` meta is modeled and filtered like the other wrapper metadata; malformed shapes still enter diagnostics.
- **Plugin data ownership** (§5): `KIMI_PLUGIN_CC_DATA` is the explicit absolute data-root override. Standard cache installs derive the expected host-specific directory from the loaded package, not shared root variables; conflicting shared data variables refuse before store access (`PLUGIN_DATA_CONFLICT`). Custom launches retain unambiguous legacy paths. No automatic data migration; detached workers pin the selected root and the Stop hook skips visibly on resolution failures.
- **Jobs in SQLite are the source of truth.** Terminal states are permanent.
- **Session visibility and titles** (§4): after a settled user-command run, native-v2 session sync fills only missing prompt previews (redacted, capped at 4,000 characters) and notifies the shared Desktop/Web index. Manual and native-generated titles are preserved; new fallback titles are replaceable by native generation. Never invoke the native title endpoint automatically: it resumes an agent. `repair-sessions` previews a host-owned, completed-v2 backfill by default and requires `--apply` to write; prompt recovery must match the job digest. Internal review-gate sessions are excluded. See [docs/session-visibility.md](docs/session-visibility.md).
- **Model selection** (§4): omit `-m` for the fresh-session default; resumes keep their session model. Explicit per-run aliases do not change the saved default. `setup --models [--json]` provides a read-only, credential-safe local inventory, not a connection test. Agents resolve natural-language requests to an unambiguous configured alias, never guess or silently fall back; provider setup stays in native `/login` or `/provider`, and saved-default changes require explicit intent via `/model`. Review gate omits `-m` unless `KIMI_PLUGIN_CC_REVIEW_GATE_MODEL` is set. Swarm children may use `[secondary_model]`. See [docs/models.md](docs/models.md).
- **Prose pass-through**: review/challenge/ask/rescue emit raw prose; the review gate is the only command that parses Kimi output (JSON allow/block), as a Stop hook, disabled by default, fail-open on malformed output, skipping visibly (with the reason in `systemMessage`) when enforcement is missing or invalid.
- **LLM-caller discipline**: stderr is for humans only; anything load-bearing goes in stdout, exit codes or SQLite. Parsers hard-fail on unknown flag-shaped tokens (`INVALID_ARGS`). `RuntimeError.details` carries structured failure context. `result <jobId> --json` opts into the structured envelope.
- **Cancellation** is AbortController + SIGTERM → SIGKILL (1500 ms) with teardown as a settlement barrier: POSIX spawns detached, snapshots descendant identity (PID/PGID/start time) and revalidates before signalling, waits through a bounded post-SIGKILL quiescence check, never signals a changed identity, and emergency-kills the controlled root rather than stranding settlement. win32 remains direct-child-only (known gap).
- **Config writes preserve mode 0o600** (`writeConfigAtomic` chmods the temp file before rename).

## Post-GA roadmap

See [ROADMAP-TO-GA.md](./ROADMAP-TO-GA.md) for the pre-GA history and the living Post-GA audit log. v1.0.0 GA shipped 2026-05-26. Remaining open items: H1 (hook fail-open runtime drift) and H5 (per-task thinking control — upstream integration needs reassessment; the plugin exposes no override). H3/H4/H8/H9 closed in v1.2.x; H7 (real-binary smoke, `bun run smoke:real`) ships as a manual-dispatch CI workflow; model calls require `KIMI_MODEL_API_KEY`. Adding the secret does not enable per-push runs.

## When editing

- Read the code before changing it — the runtime has specific invariants that aren't obvious from file names
- Run `bun run check` before considering any change done
- After any `runtime/**` (or `scripts/*.sh`) change, regenerate the Codex package: `bun run build && bun run generate:surfaces`, then stage `dist/` AND `plugins/kimi-codex/`. The `plugins/kimi-codex/` tree is GENERATED — never hand-edit it; edit `runtime/`/`scripts/`/`scripts/surface-registry.ts` and regenerate.
- Codex sidecars are generated by `bun run generate:surfaces` from `scripts/surface-registry.ts`. `bun run check:surfaces` (run after `build` inside `check`) verifies: the Claude plugin bytes match the locked hash gate, the generated Codex text surfaces are current, the bundled runtime mirror (`plugins/kimi-codex/{scripts,dist}`) byte-matches root, and no orphaned generated files remain.
- Editing a Claude command/agent or any `.claude-plugin/*` file changes its bytes, so you MUST re-pin its sha256 in `CLAUDE_SURFACE_HASHES` (`scripts/surface-registry.ts`) — `shasum -a 256 <file>` — or `check:surfaces` fails closed.
- `dist/` and `plugins/kimi-codex/` are committed intentionally (zero-build install for both hosts; Codex copies the subfolder to its cache). The drift gate catches forgotten rebuilds/regenerations.
- Agent files register at session start. Adding or editing `agents/*.md` mid-session doesn't activate them until Claude Code reloads — reach for slash commands or direct `companion.sh` in the same session.
- `.claude/` is gitignored — notes, worktrees, internal docs under it stay local. Don't try to commit them.
- **Tests never inherit host plugin env.** `bunfig.toml` preloads `tests/helpers/preload.ts`, which deletes `CLAUDE_PLUGIN_DATA`/`PLUGIN_DATA`/`CLAUDE_PLUGIN_ROOT`/`PLUGIN_ROOT` (and the per-spawn `KIMI_PLUGIN_CC_*` overlays) before every test file. A host session exports these into the shell — possibly ANOTHER plugin's data dir — and a test that spreads `process.env` would otherwise write into a live plugin store (it did, 2026-09-09). Tests that need a plugin root/data dir set their own explicitly; never remove the preload.
- **Changing a contract**: edit the full statement in `docs/invariants.md` AND its one-line summary here. Rationale and archaeology go there or in the log files, not here.

## Releasing

Plugin versions advance independently of upstream kimi-code using ordinary SemVer.
Use the next unused plugin patch for compatible maintenance and certification updates;
state the exact certified CLI versions separately. Never reuse a published version or
tag, and never encode an upstream patch with leading zeros. The source audit, exact-
binary controls, per-operation smoke and full check remain mandatory. The runtime
certification table is the compatibility authority. See [docs/invariants.md](docs/invariants.md) §2.

`runtime/version.ts` is the SINGLE version source — `scripts/surface-registry.ts` (`PLUGIN_VERSION`) imports it, so the Codex manifest/marketplace version propagates automatically. A version bump touches these and then regenerates:

- `runtime/version.ts` (`KIMI_PLUGIN_CC_VERSION` — written into the managed-block marker comment by /kimi:setup; imported by surface-registry)
- `package.json`
- `.claude-plugin/plugin.json` — **also re-pin its sha256 in `CLAUDE_SURFACE_HASHES`** (its bytes change)
- `.claude-plugin/marketplace.json` — **also re-pin its sha256 in `CLAUDE_SURFACE_HASHES`**
- `AGENTS.md` — bump the version number, and **REPLACE** a contract bullet if the release changes a standing contract (present tense, one statement, never appended). What a release *did* goes in `CHANGELOG.md` / the ROADMAP audit log; the full mechanics go in `docs/invariants.md`.
- `CHANGELOG.md` (add a new version section — see its top banner. Docs-only compat checkups that DON'T bump the version are logged in ROADMAP's Post-GA audit log instead, not here.)
- then run `bun run build && bun run generate:surfaces` to regenerate `plugins/kimi-codex/` (manifest version + bundled runtime), and stage it.

Before release validation, run `bun install --frozen-lockfile`; never reuse an
unchecked local dependency directory as proof of a reproducible build. Regenerate
and stage both distributions, then run `bun run check`. Compiled-runtime
regressions must execute the emitted JavaScript, not only Bun's TypeScript loader.

Commit and push the release commit, wait for its CI check to pass, then
`git tag -a vX.Y.Z -m "..."`, `git push origin vX.Y.Z`, and
`gh release create --verify-tag`. A published tag is immutable; fix forward.

### npm distribution

`package.json` has an explicit publication file allowlist. `bun run check:package`
packs the plugin, verifies both compiled distributions byte-for-byte, and runs
setup/check plus unsupported-version refusal in temporary homes. It must not
use live credentials, plugin state, or model calls. CI runs it after the full
check. `publish.yml` builds/tests a release tag, then publishes that exact tarball
through npm OIDC in the `npm` environment. See `docs/registry-releases.md`.
