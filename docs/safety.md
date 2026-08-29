# Safety

How kimi-plugin-cc v1.0 enforces the difference between "Kimi can answer my question" and "Kimi can rewrite my source tree."

## Why the safety story is hook-based

kimi-code's `kimi -p` mode hard-codes `permission: 'auto'` and registers an auto-approve handler for every tool call. There is no argv flag to disable this — `-p` is a non-interactive batch mode and assumes the caller wants tools to run unattended. That's a sensible default for a coding agent invoked directly from a terminal. It's the wrong default when a plugin is forwarding a read-only review request and the user expects no shell or file mutations to happen.

The plugin therefore enforces per-command safety **outside** kimi-code's permission system, using the PreToolUse hook mechanism that kimi-code itself supports. A single hook entry in `~/.kimi-code/config.toml` runs before every tool call on the supported default-v1 path. The hook reads an env var the plugin sets per spawn (`KIMI_PLUGIN_CC_CMD=ask|review|challenge|review_gate|rescue|swarm|swarm-write`) and answers `allow` or `deny` according to a per-command policy. Experimental agent-core-v2 is refused before spawn because its plan-file final allow can run before external hooks; see below.

```
┌──────────────────────┐    KIMI_PLUGIN_CC_CMD=review     ┌──────────────────────┐
│ /kimi:review         │ ───────────────────────────────► │ kimi -p              │
│   (companion.sh)     │                                  │   (permission:auto)  │
└──────────────────────┘                                  └─────────┬────────────┘
                                                                    │
                                                                    │ PreToolUse:
                                                                    │   Bash
                                                                    ▼
                                                          ┌──────────────────────┐
                                                          │ approval-hook.js     │
                                                          │   reads env var,     │
                                                          │   applies policy,    │
                                                          │   exits 2 + stderr   │
                                                          │   (deny)             │
                                                          └──────────────────────┘
```

If the hook is missing or invalid, **every model-spawning command fails closed before Kimi starts**: rescue/pursue/swarm already refused, and v1.8 extends the same rule to ask/review/challenge. The review gate cannot safely block a host Stop event without enforcement, so it skips visibly instead of spawning an un-enforced Kimi turn. `/kimi:setup` also runs a two-layer probe before reporting success so missing-Node-on-PATH and broken-quoting failures surface up front instead of at first tool call. `KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1` remains an explicit tests/diagnostics escape hatch for hook verification; it accepts kimi-code's unsafe `permission: auto` posture but **does not** bypass `CLI_V2_HOOK_ORDER_UNSAFE` and is never a repair path.

## The managed block

`/kimi:setup` writes a marker-delimited block to `~/.kimi-code/config.toml`:

```toml
# === BEGIN kimi-plugin-cc-managed:claude-code (vX.Y.Z) ===
# DO NOT EDIT — managed by /kimi:setup. Run /kimi:setup --uninstall to remove.
# Host: claude-code — Claude Code and Codex each own a separate block in this
#   shared ~/.kimi-code/config.toml; setup in one host never touches the other's.
# Purpose:
#   kimi-code's `kimi -p` mode hard-codes permission='auto' and
#   auto-approves every tool call. This hook enforces /kimi:review,
#   /kimi:challenge, /kimi:review_gate, and /kimi:ask as read-only,
#   and applies the workspace-bound rescue allowlist for /kimi:rescue.
#   Without this block the plugin's safety contract collapses.
# Matcher field is intentionally OMITTED — kimi-code compiles the
#   matcher with `new RegExp(...)`. An empty/missing matcher means
#   "fire for every tool". The string "*" would throw and silently
#   disable the hook. Do not "fix" this.
# The Node binary path is absolute so kimi-code's `/bin/sh -c`
#   hook spawn doesn't need `node` on its PATH (GUI launches,
#   LaunchAgents, etc.).
[[hooks]]
event = "PreToolUse"
command = "'/abs/path/to/node' '/abs/path/to/dist/hooks/approval-hook.js'"
timeout = 15
# === END kimi-plugin-cc-managed:claude-code ===
```

