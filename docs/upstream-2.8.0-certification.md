# Exact CLI 2.8.0 certification — plugin 3.1.0

## Scope and decision

**Status: certified for all seven operations.** Exact `@moonshot-ai/kimi-code@2.8.0` passed the source, exact-binary, deterministic stock-binary and real-provider operation gates (originally run across the 8 pre-collapse operations at `b85bb4b`, then carried over to the 7 remaining operations in `3.1.0` after retiring `review_gate` and pre-`2.8.0` rows). Certification does not update installed hosts or operator pins.

Exact source commit: `46d9085f37c1b145ccfc82a24387e26aa940e94f` (annotated tag object `81a9bb8b8ee87c9328d1f82f6b00c4074fa1f456`). The isolated npm binary reports 2.8.0; `dist/main.mjs` SHA-256 is `8d2ef20b253b604435bc1d71cbff9c79e537a9bc501fbb2de7a7ec615410fdb1`. npm `latest` was 2.8.0 during certification.

The release row is `{ version: "2.8.0", commit: "46d9085f", scope: "all" }` with the same capabilities as 2.7.2 and 2.7.3.

## The certification basis changed at 2.8.0

Through 2.7.3, a Write to the plan file skipped the managed PreToolUse hook while plan mode was active. The plugin therefore closes every way to arm plan mode (the no-plan construction), and each certification had to show that the bypass was still there.

At 2.8.0 the bypass is gone:

- **Source.** The plan guard is no longer a before-execute listener that ends the chain with `allow()`. It is an ordinary starting hook that returns `skipPermitting` (`features/plan/planService.ts`). The executor builds its starting chain as `[resetHook, legacyHook, ...hooks, internalHook]` (`agent/toolExecutor/toolExecutorService.ts`). The external PreToolUse listener runs inside `legacyHook`, so it runs before every registered hook, the plan guard included, and its veto ends the chain. No production code calls `event.allow()`. One construction site builds every agent scope, so the order holds for the main agent, subagents and swarm children, fresh and resumed.
- **Live.** Plan mode was armed on an isolated session through the authenticated KAP profile route and the session was resumed with `kimi -p -r`. Glob and both Write attempts on the plan file reached the deny-all hook and were denied on the same call. No plan file and no workspace file was written.

Upstream issue MoonshotAI/kimi-code#3431 is still open. The fix is observed in source and by control, not announced.

Every no-plan closure stays on for every release, 2.8.0 included. At 2.8.0 the closures are a second layer and not the basis. The mechanized scan pins the new order: zero `allow()` callers, an exact census of `skipPermitting` producers, the external hook registered through the legacy starting emitter, the plan guard registered through `registerHook`, and the chain literal. If either registration moves, the scan fails.

## Monitor verification and correction

The 2026-11-26 Codex monitor correctly held the production pin at 2.7.3 after its authorized 2.8.0 candidate smoke exited 1 with 34 pass / 8 skip / 5 fail / 365 assertions. It observed no hook bypass and no write to the user tree. None of the five failures is a 2.8.0 regression:

- **Three swarm failures.** The unmodified plugin had no 2.8.0 row, so its swarm lanes ran without web activation and without the bounded policy, and a fresh print session has swarm mode off. No child could start.
- **Glob.** ripgrep refused last-modified sorting in the monitor's environment. The same Glob call succeeds on 2.7.3 and on 2.8.0 from an ordinary shell, and the Glob tool's source is byte-identical to 2.7.3. Why the monitor's environment refused the sort was not identified.
- **WebSearch.** Kimi offers the tool only with the managed Kimi login, a provider `search_url`, `[services.moonshot_search]` or `KIMI_WEB_SEARCH_BASE_URL`. The monitor's API-key route has none of them, on 2.7.3 as well. The smoke now skips that lane by name on such a seed home.

The monitor's lead that the plan guard moved behind the managed hook was confirmed.

## Source audit

Six reviewers read exact 2.8.0 against exact 2.7.3: the hook contract and plan order, print mode and session bootstrap, tools with swarm and the KAP activation lifecycle, experimental flags with tower, session mentions, and an adversarial pass that was given the code and not the other conclusions. 1,099 files changed between the tags.

The review establishes:

