# AGENTS.md

Project context for coding agents. This is the **contract sheet**: standing rules in present tense, with full mechanics and rationale in [docs/invariants.md](docs/invariants.md) and the linked owning docs. Keep this file under 24 KB. `CLAUDE.md` imports it with `@AGENTS.md`, so there is one source and nothing to mirror. Release history lives in [CHANGELOG.md](./CHANGELOG.md) and [ROADMAP-TO-GA.md](./ROADMAP-TO-GA.md), never here.

## Quick reference

- **Version**: 2.5.3 (kimi-code, subprocess transport, **native agent-core-v2**).
- **Native-v2 safety** (§1): every executed tool passes managed PreToolUse; the chain-breaking plan-file allow is NEVER armed. Preserve all four closures: same-child-home preflight rejects every normalized `default_plan_mode` spelling; Enter/ExitPlanMode is denied for every label; resume requires proven native-v2 lineage and every-agent raw journal plan-taint scans; unsafe experimental selectors are refused. Local execution is mandatory: reject nonlocal defaults, disabled workspace trust, and resumed nonlocal or wrong-root bindings; fresh 2.5.0/2.5.1 print selects `--environment local`, while launcher environment selectors are refused. Require the exact-version first-line marker, validate Bash.cwd against the trusted root, and require source, plan-ON control, and per-operation smoke evidence for every certification row. Legacy-v1 never gains 0.42. Full rules and evidence: [docs/invariants.md §1](docs/invariants.md) and [certification provenance](docs/native-v2-certification-provenance.md).
- **Hook-pin durability** (§1): canonical hook commands avoid version-stamped Node tokens; `process.argv0` is eligible only when absolute and realpath-identical. `verifyHookInstalled` fail-closed checks the parsed-back Node token with `access(X_OK)`. Re-pin recovery happens only when `retryable_after_setup` is literally true and setup exits 0, then retry ONCE. `node-bin-not-executable` has a different remedy; in-verifier auto-repin is rejected.
- **Test discipline** (§1): detached-worker enforcement tests use a real node subprocess through a symlink, without `KIMI_PLUGIN_CC_NODE_BIN` or `KIMI_PLUGIN_CC_SKIP_HOOK_CHECK`. Host-dependent smoke asserts its precondition; never test the never-armed plan-file allow as though it were active.
- **Upstream compat** (§2): certification is EXACT and per-operation in `runtime/kimi-engine.ts`; legacy-v1 ends at 0.41.x for an explicitly pinned binary. The upstream plan-service allow still bypasses hooks through 2.5.0/2.5.1, so every no-plan closure remains mandatory. Each audit re-verifies all surfaces in [docs/upstream-compat-audit.md](docs/upstream-compat-audit.md) and [docs/invariants.md §2](docs/invariants.md); monitor reports never certify. Swarm activation/deactivation, identity/quiescence, child-journal correlation, and real rescue/Bash.cwd controls follow [docs/native-v2-status.md](docs/native-v2-status.md).
- **Toolchain**: Node >=22.5 (>=24.9 for DSH), TypeScript, **bun** for development; npm CLI for registry operations and package installation.
- **Workflow**: edit `runtime/**/*.ts` → `bun run check` (build + contracts + surfaces + typecheck + tests + drift gate).
- **Installed-state verification**: resolve the host's active version-stamped install cache and run its bundled `scripts/companion.sh setup --check`. A checkout, package metadata, or another host's cache is not proof of active runtime state.
- **Credential-bearing config** (§3): never routinely read, print, copy, or retain `~/.kimi-code/config.toml` or `~/.kimi-code/credentials/`; use sanitized `setup --check` or `setup --models [--json]`. Explicit config diagnosis is limited to the managed hook block with credentials redacted; credentials are never read or copied.

## Directory layout