The `vX.Y.Z` marker is replaced with the live plugin version by
`runtime/commands/setup.ts`. Both the node binary path and the hook
script path are shell-quoted via `runtime/hooks/install-paths.ts`
before they reach the config (so a path containing spaces or quotes
can't bypass the safety contract through argv splitting).

Key constraints (verified by [`runtime/hooks/managed-block.ts`](../runtime/hooks/managed-block.ts) on both install and verify):

1. **No `matcher` line.** kimi-code compiles the matcher field via `new RegExp(matcher)`. An empty matcher means "fire for every tool." `new RegExp("*")` throws, which kimi-code catches and treats as "no matcher" → silently disables the hook. The installer omits the field intentionally; the verifier rejects any block that contains a `matcher = ...` line.
2. **Absolute Node path.** kimi-code spawns hook commands via `/bin/sh -c "<command>"`. If we wrote bare `node`, the shell would resolve it against kimi-code's PATH at execution time. On a system where kimi-code launches from a GUI/LaunchAgent with a sanitized PATH (nvm/asdf/mise users), bare `node` would exit 127 → hook protocol treats non-{0,2} as **allow** → safety contract collapses with no user-visible signal.
3. **TOML basic-string escaping.** The command field is a TOML basic string. Quotes, backslashes, newlines, and control characters in the resolved hook path are escaped during install; paths containing characters that cannot be safely escaped (literal `"`, raw control chars) are rejected up front with `SETUP_HOOK_PATH_UNSAFE`.
4. **Exact marker grammar.** The verifier rejects stray comments containing the marker tag, partial references, duplicate blocks (from a setup race), and orphan markers (from a manual edit). The same parser is used by both the installer and the per-call verifier so the two cannot disagree.
5. **Exact command equality, per host.** The verifier reconstructs the canonical command byte string from the current env and equality-checks the installed `command` (never a substring — a crafted `true # /path/to/approval-hook.js` runs only `true` and would auto-allow). This holds *per host id* (below): each host verifies its own block.
6. **Full-config parse and whole-hook-array validation.** The verifier parses the complete file with vendored `smol-toml@1.6.1`, matching kimi-code's parser, before inspecting the managed block. It then applies upstream's strict config schema to every configured hook (`event`, optional string `matcher`, non-empty `command`, optional integer `timeout` 1–600, no extra fields). A malformed unrelated TOML value or one invalid foreign hook can make kimi-code discard enforcement; both therefore fail verification.
7. **Serialized, identity-bound setup mutations.** Install and uninstall hold a private `0o600` sibling lock across the complete read-modify-write transaction. The candidate lock is published atomically; lock reads are no-follow, nonblocking, regular-file-only, and capped at 4 KiB. Acquisition is bounded, live owners are never stolen, stale recovery is guarded by a nonrecursive recovery lease, and inode/token ownership is rechecked before config mutation or lock removal. Simultaneous Claude Code/Codex setup runs therefore cannot lose either host's block, and a replaced lock is never treated as ours. A newly created Kimi home is `0o700`; atomic config writes remain `0o600`.
8. **Inline hook arrays are normalized before insertion.** kimi-code accepts both `hooks = [...]` and `[[hooks]]`, but appending a managed array-of-tables block after an inline assignment can produce a conflicting document. Setup converts a valid inline hook array to canonical `[[hooks]]` tables before inserting the host block and emits an explicit warning that formatting and comments inside that assignment are normalized. Surrounding config bytes are preserved.

### Host scoping (Claude Code ↔ Codex share one config)

Claude Code and Codex install this plugin to **different, version-stamped
paths** (`~/.claude/plugins/cache/…` vs `~/.codex/plugins/cache/…`) but read
the **same** `~/.kimi-code/config.toml`. So the managed block is **host-scoped**:
its marker carries a `:<host-id>` suffix, and each host owns, verifies, and
uninstalls only its **own** block.

- **Host id** (`runtime/hooks/install-paths.ts::resolveHostId`) is derived
  version-independently from the hook path: `~/.claude/…` → `claude-code`,
  `~/.codex/…` → `codex`, else a stable `host-<sha1>` for dev checkouts. A
  plugin upgrade *refreshes* the same host's block rather than adding a new one.
- **No clobbering.** `/kimi:setup` (Claude) and `$kimi-setup` (Codex) each write
  their own block and leave the other's byte-identical. Before v1.7.0 there was
  a single block exact-matched to the running host, so the two hosts overwrote
  each other and the loser's write-commands refused with "hook path drift."
- **Enforcement is redundant-safe.** kimi-code fires *every* `[[hooks]]` entry
  and aggregates **any-block-wins** (first `block` wins). Both hosts' hooks run
  the same allowlist logic, so the current host's live hook always enforces —
  even if another host's path is stale (a stale path fails open, but the live
  one still denies). A drifted *own* block is still caught at the per-command
  verify gate, which prompts a re-setup for that host only.
- **Migration + cleanup.** A pre-v1.7.0 un-suffixed block is adopted and
  converted in place by the current host on its next `/kimi:setup`. Orphaned,
  marker-less `[[hooks]]` entries that are unambiguously our approval hook
  (canonical command, `approval-hook.js` under a kimi-marketplace/kimi-plugin-cc
  tree) are pruned **host-scoped** (v1.8.2): install and scoped uninstall touch
  only tables whose command path derives to the *current* host. `/kimi:setup
  --uninstall` removes only the current host's block (plus legacy + this host's
  orphans); `/kimi:setup --uninstall --all` removes every host's block and every
  plugin-owned table. Hand-rolled user hooks are never touched.