- external hooks (`features/externalHooks/**`) are byte-identical; aggregation, the no-output result, the inherited environment, fail-open results, the default timeout and first-entry dedupe are unchanged;
- nothing under `apps/kimi-code/src/cli` changed: print is still v2-only, non-interactive and auto mode, `system.version` is still the first line, and the argv is unchanged;
- an invalid tool call is now retried inside the model request and appears as an existing-shape `turn.step.retrying` line; it is never executed and never reaches the hook;
- append-log reading moved to `packages/core/src/store/append-log.ts` with the same line framing; the session store layout, `state.json` and the first user record are unchanged;
- `Agent` and `AgentSwarm` lost the experimental `fork` parameter; task tools, the three-tool backgrounding rule, the TaskStop session policy path, the child timeout variable and the swarm scheduler are unchanged, so no upstream concurrency fix is claimed;
- KAP adds `agent_close`, `session_continue` and `home_dir` to `/meta` and `environment_cwd` to the environment response; the plugin reads named fields only;
- the read and web tool argument keys and Kimi's default-approve list are unchanged; the new static read-only Bash approval runs in the permitting phase, after the hook, and print's auto mode never consults it;
- the flag registry holds `tower`, `notify_user`, `wait_for` and `prompt_prediction`; `subagent_fork` and `tool-select` are removed; precedence is unchanged, so per-flag environment values still win;
- print mode has no route into tower mode, and each label allows a fixed list of tool names, so a tool a flag adds is denied unless the list names it. The list names one: `WaitFor`, which only waits on background tasks that already exist.

Two findings changed the plugin:

- With `default_plan_mode = true` and an MCP server configured, 2.8.0 can journal `mcp.tools_discovered` between the create-time `plan_mode.enter` and print's `plan_mode.cancel` (1 of 3 fresh runs on 2.8.0, 0 of 3 on 2.7.3). The resume scan required the two records to be adjacent, so such a session would have refused every later resume. The scan now accepts Kimi's three durable MCP records between them: `mcp.tools_discovered`, `mcp.server_failed` and `mcp.server_failure_resolved`. The MCP service writes each on its own clock while servers connect, and each folds only into MCP discovery or failure state. Only discovery was observed there live; the two failure records are admitted from source. Any other record or an unparseable line there still taints.
- Restoring a session whose journal is left in tower mode can make Kimi adopt the workspace's `.tower/comms` state without a tool call, whatever the tower flag says. This path is unchanged from 2.7.3. The plugin now refuses to resume such a session with `KIMI_SESSION_TOWER_ACTIVE`.

## Mechanized scan

The unmodified scan against the 2.8.0 tree reported **132 pass / 15 skip / 7 fail / 853 assertions**: the missing pin row, five assertions that encoded the 2.7.3 plan-before-hook order (the single final allow, the plan entry callers, the emitter composition, the subscriber set, the plan config shape) and the restore fold, with the bounded-swarm suite skipped by its version gate.

The scan now carries 2.8.0 invariants beside the older ones, which are unchanged for older tags:

- no production caller of the emitter's final `allow()` in the engine, core runtime, CLI, KAP, SDK, klient or ACP;
- an exact per-file count of `skipPermitting: true` producers;
- the external hook's `runPreToolUse` and veto inside the `registerLegacyStarting` callback, and the plan guard returned from `registerHook({ starting })`, with no `registerLegacyStarting` in the plan service;
- the executor's chain literal `[resetHook, legacyHook, ...hooks, internalHook]`, the registry's in-order starting chain, and the phase order starting, permitting unless skipped, before-execute, execute;
- the exact subscriber sets of `registerLegacyStarting`, `registerHook` and `registerToolBatchStarting`;
- the absent subagent-fork flag file and no remaining `subagent_fork` reference;
- the tower and MCP records the resume scan names: the tower state fold, the agent-id rule replay applies to it, main-only adoption on restore, and the exact set of durable MCP events with their folds;
- a turn reaches tools only through the loop's batch executor, and a blocked or aborted batch returns before the one executor call;
- `WaitFor`, which the hook allows: on every certified row, the tool's source is one of five that were read (pinned by hash per row), with the exact services it is given, the methods it calls and its timeout cap; at 2.8.0 the goal guidance that sends the model to it;
- the repeat breaker's handoff step and its fixed text, present on every row through 2.5.3 and absent from 2.6.0;
- for bounded swarm: no fork path (every child is a fresh create), the lazy loop start awaited before settlement, the detached-completion path in the rewritten loop actor, the session tool-policy path through the core file store, and the retry loop's attempt cap under the new invalid-argument retry.