```
.claude-plugin/     Claude Code plugin manifest/marketplace — id stays kimi/kimi-marketplace
.claude/            Gitignored local audit workspace and upstream clones/reports
.agents/            Generated Codex marketplace sidecar; source.path points at plugins/kimi-codex
commands/           Claude Code slash-command wrappers over companion.sh
agents/             Claude Code subagent definitions
hooks/              Stop hook for the review gate; Kimi-side PreToolUse lives in runtime/hooks/
scripts/            Shell entry points + dev-only surface generator/registry
.mcp.json           Hash-pinned Claude MCP stdio launch config
plugins/kimi-codex/ GENERATED self-contained Codex root; never hand-edit:
  ├── .codex-plugin/plugin.json   Codex manifest (skills + MCP)
  ├── .mcp.json                   Generated MCP stdio launch config
  ├── skills/                     12 shell-backed skills, outside Claude discovery
  ├── scripts/                    Byte-mirrored shell entry points (0755)
  └── dist/                       Byte-mirror of compiled runtime
plugins/kimi-dsh/   GENERATED self-contained DeepSeek Harness bundle; never hand-edit:
  ├── package.json                Nested DSH bundle manifest with bounded engines
  ├── cordis.patch.yml           Native seven-operation provider composition
  ├── scripts/                    Byte-mirrored shell entry points (0755)
  └── dist/                       Byte-mirror of compiled runtime
runtime/            TypeScript source — the real runtime
  ├── background-spawn.ts  Shared detached-worker spawn helper (rescue + ask)
  ├── cli-client.ts        Subprocess wrapper around `kimi -p --output-format stream-json`
  ├── swarm-activation.ts  Exact-version loopback swarm activation/deactivation
  ├── stream-json.ts       Pure NDJSON parser
  ├── cli-cancellation.ts  AbortController-based cancellation
  ├── rescue-approval.ts   Workspace-bound allowlist used by the PreToolUse hook
  ├── commands/            One file per companion subcommand
  ├── dsh/                 Native DSH providers, human commands, and subprocess lifecycle
  ├── mcp/                 Typed tools, stdio/protocol, supervised launch, task ownership
  ├── hooks/               PreToolUse approval hook, policy, and install verifier
  └── schemas/             Structured review_gate output contract
dist/               Compiled JS — committed for zero-build install
tests/              bun test suite
```

## Commands

- `bun run check` — build, contract-size gate, generated-surface checks, typecheck, full tests, then drift gate for `dist`, `plugins/kimi-codex`, and `plugins/kimi-dsh`. Stage generated changes and retry when the drift gate requires it.
- `bun test <path>` — run one test file.
- `bun run build` — compile `runtime/**/*.ts` → `dist/**/*.js`.

The companion runs via `scripts/companion.sh <subcommand>` → `dist/companion.js`. Subcommands: `setup`, `review`, `task` (`rescue`, `challenge`, `pursue`, `swarm`), `ask`, `status`, `result`, `cancel`, `replay`, `repair-sessions`, `recover-swarm`, `mcp`.

## Architecture