- **Markers are not durable — verification does not depend on them (v1.8.2).**
  kimi-code persists its config via smol-toml `stringify(parse(...))` on every
  login/settings write, which deletes ALL comments — the managed-block BEGIN/END
  markers included — while the `[[hooks]]` table (data) survives and keeps
  enforcing. When this host's marked block is absent, the verifier falls back to
  a marker-less table whose decoded `command` is **byte-identical** to the
  canonical expected command, under the same strict grammar (PreToolUse event,
  no matcher, no keys beyond event/command/timeout). Anything weaker — drifted
  path, matcher-bearing table, foreign keys — still refuses. The fallback never
  applies over duplicate/orphan/invalid marked states. The next `/kimi:setup`
  re-adorns the markers; the other host's marker-less table is that host's LIVE
  hook and is left byte-untouched (pre-v1.8.2, the host-blind prune here caused
  each host's setup to disarm the other after any kimi login — the "seesaw").

## The hook's per-command policy

[`runtime/hooks/approval-policy.ts`](../runtime/hooks/approval-policy.ts) is the single source of truth:

| `KIMI_PLUGIN_CC_CMD` | Allowed tools | Denied tools |
|---|---|---|
| unset / empty | everything | nothing (kimi was invoked outside the plugin) |
| `ask` | `Read`, `Grep`, `Glob`, `ReadMediaFile`, `TaskList`, `TaskOutput` | everything else, including `Bash`, `Write`, `Edit` |
| `review`, `challenge`, `review_gate` | same as `ask` | same as `ask` |
| `rescue` | governed by [`evaluateRescueHookRequest`](../runtime/rescue-approval.ts) against the plugin-owned `KIMI_PLUGIN_CC_WORKSPACE_ROOT` — workspace-bound shell allowlist, symlink-aware path containment, mutating-flag detection on `git`/`find`/`sed`, etc. | missing-root writes and every shell command, file edit, or write that the allowlist rejects |
| `swarm` | same read-only set as `ask`, plus exact `AgentSwarm` | everything else, including singular `Agent`, shell, and writes |
| `swarm-write` | read-only set + `AgentSwarm`; `Write`/`Edit`/`Bash` only through the rescue evaluator against the trusted ephemeral-worktree root | singular `Agent`, missing-root writes, and everything the rescue evaluator rejects |
| unknown label | `Read`, `Grep`, `Glob`, `ReadMediaFile`, `TaskList`, `TaskOutput` | everything else (conservative-deny for stale/misconfigured callers) |

`EnterPlanMode` is explicitly denied before any per-label write evaluator for every managed label. Denied tool calls exit the hook with code 2 and write a reason to stderr. kimi-code surfaces the reason to the model, which can adapt and try a different approach (e.g., use `Read` instead of `Bash cat`).

### Native agent-core-v2 refusal and legacy-v1 pin

v1.9.4 corrects an earlier audit claim: agent-core-v2 external PreToolUse hooks are awaited on ordinary calls, but they are **not** registered ahead of every final allow. Production listener order puts `AgentPlanService` before `AgentExternalHooksService`. While plan mode is active, a `Write` or `Edit` whose write accesses target only the exact current plan file calls final `event.allow()`; listener iteration stops and the managed hook is never invoked.

The permitted path is confined to `<KIMI_CODE_HOME>/sessions/<workspace>/<session>/agents/<agent>/plans/<plan>.md`, not the user worktree. That confinement does not make the path compatible: the plugin's load-bearing promise is that every model tool call reaches its managed policy. The path is reachable on a **fresh** session when user config has `default_plan_mode=true`, and on a resumed session through restored plan state. Denying the model's `EnterPlanMode` tool alone is therefore insufficient.

`runtime/cli-client.ts` fails closed before process creation whenever `KIMI_CODE_EXPERIMENTAL_FLAG` has one of the truthy values `1`, `true`, `yes`, or `on` (trimmed and case-insensitive). The refusal is `CLI_V2_HOOK_ORDER_UNSAFE` with `refusal_kind:"v2-hook-order-unsafe"`. It is **not** hook-install drift and `/kimi:setup` is not the remedy; unset the experimental flag.

kimi-code 0.33.0 changed the other half of the routing contract: native v2 is now the unflagged `kimi -p` default, and `KIMI_CODE_LEGACY_FLAG=1` is the upstream-supported v1 opt-out. The plugin does not trust ambient engine state. After accepting the explicit-experimental check, `buildEnv` overwrites the child process's legacy flag to `1` for every fresh or resumed run. Older kimi-code releases ignore the unknown flag. Ambient false values are deliberately overwritten; preserving one would silently reopen native v2 on 0.33+. Unit tests prove the flag reaches both fresh and resumed children, and the exact-binary smoke asserts no v2 `system.version` record appears even when the isolated config enables default plan mode.

This is a visible engine-selection policy, not a general license to rewrite operator configuration: only the spawned child env changes; the user's shell and `config.toml` are untouched. The experimental flag remains an explicit refusal rather than being deleted silently.

Re-enable v2 only after an exact released kimi-code tag guarantees external-hook veto before any final plan allow. The release gate must then cover both a fresh `default_plan_mode=true` session and a session whose plan state was persisted out of band, proving the hook fires and blocks the plan-file write in each case.

The complete operation-by-operation gate, execution-plan schema, historical
unknown/evidence rules, and rollout state machine are committed in
[`native-v2-certification-provenance.md`](native-v2-certification-provenance.md).
New jobs persist an explicit forced-v1 command/version plan today; native v2's
production capability matrix remains empty. A native-v2 `system.version` marker
under that plan triggers immediate process-tree teardown before later records
are delivered.

## The rescue allowlist

For `/kimi:rescue`, the hook delegates to [`evaluateRescueHookRequest`](../runtime/rescue-approval.ts). This is the same workspace-bound allowlist code that v0.4 carried — kept verbatim from PR 3's port. Highlights:

- **File edits** (`Write`, `Edit`): the file path must resolve inside the workspace (`realpath`-based check), must not be inside `.git/`, and must not be a symlink that escapes the workspace.
- **Shell commands** (`Bash`): the command is parsed with `shell-quote`. Pipelines are split and each stage validated independently. Mutating flags on `git` (`commit`, `push`, `reset --hard`, ...), `find` (`-delete`, `-exec`), and `sed` (`-i`) are rejected.
- **Package-manager scripts**: `npm/pnpm/yarn/bun/uv run <script>` is rejected because `package.json` scripts can run anything. The `<pm> test` shorthand IS allowed (npm/pnpm/yarn test, bun test, uv test) — under the assumption that test runs are intentional and the developer trusts their own workspace's test config. If you don't, use direct test invocations (`pytest`, `tsc --noEmit`, `eslint`, …) instead and have your tooling refuse the `<pm> test` form.
- **Output-to-file flags**: every shell command — regardless of which binary — is rejected if its argv contains `--output`, `--output-file`, `--output-directory`, `--output-dir`, or any `<flag>=<path>` prefix form. These flags let a command write to an arbitrary path through its own report-output mechanism, bypassing the file-edit path containment check (e.g. `git diff --output=/etc/passwd`, `curl --output /tmp/payload`, `eslint . --output-file=/tmp/exfil.json`). The bare `-o` short form is NOT blanket-banned (too many read-only tools use it, e.g. `rg -o` for `--only-matching`), but the per-tool validator rejects it where the binary's semantics make it a write flag (`eslint -o`, `go -o`, `ruff check -o`, `sort -o`). `uniq IN OUT` (which writes its second operand) is rejected in pipelines.
- **Exec-delegating flags**: every shell command is rejected if its argv contains a flag whose *value* is run as a command or external tool — `--open-files-in-pager` (`git grep --open-files-in-pager=touch /tmp/x needle` makes git execute `touch`; same class as the pre-subcommand `git -c core.pager=` smuggle, just via a subcommand flag — also the `-O` short form under `git`), `-vettool` / `-toolexec` / `-exec` (`go vet -vettool=<bin>`, `go test -exec <bin>`). These were the CRITICAL/HIGH findings of the 2026-05-28 allowlist audit (report 43).
- **Report-writing flags on type/test tools**: `mypy --junit-xml`/`--*-report` and `pytest --junitxml`/`--result-log`/`--report-log` write to arbitrary paths and are rejected.
- **Read-safe commands** (`ls`, `cat`, `head`, `tail`, `rg`, `pwd`, `wc`, `git status`, `git diff`, ...): allowed.
- **`.git/`**: every file-edit path check excludes anything inside `.git/`. Shell commands cannot include `git commit`, `git push`, `git reset --hard`, etc. Branch and commit ownership stays with the main Claude thread.

### Trust boundary: test runners execute workspace code

`/kimi:rescue` intentionally allows test/build runners (`go test`, `cargo test`, `pytest`, `python -m pytest`, `<pm> test`). **Running tests runs the workspace's own code** — test functions, `build.rs`, `conftest.py`, fixtures. The allowlist stops these from writing *outside* the workspace (their report-writing flags are rejected, above), but it cannot and does not sandbox the code they execute. This is the same trust the developer already extends to their own repo. If you run `/kimi:rescue` in a workspace you do not trust, assume any allowed test runner can execute arbitrary code from that workspace.

The full table lives in `runtime/rescue-approval.ts`. Test coverage is in `tests/runtime/rescue-approval.test.ts` — every accept-shape and every reject-shape has at least one regression test.

### Trust boundary: kimi-code 0.31 custom agents and system prompts

kimi-code 0.31.0 brings custom-agent discovery and plugin system-prompt contributions to the default v1 print engine. It discovers project profiles under `<git-root>/.kimi-code/agents` and `<git-root>/.agents/agents` as well as user and enabled-plugin sources. A profile declaring `override: true` can replace a builtin name such as `agent` or `coder`; `~/.kimi-code/SYSTEM.md` can replace the default main-agent prompt, and enabled plugins can append system instructions. The bound catalog/profile is snapshotted into the upstream session, so resume preserves the selected instructions rather than proving the current repository files are unchanged.

Treat these files as **trusted model instructions** before using write-capable rescue, pursue, or swarm-write in an unfamiliar repository. They can redirect the task, remove expected tools, or replace the builtin `coder` prompt; the exact-0.31 smoke proves confinement, not task fidelity. Agent-profile fields and system-prompt text cannot themselves set hook definitions, permission mode, or cwd, cannot enlarge `runtime/hooks/approval-policy.ts`, and cannot escape swarm-write's env-pinned ephemeral root. Enabled plugins may separately contribute hooks; kimi-code's any-block-wins aggregation lets those hooks add denials but not override this plugin's managed denial. Read-only labels remain write-denying even under a hostile profile. This is an intent/prompt-injection boundary, not authority to skip the managed hook or widen the write allowlist.

## Autonomous goal mode (`/kimi:pursue`, experimental)

`/kimi:pursue` (v1.1 prototype) hands Kimi an objective to pursue across multiple continuation turns via kimi-code's headless goal mode (`kimi -p "/goal ..."`, kimi-code 0.8.0+). It is **write-capable and reuses the rescue trust boundary**: it runs with `KIMI_PLUGIN_CC_CMD=rescue`, so the PreToolUse hook applies the exact same workspace allowlist above, and it cannot mutate git state.

> **Goal-mode entry gate (changed in 0.12.0).** Headless goal mode is reached by a `/goal`-prefixed prompt. On kimi-code 0.8–0.11 it is *additionally* gated by the `goal-command` experimental flag, which `pursue.ts` sets per-spawn (`KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1`). kimi-code 0.12.0 (PR #569) **removed that experimental-flag gate**, so the `/goal` prefix alone triggers goal mode. This does not weaken plugin safety: read-only commands (review/challenge/ask/review_gate) hard-prefix an English instruction line, so their trimmed prompt never starts with `/goal` and they cannot enter goal mode on any version; and the index-0 hook denies every write under a read-only label regardless. The env var `pursue.ts` sets is now redundant on 0.12.0 but harmless, and is kept for 0.8–0.11 compat.

- **The hook fires on every tool call in every continuation turn.** `PreToolCallHookPermissionPolicy` is policy index 0 (ahead of auto-mode-approve, which moved to index 5 when kimi-code 0.14.1 inserted `AgentSwarmExclusiveDenyPermissionPolicy` at index 1 — the structural invariant holds: every policy between the index-0 hook and the first approve is a DENY), and goal continuation turns are ordinary turns — there is no autonomous-continuation path that bypasses per-tool approval (verified against kimi-code 0.9.0, audit report 58; re-verified through 0.12.0 by the goal-mode real-binary smoke, reports 61-65). A goal-mode run is exactly as write-gated as a single-turn rescue. This is locked by a real-binary smoke (`tests/runtime/real-binary-smoke.test.ts`, run via `KIMI_PLUGIN_CC_SMOKE=1 bun test ... -t "goal mode"`): it runs real headless goal mode under a read-only label and asserts that **no file lands across the entire multi-turn run** — a hook miss on any continuation turn would land one.
- **The only new risk is unboundedness, and the plugin bounds it.** Headless goal create sets no token/turn budget; only the model (via `SetGoalBudget`) or an external signal stops the loop. `/kimi:pursue` therefore enforces a **mandatory finite wall-clock ceiling** via its AbortController (`--budget`, default 45m) — the SIGTERM→SIGKILL descendant-reaping cancellation reaps the whole goal process tree. `--turns` is a *soft* hint injected into the objective (the model may call `SetGoalBudget`); it is not enforceable headless. Treat `--budget` as the real bound.
- **Loop runaway is now also capped upstream.** kimi-code 0.8.0 (#364) detects repeated identical tool calls and force-stops a turn at a repeat streak. This benefits `/kimi:rescue`, `/kimi:ask`, and `/kimi:pursue` alike: a force-stopped turn ends *normally* (exit 0, flows through the plugin's success path — not a failure), reducing the chance an autonomous run spins against the wall-clock budget. It is a complement to, not a replacement for, the wall-clock ceiling.
- **Resume is intentionally not exposed yet.** In goal mode `goal.summary` emits a *goalId* distinct from the resume-hint *sessionId*; `kimi -r <sessionId>` re-enters the session but not necessarily the goal continuation. The plugin captures and surfaces the goalId but does not offer `--resume` for pursue until that split is reconciled upstream — exposing it now would be a silent-failure trap. **Re-verified against kimi-code 0.26.0 (2026-07-16):** the headless CLI still has no argv, prompt syntax, or session-resume path that calls `resumeGoal()`. `parseHeadlessGoalCreate` (`apps/kimi-code/src/cli/goal-prompt.ts`) accepts only the `/goal <objective>` *create* shape on both the v1 and experimental-v2 drivers, and upstream's own docs (`docs/en/guides/goals.md`, § "Use goal mode carefully") state that in non-interactive prompt mode *only goal creation is supported* — goal management is a TUI/kimi-web control. PR #552 makes a plain `-r <sessionId>` correctly *restore* the paused goal snapshot, but nothing in the headless path *acts* on it; the real `resumeGoal()` is wired only to the TUI (`/goal resume`) and kimi-web RPC (PR #1693, web-only). Implementing `--resume` would therefore require either prompt-injected model compliance (rejected — the plugin bounds autonomy with hard limits, not model goodwill) or abandoning the subprocess model for kimi-web's RPC. Re-check if upstream ever ships a headless `goal resume` verb.
- **A model-invocable `kimi-pursue` agent (v1.3) wraps this command.** The main Claude thread can dispatch autonomous goal mode, not just the human-typed `/kimi:pursue` — the same command↔agent mirror as rescue/review/swarm. Auto-dispatch does NOT widen the blast radius: pursue runs under `commandLabel: "rescue"`, so the index-0 PreToolUse hook + workspace allowlist gate every tool call on every continuation turn (no git mutation), and the mandatory `--budget` wall-clock ceiling bounds the autonomy regardless of who launched it. Because it is write-capable AND autonomous — the plugin's highest blast radius — the agent's description requires an explicit user request for hands-off multi-turn pursuit, steers single bounded tasks to `kimi-rescue`, and never auto-promotes a fix or a question into a goal loop. Like the command, it refuses without the hook and offers no `--resume`.

## Read-only swarm (`/kimi:swarm`)

`/kimi:swarm` (v1.2) fans a **read-only** review out across subagents using kimi-code's `AgentSwarm` tool (kimi-code 0.12.0+). The coordinator launches one subagent per target (file/module/question); each inspects the workspace with read tools and reports findings, which the coordinator consolidates into one markdown report. It opens **zero new write surface**.

- **The hook label is `swarm`, and it allows the read-only tool set PLUS `AgentSwarm`.** The coordinator must be allowed to call `AgentSwarm` (else the swarm never launches), but no write/edit/shell tool is allowed. The exact allowed tool name is `AgentSwarm` (verified against `packages/agent-core/.../collaboration/agent-swarm.ts`, `readonly name = 'AgentSwarm' as const`). The singular `Agent` tool is deliberately *not* allowed — swarm is the fan-out surface, not arbitrary delegation.
- **Every subagent inherits the `swarm` label and fires the same hook at policy index 0.** kimi-code builds each agent's permission stack via `createPermissionDecisionPolicies(agent)`, which puts `PreToolCallHookPermissionPolicy` at index 0 for *all* agents — there is no sub-vs-main branch (verified against 0.12.0). So a subagent's `Write`/`Edit`/`Bash` is denied exactly like a single-turn review's. The `SwarmModeAgentSwarmApprovePermissionPolicy` (index ~14) only auto-approves `AgentSwarm` *after* `swarmMode.enter()` runs inside `AgentSwarm.execute()` — i.e. after the index-0 hook already gated the coordinator's `AgentSwarm` call — so it cannot pre-approve around the hook. **This is locked by a real-binary smoke** (`tests/runtime/real-binary-smoke.test.ts`, run via `bun run smoke:real`): it spawns the real binary under the `swarm` label with an adversarial prompt that forces a spawned subagent to attempt a write, and asserts that **no file lands** and the hook deny marker appears — converting the subagent-denial claim from source-read-verified to runtime-test-verified.
- **Defense-in-depth: read-only subagent profile.** The coordinator prompt steers the swarm to `subagent_type: "explore"` — kimi-code's read-only exploration profile, whose tool loadout has *no* `Write`/`Edit` tools at all. That is a second layer beneath the hook: even setting the hook aside, an explore subagent has no file-editing tool to call. (The hook remains the load-bearing enforcement; the profile is belt-and-suspenders.)
- **Swarm refuses without the hook, like every model-spawning command.** A swarm makes the reason especially acute: it fans out up to `--cap` subagents, so a missing index-0 hook would remove enforcement from all of them at once. `KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1` remains an explicit tests/diagnostics escape hatch, not a recovery path.
- **The only new risk is COST, and the plugin bounds it.** Read-only swarm writes nothing, so the new risk is runaway cost from N parallel model runs (and possible nested `AgentSwarm`). `/kimi:swarm` enforces a **mandatory finite wall-clock ceiling** via its AbortController (`--budget`, default 30m); the SIGTERM→SIGKILL descendant-reaping cancellation reaps the whole subagent process tree. Two **distinct** subagent bounds: `--cap N` is a *soft* prompt-injected hint on TOTAL subagent count (the hook is stateless and cannot enforce a count, so the model may exceed it), and `--max-concurrency N` is a *hard* ceiling on how many subagents kimi-code's `SubagentBatch` runs concurrently — exported as `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` (PR #888) on **kimi-code 0.18.0+** (older binaries ignore the unknown env var, so on < 0.18 only the soft hint applies). It **defaults to 4** when the user passes none (`resolveSwarmMaxConcurrency` in swarm.ts), so every swarm run — agent-dispatched or human-typed — carries an enforced peak-parallelism ceiling on 0.18.0+ rather than falling back to kimi-code's internal ramp; pass an explicit value to widen or throttle. **Never merge them into one flag:** concurrency ≠ total count — a hard concurrency cap of N still permits more than N subagents over the life of the run, just never more than N at once. So the `--budget` wall-clock ceiling remains the real hard bound on total cost; `--max-concurrency` bounds *peak* parallelism (the spike in simultaneous model spend), and `--cap` is only an advisory total-count nudge. Folding both onto one flag would create the "cap-as-total-count illusion" — a user reading `--cap N` would expect a total bound but receive only a peak-parallelism one.
- **A model-invocable `kimi-swarm` agent (v1.3) wraps this command.** The `/kimi:swarm` slash command is human-only (`disable-model-invocation: true`, the blanket convention for *all* commands), but the `kimi-swarm` subagent lets the main Claude thread *dispatch* a read-only fan-out on its own judgement — the same human-command + model-invocable-agent split that `kimi-review`/`kimi-challenge`/`kimi-ask`/`kimi-rescue` already use. Swarm is a safe candidate for an agent precisely because it is **read-only (zero write surface)**: the only thing auto-dispatch adds is COST exposure, already bounded by the hard `--budget` and a hard `--max-concurrency` that the runtime now defaults to 4 for every swarm run (enforced on 0.18.0+) — so an auto-dispatched fan-out is bounded by construction, not by ignorable agent prose (the agent additionally restricts backgrounding to explicit user requests). `/kimi:pursue` ALSO gains a model-invocable agent (`kimi-pursue`, v1.3 — see the Autonomous goal mode section above): it is write-capable, but auto-dispatch widens no write surface (the rescue workspace allowlist + the index-0 hook gate every tool call on every continuation turn, and it cannot mutate git state) and removes no bound (the mandatory `--budget` ceiling holds), so its agent path is exactly as confined as its command path. Because it is the plugin's highest-autonomy surface, its agent description demands an explicit hands-off-autonomy request and steers single bounded tasks to `kimi-rescue`.

## Write-capable swarm (`/kimi:swarm --write`)

`/kimi:swarm --write` (v1.4) is the first WRITE mode for swarm: the coordinator and `coder` (write-capable) subagents EDIT files in parallel. It is **safe because the edits happen in a throwaway git worktree, not the user's checkout**, and the result is handed back as a patch the user reviews before anything touches their branch.

- **One ephemeral worktree for the whole swarm (Design A).** kimi-code spawns `AgentSwarm` subagents **in-process**, all sharing the coordinator's cwd (`subagent-host.ts:362`, `cwd: parent.config.cwd`) — so "a worktree per subagent" is impossible without abandoning `AgentSwarm`. Instead the plugin creates ONE detached worktree off HEAD (under its own data dir, never inside the user repo) and spawns the coordinator `kimi -p` with cwd = that worktree. Every subagent inherits it. The worktree is disposable: a botched run is thrown away.
- **Writes are confined by the hook to a forge-proof trusted root.** The `swarm-write` hook label routes write/edit/shell through the **rescue allowlist verbatim** (workspace check, symlink/realpath reject, mutating-flag + exec-delegating-flag detector, git-mutation deny), but scoped to `KIMI_PLUGIN_CC_WORKSPACE_ROOT` — the worktree path the plugin exports on the spawn — **NOT** the hook payload `cwd`. The model running inside kimi cannot set an env var on its already-spawned process, so confinement does not depend on how upstream derives the payload cwd for an in-process subagent. A missing trusted root **fails closed** (all writes denied). An out-of-worktree write (absolute path into the user's real tree) is rejected by the allowlist's `isWithin` check; a write to the worktree's `.git` pointer is rejected by the `.git`-segment check.
- **`coder` subagents really can write, and the hook is the sole boundary.** Verified against the kimi-code 0.18.0 source: swarm subagents use the STANDARD permission stack — the lone `DenyAllPermissionPolicy.unshift` in `subagent-host.ts` is inside `startBtw()` (the side-question path), NOT the swarm spawn path. So unlike read-only swarm (which has the `explore` profile's no-edit-tools as a second layer), write-swarm's `coder` subagents DO have edit tools, and the index-0 PreToolUse hook is the **only** write boundary — which is why the trusted-root confinement above is load-bearing and gated tightly.
- **The plugin never touches git; the main thread owns the merge.** Subagents cannot run git (allowlist denies mutation). The plugin captures the change set with `git add -N` (intent-to-add, so new files appear in the diff WITHOUT writing loose objects into the shared object DB) + `git diff --binary` (untruncated, applyable), writes it to a `swarm-write-<jobId>.patch` artifact, and prints the path. It does **not** `git apply`, commit, or move any ref — the user/main thread reviews the patch and applies it (`git apply <path>`). The worktree shares the main repo's object DB and refs, but no ref/HEAD is ever moved, so the user's repository state is untouched.
- **The patch is captured on every terminal path, before cleanup.** Success, cancel, budget-expiry, and failure all capture the (possibly partial) patch BEFORE `git worktree remove --force` discards the tree, so a cancelled run never silently loses the work the subagents already did. That guarantee covers the plugin's own terminal paths, including `companion.sh cancel`. It does **not** cover a harness interrupt: Esc/TaskStop delivers SIGTERM then SIGKILL after ~1.35s (measured, process-group-wide), which is shorter than the 1500ms child escalation plus quiescence plus patch capture — so a hard interrupt can kill the companion mid-teardown and lose the patch. `companion.sh cancel` signals from a separate process not racing that deadline and is the work-preserving stop. A startup sweep reaps worktrees orphaned by a hard kill (SIGKILL of the plugin process); its reap TTL is derived as `MAX_DURATION_MS + 2h` so it always exceeds the longest a run can live (the 24h `--budget` cap) and can never force-remove a still-live worktree out from under a concurrent run — the sweep's only liveness signal is the worktree dir mtime, which a run editing only existing files leaves frozen at `git worktree add` time.
- **Gated tightly.** Requires kimi-code **≥ 0.18.0** (below it `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` is ignored, so a write fan-out would have no hard peak bound — unacceptable for concurrent writers); because that cap cannot be guaranteed without a confirmed version, the write-mode version gate **fails closed** on an unconfirmable `kimi --version` probe (read-only swarm keeps failing *open* — a too-old read binary is only degraded, and its read-only hook still holds). Also requires a git repo with a **committed HEAD**, and the PreToolUse hook (**refuses** without it, like read swarm). Bases the worktree on HEAD, so a **loud warning** fires when the working tree is dirty (uncommitted work is not visible to the swarm). Default `--max-concurrency` is **1** (serialize) since disjoint-target partitioning is prompt-only and unenforceable by the stateless hook; the coordinator prompt also forbids git mutation and nested `AgentSwarm`.
- **Field-proven by a real-binary smoke.** `tests/runtime/real-binary-smoke.test.ts` runs the real `runSwarm --write` and asserts the POSITIVE end-to-end (a `coder` subagent's edits land in the worktree, captured as a patch; the user's real tree is byte-identical + git-clean; the worktree is cleaned up) plus the NEGATIVE (an absolute-path write outside the trusted root is hook-denied). It is the check that catches `tool_input` field-name drift — `Write`/`Edit` carry `path`, not `file_path`, and reading the wrong key denies every real write silently.
- **Model-invocable agent (v1.5), patch-only by construction.** Following the field-proof above, `--write` now has a `kimi-swarm-write` subagent so the main Claude thread can dispatch a write fan-out on its own judgement — the same human-command + model-invocable-agent split the rest of the suite uses. Auto-dispatch is a safe extension here because it widens **no** write surface and removes **no** bound: the agent path runs the identical `runSwarm --write` code, so edits still land only in the throwaway worktree, the index-0 hook still gates every `coder` subagent, the patch is still handed back for the user to apply (**the plugin never applies or commits**), and `--budget` + default `--max-concurrency` 1 + the hook requirement all still hold. In fact write-swarm is a *less* dangerous agent than the `kimi-pursue` agent already shipped: pursue writes directly into the workspace, whereas write-swarm's output is a patch the human reviews before anything reaches a real tree. Because it is still a write surface, the agent description demands BOTH signals — many disjoint write targets AND explicit fan-out intent — and steers single edits to `kimi-rescue`, read-only fan-outs to `kimi-swarm`, and autonomous loops to `kimi-pursue`. Default `--max-concurrency` stays **1**; raising it (concurrent writers) remains a deliberate, human-or-explicitly-requested choice.

## The setup probe

`/kimi:setup` runs a two-layer probe before reporting success:

1. **Direct probe.** Spawns the hook with the same Node binary (`process.execPath`) the companion is running under. Sends synthetic PreToolUse stdin with `KIMI_PLUGIN_CC_CMD=review` + a Bash tool request. Asserts exit 2 + non-empty stderr.
2. **Shell probe.** Re-runs the same payload via `/bin/sh -c "<command>"` — the exact spawn shape kimi-code's hook runner uses. Same assertion.

Both must pass. The shell probe catches the case where `process.execPath` works but `/bin/sh` can't resolve the path through quoting (a `KIMI_PLUGIN_CC_NODE_BIN` override pointing at a binary in a shell-unsafe path, for example). If either probe fails, setup reports failure with the captured stderr and the user can act on a clear signal rather than discover the gap by accident.

## How to verify the install yourself

```
/kimi:setup --check
```

Reports the current state without writing. The output line you want to see is `Probe: ok`. If the probe is failing, the `Details:` section shows which layer failed and what stderr was captured.

`/kimi:setup --check` is strict and exits nonzero on failure. It rejects an unloadable TOML file, any invalid configured hook, and any managed block that doesn't pass the [`parseManagedBlock`](../runtime/hooks/managed-block.ts) grammar (missing `[[hooks]]` table, wrong event, present `matcher = ...` line, duplicate blocks, orphan markers, or a stale hook-script path). `/kimi:setup` (without `--check`) can replace a malformed managed block, but it will not overwrite or silently work around invalid foreign config: if the complete candidate file would not load, setup leaves the existing file unchanged and identifies the bad hook or TOML line.

You can also inspect the managed block manually:

```bash
awk '/^# === BEGIN kimi-plugin-cc-managed/,/^# === END kimi-plugin-cc-managed/' \
  ~/.kimi-code/config.toml
```

The block should match the template at the top of this document. If the `[[hooks]]` line is missing, if `event` is something other than `"PreToolUse"`, or if there's a `matcher = ...` line — the installer should have rejected the block. Run `/kimi:setup --uninstall` + `/kimi:setup` to repair.

## How to opt out

```
/kimi:setup --uninstall
```

Removes the managed block from `~/.kimi-code/config.toml`. Subsequent kimi-plugin-cc command invocations:

- Every model-spawning command will refuse before Kimi starts with its command-specific `*_HOOK_NOT_INSTALLED` error.
- The review gate will skip visibly and allow the host to stop; it will not run an un-enforced model turn.

For tests or deliberate diagnostics only, `KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1` bypasses verification.

> **Note:** `KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1` disables every command's refusal safeguard and the review gate's skip, restoring kimi-code's `permission: auto` behavior. The bypass exists for setup probes and the test suite. Set it only when un-enforced Bash/Write/Edit auto-approval is an intentional part of the diagnostic.

## What this safety story does NOT cover

- **Malicious kimi-code binaries.** The threat model assumes the user trusts the kimi-code binary they installed. A hostile binary can ignore the hook entry in its own config.
- **TOCTOU between path check and edit.** The rescue allowlist resolves and checks paths at allowlist time. Between that check and the actual file write, an attacker with workspace write access could swap a symlink. The mitigation is workspace-write-trust — if untrusted code can edit your workspace, you have bigger problems than this plugin.
- **Custom kimi-code skill libraries that bypass the hook.** Hooks fire on tool calls, not on skill activations. A skill that calls `Bash` will be hooked; a skill that performs file ops via a Node binding that doesn't surface as a tool call won't be. The default kimi-code skill catalog uses the standard tool surface.
- **The host (Claude Code) itself.** kimi-plugin-cc constrains kimi-code, not Claude. Claude's own tool permissions live in `~/.claude/settings.json`.
- **Compute exhaustion (no per-turn step cap on kimi-code ≥ 0.6.0).** kimi-code 0.6.0 (PR #186) removed the default 1000-step-per-turn ceiling; absent an explicit `max_steps_per_turn` in config, a turn can loop tool calls without an upstream bound. This is **not a write bypass** — every tool call still passes the PreToolUse hook and (for rescue) the workspace allowlist. The plugin bounds wall-clock and reaps the descendant process tree via its AbortController budget + SIGTERM→SIGKILL cancellation, so a runaway `/kimi:rescue` is cancellable; but if you want a hard step ceiling, set `max_steps_per_turn` in your kimi-code config.
- **A poisoned `KIMI_MODEL_*` child environment.** kimi-code 0.6.0 (PR #212) added an opt-in env channel: when `KIMI_MODEL_NAME` is set, kimi synthesizes a provider (base URL + API key) as the default model. `kimi -p` inherits the plugin's parent environment, so a pre-poisoned `KIMI_MODEL_BASE_URL`/`KIMI_MODEL_API_KEY` could reroute model traffic (which may carry workspace file contents from review/ask). The plugin does not sanitize the child environment — this is the same parent-env trust the host already extends. It does **not** touch hook or permission config: kimi-code only writes the synthesized provider/model/thinking entries (never `hooks`), and strips them on any config write-back, so `/kimi:setup`'s managed hook block can neither clobber nor be clobbered by it.
- **Out-of-band binary drift (kimi-code self-upgrades by default on ≥ 0.8.0).** kimi-code 0.8.0 (PR #334) added background automatic upgrades, enabled by default (`autoInstall: true`). The plugin's own `kimi -p` spawns are unaffected — in print mode the install source is forced `unsupported`, so a plugin spawn never swaps the binary mid-flight — but a user who *also* runs the interactive `kimi` TUI can be silently upgraded to a kimi-code the plugin has not compat-audited. This is a *version-assurance* boundary, not permission to guess. Setup emits an "outside tested range" warning and can complete, while every model-spawning command independently probes the exact command tuple and refuses an untested minor before Kimi starts. Update the plugin to a release that certifies the new minor or point `KIMI_PLUGIN_CC_KIMI_BIN` at a certified binary; `KIMI_PLUGIN_CC_SKIP_VERSION_PROBE` is tests/smoke only. As of v1.9.12, the certified boundary is through exact kimi-code 0.39.1 on forced legacy-v1; native agent-core-v2 remains fail-closed disabled.
- **New permission approval hook events are observability, not a decision surface.** kimi-code 0.8.0 (PR #336) added `PermissionRequest`/`PermissionResult` hook events. A user *can* register `[[hooks]]` blocks for them in `config.toml`, but they fire fire-and-forget (the result is discarded) and only inside the interactive approval/ask path — which `kimi -p` auto mode shadows. They **cannot** approve a tool the PreToolUse hook denied, cannot run on the plugin's `-p` path, and live in a disjoint event bucket from the managed `PreToolUse` block (no impersonation). The strict-exact `verifyHookInstalled` check remains sufficient; no new verifier coverage is required.

## Known limitation: Node version manager switches

The verifier does exact equality on the installed `command = "..."` against the canonical command for the **current** `process.execPath`. If you use `nvm`, `asdf`, `mise`, or `fnm` and switch the active Node version after `/kimi:setup`, the canonical command's Node binary path changes and the verifier rejects the previously-installed block. Every model-spawning command will refuse; the review gate will skip.

The workaround is to re-run `/kimi:setup` after any Node version switch. The strict behavior is deliberate — loosening the exact-equality check to "survive" Node moves would reopen the crafted-command bypass the audit closed (reports 27/28), so it stays strict by design.

**Soft-recovery (H4):** to make that strict failure *legible* instead of cryptic, the verifier classifies a command mismatch when the block is otherwise valid. Rather than dumping the raw expected-vs-got command, it reports the drift class — e.g. *"Node binary drift: the installed hook pins `/opt/homebrew/Cellar/node/26.0.0/bin/node`, which no longer exists on disk (this companion runs `…/26.3.0/…`) — the classic Node-upgrade / version-manager drift … Run /kimi:setup to re-pin"*, or *"Hook script path drift … likely a plugin update or move"* when the version-stamped plugin path moved instead. A gone interpreter is the unambiguous signal. The same classified reason surfaces from `/kimi:setup --check`. This changes only the message; the strict installed/not-installed decision is unchanged.

**Stable Node path (v1.9.0).** `process.execPath` is fully symlink-resolved, so under Homebrew it names `…/Cellar/node/<version>/bin/node` — a path that changes on every `brew upgrade node` and therefore invalidated **both** hosts' blocks at once, with no user-visible cause. `resolveNodeBinary` now prefers `process.argv0` (the name the interpreter was actually invoked with; `companion.sh` resolves `node` through the stable `/opt/homebrew/bin/node` symlink), **but only when that path is absolute AND `realpath`-identical to `process.execPath`**. The guard is the safety argument: the substitution can pick a more stable *name* for the interpreter already running, and provably never a *different* binary. Any doubt falls back to `execPath`. Exact-equality verification, absolute-path enforcement, and the shell probe are unchanged. It also keeps hook and companion on one interpreter by construction — previously the companion could run a freshly upgraded Node while the hook stayed pinned to a Cellar path `brew` had deleted, which fails to spawn and (exit 127) is read as **allow**. Version-manager users (nvm/asdf/mise/fnm) expose version-stamped paths directly, so `argv0 === execPath` and the limitation above still applies to them unchanged.

## Hook-path drift is repaired by the caller, never by the verifier (v1.9.0)

Plugin install paths are version-stamped (`…/kimi-marketplace/kimi/<version>/dist/hooks/approval-hook.js`), so a plugin update moves the hook script and the recorded command stops matching. That refusal is correct and fail-closed, but it is also routine, so refusals now carry a **machine-readable** classification alongside the prose reason:

`HookInstallStatus.drift` = `{axis: "hook-script" | "node-bin" | "both", installedCommand, expectedCommand}`, surfaced in every refusal's `RuntimeError.details` as `drift_axis` / `retryable_after_setup`. It is populated **only** when a structurally sound block's command names different paths, and is derived **after** byte-exact equality has already failed — it can never influence the installed decision, exactly like the H4 prose classification. Refusals that re-pinning cannot fix (unresolvable command, unreadable config, invalid hook set, duplicate/orphan markers, missing script) carry no drift at all.

The plugin's agents read that field: on `hook-script` (`retryable_after_setup: true`) they run `/kimi:setup` for that host and retry **once**. On `node-bin`/`both` they surface the refusal and stop — a moved interpreter may be *gone*, which is a real enforcement gap rather than a moved file, and blind re-pinning would paper over it.

**The verifier never repairs the config itself.** An in-verifier auto-repin was specified and rejected after two independent adversarial reviews found: a lock self-deadlock (the repin path and the install transaction both take a non-reentrant lock); a false "target cannot be steered" premise (`KIMI_PLUGIN_CC_HOOK_SCRIPT`/`NODE_BIN`/`HOST_ID` override resolution, and every proposed gate reads the same env, so they corroborate nothing); no version-monotonicity bound, letting a stale session pin the *global* block down to a pre-1.0.3 hook carrying the CRITICAL exec-delegation bypass; and a write→spawn TOCTOU in which one session repins to a deleted path inside another's spawn window, producing exit 127 → allow → an unenforced `rescue` run. Keeping repair in the caller makes it a **visible, permission-gated action in the transcript** instead of a silent mutation of a security surface. Full analysis: `.claude/hook-pin-durability-spec-2026-07-25.md`.

## Reporting safety issues

If you find a way to coax /kimi:review, /kimi:challenge, /kimi:review_gate, or /kimi:ask into running a non-read tool — or to make /kimi:rescue mutate `.git/` or escape the workspace — please open a GitHub security advisory rather than a public issue.