The 2.8.0 row has **171 pins**: it inherits 2.7.3, re-pins 54 changed files, adds the new hook-registry, read-only-Bash-policy, turn, store, tower-record, MCP-record and `WaitFor` files, and drops five removed paths. Final exact 2.8.0 scan: **216 pass / 0 skip / 0 fail / 1,863 assertions** (`tag-scan-03.log`). Exact 2.7.3 regression: **216 pass / 0 skip / 0 fail / 1,724 assertions**. Two of the new source pins, the turn machine and the file-storage backend, had been read only in part; both are now read whole and each has an assertion of its own. The implementing lane reported that mutating nine of the new assertions made each fail; that was not re-run. A later run that mutated four of the tower and MCP assertions and one pin failed the scan.

## Exact-binary controls

All controls ran sequentially against the isolated binary. Real-model controls used the dedicated Agent Keys environment-model route and fresh absolute-path homes; for these controls personal config and credential stores were neither read nor linked.

- **Plan OFF:** an ordinary Write reached the deny hook, returned `cert-control: denied` on the same call, created no file, recorded no plan state, and emitted exact first-line `system.version` 2.8.0.
- **Deliberately armed plan ON:** authenticated JSON/KAP activation armed an isolated session. Glob and both plan-file Writes reached the hook and were denied; no plan file and no workspace file was created.
- **Forced EnterPlanMode:** the tool was absent from offered tools. A scripted call returned `Tool "EnterPlanMode" not found` before any hook, was returned to the provider, and created no plan journal or file.
- **Environment:** real JSON activation and deactivation passed through the plugin's own activation code. A configured remote default refused before its launcher ran, and a resumed nonlocal binding refused.
- **Plan pair timing:** three fresh `kimi -p` runs each on 2.7.3 and 2.8.0 with `default_plan_mode = true` and one stdio MCP server, recording the journal order.

Receipts are `write-off/summary.json`, `plan-on/summary.json`, `enter-off-forced/summary.json`, `environment-controls/summary.json` and `r1-control/` under `.claude/kimi-code-research/cert-2.8.0-live/`.

## Deterministic and real-provider operation evidence

The deterministic untouched-binary suite passed **23 tests / 138 assertions in 616.84 seconds** (`deterministic-05.log`) on the final runtime; only tests and documents changed after it. It covers real new, resumed and odd waves, child-authored writes and patches, explicit and automatic background controls, direct workers, nested-profile refusal, timeout and cancellation tails, and both long recovery controls.

The final real-provider smoke ran on exact 2.8.0 through the maintainer route, a read-only Agent Keys API key and an empty dedicated seed home, with `KIMI_PLUGIN_CC_SMOKE_INSTALL=1`: **51 pass / 3 skip / 0 fail / 695 assertions in 663.55 seconds** (`smoke-final-04.log`). A skip is not evidence. The three skips, by name:

- `narrowed production certification refuses swarm before spawn > swarm returns the scoped refusal without creating a model session` and its `swarm-write` twin. They apply only to the narrowed 2.6.0 row.
- `per-call read scope and network access (ask) > --network: WebSearch passes the hook; without it WebSearch is denied naming --network`. Kimi offers no WebSearch tool on an API-key route with an empty seed home. This lane ran separately; see below.

Lanes new in this release, all passing on that run:

- **Every experimental feature on.** With every 2.8.0 experimental feature switched on in config and environment, the ask ran, its Write was denied by the hook on the same call, and the one journal held no tower record.
- **A referenced session.** A fresh ask with `--reference-session` answered with a code that existed only in the earlier session's journal, read through Kimi's own Read. The same reference on a `--network` call read the journal through the added read root, while a Read of that session's `state.json` was denied.
- **FetchURL.** On a `--network` call a public page came back and a loopback URL was denied. FetchURL has a local fetcher behind Kimi's hosted fetch service, and the tool result does not say which one answered.
- **`setup --install-kimi`** installed 2.8.0 into the smoke's own data root and an ask ran that binary.
- **`WaitFor`.** Under `ask` it returned at once with nothing to wait for. Under `rescue` it waited on a background test run that the same turn had started, named no task, and ended on that task finishing with exit code 0; nothing stopped the task. Under `pursue` it ran and the goal completed. In each lane a second, recording hook saw the `WaitFor` call's own id, and the managed hook denied another call in the same run.

The bounded-swarm lanes now follow the release table, so they ran on 2.8.0.