**Thin hosts, rich runtime** — mirrors [codex-plugin-cc](https://github.com/openai/codex-plugin-cc):

- Host surfaces route only; runtime owns subprocesses, SQLite jobs, approval policy, and rendering.
- Commands: `slash/skill → companion.sh → companion.js → kimi -p --output-format stream-json → job store → artifact`.
- MCP: `tool call → companion.sh mcp → supervised mcp-child → the same execution plan, job store, and artifact`.
- DSH: `native provider → managed subprocess → dist/companion.js → the same execution plan, job store, and artifact`; no ACP transport.

**Key invariants** (full statements in docs/invariants.md §4 unless linked otherwise):

- **Subprocess-first.** One `kimi -p` runner per job; certified swarm jobs add only the bounded activation lifecycle in §2. Session-id capture is dual-source, first-announce-wins, pinned, idempotent, and meta is filtered from `records[]`; ids round-trip through `kimi -r`.
- **MCP transport and ownership.** Seven model tools plus job controls use per-request tasks capability; Codex legacy gets ordinary results, not native tasks. Fixed task/job UUIDs, bounded attachment, pinned data root/workspace, JSON-only stdout, identity revalidation, and reconnect-by-ID are mandatory. Disconnects never cancel; `jobs` owns outcomes and failed jobs return `isError:true` with artifacts.
- **DSH native providers.** The bundle exposes all seven operations with the same write boundaries as other hosts, plus `/kimi-setup`, `/kimi-status`, `/kimi-result`, `/kimi-cancel`. DSH pins host id `dsh` and an explicit data root; provider-owned env clears other-host and bypass overlays. Prompts follow `--`; profile model/thinking/budget/review-base options precede them. Only complete successful stdout reaches the parent; failures are bounded diagnostics and disposal awaits managed-range quiescence. Setup never runs implicitly; one-shot activations have no parent context, follow-up input, or per-call model overrides. DSH services/tool adapters are optional host-provided peers, so other hosts do not install the harness. DSH requires a patched host and profiles; package validation audits both and boots that same host (see docs/registry-releases.md).
- **Prompt and metadata separation.** Raw task text owns summaries/titles; full prefixed prompts own spawn/digest/recovery. Working-tree review includes untracked files; `--base` never treats dirty files as committed snapshots. Pursue uses `/goal --`, enforces the 4000-character objective budget including hints, and denies `SetGoalBudget`.
- **Managed hook enforcement.** Every model-spawning command requires the canonical PreToolUse hook; ask/review/challenge/rescue/pursue/swarm refuse before spawn when verification fails, and the review gate skips visibly. `KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1` is a tests/diagnostics bypass only, never a repair path or a v2-preflight bypass.
- **Hook-escape monitor** (§1): denied streamed calls whose result is not the managed denial record `mismatch`; absent results record `unresolved`. Findings are detection evidence, never failure; expose them through logs, `hook_escapes`, status/result/stderr, and timeout details. Never fail a job without positive execution evidence.
- **Exact hook verification.** Rebuild canonical command bytes; parse COMPLETE TOML with vendored smol-toml@1.9.1; validate every hook and the managed grammar. Markers are not durable: only absent-state fallback accepts a real-parser-proven clean enforcing table with byte-exact command, no matcher, and no extra keys. Never substitute substring/line scanning; pruning stays conservative and host-scoped.
- **Serialized config mutation.** Hold the private adjacent lock across read-modify-write and publish atomically. No-follow/nonblocking/regular-file capped reads, bounded acquisition, no live-owner theft, ABA-safe stale recovery, inode/token rechecks, home 0700, config/lock 0600. Normalize inline hooks and remove only lexically proven orphan marker comments with warnings, across hosts when necessary; preserve surrounding content and every other host's hook. Setup/check fails on any remaining config, schema, block, path, or probe failure.
- **Host-scoped managed blocks.** Claude Code, Codex, and DSH share config.toml but own separate host-id blocks; DSH pins `dsh`. Install/uninstall is per-host and exact, prunes only strictly owned marker-less hooks, and never touches hand-rolled hooks. `--uninstall --all` is the sole every-host sweep. Coexistence relies on kimi-code's any-block-wins aggregation.
- **Rescue write policy.** Rescue and pursue share `evaluateRescueHookRequest`: shell-quote parsing, mutating/output/exec-flag detection, symlink/realpath containment, and report-writer rejects. Test runners execute repo code by design; internal Git context commands retain the repository-config/helper trust boundary documented in [docs/safety.md](docs/safety.md).
- **No Git mutation.** Rescue cannot mutate Git state; the calling host owns branch and commit decisions.
- **Pursue (experimental).** Runtime-foreground-only autonomous `/goal --` with rescue write policy and hook enforcement on every turn; no Git mutation or resume, default finite 45m wall-clock budget. Only trusted pursue/root permits exact GetGoal and terminal UpdateGoal complete/blocked; creation/reactivation/budget mutation remains denied. Preserve rescue lineage, immutable operation export, legacy goal flag, and terminal exits 0/3/6.
- **Read-only swarm.** Exact `AgentSwarm` is added to the read-only set; singular `Agent` is denied and every child fires the same eager hook. Mandatory finite budget (default 30m); `--cap` is a soft total hint, `--max-concurrency` a hard peak cap (default 4, always exported). Never merge the flags. Internal Git trust boundaries still apply.
- **Write-swarm is patch-only.** Use a born-HEAD detached worktree under the plugin data root while `job.cwd` stays the user workspace. Forge-proof trusted root confines every write; children have disjoint targets, no Git, and no nested swarm. Require verified hooks, finite budget, dirty-tree warning, and default hard concurrency 1. Capture an untruncated binary patch before any ordinary cleanup; capture/cleanup failure retains the tree. Never apply/commit or delete abandoned trees by age. Prefer explicit cancellation over hard interruption. Pursue writes the real workspace; swarm-write returns a discardable patch.
- **`goal.summary` and retry metadata.** Capture role-less `goal.summary` on `CliClientResult.goalSummary`; model/filter `turn.step.retrying` like other wrapper metadata, while malformed shapes enter diagnostics.
- **Plugin data ownership** (§5): `KIMI_PLUGIN_CC_DATA` is the explicit absolute override. Standard installs derive host-specific paths from the loaded package; conflicting shared values refuse before store access. DSH selects `$DSH_HOME/plugin-data/kimi-plugin-cc` or an absolute override and clears shared host variables. No automatic migration; detached workers pin the selected root and Stop skips visibly on resolution failure.
- **Jobs are authoritative.** SQLite terminal states are permanent. Nullable response budgets and `budget_source` preserve explicit/inherited/default provenance for ask/rescue/review/challenge; pursue/swarm persist effective safety ceilings. Detached workers reload budgets from SQLite; inherited ask/rescue budgets print at launch.
- **Session visibility and titles.** Settled native-v2 sync fills only missing redacted previews (≤4000 chars) and invalidates the shared index; preserve manual/native titles and replaceable fallback semantics. Never auto-invoke the native title endpoint. `repair-sessions` previews by default, writes only with `--apply` after a prompt-digest match, and excludes review-gate sessions. See [docs/session-visibility.md](docs/session-visibility.md).
- **Model selection.** `--thinking` requests effort through `KIMI_MODEL_THINKING_EFFORT`; omission preserves ambient env and resumes do not inherit. Honoring is unverifiable over stream-json. Omit `-m` for fresh defaults; resumes keep session models and per-run aliases never change saved defaults. `setup --models [--json]` is a credential-safe inventory, not a connection test; never guess aliases or fall back silently. Provider setup stays in `/login` or `/provider`, saved-default changes in explicit `/model`. See [docs/models.md](docs/models.md).
- **Prose pass-through.** review/challenge/ask/rescue emit raw prose. Only the review gate parses Kimi output, as a disabled-by-default Stop hook that fails open on malformed output/timeout and skips visibly without valid enforcement.
- **LLM-caller discipline.** stderr is for humans; load-bearing results use stdout, exit codes, or SQLite. Unknown flag-shaped tokens fail `INVALID_ARGS`; leading `--help` prints supported usage and exits 0. `RuntimeError.details` carries structured context; CLI errors stay bounded diagnostics and never override lineage/prose/exits. `result <jobId> --json` exposes the structured envelope, budget provenance, and captured session id/source.
- **Cancellation.** AbortController + SIGTERM → SIGKILL (1500ms), with teardown a settlement barrier. Revalidate PID/PGID/start identities, confirm bounded quiescence, never signal replacements, and emergency-kill the owned root on teardown failure; Windows remains direct-child-only. Budgets are finite ≤24h and unaffected by backgrounding. Clean non-aborted exit-0 wins same-tick expiry. Only budget timeouts may retain partial prose and a proven session; cancellation never captures partial output. Preserve `settled_post_abort`, recovery, and lineage gates.
- **Durable swarm recovery.** Record launch intent and verified identities before enabling swarm; never store tokens. `recover-swarm` previews by default; `--apply` only recovers the current repo's stopped owner after identity/session revalidation, and captures but never applies/deletes the worktree. Terminal outcomes never change; abandoned running jobs fail, never succeed. Normal cancellation launches no recovery, and no age-only orphan deletion exists. See [docs/swarm-recovery.md](docs/swarm-recovery.md).
- **Spawn diagnostics.** Preserve structured process causes and never translate argument/resource exhaustion into reinstall advice. Windows rejects known-overlimit UTF-16 argv with `CLI_COMMAND_LINE_TOO_LONG` and omits the prompt. Print prompts remain argv-backed; no stdin transport or Windows large-review support is implied.
- **Config mode.** `writeConfigAtomic` preserves 0o600 by chmodding the temp file before rename.

## Post-GA roadmap

See [ROADMAP-TO-GA.md](./ROADMAP-TO-GA.md) for pre-GA history and the living audit log. v1.0.0 GA shipped 2026-05-26. Open items: H1 enforcement (2.2.1 ships read-only DETECTION; fail/stop needs positive execution evidence in MoonshotAI/kimi-code#4241), filesystem-dependent write-label coverage, and swarm subagent coverage. H5 is a requested thinking knob, not a guarantee. H3/H4/H8/H9 closed in v1.2.x; H7 real-binary smoke (`bun run smoke:real`) is manual-dispatch CI and requires `KIMI_MODEL_API_KEY` for model calls.

## When editing

- Read the runtime before changing it; several safety invariants are not obvious from file names.
- Run `bun run check` before considering a change done.
- After `runtime/**` or `scripts/*.sh` changes, run `bun run build && bun run generate:surfaces`, then stage `dist/`, `plugins/kimi-codex/`, and `plugins/kimi-dsh/`. Both generated trees forbid hand edits; edit source and regenerate.
- `check:surfaces` verifies Claude byte hashes, current Codex/DSH generated text, byte-exact runtime mirrors, and no orphaned generated files. Re-pin Claude bytes in `CLAUDE_SURFACE_HASHES` with `shasum -a 256 <file>` whenever they change.
- `dist/` and both `plugins/` trees are committed for zero-build installs. The drift gate catches stale generated output.
- Agent definitions register at session start; mid-session edits require slash commands or direct `companion.sh` until the host reloads.
- `.claude/` is gitignored; local notes and worktrees stay uncommitted.
- **Tests never inherit host plugin env.** `bunfig.toml` preloads `tests/helpers/preload.ts` to delete host root/data and per-spawn overlays. Tests requiring those paths set their own explicitly; dependency directories stay out of test discovery and the preload is never removed.
- Keep comments limited to current, non-obvious constraints. Update comments/docstrings with behavior changes; history belongs in the changelog/audit log.
- **Changing a contract** requires the full statement in `docs/invariants.md` and its short summary here. Rationale and archaeology belong in owning docs or logs.

## Releasing

Plugin versions use ordinary SemVer and may align with the certified kimi-code version, but the number is never compatibility evidence; state exact certified CLI versions separately. Never reuse a published version/tag or encode an upstream patch with leading zeros. Source audit, exact-binary controls, per-operation smoke, and full check are mandatory. The runtime certification table is authoritative ([docs/invariants.md §2](docs/invariants.md)).

`runtime/version.ts` is the SINGLE version source; `scripts/surface-registry.ts` propagates it to Codex and DSH manifests. A version bump touches:

- `runtime/version.ts`, `package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`; re-pin both manifest hashes in `CLAUDE_SURFACE_HASHES`.
- `scripts/surface-registry.ts`: update `DSH_PUBLISH_TIMESTAMP` with the actual publication time; `generate:surfaces` refreshes `dsh/index.json` and its test checks version/timestamp/range.
- `AGENTS.md`: bump the version and REPLACE any changed standing contract in present tense; what a release did belongs in `CHANGELOG.md` or the ROADMAP audit log, mechanics in `docs/invariants.md`.
- `CHANGELOG.md`: add a version section for releases, not docs-only compatibility checkups.
- Run `bun run build && bun run generate:surfaces` and stage all three distributions.

Before release validation, run `bun install --frozen-lockfile`; never reuse an unchecked dependency directory as proof of reproducibility. Regenerate/stage all distributions, then run `bun run check`. Compiled-runtime regressions must execute emitted JavaScript, not only Bun's TypeScript loader.

Commit and push the release commit, wait for CI, then `git tag -a vX.Y.Z -m "..."`, `git push origin vX.Y.Z`, and `gh release create --verify-tag`. Published tags are immutable; fix forward.

### npm distribution

`package.json` allowlists publication files. `bun run check:package` packs the archive, rejects sync-conflict copies, byte-checks all three compiled distributions, and runs isolated setup/check, unsupported-version refusal, and modern/legacy MCP smokes without credentials, live plugin state, or model calls. CI runs it after the full check. `publish.yml` builds/tests a release tag and publishes that exact tarball through npm OIDC in the `npm` environment. See [docs/registry-releases.md](docs/registry-releases.md).