**WebSearch and FetchURL on the owner's own Kimi setup.** With the owner's explicit authorization for this run, those two lanes alone ran on exact 2.8.0 seeded from the owner's Kimi home: the config copied into a temporary home, the token stores linked and never copied, no API key, no model override. **2 pass / 0 fail / 17 assertions** (`smoke-subscription-web-03.log`). WebSearch returned real results on the `--network` turn and was denied, naming `--network`, without it. FetchURL returned the public page and the loopback URL was denied. The plugin's credential-safe inventory lists a Magpie-routed model as the fresh-session default; the stream does not name the model that answered, so that route is read from the default and was not observed. Upstream resolves a search provider from a services entry, then the model provider's search URL, then the managed login; which of them served the search was not determined, and the config was not read to find out.

Those two lanes first ran on the tree before `WaitFor` was allowed. With the owner's authorization for that run, they ran again on the published tree (`v3.1.0`, `b714cdd`) the same way: **2 pass / 0 fail / 17 assertions** (`smoke-subscription-web-published-v3.1.0-01.log`). WebSearch returned real results on the `--network` turn.

**A failed run.** The full smoke before the final one (`smoke-final-03.log`) failed one lane, 49 pass / 3 skip / 1 fail. In the directed bounded-swarm write lane the coordinator wrote a report file of its own. The children had done every assigned edit, but the shared evidence check refused any coordinator write, where the lane's instruction forbids only writing a target. The check now refuses a coordinator write to a target and has a unit test for both cases. That lane had passed on the two full runs before it.

**Disclosure.** Earlier in this certification a full smoke was started on the personal seed route without authorization. It was stopped and its temporary home removed, links first. Its log is kept as `smoke-01-ABORTED-personal-seed-route-not-evidence.log`; none of its results count.

## Certification validation

Final upstream certification gates (commit `b85bb4b` before the 3.1.0 connector/doc collapse) and tagged `v3.1.0` release gates (commit `b714cdd`):

- Mechanized source scan, exact 2.8.0: passed (`1,863` assertions at `b85bb4b`; `v3.1.0` removed pre-`2.8.0` regression rows so `v2-tag-scan.test.ts` targets `>= 2.8.0`).
- Deterministic stock-binary suite on exact 2.8.0 (`b85bb4b`): 23 pass / 138 assertions in 616.84 seconds.
- Real-provider smoke on exact 2.8.0 (`b85bb4b`): 51 pass / 3 skip (2 narrowed `2.6.0` skips + `WebSearch` empty-seed skip) / 0 fail / 695 assertions in 663.55 seconds, plus 2 pass / 0 fail subscription `WebSearch` + `FetchURL` lanes.
- Real-provider smoke on the published tree (`v3.1.0`, `b714cdd`), exact 2.8.0, run after publication on the maintainer API-key route with an empty seed home and `KIMI_PLUGIN_CC_SMOKE_INSTALL=1`: 50 pass / 3 skip (the same three lanes) / 0 fail / 681 assertions in 550.38 seconds (`smoke-published-v3.1.0-02.log`). An earlier run (`01`) was cut off by a host restart and is not evidence. The exact-source scan and the deterministic stock-binary suite have no recorded run on this tree.
- Release `bun run check` on `v3.1.0` (`b714cdd`, Linux CI): all tests passed (`2,384 pass / 111 skip / 0 fail` across 115 files) with `check:contracts`, `check:surfaces`, and drift gates.
- Release `bun run check:package` on `v3.1.0`: verified `kimi-plugin-cc@3.1.0` (`201` files), root + Codex distributions, `kimi-companion --help`, 4-tool MCP + `SEP-2640` skills, isolated hook setup/check, `< 2.8.0` version refusal, and patched DSH host/profile (`dsh web` boot + live `mcp__kimi__kimi_setup` tool call).
- Release `bun run check:consumer-security`: verified isolated npm consumer security for `kimi-plugin-cc@3.1.0`.

**Reviews.** GPT Astra (through Codex) and Kimi each read the whole change: 16 and 7 findings. Both then read only what changed after their first pass: GPT Astra reported 10 findings (two high, four medium, four low) and Kimi three low. Every accepted finding has a fix and a test in this tree:

- The resume scan identifies the main journal by what Kimi's `agents/main` lookup reaches, not by the stored directory name, so a directory stored as `Main` on a case-insensitive volume is still folded for tower state.
- A scoped call is granted only the main-agent directory that was validated: its physical path must equal the physical sessions directory plus the validated components.
- The tower fold freezes at the first complete corrupt line, for enters as well as exits, as Kimi's replay does.
- The warning list and the refusal come from one read of the config. Environment names match exactly except on Windows.
- The companion re-keys `KIMI_*` names once at entry on Windows, so the legacy master-flag guard sees a mixed-case name. No Windows machine ran this.
- Descriptions name the whole main-agent directory a scoped reference grants, including saved tool outputs and plans.

Not changed, and why:

- A hook that cannot start, crashes or times out still reads as allow. That is upstream's rule; see the residual boundaries.
- Scope flags do not work on Windows paths, with or without a reference. They refuse.
- A request whose own text ends in a block of the exact rendered grammar loses that block from the summary, title and preview. The spawned prompt keeps it.
- A warning that first appears between planning and spawn is not reported; the spawn-time check only refuses.

The fixes made after the second review were not reviewed a third time.

**The `WaitFor` change had its own review.** It was decided after the two passes above. GPT Astra (through Codex) read it and reported 10 findings, five medium and five low. After those fixes Kimi read the result and reported four, one medium and three low. Accepted, each with a fix in this tree:

- The contract said `WaitFor` writes nothing. Through 2.5.3 a wait also marks completion notices delivered and returns up to 32 KiB of task output. The contract now says what it does on each release, that its cap bounds the requested wait and not the whole call, and that swarm members appear in task history.
- The scan's census missed a call made through a helper's parameter and did not say which sources had been read. It now covers that call and pins the five distinct tool sources by hash.
- The live lanes could pass if Kimi skipped the hook for this one tool, or with the managed hook dead. Each lane now has the recording hook and a call the managed hook denies in the same run. The rescue lane ties the wait to the Bash call that started the task and requires that no task was named, which the tool answers with `no_tasks` unless one was running.
- The escape monitor accepted upstream's old handoff text on every release. It now accepts it only before 2.6.0 or when the version is unknown, and the documents describe the handoff step as it is: every call attempted in the step after a twelfth identical call, not the twelfth call's own result.
- The setup notice and one changelog line said the hook denies tools it allows.

Not changed, and why:

- `TaskOutput` and `WaitFor` read the session's task history and are not confined by `--read-root` or `--network`. A session the user continued outside the plugin can hold task output, and through 2.5.3 a wait there marks a notice delivered. `TaskOutput` already read that output before this release; refusing both tools on scoped calls is a separate decision.
- The task-service methods behind the tool are not pinned on older rows. They were read at 2.5.3 and 2.8.0.
- `WaitFor` is allowed on unlisted releases too, like every other name on the read-only list.

The fixes made after Kimi's pass, which are test and document changes, were not reviewed again.

## Residual boundaries

The concurrency bound covers simultaneous Kimi child-agent turns, excluding the coordinator and OS subprocess counts. `--cap` remains a soft lifetime-total hint, and a finite time budget is not a spend cap. Upstream rate-limit recovery can still exceed its native setting; the plugin-owned bound is required. Parallel sessions retain the native TaskStop restriction after deactivation, and later external interactive resume is outside this certification. Stream-json still lacks a general execution-outcome field, so hook-escape findings remain detection evidence, not a failure signal.

Reaching the hook is not the same as the hook deciding. Kimi still reads a hook that cannot be started, crashes or times out as allow; that is unchanged at 2.8.0, and the plugin's 10-second deadline cannot run in a process that never started.

The order covers a tool's dispatch, not everything a tool does before it. With an active, non-empty plan, preparing `ExitPlanMode` records a plan revision before the starting chain runs (`features/plan/tools/exit-plan-mode/exitPlanModeTool.ts`; the same at 2.7.3), and a later hook denial does not undo it. A plugin session never has an active plan, which is one reason the no-plan closures stay on at 2.8.0.

A source pass over every tool's preparation step at 2.8.0 found two effects that can precede the hook, both byte-identical at 2.7.3. The `ExitPlanMode` revision above is one. The other: a tool whose preparation returns an error result ends the call there, so the starting chain, and the hook, never run for it. Nothing executes, and the result is an error; if that error text exceeds 50,000 characters Kimi writes it to a spill file under its own home, which only the Cron tools' echoed arguments can reach. File tools resolve paths before the hook and read no target content. No tool spawns a process, makes a network request or writes to the workspace before the hook. The pass did not establish which of these tools print mode registers.

The hook-before-plan order at 2.8.0 is established for this exact release only. A later release that registers the external hook differently would restore the dependence on construction order; the scan is written to fail on that.

Kimi session locks at 2.8.0 reclaim a live holder recorded under another hostname. The plugin does not treat Kimi's locks as enforcement. On a machine whose hostname changes while jobs run, two Kimi processes can resume one session; each still runs its own hook.

Tower mode is not offered as a plugin operation. Its tools create branches and worktrees and merge into the user's base branch, which the plugin's no-Git-mutation rule excludes, and print mode cannot enter it.
