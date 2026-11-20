// Mechanized native-v2 tag scan (audit routine, not CI-default).
//
// Native v2 is certified on a construction, not on an upstream ordering
// contract: the engine's ONLY chain-breaking final allow is the plan-file
// guard, it fires only while plan mode is active, and the plugin closes every
// route by which plan mode can arm in a `kimi -p` session. That construction is
// an enumeration over one exact source tree, so it must be re-established for
// every kimi-code version before that version is appended to
// `NATIVE_V2_CERTIFIED` (runtime/kimi-engine.ts). This file is that
// re-establishment, in symbol-level form. It cannot see semantic regressions
// (a new listener that performs a side effect and then vetoes; a tool whose
// `resolveExecution` has effects; a final allow reached via a destructured or
// bracket-notation reference such as `const {allow}=event; allow()` or
// `event['allow']()`, which the literal ".allow()" scan below does not match)
// — those remain the human checklist in docs/upstream-compat-audit.md. The
// sha256 pins below are the backstop: any byte change to a load-bearing file
// (the allow gate, the plan guard, or the restore-folding source the journal
// taint scan depends on) forces a human re-read even when a symbol scan is
// blind to the change.
//
// Run: KIMI_CODE_SOURCE_TAG_DIR=/path/to/kimi-code@<tag> bun test tests/audit/
// Skips (does not fail) when the env var is unset.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";

const SOURCE = process.env.KIMI_CODE_SOURCE_TAG_DIR;
const suite = SOURCE !== undefined && existsSync(SOURCE) ? describe : describe.skip;

const CORE = "packages/agent-core-v2/src";
const CORE_RUNTIME = "packages/core/src";
const CLI = "apps/kimi-code/src";
const KAP = "packages/kap-server/src";
const SDK = "packages/node-sdk/src";
const KLIENT = "packages/klient/src";
const ACP = "packages/acp-server/src";

/**
 * Per-version pins for files whose exact bytes decide the construction. A new
 * version MUST add its own row after a human read of the diff; a missing row
 * fails the scan rather than silently accepting drift.
 */
const PINNED_HASHES: Record<string, Record<string, string>> = {
  "0.42.0": {
    [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]:
      "ef981d83e607f0427f77a0fc89e4c03d301116b01ac5f0c33bb68ea955749455",
    [`${CORE}/features/plan/planService.ts`]:
      "1d3526543839a78820e6a2e21f746c311e3034812f479233a4462a2a4fe5fc4d",
    // The resume-taint closure (vector C) rests on restore() folding ONLY the
    // agent wire journal — that is what scanSessionJournalsForPlan walks. Pin
    // the restore-folding source and the fork snapshot-exclusion so a future
    // patch that widens what restore() loads (a snapshot/checkpoint/compaction
    // path carrying plan state) fails THIS audit loudly instead of silently
    // narrowing what the journal scan actually verifies.
    [`${CORE}/state/eventDispatcherService.ts`]:
      "0f2f55a070a7a69ea9baac98c5fadb96c3ef47fb44596b044431fc768e7be264",
    [`${CORE}/state/state.ts`]:
      "b1b1de1d3060d29e998292e4a3047eedfbf05bf181c199d8800694e23a567fb5",
    // The durable plan-state event classes. Their `type` strings are the
    // fold keys restore() dispatches on AND the prefixes the journal taint scan
    // keys on (`plan_mode.` / `plan.`); a rename here would blind the scan
    // while every other check stayed green.
    [`${CORE}/features/plan/planOps.ts`]:
      "5fc805219ac755c7f155695f783b553088aab90a1ed44aa8f3d59e2926204dde",
    // The config loader's key normalization. `transformTomlData` camelCases
    // every top-level key before the registry sees it, so the preflight
    // inspects config through the SAME `snakeToCamel` (mirrored verbatim in
    // runtime/native-v2-preflight.ts::upstreamSnakeToCamel). A change here
    // changes which spellings arm `defaultPlanMode`.
    [`${CORE}/app/config/toml.ts`]:
      "57f3830d4fcbf48bb79f6e400efb53af3198ea64de194b381ff8545ab808e334",
    // Upstream's own scanner of the on-disk session layout
    // (`<session>/agents/**/wire.jsonl`) — the layout scanSessionJournalsForPlan
    // walks. A rename here would make every v2 resume refuse as
    // "journal unavailable" (fail-closed but functionally broken) with every
    // other check green; smoke lane 3b catches it at runtime, this pin catches
    // it at audit time. (Kimi second-round finding.)
    [`${CORE}/app/sessionExport/wire-scan.ts`]:
      "29489dabbc2a585a5cc70015a7b160f7c0a13403f102de007bbce89d1a6b5ef9",
    // The wire-journal reader chain the restore-folding assertion inspects by
    // regex (Kimi 1.10.3 review): pin the bytes too, so a reformat cannot
    // degrade those regexes into a silent false-green.
    [`${CORE}/wire/wireService.ts`]:
      "de9170dee3b6e69e3e4dfe1803a618b70f493d446e8fb09ffc47556a6f8cd9a7",
    [`${CORE}/wire/record.ts`]:
      "8b9eead225a5120d5dccd829cb900cd31fe2262ac0771bff4983043bb6f55056",
  },
  // 0.43.0 (commit ffa94fae) and 0.43.1 (commit 75ac010b) share byte-identical
  // load-bearing files (verified with cmp on the exact tag archives, 2026-09-15);
  // the 0.43.0 -> 0.43.1 diff is TUI, DI-scope, tower, event-bus and
  // subagent-model-validation work. Five of the seven pins are unchanged from
  // 0.42.0. The two that moved are the restore refactor (#state):
  //   - eventDispatcherService.ts: patch-history undo replaced by state
  //     snapshots kept in memory (`checkpoints: unknown[]`, never persisted);
  //     restore() now folds `wire.readRestorable()` (undoable folds) and then
  //     `wire.readJournal()` (the rest). readRestorable() is `readStableEntries()`
  //     over the SAME `AGENT_WIRE_RECORD_KEY` ('wire.jsonl') log, filtered by
  //     `restorableChain()` (wire/tree/fork.ts) — a pure in-memory branch/undo
  //     filter with no second on-disk source — so the raw journal scan stays a
  //     strict superset of anything restore() can fold. Asserted below in the
  //     "folds only the wire journal" test.
  //   - state.ts: `PatchEntry`/`enablePatches`/`keepsUndoCheckpoints` removed
  //     with the patch history; `snapshotExcluded` (fork isolation) unchanged.
  "0.43.0": {
    [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]:
      "ef981d83e607f0427f77a0fc89e4c03d301116b01ac5f0c33bb68ea955749455",
    [`${CORE}/features/plan/planService.ts`]:
      "1d3526543839a78820e6a2e21f746c311e3034812f479233a4462a2a4fe5fc4d",
    [`${CORE}/state/eventDispatcherService.ts`]:
      "edcab84af00e59a3e67f99b31adb5e97fc97566d5f31e934a230e156dc5e3584",
    [`${CORE}/state/state.ts`]:
      "f473464f22800937ef85a0eb9f4ddd16a8041277eeb4c35b55f4bca6ac52255b",
    [`${CORE}/features/plan/planOps.ts`]:
      "5fc805219ac755c7f155695f783b553088aab90a1ed44aa8f3d59e2926204dde",
    [`${CORE}/app/config/toml.ts`]:
      "57f3830d4fcbf48bb79f6e400efb53af3198ea64de194b381ff8545ab808e334",
    [`${CORE}/app/sessionExport/wire-scan.ts`]:
      "29489dabbc2a585a5cc70015a7b160f7c0a13403f102de007bbce89d1a6b5ef9",
    [`${CORE}/wire/wireService.ts`]:
      "08698984896c09aab1bd21ce367a3fa79054588ec2fc1f1411212ebf92d30615",
    [`${CORE}/wire/record.ts`]:
      "8b9eead225a5120d5dccd829cb900cd31fe2262ac0771bff4983043bb6f55056",
    [`${CORE}/wire/tree/fork.ts`]:
      "843b09947cb7b3bc91cb8bf8216c10d00baba4fcd268b34b174c57b9ea04c533",
  },
  "0.43.1": {
    [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]:
      "ef981d83e607f0427f77a0fc89e4c03d301116b01ac5f0c33bb68ea955749455",
    [`${CORE}/features/plan/planService.ts`]:
      "1d3526543839a78820e6a2e21f746c311e3034812f479233a4462a2a4fe5fc4d",
    [`${CORE}/state/eventDispatcherService.ts`]:
      "edcab84af00e59a3e67f99b31adb5e97fc97566d5f31e934a230e156dc5e3584",
    [`${CORE}/state/state.ts`]:
      "f473464f22800937ef85a0eb9f4ddd16a8041277eeb4c35b55f4bca6ac52255b",
    [`${CORE}/features/plan/planOps.ts`]:
      "5fc805219ac755c7f155695f783b553088aab90a1ed44aa8f3d59e2926204dde",
    [`${CORE}/app/config/toml.ts`]:
      "57f3830d4fcbf48bb79f6e400efb53af3198ea64de194b381ff8545ab808e334",
    [`${CORE}/app/sessionExport/wire-scan.ts`]:
      "29489dabbc2a585a5cc70015a7b160f7c0a13403f102de007bbce89d1a6b5ef9",
    [`${CORE}/wire/wireService.ts`]:
      "08698984896c09aab1bd21ce367a3fa79054588ec2fc1f1411212ebf92d30615",
    [`${CORE}/wire/record.ts`]:
      "8b9eead225a5120d5dccd829cb900cd31fe2262ac0771bff4983043bb6f55056",
    [`${CORE}/wire/tree/fork.ts`]:
      "843b09947cb7b3bc91cb8bf8216c10d00baba4fcd268b34b174c57b9ea04c533",
  },
  // 2.0.0 (1b89e4b0): only wireService changes among these pins. flushLog
  // drains the same agent wire.jsonl through flushState, instead of flushing
  // every agent log. Restore sources and plan event folding are unchanged.
  "2.0.0": {
    // Major-version hook schema is explicitly reviewed, never inferred.
    [`${CORE}/features/externalHooks/configSection.ts`]:
      "a95482d27f1a873a64d4e67fda77e844dc8dc29e424acbe03f6ffb094d832b20",
    [`${CORE}/features/externalHooks/internal/types.ts`]:
      "b8ecad863326646df46e5b596324fe9a3d7bd687c78bc6b538399c1201e01d6f",
    [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]:
      "ef981d83e607f0427f77a0fc89e4c03d301116b01ac5f0c33bb68ea955749455",
    [`${CORE}/features/plan/planService.ts`]:
      "1d3526543839a78820e6a2e21f746c311e3034812f479233a4462a2a4fe5fc4d",
    [`${CORE}/state/eventDispatcherService.ts`]:
      "edcab84af00e59a3e67f99b31adb5e97fc97566d5f31e934a230e156dc5e3584",
    [`${CORE}/state/state.ts`]:
      "f473464f22800937ef85a0eb9f4ddd16a8041277eeb4c35b55f4bca6ac52255b",
    [`${CORE}/features/plan/planOps.ts`]:
      "5fc805219ac755c7f155695f783b553088aab90a1ed44aa8f3d59e2926204dde",
    [`${CORE}/app/config/toml.ts`]:
      "57f3830d4fcbf48bb79f6e400efb53af3198ea64de194b381ff8545ab808e334",
    [`${CORE}/app/sessionExport/wire-scan.ts`]:
      "29489dabbc2a585a5cc70015a7b160f7c0a13403f102de007bbce89d1a6b5ef9",
    [`${CORE}/wire/wireService.ts`]:
      "ed730c86e4df0947a31edcccc41892d0989da40766e2b1906586a4916264462b",
    [`${CORE}/wire/record.ts`]:
      "8b9eead225a5120d5dccd829cb900cd31fe2262ac0771bff4983043bb6f55056",
    [`${CORE}/wire/tree/fork.ts`]:
      "843b09947cb7b3bc91cb8bf8216c10d00baba4fcd268b34b174c57b9ea04c533",
  },
  // 2.0.1 (caf7d4e2): restore materializes two views of the SAME wire log;
  // hook types add diagnostic errored state, with the event schema unchanged.
  "2.0.1": {
    // Major-version hook schema is explicitly reviewed, never inferred.
    [`${CORE}/features/externalHooks/configSection.ts`]:
      "a95482d27f1a873a64d4e67fda77e844dc8dc29e424acbe03f6ffb094d832b20",
    [`${CORE}/features/externalHooks/internal/types.ts`]:
      "d4cdf4d4dc3fd0fb761f21ffbe9bfa0b6f313243fcbf7e259e2aa7090c4f0fc6",
    [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]:
      "ef981d83e607f0427f77a0fc89e4c03d301116b01ac5f0c33bb68ea955749455",
    [`${CORE}/features/plan/planService.ts`]:
      "1d3526543839a78820e6a2e21f746c311e3034812f479233a4462a2a4fe5fc4d",
    [`${CORE}/state/eventDispatcherService.ts`]:
      "0b0f74748c10a85d300c9af40ce7194049aeb5747de4457858d6db6569926e2c",
    [`${CORE}/state/state.ts`]:
      "f473464f22800937ef85a0eb9f4ddd16a8041277eeb4c35b55f4bca6ac52255b",
    [`${CORE}/features/plan/planOps.ts`]:
      "5fc805219ac755c7f155695f783b553088aab90a1ed44aa8f3d59e2926204dde",
    [`${CORE}/app/config/toml.ts`]:
      "57f3830d4fcbf48bb79f6e400efb53af3198ea64de194b381ff8545ab808e334",
    [`${CORE}/app/sessionExport/wire-scan.ts`]:
      "29489dabbc2a585a5cc70015a7b160f7c0a13403f102de007bbce89d1a6b5ef9",
    [`${CORE}/wire/wireService.ts`]:
      "3f79dfb010e9a6fe4490b28e77e6c2446516eef755f3cee6d9475a32801f5b5e",
    [`${CORE}/wire/record.ts`]:
      "8b9eead225a5120d5dccd829cb900cd31fe2262ac0771bff4983043bb6f55056",
    [`${CORE}/wire/tree/fork.ts`]:
      "843b09947cb7b3bc91cb8bf8216c10d00baba4fcd268b34b174c57b9ea04c533",
  },
  // 2.0.2 (9d07f634): these construction/schema bytes are identical to
  // 2.0.1. A reviewed hash row enables the source gate, not live certification.
  // The changed human-journal/loop/compaction path is reviewed separately;
  // candidate controls and smoke must pass before changing the runtime matrix.
  "2.0.2": {
    [`${CORE}/features/externalHooks/configSection.ts`]:
      "a95482d27f1a873a64d4e67fda77e844dc8dc29e424acbe03f6ffb094d832b20",
    [`${CORE}/features/externalHooks/internal/types.ts`]:
      "d4cdf4d4dc3fd0fb761f21ffbe9bfa0b6f313243fcbf7e259e2aa7090c4f0fc6",
    [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]:
      "ef981d83e607f0427f77a0fc89e4c03d301116b01ac5f0c33bb68ea955749455",
    [`${CORE}/features/plan/planService.ts`]:
      "1d3526543839a78820e6a2e21f746c311e3034812f479233a4462a2a4fe5fc4d",
    [`${CORE}/state/eventDispatcherService.ts`]:
      "0b0f74748c10a85d300c9af40ce7194049aeb5747de4457858d6db6569926e2c",
    [`${CORE}/state/state.ts`]:
      "f473464f22800937ef85a0eb9f4ddd16a8041277eeb4c35b55f4bca6ac52255b",
    [`${CORE}/features/plan/planOps.ts`]:
      "5fc805219ac755c7f155695f783b553088aab90a1ed44aa8f3d59e2926204dde",
    [`${CORE}/app/config/toml.ts`]:
      "57f3830d4fcbf48bb79f6e400efb53af3198ea64de194b381ff8545ab808e334",
    [`${CORE}/app/sessionExport/wire-scan.ts`]:
      "29489dabbc2a585a5cc70015a7b160f7c0a13403f102de007bbce89d1a6b5ef9",
    [`${CORE}/wire/wireService.ts`]:
      "3f79dfb010e9a6fe4490b28e77e6c2446516eef755f3cee6d9475a32801f5b5e",
    [`${CORE}/wire/record.ts`]:
      "8b9eead225a5120d5dccd829cb900cd31fe2262ac0771bff4983043bb6f55056",
    [`${CORE}/wire/tree/fork.ts`]:
      "843b09947cb7b3bc91cb8bf8216c10d00baba4fcd268b34b174c57b9ea04c533",
  },
  // 2.1.0: reviewed construction and hook-schema bytes match 2.0.2.
  "2.1.0": {
    [`${CORE}/features/externalHooks/configSection.ts`]:
      "a95482d27f1a873a64d4e67fda77e844dc8dc29e424acbe03f6ffb094d832b20",
    [`${CORE}/features/externalHooks/internal/types.ts`]:
      "d4cdf4d4dc3fd0fb761f21ffbe9bfa0b6f313243fcbf7e259e2aa7090c4f0fc6",
    [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]:
      "ef981d83e607f0427f77a0fc89e4c03d301116b01ac5f0c33bb68ea955749455",
    [`${CORE}/features/plan/planService.ts`]:
      "1d3526543839a78820e6a2e21f746c311e3034812f479233a4462a2a4fe5fc4d",
    [`${CORE}/state/eventDispatcherService.ts`]:
      "0b0f74748c10a85d300c9af40ce7194049aeb5747de4457858d6db6569926e2c",
    [`${CORE}/state/state.ts`]:
      "f473464f22800937ef85a0eb9f4ddd16a8041277eeb4c35b55f4bca6ac52255b",
    [`${CORE}/features/plan/planOps.ts`]:
      "5fc805219ac755c7f155695f783b553088aab90a1ed44aa8f3d59e2926204dde",
    [`${CORE}/app/config/toml.ts`]:
      "57f3830d4fcbf48bb79f6e400efb53af3198ea64de194b381ff8545ab808e334",
    [`${CORE}/app/sessionExport/wire-scan.ts`]:
      "29489dabbc2a585a5cc70015a7b160f7c0a13403f102de007bbce89d1a6b5ef9",
    [`${CORE}/wire/wireService.ts`]:
      "3f79dfb010e9a6fe4490b28e77e6c2446516eef755f3cee6d9475a32801f5b5e",
    [`${CORE}/wire/record.ts`]:
      "8b9eead225a5120d5dccd829cb900cd31fe2262ac0771bff4983043bb6f55056",
    [`${CORE}/wire/tree/fork.ts`]:
      "843b09947cb7b3bc91cb8bf8216c10d00baba4fcd268b34b174c57b9ea04c533",
  },
  // 2.1.1: reviewed construction and hook-schema bytes match 2.0.2.
  "2.1.1": {
    [`${CORE}/features/externalHooks/configSection.ts`]:
      "a95482d27f1a873a64d4e67fda77e844dc8dc29e424acbe03f6ffb094d832b20",
    [`${CORE}/features/externalHooks/internal/types.ts`]:
      "d4cdf4d4dc3fd0fb761f21ffbe9bfa0b6f313243fcbf7e259e2aa7090c4f0fc6",
    [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]:
      "ef981d83e607f0427f77a0fc89e4c03d301116b01ac5f0c33bb68ea955749455",
    [`${CORE}/features/plan/planService.ts`]:
      "1d3526543839a78820e6a2e21f746c311e3034812f479233a4462a2a4fe5fc4d",
    [`${CORE}/state/eventDispatcherService.ts`]:
      "0b0f74748c10a85d300c9af40ce7194049aeb5747de4457858d6db6569926e2c",
    [`${CORE}/state/state.ts`]:
      "f473464f22800937ef85a0eb9f4ddd16a8041277eeb4c35b55f4bca6ac52255b",
    [`${CORE}/features/plan/planOps.ts`]:
      "5fc805219ac755c7f155695f783b553088aab90a1ed44aa8f3d59e2926204dde",
    [`${CORE}/app/config/toml.ts`]:
      "57f3830d4fcbf48bb79f6e400efb53af3198ea64de194b381ff8545ab808e334",
    [`${CORE}/app/sessionExport/wire-scan.ts`]:
      "29489dabbc2a585a5cc70015a7b160f7c0a13403f102de007bbce89d1a6b5ef9",
    [`${CORE}/wire/wireService.ts`]:
      "3f79dfb010e9a6fe4490b28e77e6c2446516eef755f3cee6d9475a32801f5b5e",
    [`${CORE}/wire/record.ts`]:
      "8b9eead225a5120d5dccd829cb900cd31fe2262ac0771bff4983043bb6f55056",
    [`${CORE}/wire/tree/fork.ts`]:
      "843b09947cb7b3bc91cb8bf8216c10d00baba4fcd268b34b174c57b9ea04c533",
  },
  // 2.2.0 (472192c34c1efad89a369870eff0da0b708ce9bb): all twelve load-bearing files are
  // byte-identical to 2.1.1 (verified 2026-10-14 by sha256 over the exact tag checkout).
  "2.2.0": {
    [`${CORE}/features/externalHooks/configSection.ts`]:
      "a95482d27f1a873a64d4e67fda77e844dc8dc29e424acbe03f6ffb094d832b20",
    [`${CORE}/features/externalHooks/internal/types.ts`]:
      "d4cdf4d4dc3fd0fb761f21ffbe9bfa0b6f313243fcbf7e259e2aa7090c4f0fc6",
    [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]:
      "ef981d83e607f0427f77a0fc89e4c03d301116b01ac5f0c33bb68ea955749455",
    [`${CORE}/features/plan/planService.ts`]:
      "1d3526543839a78820e6a2e21f746c311e3034812f479233a4462a2a4fe5fc4d",
    [`${CORE}/state/eventDispatcherService.ts`]:
      "0b0f74748c10a85d300c9af40ce7194049aeb5747de4457858d6db6569926e2c",
    [`${CORE}/state/state.ts`]:
      "f473464f22800937ef85a0eb9f4ddd16a8041277eeb4c35b55f4bca6ac52255b",
    [`${CORE}/features/plan/planOps.ts`]:
      "5fc805219ac755c7f155695f783b553088aab90a1ed44aa8f3d59e2926204dde",
    [`${CORE}/app/config/toml.ts`]:
      "57f3830d4fcbf48bb79f6e400efb53af3198ea64de194b381ff8545ab808e334",
    [`${CORE}/app/sessionExport/wire-scan.ts`]:
      "29489dabbc2a585a5cc70015a7b160f7c0a13403f102de007bbce89d1a6b5ef9",
    [`${CORE}/wire/wireService.ts`]:
      "3f79dfb010e9a6fe4490b28e77e6c2446516eef755f3cee6d9475a32801f5b5e",
    [`${CORE}/wire/record.ts`]:
      "8b9eead225a5120d5dccd829cb900cd31fe2262ac0771bff4983043bb6f55056",
    [`${CORE}/wire/tree/fork.ts`]:
      "843b09947cb7b3bc91cb8bf8216c10d00baba4fcd268b34b174c57b9ea04c533",
  },
  // 2.3.0: restore still reads the same trusted journal. Pin the new stale
  // reload route too; concurrent operator writes remain the documented residual.
  "2.3.0": {
    [`${CORE}/features/externalHooks/configSection.ts`]:
      "a95482d27f1a873a64d4e67fda77e844dc8dc29e424acbe03f6ffb094d832b20",
    [`${CORE}/features/externalHooks/internal/types.ts`]:
      "d4cdf4d4dc3fd0fb761f21ffbe9bfa0b6f313243fcbf7e259e2aa7090c4f0fc6",
    [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]:
      "ef981d83e607f0427f77a0fc89e4c03d301116b01ac5f0c33bb68ea955749455",
    [`${CORE}/features/plan/planService.ts`]:
      "1d3526543839a78820e6a2e21f746c311e3034812f479233a4462a2a4fe5fc4d",
    [`${CORE}/state/eventDispatcherService.ts`]:
      "318b67bece05963fa703cf29d64c43db229a0443a2402b433ae61798db469f4c",
    [`${CORE}/state/state.ts`]:
      "f473464f22800937ef85a0eb9f4ddd16a8041277eeb4c35b55f4bca6ac52255b",
    [`${CORE}/features/plan/planOps.ts`]:
      "5fc805219ac755c7f155695f783b553088aab90a1ed44aa8f3d59e2926204dde",
    [`${CORE}/app/config/toml.ts`]:
      "57f3830d4fcbf48bb79f6e400efb53af3198ea64de194b381ff8545ab808e334",
    [`${CORE}/app/sessionExport/wire-scan.ts`]:
      "29489dabbc2a585a5cc70015a7b160f7c0a13403f102de007bbce89d1a6b5ef9",
    [`${CORE}/wire/wireService.ts`]:
      "9a66326ad86186815cc63935e36584a2d1f2ee6cb9c73f303a083536f74a3316",
    [`${CORE}/wire/record.ts`]:
      "8b9eead225a5120d5dccd829cb900cd31fe2262ac0771bff4983043bb6f55056",
    [`${CORE}/wire/tree/fork.ts`]:
      "843b09947cb7b3bc91cb8bf8216c10d00baba4fcd268b34b174c57b9ea04c533",
    [`${CLI}/cli/v2/run-v2-print.ts`]:
      "cd4c6c8274cf85720d63e403604108a340acc47bb95d082f6c466f20901457ec",
    [`${CORE}/app/sessionManager/sessionLookup.ts`]:
      "7932bc912e29f4cb0d04834e60a79d8ef7f7a56591085c4357d86bf56fcce5fc",
    [`${CORE}/session/sessionActivity/sessionRunGateService.ts`]:
      "47c5feac88eab42e123f92fbbc85c1fa0740283daec63f5ae043a9e509980d4d",
  },
  // 2.3.1: all fifteen load-bearing files are byte-identical to 2.3.0.
  // The workspace-trust and session-lock changes are reviewed separately.
  "2.3.1": {
    [`${CORE}/features/externalHooks/configSection.ts`]:
      "a95482d27f1a873a64d4e67fda77e844dc8dc29e424acbe03f6ffb094d832b20",
    [`${CORE}/features/externalHooks/internal/types.ts`]:
      "d4cdf4d4dc3fd0fb761f21ffbe9bfa0b6f313243fcbf7e259e2aa7090c4f0fc6",
    [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]:
      "ef981d83e607f0427f77a0fc89e4c03d301116b01ac5f0c33bb68ea955749455",
    [`${CORE}/features/plan/planService.ts`]:
      "1d3526543839a78820e6a2e21f746c311e3034812f479233a4462a2a4fe5fc4d",
    [`${CORE}/state/eventDispatcherService.ts`]:
      "318b67bece05963fa703cf29d64c43db229a0443a2402b433ae61798db469f4c",
    [`${CORE}/state/state.ts`]:
      "f473464f22800937ef85a0eb9f4ddd16a8041277eeb4c35b55f4bca6ac52255b",
    [`${CORE}/features/plan/planOps.ts`]:
      "5fc805219ac755c7f155695f783b553088aab90a1ed44aa8f3d59e2926204dde",
    [`${CORE}/app/config/toml.ts`]:
      "57f3830d4fcbf48bb79f6e400efb53af3198ea64de194b381ff8545ab808e334",
    [`${CORE}/app/sessionExport/wire-scan.ts`]:
      "29489dabbc2a585a5cc70015a7b160f7c0a13403f102de007bbce89d1a6b5ef9",
    [`${CORE}/wire/wireService.ts`]:
      "9a66326ad86186815cc63935e36584a2d1f2ee6cb9c73f303a083536f74a3316",
    [`${CORE}/wire/record.ts`]:
      "8b9eead225a5120d5dccd829cb900cd31fe2262ac0771bff4983043bb6f55056",
    [`${CORE}/wire/tree/fork.ts`]:
      "843b09947cb7b3bc91cb8bf8216c10d00baba4fcd268b34b174c57b9ea04c533",
    [`${CLI}/cli/v2/run-v2-print.ts`]:
      "cd4c6c8274cf85720d63e403604108a340acc47bb95d082f6c466f20901457ec",
    [`${CORE}/app/sessionManager/sessionLookup.ts`]:
      "7932bc912e29f4cb0d04834e60a79d8ef7f7a56591085c4357d86bf56fcce5fc",
    [`${CORE}/session/sessionActivity/sessionRunGateService.ts`]:
      "47c5feac88eab42e123f92fbbc85c1fa0740283daec63f5ae043a9e509980d4d",
  },
  // 2.3.2: the construction/schema bytes match 2.3.1. The removal of
  // AgentSwarm from print mode is a separate per-operation compatibility gate.
  "2.3.2": {
    [`${CORE}/features/externalHooks/configSection.ts`]:
      "a95482d27f1a873a64d4e67fda77e844dc8dc29e424acbe03f6ffb094d832b20",
    [`${CORE}/features/externalHooks/internal/types.ts`]:
      "d4cdf4d4dc3fd0fb761f21ffbe9bfa0b6f313243fcbf7e259e2aa7090c4f0fc6",
    [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]:
      "ef981d83e607f0427f77a0fc89e4c03d301116b01ac5f0c33bb68ea955749455",
    [`${CORE}/features/plan/planService.ts`]:
      "1d3526543839a78820e6a2e21f746c311e3034812f479233a4462a2a4fe5fc4d",
    [`${CORE}/state/eventDispatcherService.ts`]:
      "318b67bece05963fa703cf29d64c43db229a0443a2402b433ae61798db469f4c",
    [`${CORE}/state/state.ts`]:
      "f473464f22800937ef85a0eb9f4ddd16a8041277eeb4c35b55f4bca6ac52255b",
    [`${CORE}/features/plan/planOps.ts`]:
      "5fc805219ac755c7f155695f783b553088aab90a1ed44aa8f3d59e2926204dde",
    [`${CORE}/app/config/toml.ts`]:
      "57f3830d4fcbf48bb79f6e400efb53af3198ea64de194b381ff8545ab808e334",
    [`${CORE}/app/sessionExport/wire-scan.ts`]:
      "29489dabbc2a585a5cc70015a7b160f7c0a13403f102de007bbce89d1a6b5ef9",
    [`${CORE}/wire/wireService.ts`]:
      "9a66326ad86186815cc63935e36584a2d1f2ee6cb9c73f303a083536f74a3316",
    [`${CORE}/wire/record.ts`]:
      "8b9eead225a5120d5dccd829cb900cd31fe2262ac0771bff4983043bb6f55056",
    [`${CORE}/wire/tree/fork.ts`]:
      "843b09947cb7b3bc91cb8bf8216c10d00baba4fcd268b34b174c57b9ea04c533",
    [`${CLI}/cli/v2/run-v2-print.ts`]:
      "cd4c6c8274cf85720d63e403604108a340acc47bb95d082f6c466f20901457ec",
    [`${CORE}/app/sessionManager/sessionLookup.ts`]:
      "7932bc912e29f4cb0d04834e60a79d8ef7f7a56591085c4357d86bf56fcce5fc",
    [`${CORE}/session/sessionActivity/sessionRunGateService.ts`]:
      "47c5feac88eab42e123f92fbbc85c1fa0740283daec63f5ae043a9e509980d4d",
  },
  // 2.3.3: exact-tag construction/schema files are byte-identical to 2.3.2.
  "2.3.3": {
    [`${CORE}/features/externalHooks/configSection.ts`]:
      "a95482d27f1a873a64d4e67fda77e844dc8dc29e424acbe03f6ffb094d832b20",
    [`${CORE}/features/externalHooks/internal/types.ts`]:
      "d4cdf4d4dc3fd0fb761f21ffbe9bfa0b6f313243fcbf7e259e2aa7090c4f0fc6",
    [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]:
      "ef981d83e607f0427f77a0fc89e4c03d301116b01ac5f0c33bb68ea955749455",
    [`${CORE}/features/plan/planService.ts`]:
      "1d3526543839a78820e6a2e21f746c311e3034812f479233a4462a2a4fe5fc4d",
    [`${CORE}/state/eventDispatcherService.ts`]:
      "318b67bece05963fa703cf29d64c43db229a0443a2402b433ae61798db469f4c",
    [`${CORE}/state/state.ts`]:
      "f473464f22800937ef85a0eb9f4ddd16a8041277eeb4c35b55f4bca6ac52255b",
    [`${CORE}/features/plan/planOps.ts`]:
      "5fc805219ac755c7f155695f783b553088aab90a1ed44aa8f3d59e2926204dde",
    [`${CORE}/app/config/toml.ts`]:
      "57f3830d4fcbf48bb79f6e400efb53af3198ea64de194b381ff8545ab808e334",
    [`${CORE}/app/sessionExport/wire-scan.ts`]:
      "29489dabbc2a585a5cc70015a7b160f7c0a13403f102de007bbce89d1a6b5ef9",
    [`${CORE}/wire/wireService.ts`]:
      "9a66326ad86186815cc63935e36584a2d1f2ee6cb9c73f303a083536f74a3316",
    [`${CORE}/wire/record.ts`]:
      "8b9eead225a5120d5dccd829cb900cd31fe2262ac0771bff4983043bb6f55056",
    [`${CORE}/wire/tree/fork.ts`]:
      "843b09947cb7b3bc91cb8bf8216c10d00baba4fcd268b34b174c57b9ea04c533",
    [`${CLI}/cli/v2/run-v2-print.ts`]:
      "cd4c6c8274cf85720d63e403604108a340acc47bb95d082f6c466f20901457ec",
    [`${CORE}/app/sessionManager/sessionLookup.ts`]:
      "7932bc912e29f4cb0d04834e60a79d8ef7f7a56591085c4357d86bf56fcce5fc",
    [`${CORE}/session/sessionActivity/sessionRunGateService.ts`]:
      "47c5feac88eab42e123f92fbbc85c1fa0740283daec63f5ae043a9e509980d4d",
  },
  // 2.4.0: plan entry is main-agent-only and the EnterPlanMode tool is removed.
  // Fresh print cancels the configured default; resume still replays the same
  // wire journal. Mutable replay is used by context memory, not plan state.
  "2.4.0": {
    [`${CORE}/features/externalHooks/configSection.ts`]:
      "a95482d27f1a873a64d4e67fda77e844dc8dc29e424acbe03f6ffb094d832b20",
    [`${CORE}/features/externalHooks/internal/types.ts`]:
      "d4cdf4d4dc3fd0fb761f21ffbe9bfa0b6f313243fcbf7e259e2aa7090c4f0fc6",
    [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]:
      "ef981d83e607f0427f77a0fc89e4c03d301116b01ac5f0c33bb68ea955749455",
    [`${CORE}/features/plan/planService.ts`]:
      "10c2cc7bf29bab9b810aa55f3ee0ca36d7a8f2947e99aadaaa1b3fec2603fe8b",
    [`${CORE}/state/eventDispatcherService.ts`]:
      "5a98a1f4ca9f14ae1e3f967c66943045f8e389e9379e06fd88863d44a41884da",
    [`${CORE}/state/state.ts`]:
      "736bd13f41d245b519ddce795bbf5ea6847016ed244c58f0b14d603d548a4f41",
    [`${CORE}/features/plan/planOps.ts`]:
      "074d63a1a1be9d361abf3c46656415a1be1517a9a8237df34a6cc24ce9864cef",
    [`${CORE}/app/config/toml.ts`]:
      "57f3830d4fcbf48bb79f6e400efb53af3198ea64de194b381ff8545ab808e334",
    [`${CORE}/app/sessionExport/wire-scan.ts`]:
      "29489dabbc2a585a5cc70015a7b160f7c0a13403f102de007bbce89d1a6b5ef9",
    [`${CORE}/wire/wireService.ts`]:
      "e92bc7c0d2d9428c810a9fb44ce2a8217ae7dfed906fbf00b59a3f3cd18bcbde",
    [`${CORE}/wire/record.ts`]:
      "8b9eead225a5120d5dccd829cb900cd31fe2262ac0771bff4983043bb6f55056",
    [`${CORE}/wire/tree/fork.ts`]:
      "843b09947cb7b3bc91cb8bf8216c10d00baba4fcd268b34b174c57b9ea04c533",
    [`${CLI}/cli/v2/run-v2-print.ts`]:
      "b378a1dd32b1b0acd42f2f544d10ffbd5afeab1f8482e4125988c7a716c180d3",
    [`${CORE}/app/sessionManager/sessionLookup.ts`]:
      "d4a087aa8364e1ca1b9c7b2324956d06495c8c54c880c2a767a27560c676129d",
    [`${CORE}/session/sessionActivity/sessionRunGateService.ts`]:
      "47c5feac88eab42e123f92fbbc85c1fa0740283daec63f5ae043a9e509980d4d",
  },
  // 2.4.1: all fifteen construction/schema files are byte-identical to 2.4.0.
  // Read output/token limiting and model-facing prompt changes are reviewed separately.
  "2.4.1": {
    [`${CORE}/features/externalHooks/configSection.ts`]:
      "a95482d27f1a873a64d4e67fda77e844dc8dc29e424acbe03f6ffb094d832b20",
    [`${CORE}/features/externalHooks/internal/types.ts`]:
      "d4cdf4d4dc3fd0fb761f21ffbe9bfa0b6f313243fcbf7e259e2aa7090c4f0fc6",
    [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]:
      "ef981d83e607f0427f77a0fc89e4c03d301116b01ac5f0c33bb68ea955749455",
    [`${CORE}/features/plan/planService.ts`]:
      "10c2cc7bf29bab9b810aa55f3ee0ca36d7a8f2947e99aadaaa1b3fec2603fe8b",
    [`${CORE}/state/eventDispatcherService.ts`]:
      "5a98a1f4ca9f14ae1e3f967c66943045f8e389e9379e06fd88863d44a41884da",
    [`${CORE}/state/state.ts`]:
      "736bd13f41d245b519ddce795bbf5ea6847016ed244c58f0b14d603d548a4f41",
    [`${CORE}/features/plan/planOps.ts`]:
      "074d63a1a1be9d361abf3c46656415a1be1517a9a8237df34a6cc24ce9864cef",
    [`${CORE}/app/config/toml.ts`]:
      "57f3830d4fcbf48bb79f6e400efb53af3198ea64de194b381ff8545ab808e334",
    [`${CORE}/app/sessionExport/wire-scan.ts`]:
      "29489dabbc2a585a5cc70015a7b160f7c0a13403f102de007bbce89d1a6b5ef9",
    [`${CORE}/wire/wireService.ts`]:
      "e92bc7c0d2d9428c810a9fb44ce2a8217ae7dfed906fbf00b59a3f3cd18bcbde",
    [`${CORE}/wire/record.ts`]:
      "8b9eead225a5120d5dccd829cb900cd31fe2262ac0771bff4983043bb6f55056",
    [`${CORE}/wire/tree/fork.ts`]:
      "843b09947cb7b3bc91cb8bf8216c10d00baba4fcd268b34b174c57b9ea04c533",
    [`${CLI}/cli/v2/run-v2-print.ts`]:
      "b378a1dd32b1b0acd42f2f544d10ffbd5afeab1f8482e4125988c7a716c180d3",
    [`${CORE}/app/sessionManager/sessionLookup.ts`]:
      "d4a087aa8364e1ca1b9c7b2324956d06495c8c54c880c2a767a27560c676129d",
    [`${CORE}/session/sessionActivity/sessionRunGateService.ts`]:
      "47c5feac88eab42e123f92fbbc85c1fa0740283daec63f5ae043a9e509980d4d",
  },
  // 2.5.0: reviewed hook diagnostics, environment-aware plan targets, wire
  // normalization, and the native SDK print bootstrap. The removed-tool surface
  // and the other nine construction/schema files are unchanged from 2.4.1.
  "2.5.0": {
    [`${CORE}/features/externalHooks/configSection.ts`]:
      "a95482d27f1a873a64d4e67fda77e844dc8dc29e424acbe03f6ffb094d832b20",
    [`${CORE}/features/externalHooks/internal/types.ts`]:
      "322a7ec016ccb6f33ca0d9fdc1e609393921c366c2b5bb7063341c9ca29cc318",
    [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]:
      "ef981d83e607f0427f77a0fc89e4c03d301116b01ac5f0c33bb68ea955749455",
    [`${CORE}/features/plan/planService.ts`]:
      "0d5d269e5cfc052db6697d4ebe01069e46ea756f2b34d7822ac4e8b2c3bd16a0",
    [`${CORE}/state/eventDispatcherService.ts`]:
      "5a98a1f4ca9f14ae1e3f967c66943045f8e389e9379e06fd88863d44a41884da",
    [`${CORE}/state/state.ts`]:
      "736bd13f41d245b519ddce795bbf5ea6847016ed244c58f0b14d603d548a4f41",
    [`${CORE}/features/plan/planOps.ts`]:
      "074d63a1a1be9d361abf3c46656415a1be1517a9a8237df34a6cc24ce9864cef",
    [`${CORE}/app/config/toml.ts`]:
      "57f3830d4fcbf48bb79f6e400efb53af3198ea64de194b381ff8545ab808e334",
    [`${CORE}/app/sessionExport/wire-scan.ts`]:
      "29489dabbc2a585a5cc70015a7b160f7c0a13403f102de007bbce89d1a6b5ef9",
    [`${CORE}/wire/wireService.ts`]:
      "7075a05a7ec9cdb117469943ce1b507a97ad2c0e4bfd55d07eb64c30ec5e8dbc",
    [`${CORE}/wire/record.ts`]:
      "75f71ea73c2f7aef1f26efe6d5b1f86b4c1bbfa66945bd2d2bceec2e67b5109b",
    [`${CORE}/wire/tree/fork.ts`]:
      "c8b692dd32cc86d09d95c7a83be2d357d73f071acb5c5a44387d12c6a652807c",
    [`${CLI}/cli/v2/run-v2-print.ts`]:
      "b40ca78e5bb7867ee636a38b9bfa1513e41dd1a832ae1c4e662f1fcb9865c19c",
    [`${CORE}/app/sessionManager/sessionLookup.ts`]:
      "d4a087aa8364e1ca1b9c7b2324956d06495c8c54c880c2a767a27560c676129d",
    [`${CORE}/session/sessionActivity/sessionRunGateService.ts`]:
      "47c5feac88eab42e123f92fbbc85c1fa0740283daec63f5ae043a9e509980d4d",
    [`${SDK}/sdk-rpc-client-v2.ts`]:
      "b10009d4f6eab8435a87068ec2d674b8745d136535a2014624a1b00c8ecc8e40",
    [`${CORE}/app/sessionManager/sessionManagerService.ts`]:
      "9f7b0909c592767c5affd66349d953379758a27e78be9e610fcd7ae020b3f4b6",
    [`${CORE}/workspace/sessionLifecycle/sessionLifecycleService.ts`]:
      "d02ed76254f37f79125c0f0e5ed3ae0ab13bd2eda2b129aaaaab71c2a15a0339",
    [`${CORE}/session/agentLifecycle/agentLifecycleService.ts`]:
      "bd16636c6249617a60188746aa96522e5333278c2b48903d7bc8e1d267e55462",
    [`${CORE}/agent/environmentBinding/environmentBindingService.ts`]:
      "3a54b6b80e9ccade6f5d5ec19a3a7ac0218c37aee9eedb970c0b0616194118c5",
    [`${CORE}/agent/environmentBinding/environmentBindingOps.ts`]:
      "bc0ff3d206520dbc16bf8223eb5dff67673865dfd25f04d391f962ef9322b13b",
    [`${CORE}/app/config/configService.ts`]:
      "8b1709ba10a5f7ae8d79be4eadd008e3861b6f2121fbed8b0dd8d1c6d198d53c",
    [`${CORE}/workspace/workspaceTrust/configSection.ts`]:
      "e10c5e96f0211e3936d03f68ee3695c8573ceb1398aed4e0bb4a3782f500d758",
    [`${CORE}/workspace/workspaceTrust/workspaceTrustStore.ts`]:
      "bcd4621eb02c50e9a79c4f0076afaa0e6f72ef299dedb149077a1b4e3bde7acc",
    [`${CORE}/workspace/workspaceMcpConfig/workspaceMcpConfigService.ts`]:
      "ff805190454881fc7179e63684c1a409e27e66c987ae3c856a42ca944405c3c2",
    [`${CORE}/features/externalHooks/agent/agentExternalHooksService.ts`]:
      "701a53165f60d62a544e2e3154dadc97b41693014c456a9fec061327a3fdf9bc",
    [`${CORE}/agent/tools/os/bash/bashTool.ts`]:
      "91baca9ee4e70190cf24ccace0313e525c473b6184eab9eb1ec90f28e3bdb500",
    [`${CORE}/remote/client/remoteEnvironmentProvider.ts`]:
      "0260b35b201e632f4e742694f962ee414bd7bbac16eb9193e08540b8e8ad26f9",
    [`${CLI}/cli/prompt-render.ts`]:
      "d413a0678dcebb5a0a6f9dda8ce51d53e4b70d55b162afe6635a7d8c1a1536c4",
    [`${CLI}/cli/goal-prompt.ts`]:
      "b95cabc1336c191c5efebbbc08956d5d45138f39877ffffda8066bcb9fc75ca8",
    [`${CLI}/cli/headless-exit.ts`]:
      "9087cba8698f21aba08190240cedbf3da650d4596b6217eca26ec179d9396826",
    [`${KAP}/protocol/ws-agent.ts`]:
      "cbf9a9f2ae111dceb34e5674b336d3accacf265246bc187d7453b19cbfc5d093",
    [`${KAP}/transport/ws/v1/agentState.ts`]:
      "0261a6a674965935f03e4fa3be7bdde0b518d0c31f5ff01e35366de23dbcb5f1",
    [`${KAP}/transport/ws/bearerProtocol.ts`]:
      "c9ee2315b3872bcc86a1a50ba965cfa43700754b6421873fd9771067c5eb8ec2",
    [`${KAP}/transport/ws/v1/wsConnectionV1.ts`]:
      "f036f0bbc0af8b5d97de79db96f61f92f1cbe05b8e2498f2ee2989f7c2d3a69d",
    [`${KAP}/transport/ws/v1/sessionAgentFeed.ts`]:
      "d22f9cde4a7acfb49dda64740bd9eb818b6bd65c9a77aa921fb9840077cd6fb3",
    [`${KAP}/transport/ws/v1/sessionEventBroadcaster.ts`]:
      "13986d6ee58373c8f52e00b33fbf61c2a4a665f1fa40e2c65db56ed5addb0197",
    [`${KAP}/routes/environment.ts`]:
      "f40f3ef8f47cc8cc977e53bf8b9b5b67a415960cd64455902cab943291745689",
    [`${KAP}/routes/sessions.ts`]:
      "f99cae893c51ac987ab7b0cc16090d98a3549d9ad2509140434d8dea34f07bfb",
    [`${KAP}/start.ts`]:
      "21842202f83ac093b63ab3ced9805d56be8a46c0e6199e96457948cf4b0feac1",
  },
  // 2.5.1: the construction, hook schema, print, environment and WebSocket
  // files are byte-identical to 2.5.0. Session-list visibility filtering is the
  // only changed pinned file; it does not alter session creation or activation.
  "2.5.1": {
    [`${CORE}/features/externalHooks/configSection.ts`]:
      "a95482d27f1a873a64d4e67fda77e844dc8dc29e424acbe03f6ffb094d832b20",
    [`${CORE}/features/externalHooks/internal/types.ts`]:
      "322a7ec016ccb6f33ca0d9fdc1e609393921c366c2b5bb7063341c9ca29cc318",
    [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]:
      "ef981d83e607f0427f77a0fc89e4c03d301116b01ac5f0c33bb68ea955749455",
    [`${CORE}/features/plan/planService.ts`]:
      "0d5d269e5cfc052db6697d4ebe01069e46ea756f2b34d7822ac4e8b2c3bd16a0",
    [`${CORE}/state/eventDispatcherService.ts`]:
      "5a98a1f4ca9f14ae1e3f967c66943045f8e389e9379e06fd88863d44a41884da",
    [`${CORE}/state/state.ts`]:
      "736bd13f41d245b519ddce795bbf5ea6847016ed244c58f0b14d603d548a4f41",
    [`${CORE}/features/plan/planOps.ts`]:
      "074d63a1a1be9d361abf3c46656415a1be1517a9a8237df34a6cc24ce9864cef",
    [`${CORE}/app/config/toml.ts`]:
      "57f3830d4fcbf48bb79f6e400efb53af3198ea64de194b381ff8545ab808e334",
    [`${CORE}/app/sessionExport/wire-scan.ts`]:
      "29489dabbc2a585a5cc70015a7b160f7c0a13403f102de007bbce89d1a6b5ef9",
    [`${CORE}/wire/wireService.ts`]:
      "7075a05a7ec9cdb117469943ce1b507a97ad2c0e4bfd55d07eb64c30ec5e8dbc",
    [`${CORE}/wire/record.ts`]:
      "75f71ea73c2f7aef1f26efe6d5b1f86b4c1bbfa66945bd2d2bceec2e67b5109b",
    [`${CORE}/wire/tree/fork.ts`]:
      "c8b692dd32cc86d09d95c7a83be2d357d73f071acb5c5a44387d12c6a652807c",
    [`${CLI}/cli/v2/run-v2-print.ts`]:
      "b40ca78e5bb7867ee636a38b9bfa1513e41dd1a832ae1c4e662f1fcb9865c19c",
    [`${CORE}/app/sessionManager/sessionLookup.ts`]:
      "d4a087aa8364e1ca1b9c7b2324956d06495c8c54c880c2a767a27560c676129d",
    [`${CORE}/session/sessionActivity/sessionRunGateService.ts`]:
      "47c5feac88eab42e123f92fbbc85c1fa0740283daec63f5ae043a9e509980d4d",
    [`${SDK}/sdk-rpc-client-v2.ts`]:
      "b10009d4f6eab8435a87068ec2d674b8745d136535a2014624a1b00c8ecc8e40",
    [`${CORE}/app/sessionManager/sessionManagerService.ts`]:
      "9f7b0909c592767c5affd66349d953379758a27e78be9e610fcd7ae020b3f4b6",
    [`${CORE}/workspace/sessionLifecycle/sessionLifecycleService.ts`]:
      "d02ed76254f37f79125c0f0e5ed3ae0ab13bd2eda2b129aaaaab71c2a15a0339",
    [`${CORE}/session/agentLifecycle/agentLifecycleService.ts`]:
      "bd16636c6249617a60188746aa96522e5333278c2b48903d7bc8e1d267e55462",
    [`${CORE}/agent/environmentBinding/environmentBindingService.ts`]:
      "3a54b6b80e9ccade6f5d5ec19a3a7ac0218c37aee9eedb970c0b0616194118c5",
    [`${CORE}/agent/environmentBinding/environmentBindingOps.ts`]:
      "bc0ff3d206520dbc16bf8223eb5dff67673865dfd25f04d391f962ef9322b13b",
    [`${CORE}/app/config/configService.ts`]:
      "8b1709ba10a5f7ae8d79be4eadd008e3861b6f2121fbed8b0dd8d1c6d198d53c",
    [`${CORE}/workspace/workspaceTrust/configSection.ts`]:
      "e10c5e96f0211e3936d03f68ee3695c8573ceb1398aed4e0bb4a3782f500d758",
    [`${CORE}/workspace/workspaceTrust/workspaceTrustStore.ts`]:
      "bcd4621eb02c50e9a79c4f0076afaa0e6f72ef299dedb149077a1b4e3bde7acc",
    [`${CORE}/workspace/workspaceMcpConfig/workspaceMcpConfigService.ts`]:
      "ff805190454881fc7179e63684c1a409e27e66c987ae3c856a42ca944405c3c2",
    [`${CORE}/features/externalHooks/agent/agentExternalHooksService.ts`]:
      "701a53165f60d62a544e2e3154dadc97b41693014c456a9fec061327a3fdf9bc",
    [`${CORE}/agent/tools/os/bash/bashTool.ts`]:
      "91baca9ee4e70190cf24ccace0313e525c473b6184eab9eb1ec90f28e3bdb500",
    [`${CORE}/remote/client/remoteEnvironmentProvider.ts`]:
      "0260b35b201e632f4e742694f962ee414bd7bbac16eb9193e08540b8e8ad26f9",
    [`${CLI}/cli/prompt-render.ts`]:
      "d413a0678dcebb5a0a6f9dda8ce51d53e4b70d55b162afe6635a7d8c1a1536c4",
    [`${CLI}/cli/goal-prompt.ts`]:
      "b95cabc1336c191c5efebbbc08956d5d45138f39877ffffda8066bcb9fc75ca8",
    [`${CLI}/cli/headless-exit.ts`]:
      "9087cba8698f21aba08190240cedbf3da650d4596b6217eca26ec179d9396826",
    [`${KAP}/protocol/ws-agent.ts`]:
      "cbf9a9f2ae111dceb34e5674b336d3accacf265246bc187d7453b19cbfc5d093",
    [`${KAP}/transport/ws/v1/agentState.ts`]:
      "0261a6a674965935f03e4fa3be7bdde0b518d0c31f5ff01e35366de23dbcb5f1",
    [`${KAP}/transport/ws/bearerProtocol.ts`]:
      "c9ee2315b3872bcc86a1a50ba965cfa43700754b6421873fd9771067c5eb8ec2",
    [`${KAP}/transport/ws/v1/wsConnectionV1.ts`]:
      "f036f0bbc0af8b5d97de79db96f61f92f1cbe05b8e2498f2ee2989f7c2d3a69d",
    [`${KAP}/transport/ws/v1/sessionAgentFeed.ts`]:
      "d22f9cde4a7acfb49dda64740bd9eb818b6bd65c9a77aa921fb9840077cd6fb3",
    [`${KAP}/transport/ws/v1/sessionEventBroadcaster.ts`]:
      "13986d6ee58373c8f52e00b33fbf61c2a4a665f1fa40e2c65db56ed5addb0197",
    [`${KAP}/routes/environment.ts`]:
      "f40f3ef8f47cc8cc977e53bf8b9b5b67a415960cd64455902cab943291745689",
    [`${KAP}/routes/sessions.ts`]:
      "a6a6202d06359466904c862ecd0a78bbae7c1eaf0c1b37cb16ac1d1ec79a1f15",
    [`${KAP}/start.ts`]:
      "21842202f83ac093b63ab3ced9805d56be8a46c0e6199e96457948cf4b0feac1",
  },
  // 2.5.2: all forty pinned files are byte-identical to 2.5.1. The release
  // changes only MCP pending-tool registration, tool-select reconciliation, and
  // tool-contract signature helpers; executor, hooks, plan, and print are untouched.
  "2.5.2": {
    [`${CORE}/features/externalHooks/configSection.ts`]:
      "a95482d27f1a873a64d4e67fda77e844dc8dc29e424acbe03f6ffb094d832b20",
    [`${CORE}/features/externalHooks/internal/types.ts`]:
      "322a7ec016ccb6f33ca0d9fdc1e609393921c366c2b5bb7063341c9ca29cc318",
    [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]:
      "ef981d83e607f0427f77a0fc89e4c03d301116b01ac5f0c33bb68ea955749455",
    [`${CORE}/features/plan/planService.ts`]:
      "0d5d269e5cfc052db6697d4ebe01069e46ea756f2b34d7822ac4e8b2c3bd16a0",
    [`${CORE}/state/eventDispatcherService.ts`]:
      "5a98a1f4ca9f14ae1e3f967c66943045f8e389e9379e06fd88863d44a41884da",
    [`${CORE}/state/state.ts`]:
      "736bd13f41d245b519ddce795bbf5ea6847016ed244c58f0b14d603d548a4f41",
    [`${CORE}/features/plan/planOps.ts`]:
      "074d63a1a1be9d361abf3c46656415a1be1517a9a8237df34a6cc24ce9864cef",
    [`${CORE}/app/config/toml.ts`]:
      "57f3830d4fcbf48bb79f6e400efb53af3198ea64de194b381ff8545ab808e334",
    [`${CORE}/app/sessionExport/wire-scan.ts`]:
      "29489dabbc2a585a5cc70015a7b160f7c0a13403f102de007bbce89d1a6b5ef9",
    [`${CORE}/wire/wireService.ts`]:
      "7075a05a7ec9cdb117469943ce1b507a97ad2c0e4bfd55d07eb64c30ec5e8dbc",
    [`${CORE}/wire/record.ts`]:
      "75f71ea73c2f7aef1f26efe6d5b1f86b4c1bbfa66945bd2d2bceec2e67b5109b",
    [`${CORE}/wire/tree/fork.ts`]:
      "c8b692dd32cc86d09d95c7a83be2d357d73f071acb5c5a44387d12c6a652807c",
    [`${CLI}/cli/v2/run-v2-print.ts`]:
      "b40ca78e5bb7867ee636a38b9bfa1513e41dd1a832ae1c4e662f1fcb9865c19c",
    [`${CORE}/app/sessionManager/sessionLookup.ts`]:
      "d4a087aa8364e1ca1b9c7b2324956d06495c8c54c880c2a767a27560c676129d",
    [`${CORE}/session/sessionActivity/sessionRunGateService.ts`]:
      "47c5feac88eab42e123f92fbbc85c1fa0740283daec63f5ae043a9e509980d4d",
    [`${SDK}/sdk-rpc-client-v2.ts`]:
      "b10009d4f6eab8435a87068ec2d674b8745d136535a2014624a1b00c8ecc8e40",
    [`${CORE}/app/sessionManager/sessionManagerService.ts`]:
      "9f7b0909c592767c5affd66349d953379758a27e78be9e610fcd7ae020b3f4b6",
    [`${CORE}/workspace/sessionLifecycle/sessionLifecycleService.ts`]:
      "d02ed76254f37f79125c0f0e5ed3ae0ab13bd2eda2b129aaaaab71c2a15a0339",
    [`${CORE}/session/agentLifecycle/agentLifecycleService.ts`]:
      "bd16636c6249617a60188746aa96522e5333278c2b48903d7bc8e1d267e55462",
    [`${CORE}/agent/environmentBinding/environmentBindingService.ts`]:
      "3a54b6b80e9ccade6f5d5ec19a3a7ac0218c37aee9eedb970c0b0616194118c5",
    [`${CORE}/agent/environmentBinding/environmentBindingOps.ts`]:
      "bc0ff3d206520dbc16bf8223eb5dff67673865dfd25f04d391f962ef9322b13b",
    [`${CORE}/app/config/configService.ts`]:
      "8b1709ba10a5f7ae8d79be4eadd008e3861b6f2121fbed8b0dd8d1c6d198d53c",
    [`${CORE}/workspace/workspaceTrust/configSection.ts`]:
      "e10c5e96f0211e3936d03f68ee3695c8573ceb1398aed4e0bb4a3782f500d758",
    [`${CORE}/workspace/workspaceTrust/workspaceTrustStore.ts`]:
      "bcd4621eb02c50e9a79c4f0076afaa0e6f72ef299dedb149077a1b4e3bde7acc",
    [`${CORE}/workspace/workspaceMcpConfig/workspaceMcpConfigService.ts`]:
      "ff805190454881fc7179e63684c1a409e27e66c987ae3c856a42ca944405c3c2",
    [`${CORE}/features/externalHooks/agent/agentExternalHooksService.ts`]:
      "701a53165f60d62a544e2e3154dadc97b41693014c456a9fec061327a3fdf9bc",
    [`${CORE}/agent/tools/os/bash/bashTool.ts`]:
      "91baca9ee4e70190cf24ccace0313e525c473b6184eab9eb1ec90f28e3bdb500",
    [`${CORE}/remote/client/remoteEnvironmentProvider.ts`]:
      "0260b35b201e632f4e742694f962ee414bd7bbac16eb9193e08540b8e8ad26f9",
    [`${CLI}/cli/prompt-render.ts`]:
      "d413a0678dcebb5a0a6f9dda8ce51d53e4b70d55b162afe6635a7d8c1a1536c4",
    [`${CLI}/cli/goal-prompt.ts`]:
      "b95cabc1336c191c5efebbbc08956d5d45138f39877ffffda8066bcb9fc75ca8",
    [`${CLI}/cli/headless-exit.ts`]:
      "9087cba8698f21aba08190240cedbf3da650d4596b6217eca26ec179d9396826",
    [`${KAP}/protocol/ws-agent.ts`]:
      "cbf9a9f2ae111dceb34e5674b336d3accacf265246bc187d7453b19cbfc5d093",
    [`${KAP}/transport/ws/v1/agentState.ts`]:
      "0261a6a674965935f03e4fa3be7bdde0b518d0c31f5ff01e35366de23dbcb5f1",
    [`${KAP}/transport/ws/bearerProtocol.ts`]:
      "c9ee2315b3872bcc86a1a50ba965cfa43700754b6421873fd9771067c5eb8ec2",
    [`${KAP}/transport/ws/v1/wsConnectionV1.ts`]:
      "f036f0bbc0af8b5d97de79db96f61f92f1cbe05b8e2498f2ee2989f7c2d3a69d",
    [`${KAP}/transport/ws/v1/sessionAgentFeed.ts`]:
      "d22f9cde4a7acfb49dda64740bd9eb818b6bd65c9a77aa921fb9840077cd6fb3",
    [`${KAP}/transport/ws/v1/sessionEventBroadcaster.ts`]:
      "13986d6ee58373c8f52e00b33fbf61c2a4a665f1fa40e2c65db56ed5addb0197",
    [`${KAP}/routes/environment.ts`]:
      "f40f3ef8f47cc8cc977e53bf8b9b5b67a415960cd64455902cab943291745689",
    [`${KAP}/routes/sessions.ts`]:
      "a6a6202d06359466904c862ecd0a78bbae7c1eaf0c1b37cb16ac1d1ec79a1f15",
    [`${KAP}/start.ts`]:
      "21842202f83ac093b63ab3ced9805d56be8a46c0e6199e96457948cf4b0feac1",
  },
  // 2.5.3: all forty pinned files remain byte-identical to 2.5.2. Steering,
  // transcript healing, MCP startup and Windows process-spawn changes do not
  // alter the executor, hooks, plan, print, environment or WebSocket pins.
  "2.5.3": {
    [`${CORE}/features/externalHooks/configSection.ts`]:
      "a95482d27f1a873a64d4e67fda77e844dc8dc29e424acbe03f6ffb094d832b20",
    [`${CORE}/features/externalHooks/internal/types.ts`]:
      "322a7ec016ccb6f33ca0d9fdc1e609393921c366c2b5bb7063341c9ca29cc318",
    [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]:
      "ef981d83e607f0427f77a0fc89e4c03d301116b01ac5f0c33bb68ea955749455",
    [`${CORE}/features/plan/planService.ts`]:
      "0d5d269e5cfc052db6697d4ebe01069e46ea756f2b34d7822ac4e8b2c3bd16a0",
    [`${CORE}/state/eventDispatcherService.ts`]:
      "5a98a1f4ca9f14ae1e3f967c66943045f8e389e9379e06fd88863d44a41884da",
    [`${CORE}/state/state.ts`]:
      "736bd13f41d245b519ddce795bbf5ea6847016ed244c58f0b14d603d548a4f41",
    [`${CORE}/features/plan/planOps.ts`]:
      "074d63a1a1be9d361abf3c46656415a1be1517a9a8237df34a6cc24ce9864cef",
    [`${CORE}/app/config/toml.ts`]:
      "57f3830d4fcbf48bb79f6e400efb53af3198ea64de194b381ff8545ab808e334",
    [`${CORE}/app/sessionExport/wire-scan.ts`]:
      "29489dabbc2a585a5cc70015a7b160f7c0a13403f102de007bbce89d1a6b5ef9",
    [`${CORE}/wire/wireService.ts`]:
      "7075a05a7ec9cdb117469943ce1b507a97ad2c0e4bfd55d07eb64c30ec5e8dbc",
    [`${CORE}/wire/record.ts`]:
      "75f71ea73c2f7aef1f26efe6d5b1f86b4c1bbfa66945bd2d2bceec2e67b5109b",
    [`${CORE}/wire/tree/fork.ts`]:
      "c8b692dd32cc86d09d95c7a83be2d357d73f071acb5c5a44387d12c6a652807c",
    [`${CLI}/cli/v2/run-v2-print.ts`]:
      "b40ca78e5bb7867ee636a38b9bfa1513e41dd1a832ae1c4e662f1fcb9865c19c",
    [`${CORE}/app/sessionManager/sessionLookup.ts`]:
      "d4a087aa8364e1ca1b9c7b2324956d06495c8c54c880c2a767a27560c676129d",
    [`${CORE}/session/sessionActivity/sessionRunGateService.ts`]:
      "47c5feac88eab42e123f92fbbc85c1fa0740283daec63f5ae043a9e509980d4d",
    [`${SDK}/sdk-rpc-client-v2.ts`]:
      "b10009d4f6eab8435a87068ec2d674b8745d136535a2014624a1b00c8ecc8e40",
    [`${CORE}/app/sessionManager/sessionManagerService.ts`]:
      "9f7b0909c592767c5affd66349d953379758a27e78be9e610fcd7ae020b3f4b6",
    [`${CORE}/workspace/sessionLifecycle/sessionLifecycleService.ts`]:
      "d02ed76254f37f79125c0f0e5ed3ae0ab13bd2eda2b129aaaaab71c2a15a0339",
    [`${CORE}/session/agentLifecycle/agentLifecycleService.ts`]:
      "bd16636c6249617a60188746aa96522e5333278c2b48903d7bc8e1d267e55462",
    [`${CORE}/agent/environmentBinding/environmentBindingService.ts`]:
      "3a54b6b80e9ccade6f5d5ec19a3a7ac0218c37aee9eedb970c0b0616194118c5",
    [`${CORE}/agent/environmentBinding/environmentBindingOps.ts`]:
      "bc0ff3d206520dbc16bf8223eb5dff67673865dfd25f04d391f962ef9322b13b",
    [`${CORE}/app/config/configService.ts`]:
      "8b1709ba10a5f7ae8d79be4eadd008e3861b6f2121fbed8b0dd8d1c6d198d53c",
    [`${CORE}/workspace/workspaceTrust/configSection.ts`]:
      "e10c5e96f0211e3936d03f68ee3695c8573ceb1398aed4e0bb4a3782f500d758",
    [`${CORE}/workspace/workspaceTrust/workspaceTrustStore.ts`]:
      "bcd4621eb02c50e9a79c4f0076afaa0e6f72ef299dedb149077a1b4e3bde7acc",
    [`${CORE}/workspace/workspaceMcpConfig/workspaceMcpConfigService.ts`]:
      "ff805190454881fc7179e63684c1a409e27e66c987ae3c856a42ca944405c3c2",
    [`${CORE}/features/externalHooks/agent/agentExternalHooksService.ts`]:
      "701a53165f60d62a544e2e3154dadc97b41693014c456a9fec061327a3fdf9bc",
    [`${CORE}/agent/tools/os/bash/bashTool.ts`]:
      "91baca9ee4e70190cf24ccace0313e525c473b6184eab9eb1ec90f28e3bdb500",
    [`${CORE}/remote/client/remoteEnvironmentProvider.ts`]:
      "0260b35b201e632f4e742694f962ee414bd7bbac16eb9193e08540b8e8ad26f9",
    [`${CLI}/cli/prompt-render.ts`]:
      "d413a0678dcebb5a0a6f9dda8ce51d53e4b70d55b162afe6635a7d8c1a1536c4",
    [`${CLI}/cli/goal-prompt.ts`]:
      "b95cabc1336c191c5efebbbc08956d5d45138f39877ffffda8066bcb9fc75ca8",
    [`${CLI}/cli/headless-exit.ts`]:
      "9087cba8698f21aba08190240cedbf3da650d4596b6217eca26ec179d9396826",
    [`${KAP}/protocol/ws-agent.ts`]:
      "cbf9a9f2ae111dceb34e5674b336d3accacf265246bc187d7453b19cbfc5d093",
    [`${KAP}/transport/ws/v1/agentState.ts`]:
      "0261a6a674965935f03e4fa3be7bdde0b518d0c31f5ff01e35366de23dbcb5f1",
    [`${KAP}/transport/ws/bearerProtocol.ts`]:
      "c9ee2315b3872bcc86a1a50ba965cfa43700754b6421873fd9771067c5eb8ec2",
    [`${KAP}/transport/ws/v1/wsConnectionV1.ts`]:
      "f036f0bbc0af8b5d97de79db96f61f92f1cbe05b8e2498f2ee2989f7c2d3a69d",
    [`${KAP}/transport/ws/v1/sessionAgentFeed.ts`]:
      "d22f9cde4a7acfb49dda64740bd9eb818b6bd65c9a77aa921fb9840077cd6fb3",
    [`${KAP}/transport/ws/v1/sessionEventBroadcaster.ts`]:
      "13986d6ee58373c8f52e00b33fbf61c2a4a665f1fa40e2c65db56ed5addb0197",
    [`${KAP}/routes/environment.ts`]:
      "f40f3ef8f47cc8cc977e53bf8b9b5b67a415960cd64455902cab943291745689",
    [`${KAP}/routes/sessions.ts`]:
      "a6a6202d06359466904c862ecd0a78bbae7c1eaf0c1b37cb16ac1d1ec79a1f15",
    [`${KAP}/start.ts`]:
      "21842202f83ac093b63ab3ced9805d56be8a46c0e6199e96457948cf4b0feac1",
  },
  // 2.6.0: reviewed executor, live-root, swarm-lifecycle, journal-normalization,
  // and direct-subscription protocol bytes at commit 740d6c0b.
  "2.6.0": {
    [`${CORE}/features/externalHooks/configSection.ts`]:
      "a95482d27f1a873a64d4e67fda77e844dc8dc29e424acbe03f6ffb094d832b20",
    [`${CORE}/features/externalHooks/internal/types.ts`]:
      "322a7ec016ccb6f33ca0d9fdc1e609393921c366c2b5bb7063341c9ca29cc318",
    [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]:
      "b3bb899d89ae1aeca0dc25eaf530f061992f8610e031eca86a1853bc06c679c0",
    [`${CORE}/features/plan/planService.ts`]:
      "15973cf75e5f87362e2ebaa8a708be5929965221ef517115f9ab8988e04c7546",
    [`${CORE}/state/eventDispatcherService.ts`]:
      "fa7b1a4aae91bab708f11fa1383e0f1b58612a161dff96f43f003af789a56889",
    [`${CORE}/state/state.ts`]:
      "e48d456b078fd387857599a8b0f7f289623d7d1614230e46b898fa4a1f719e75",
    [`${CORE}/features/plan/planOps.ts`]:
      "ed1010511cef4244f35e3baee8cca0fd6638b709f28703c6159eb1735fe05137",
    [`${CORE}/app/config/toml.ts`]:
      "57f3830d4fcbf48bb79f6e400efb53af3198ea64de194b381ff8545ab808e334",
    [`${CORE}/app/sessionExport/wire-scan.ts`]:
      "29489dabbc2a585a5cc70015a7b160f7c0a13403f102de007bbce89d1a6b5ef9",
    [`${CORE}/wire/wireService.ts`]:
      "ca38106e043bc230b77e606ff641286cc000b76dc34a04d331425d326e3b23ee",
    [`${CORE}/wire/record.ts`]:
      "ec9e4c1ad7b1c067a782570f5bfd0d7299a60fc120d8ca997243d134b7f8eb1d",
    [`${CORE}/wire/tree/fork.ts`]:
      "9588d05ee09f9c5534f19f0c4be7c521b4c74c4071d489073abfa203d533a5a9",
    [`${CLI}/cli/v2/run-v2-print.ts`]:
      "aa2973350da8339e3424a8df8c84254ae8c26a886244cda83b545b2e59d8650f",
    [`${CORE}/app/sessionManager/sessionLookup.ts`]:
      "d4a087aa8364e1ca1b9c7b2324956d06495c8c54c880c2a767a27560c676129d",
    [`${CORE}/session/sessionActivity/sessionRunGateService.ts`]:
      "43375aced3e13dcd0fb0233932d86ef16336d6d4aac16c3fec164b8c8c4abce0",
    [`${SDK}/sdk-rpc-client-v2.ts`]:
      "ca5b95fb4c8bd169a963a62d6c2d12d9ecfb10c3dd68a14de2cc0a42f7985c36",
    [`${CORE}/app/sessionManager/sessionManagerService.ts`]:
      "9f7b0909c592767c5affd66349d953379758a27e78be9e610fcd7ae020b3f4b6",
    [`${CORE}/workspace/sessionLifecycle/sessionLifecycleService.ts`]:
      "7387c13342305644419f80fb9148ba30457f1b28e21b1a76f004c05238088470",
    [`${CORE}/session/agentLifecycle/agentLifecycleService.ts`]:
      "5c603a0910c7d5de768f96b4f24ef8e07757681f0450a4dc1154dc15c9c5de94",
    [`${CORE}/agent/environmentBinding/environmentBindingService.ts`]:
      "6fb825ba3b5f38511bc90ce4a3adbfd2f0dd211b46f80490ff4b35deba69ee9b",
    [`${CORE}/agent/environmentBinding/environmentBindingOps.ts`]:
      "bc0ff3d206520dbc16bf8223eb5dff67673865dfd25f04d391f962ef9322b13b",
    [`${CORE}/app/config/configService.ts`]:
      "8b1709ba10a5f7ae8d79be4eadd008e3861b6f2121fbed8b0dd8d1c6d198d53c",
    [`${CORE}/workspace/workspaceTrust/configSection.ts`]:
      "e10c5e96f0211e3936d03f68ee3695c8573ceb1398aed4e0bb4a3782f500d758",
    [`${CORE}/workspace/workspaceTrust/workspaceTrustStore.ts`]:
      "ff59ccb811c48fe3e0535becc9a68ad8921962ca5be8ac4e8a02762690fea164",
    [`${CORE}/workspace/workspaceMcpConfig/workspaceMcpConfigService.ts`]:
      "8bbc1e6ccd2fdd3ad30d17e7984deec20c86e430f07960ee495f0fab541060a9",
    [`${CORE}/features/externalHooks/agent/agentExternalHooksService.ts`]:
      "304a3fad6f4292789059a517ba1a3d865d60a700bf47759eb1ea14f29418f58d",
    [`${CORE}/agent/tools/os/bash/bashTool.ts`]:
      "e3aecff7fb8a394fb4f3ef63e305a48069f0ffd251ed40117e903b3293bf6559",
    [`${CORE}/remote/client/remoteEnvironmentProvider.ts`]:
      "0260b35b201e632f4e742694f962ee414bd7bbac16eb9193e08540b8e8ad26f9",
    [`${CLI}/cli/prompt-render.ts`]:
      "d413a0678dcebb5a0a6f9dda8ce51d53e4b70d55b162afe6635a7d8c1a1536c4",
    [`${CLI}/cli/goal-prompt.ts`]:
      "b95cabc1336c191c5efebbbc08956d5d45138f39877ffffda8066bcb9fc75ca8",
    [`${CLI}/cli/headless-exit.ts`]:
      "9087cba8698f21aba08190240cedbf3da650d4596b6217eca26ec179d9396826",
    [`${KAP}/protocol/ws-agent.ts`]:
      "7c4702e09b26f1daf44bb17e61c69ba4f2c53ea6fa1f752998c338679f01087c",
    [`${KAP}/transport/ws/v1/agentState.ts`]:
      "c9de1f771f9cac100ef6330a661d372f6af7336e02ed2cb0a698d030e7dec80c",
    [`${KAP}/transport/ws/bearerProtocol.ts`]:
      "c9ee2315b3872bcc86a1a50ba965cfa43700754b6421873fd9771067c5eb8ec2",
    [`${KAP}/transport/ws/v1/wsConnectionV1.ts`]:
      "8eed7a6e80a616c1f52599fcce3127e6c43fee2c12b862e3b50df9d05eeb3783",
    [`${KAP}/transport/ws/v1/sessionAgentFeed.ts`]:
      "fff4f4fc515fd73b7f722da9dc9f5a4d013f1053481b7202507c59c6e7910c3d",
    [`${KAP}/transport/ws/v1/sessionEventBroadcaster.ts`]:
      "3feba744a838169fe54e5c45a92dbfe3586bfef2e588d5c99c5af382cb7b9db9",
    [`${KAP}/routes/environment.ts`]:
      "2896fd55bf06250a2c99b43305c1e4f23eea991848d2cb2782cb8931a96bb740",
    [`${KAP}/routes/sessions.ts`]:
      "56a668b0df3a6dabcc4481d72f3d85f224edf2f36cf6999003198f78810a287a",
    [`${KAP}/start.ts`]:
      "242b6419f697ff42afd669261b30ef1e65738ed28c4d47b4e91f35602725297b",
    [`${CORE}/agent/toolExecutor/legacyHooks.ts`]:
      "f28ea8b7e462268990e4f10bc38693bce99b3e1304f7200756019a6bd007c4f6",
    [`${CORE}/agent/toolExecutor/toolExecutorService.ts`]:
      "662efd34010010983056e5368dbb8fc1bc74a65576a8423f1e19fdb62c000c2a",
    [`${CORE}/agent/toolExecutor/toolExecutor.ts`]:
      "090c18ac2ccd10bda832184fc8f8f41ab80ea070097b00bae1eb0f5b2ec09780",
    [`${CORE}/agent/permissionGate/permissionGateService.ts`]:
      "e54b9f3c60e16542af71b52211b8eb37eb05a05fdbcae335296075400af34f13",
    [`${CORE}/tool/executor/tool-executor.ts`]:
      "9809209d8d5e1576d4d46d580650f9c2b4aa9a0a8443a49be3fea447de3f4198",
    [`${CORE}/tool/executor/hook-composer.ts`]:
      "87fbe3ee4b66c257deb3f697d5e1eddf1edbbdac4f8087dd04190700a8488fda",
    [`${CORE}/tool/executor/legacy-adapter.ts`]:
      "36dbe505edc195383bacb2bc1b40f8cb94f81f693f1a9e25ca00c387e81061d1",
    [`${CORE}/features/externalHooks/externalHooksFeature.ts`]:
      "658b6655cd2484d0001240e3ddbf9bc7c740f94d9ff93cbe83ce472a12188fc1",
    [`${CORE}/wire/human.ts`]:
      "13bebbc0dfd6774a12a6573d53e4b0df5533db40a44e987020da4b8bbe1c193d",
    [`${CORE}/agent/loop/core/loop-actor.ts`]:
      "f8012925aa1dc49504f5aa6a6d9bf2cdec2a38c565c8734d6be35fe694243303",
    [`${CORE}/agent/shellCommand/shellCommandService.ts`]:
      "5d6ab2ed43b04b4b583759bcfdf092980ea6eac75f807a67aabafc89ee4cbeea",
    [`${CORE}/features/swarm/agent/swarmService.ts`]:
      "39e7b76f2ee237d1f55ebc32ea84dee7b7d851d9370c6d4a971732869475ef39",
    [`${CORE}/features/swarm/session/agentRunBatch.ts`]:
      "339dbd7962c3b9bac145aff83aee06d6e5f3c6b9e8c472d4f4f94d7fb26390fc",
    [`${CORE}/features/swarm/session/sessionSwarmService.ts`]:
      "d4c80b19c03ee3c76469b0ca2e155bfb8f4f3f9a5019dafa21713b6eb89edbf0",
    [`${CORE}/features/swarm/session/swarmMemberTask.ts`]:
      "0d3dc139b4b3046b6aa924de1ef97a7342a0fef7f7e9680aa1c590b16186b7a4",
    [`${CORE}/agent/task/taskService.ts`]:
      "84f9c0c2c58903b0e35d80b6e9c8c4f245838fbed23937cdc6afbc58b50ff87e",
    [`${CORE}/agent/tools/task/task-stop/taskStopTool.ts`]:
      "2b0ea33daa6c7ebb28ecf756332ab2852351a69a7f9d862c37bd571e5f56b039",
    [`${CORE}/session/subagent/subagentService.ts`]:
      "7617d01bd6c7252caa5d575cba83eac17e14b28631bd6e9a3faa44511e2d1d06",
    [`${CORE}/features/swarm/tools/agent-swarm/agentSwarmTool.ts`]:
      "aad08384b2072731c01b17b5caa154fa048bba5cd87103285670f647807ea448",
    [`${CORE}/features/swarm/swarmOps.ts`]:
      "ee1d7b950482b38d4ca5616a03db485c64ba23a6dfd1af21d2346c3f99b93680",
    [`${CORE}/agent/loop/journal.ts`]:
      "6db67cb9803ee0b410349afc3b8d70a06fd29480499f462d3fbc58a19fc43a78",
    [`${CORE}/agent/loop/turnOps.ts`]:
      "01169a2ac6fd044021049dc4bf08ce4a9a258b00e5b42fc3a7f385f968eac08f",
    [`${CORE}/agent/loop/loopService.ts`]:
      "619befc8f9eea145cd01882a959dd73b347fbe08418595261d79fe75a5eda564",
    [`${CORE}/agent/loop/turnProjection.ts`]:
      "b36045d4c410a71a935df7dcb9a2b705ae4379c887a7af3292a24c4994b756ac",
    [`${CORE}/agent/contextMemory/loopEventFold.ts`]:
      "a785714d432d385a649deb9c37a7e5376a802ad08f7b5817e76db4eab39e6d8d",
    [`${CORE}/session/subagent/mirrorAgentRun.ts`]:
      "c52b28630bd8ab125c4def10d8b4ab577578bc81c3771474469d8b90ffc42e42",
    [`${CORE}/_base/di/cascadeEngine.ts`]:
      "ceb727b65f6a60e1644789b30048e5bb0436270cf01b9924f8985f8a7ac78c21",
    [`${CORE}/_base/di/scope.ts`]:
      "f474989c70dc4f5063ac10c2c3ff4780fb17d961946a3a05e1616fea7a13256c",
    [`${CORE}/features/feature.ts`]:
      "e0b281a039200524bd289401be1d937d0709dc1951f4352cd130e89656a3451b",
    [`${CORE}/workspace/workspaceDirs/workspaceDirsService.ts`]:
      "8b93555ab2d73cf12fd7e717ba935017a1add233fb0af10f288d6a731a0b6fa6",
    [`${CORE}/session/workspaceContext/workspaceRoots.ts`]:
      "8b1d6bfdb3da68afad5b00c9e869270996b32128148027692e446dbbc53e2487",
    [`${CORE}/workspace/workspaceTrust/workspaceTrustService.ts`]:
      "29c7756014c7f0ad94a640d2183b60bb6e91f36632d634af1284871b08973dc6",
    [`${CORE}/app/sessionIndex/sessionIndexSource.ts`]:
      "e3659f557668cf798c424e1c4a1c846abf98fe84f0750ee6b313b5baac774055",
    [`${CORE}/workspace/workspaceInstance/workspaceInstanceManagerService.ts`]:
      "677b1cedf43a720855ec0bff83757b944309debff6b18557316a222bebcdc45b",
    [`${CORE}/agent/loop/profileAdapter.ts`]:
      "90fd5e02835fe8afebf91270c92713ffde8611010bceadbf9da97b92895364e2",
    [`${CORE}/features/btw/btwService.ts`]:
      "b9ae0e8f51bc9262f67a440c8b024bf6c83e5e918e65259aa0f896bd4fdf98f3",
    [`${CORE}/features/goal/goalService.ts`]:
      "090624c3f71a9f447bb8dd35d93a53be17ffe985a0c9e4d0ca9ab6c3173fb239",
    [`${CORE}/features/tower/towerService.ts`]:
      "7cb07fc0be7ec8babe7e0f04c80a43160504760b7ec8f92fa124d82972f39ced",
    [`${CORE}/agent/toolDedupe/toolDedupeService.ts`]:
      "0188b03ff68dbf13bd6a8234c4274ef6abf4e1d61af78faad7b185398ef9887b",
    [`${CORE}/agent/toolPolicy/toolPolicyService.ts`]:
      "364fadd926c88eebccebf7277daae3284bc58b5b78c1cdce4b8d0d2e2682948d",
    [`${CORE}/agent/toolSelect/toolSelectService.ts`]:
      "373c78ad962f8b9d74cc5a68586c46e974f35e9dc7d72239c1d66dfbd7dae844",
    [`${CORE}/agent/mcp/mcpService.ts`]:
      "21235344108f1011e506c077cc3699923844d25d9d45e3a629bef8b4ad16a4a0",
    [`${CORE}/features/fileHistory/fileHistoryService.ts`]:
      "59685167b17932f3d1f28a4a5c25af0fa71ab8c92a55f03f6a08b35aedfdeabc",
    [`${CORE}/agent/agentsMdReminder/agentsMdReminderService.ts`]:
      "c7c3ebc1d19372d664f24635dc65337374d7b4b3f410636920065db2ae4e81db",
    [`${CORE}/features/plan/planFeature.ts`]:
      "5f225e09c7d2997d35137f33fba9425bfd9c25c0cd2d4f6666a6d9a256fe3e73",
    [`${CORE}/agent/tools/os/write/write.ts`]:
      "2e68559fcc0cb191ab41145fa84ab83bad8f87a5d8c9d81604e3144e7ce10167",
    [`${CORE}/agent/tools/edit/edit.ts`]:
      "7041e1d31bbe766e3e00c7f86ade466d1887c575770b51a2022f196df1095eae",
    [`${CORE}/agent/tools/os/bash/bash.ts`]:
      "16b1de61b520b5a6670c81c6b1d657f7e9ed124acf695e7225322f1dafe39cef",
    [`${KAP}/protocol/ws-control.ts`]:
      "1a23ac146e8f90b2598f8247d299465bdc1d6fc881255f58099d8096c7e21591",
    [`${KAP}/routes/sessionAgentConfig.ts`]:
      "8e493190bc577c3294634f9e032e53abd04b73afafecc2ec867aff88a0c380d1",
  },
};

// 2.6.2 (6a8493df): mutable participant replay and loop-journal freezing retain
// the same two wire-journal restore passes and raw plan-taint closure. The
// additional pins cover bounded swarm waves: task identity, settlement,
// per-agent activation, owned resume, the forced native timeout ceiling, and
// session-wide native TaskStop disablement that prevents Bash auto-detachment.
PINNED_HASHES["2.6.2"] = {
  ...PINNED_HASHES["2.6.0"],
  [`${CORE}/state/eventDispatcherService.ts`]:
    "76b9377fd911c0392eea135865f498ee1e593f1eeaaa9d1de4abfc5f997f7957",
  [`${CORE}/agent/loop/journal.ts`]:
    "17dead246642b01273cbc7cdeb5478cc561b4e3856b6d7b1ef524c94b7a177ec",
  [`${CORE}/agent/loop/turnProjection.ts`]:
    "226a4377822a042e0bc391b695ac0a40ac65ce35d7ba307ddd095885f59dd91a",
  [`${SDK}/sdk-rpc-client-v2.ts`]:
    "4c635caed581c09332ad9e54490d578bd5a30e4fe37e6b8e88720a691142638c",
  [`${CORE}/features/swarm/tools/agent-swarm/agent-swarm.ts`]:
    "a9c06b889692626c38e535f80f54ad0f4349fe798bf7c2986999319d8bdc7d0f",
  [`${CORE}/features/swarm/configSection.ts`]:
    "fb08489d5d56b17af20fdbd11676cf9a37127519d33e769649dd35c10164e7c3",
  [`${CORE}/features/swarm/swarmFeature.ts`]:
    "a28426dfd4a2f53fb66e6e00d4e8d6e4a1dd30f37d694bbaff65664c9dab2fd7",
  [`${CORE}/session/subagent/runAgentTurn.ts`]:
    "0e2915b27d3ba5142ae917e26036d096bfcbbe6a430df93c8ba36efbfa5bff0d",
  [`${CORE}/session/subagent/spawn.ts`]:
    "ccd5931bb49b1ebd595d1fbcc374e12613f61893954759c0227af046ffe739b1",
  [`${CORE}/session/subagent/flag.ts`]:
    "a6d6e0ec065ecbe043addac17826c3542e02341e422c6fb2d547980a9f9563d1",
  [`${CORE}/session/agentLifecycle/subagentMetadata.ts`]:
    "75996d22d8d1ec954d59cdc67c95e4ad25ec8685a1e14afaa4529ce3b297f7c4",
  [`${CORE}/session/agentLifecycle/profile/profiles.ts`]:
    "ce9895a1e519872228515d2aba7bed8a5c34c4ab39d23590ae9a3dce1cfff4c2",
  [`${CORE}/agent/toolExecutor/toolScheduler.ts`]:
    "6112511b45092a3d63150395166b5610337732a24420cb0f9598d65f8ec667ab",
  [`${CORE}/agent/task/printDefaults.ts`]:
    "cd96a9ef7b5c44c7b15d197ef73ffced96718ba4306c93cfd17687a62f1d2925",
  [`${CORE}/_base/utils/timer.ts`]:
    "840147aa36f6c1cdd7bb8a3e479342dfeca2f3a88a885ccb6c0fb3cea7ff9b9a",
  [`${CORE}/_base/utils/abort.ts`]:
    "07f6191fc42e479dd33c5263e009ce2fe160b0797e9d9c484d8e7f701ea958db",
  [`${CORE}/features/externalHooks/session/sessionExternalHooksService.ts`]:
    "201925b50a1a49b104e79a3b6db75de4f527fd2e84c80a7c1df6785506f7b7ab",
  [`${CORE}/features/externalHooks/app/externalHooksRunnerService.ts`]:
    "63ebf53f2e312ca5984b50bcbaf360d3114221d2fd1c1bd44579df1f69271444",
  [`${CORE}/agent/task/taskOutput.ts`]:
    "1ffba2f17f46edb0bfd606d75c9811c9f54597da3054e52a13d5541f008e4620",
  [`${CORE}/agent/task/configSection.ts`]:
    "ee84882f5d3fbf0887c6967ea060f2eec31b050aa2c9e1fa8aee752c30906d87",
  [`${CORE}/session/sessionToolPolicy/sessionToolPolicyService.ts`]:
    "0fd170d82e6bfe8a1e4111886f5ccf1e7ed0532bf0dcbaf6dc911f2993ccce8e",
  [`${CORE}/agent/toolPolicy/evaluate.ts`]:
    "087c8c39b94ffbc6dfad59a45bac792d8ddbdbfbd8898788644f97062a1f3901",
  [`${CORE}/persistence/backends/node-fs/atomicDocumentStore.ts`]:
    "2a738b0d4e6e806150d1c2e91b579c035f88ad4fd4aaf571c5e6637a07ef19fa",
  [`${CORE}/persistence/backends/node-fs/fileStorageService.ts`]:
    "e7b00f29291cc6a1b288ea3fad1850405ab693817846d6d37770fb5ebd6013fd",
  [`${CORE}/session/sessionContext/sessionContext.ts`]:
    "d64fa89b478cfedfbab5f2f566180415ad972f2e71b25bb55d2fcb684a284b1d",
  [`${CORE}/workspace/sessionLifecycle/internal/addressing.ts`]:
    "9118987642f8749dc6cce9c1cd130212e807b31dc434059f60578d75725273eb",
  [`${CORE}/features/tower/tools/spawn/spawnTool.ts`]:
    "c8fd9ee9a81a909eea9b7335936db8f9d92ce5de57134b37eee02e0115134784",
  [`${CORE}/agent/tools/ask-user-question/askUserQuestionTool.ts`]:
    "b6f18610da05b24270a096c7c7ee9305a22c4f6d0974c6078c717a65c626cfda",
  [`${CORE}/agent/tools/agent/agentTool.ts`]:
    "6afed948b81bb0850c7b165fe65908141b5af40eec54a548a9dec444a3b197ee",
};

// 2.6.3 (b0de2fbd): tool origins, queued Stop hooks and task reconciliation
// preserve the no-plan gate and two-journal restore. Child completion now waits
// for loop and task quiescence; cancellation stops active child tasks.
PINNED_HASHES["2.6.3"] = {
  ...PINNED_HASHES["2.6.2"],
  [`${CLI}/cli/v2/run-v2-print.ts`]:
    "88335492c4f606324ee352dee1e07ae070d89056bc8ba6432ae7d955f50e12a0",
  [`${CORE}/agent/loop/core/loop-actor.ts`]:
    "70c0a30886a2d95868ff676d5bee9d3cbd6f9e8c3431428965e148d176d2458e",
  [`${CORE}/agent/loop/loopService.ts`]:
    "12645003f352427a52a9b044f423a50174533ff52407395e5c29721235e0f2d5",
  [`${CORE}/agent/loop/turnProjection.ts`]:
    "22c1836bda136477ed45ddabd21c893d10e9602ff52a54593ea4d23ec656836f",
  [`${CORE}/agent/shellCommand/shellCommandService.ts`]:
    "a0eb450606c102990eceab7ac8fa2f01bd5939b66ab8959c67f597fc125ac601",
  [`${CORE}/agent/toolExecutor/toolExecutorService.ts`]:
    "7d1085580914f19e67e7c04d5a3ebb3280f09fc3c35f963d0b7e5c3579e11242",
  [`${CORE}/agent/toolSelect/toolSelectService.ts`]:
    "146f5479544e3fa42c04179ce5a1bccc44d9504fc1b0634685660c9658d25356",
  [`${CORE}/app/config/configService.ts`]:
    "afa300f75bb7f5be6636bc95686390e5554af36d600b5c77313027c6d2470b7b",
  [`${CORE}/features/externalHooks/agent/agentExternalHooksService.ts`]:
    "7ecdc7925e098d64c5fd718da4496fde9d58cd40751f94edecf12afd67e2fc52",
  [`${CORE}/features/tower/towerService.ts`]:
    "4838643fc451f3cf0905416dc4cdfd6841305ad989101ceb51d97a888030a92c",
  [`${CORE}/session/agentLifecycle/agentLifecycleService.ts`]:
    "2d85833edfaf587c8301de45f06f2d9c80538a56aa00cb97bda9254a6313bb2c",
  [`${CORE}/session/subagent/runAgentTurn.ts`]:
    "5400f150cea1b812bb4e24692091c3a29d0f2807229911be2cc8b6c93a5d6b5f",
  [`${CORE}/tool/executor/legacy-adapter.ts`]:
    "79d7629528fad29204c0e4c1865d49340e746b27a568115770611a13cb4e1792",
  [`${KAP}/start.ts`]:
    "4993879aa2f36af0fe0d2992eeb777853e0c46e40cb7d7f37ff4edc20da21aee",
  [`${SDK}/sdk-rpc-client-v2.ts`]:
    "3e5e59a86c76e9bae335100600c12903964fe67f61f19cb7d7d32a02283796cd",
};

// 2.7.2 (56145f84): fifty-three inherited pins changed and the loop actor moved
// to the DI-free core. Pin the real executor, hook composer, and loop actor as
// well as the compatibility re-exports, shared retry code, CLI boundaries, and
// authenticated JSON/KAP route composition.
PINNED_HASHES["2.7.2"] = {
  ...PINNED_HASHES["2.6.3"],
  [`${CORE}/features/externalHooks/internal/types.ts`]:
    "eb697379c4efdc48b0ee5ac00256d1205b85d99eefb7b19843218d35107852dc",
  [`${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`]:
    "54d52bb02917cebbc97df66e92aa67ea0aab2768fe1b759c9a3f53f27571841b",
  [`${CORE}/features/plan/planService.ts`]:
    "acddcf426b3716b93701dd9153e0c7d7c21c9156a1e762b3e94090ec392e4604",
  [`${CORE}/state/eventDispatcherService.ts`]:
    "d8b74a5001eb6ec4567e674013c002ddad650f1f815f45aca2d1057962821094",
  [`${CORE}/features/plan/planOps.ts`]:
    "37b3d018746da238686733b66d9e9328248897859ca45f96ae28c26533564637",
  [`${CORE}/wire/wireService.ts`]:
    "04fcdaf00ce688c2cc4e9e5d243569cee3e7a2717b19a89391d0671bdac995aa",
  [`${CORE}/wire/record.ts`]:
    "68357abd44314ff757cd049155f35bf772f2310c2bc7dd65b793a05e417fea88",
  [`${CLI}/cli/v2/run-v2-print.ts`]:
    "c7e724748b238245407f6f29e6af42ac41cf84f08a90f382eee51854b1b8ccb3",
  [`${CORE}/session/sessionActivity/sessionRunGateService.ts`]:
    "2ed8303ec3d042f3c613ca6e1c62d264178752609128dad710102e54ae523a01",
  [`${SDK}/sdk-rpc-client-v2.ts`]:
    "84cf2005986471f9b33c73ac7d86dc121f14a1588acfb3ecf0fb0f6648e89cb9",
  [`${CORE}/workspace/sessionLifecycle/sessionLifecycleService.ts`]:
    "801dc7b9fe3baa05b455a8615a8b7b16bcf373f9e44da5173dcd57f60146edda",
  [`${CORE}/session/agentLifecycle/agentLifecycleService.ts`]:
    "28861d60b9f425f2ecdf46d754e909201af9a88f8958a90f05d3548da7ba86e4",
  [`${CORE}/agent/environmentBinding/environmentBindingOps.ts`]:
    "2f65bebb17455c435603520f73089bfdf239864742df86124e3bd8acf2aa5269",
  [`${CORE}/features/externalHooks/agent/agentExternalHooksService.ts`]:
    "2847e3f3f75247e71bc0fd9139a28a34f7dfca8d9d0cbff87df8d395b3c64222",
  [`${CORE}/agent/tools/os/bash/bashTool.ts`]:
    "c8ee4ef1db609700dac06519e40b022c9f3d0fb1c0dd9ab1b0af0e6210aaf6bf",
  [`${CLI}/cli/prompt-render.ts`]:
    "ddfc890858766e43d635a37268d6131baf3f82fbab8bd06bd5e16e3d3397265d",
  [`${CLI}/cli/goal-prompt.ts`]:
    "4db3c76ccdca5bf68bbb34cd083a7ff8bc0ce0363c2630bd0daef4895fd5a801",
  [`${CLI}/cli/headless-exit.ts`]:
    "d6a77ec31627583ab7acec016fa66070524b72b0a4730d81b7d5ec5f46cfec5c",
  [`${KAP}/protocol/ws-agent.ts`]:
    "0fda7f2f53f5cf73ba1b8c9fe93573bd1ba926c23c8bc4e194f6d051ae29682e",
  [`${KAP}/transport/ws/v1/agentState.ts`]:
    "c54c9633cad62aa32c05a5612bc9e3002b7accc1be3693dbbaa395dfb99cc293",
  [`${KAP}/transport/ws/v1/sessionAgentFeed.ts`]:
    "bdceb5d5e0481a897f8a096c73e356927b85e8b7723521a4bb33f4d46801bd69",
  [`${KAP}/transport/ws/v1/sessionEventBroadcaster.ts`]:
    "1b3bb299538d60e3d9d49f6dc400fc66a4b2722927693e0742d9f5256cad733a",
  [`${KAP}/routes/sessions.ts`]:
    "7a0733411c4b7a44a199c895fbcd40b16a93ff7215e87f32d99a93f1a9ad62ec",
  [`${KAP}/start.ts`]:
    "25803707bd6797c93b3382f1840d3df0788489ebf6f5e1a6d119b261b75afa2c",
  [`${CORE}/agent/toolExecutor/legacyHooks.ts`]:
    "e900c7bb1028dab051bfa94f7e5b3c5f60b5049f4d490a2b7e2bad8b75622c0f",
  [`${CORE}/agent/toolExecutor/toolExecutor.ts`]:
    "efb780931c8a690927279dfdd4c4b236709084f1a7f81cd5e6036df721936543",
  [`${CORE_RUNTIME}/tool/tool-executor.ts`]:
    "35b03edcb0afa5e6451f906945cb328bfe7458de33b4982ad2cf9c7bb9ed8fa7",
  [`${CORE_RUNTIME}/tool/hook-composer.ts`]:
    "87fbe3ee4b66c257deb3f697d5e1eddf1edbbdac4f8087dd04190700a8488fda",
  [`${CORE}/tool/executor/legacy-adapter.ts`]:
    "c1369c9217608e2bb0b45e7ab6cb60ed2bb36e59731f931ebe2bff3acae09da6",
  [`${CORE_RUNTIME}/loop/loop-actor.ts`]:
    "899238c3e9f7c6f85dc7383eed8c3d056b406944c960c5d1a6af59802c7c1dd4",
  [`${CORE}/agent/shellCommand/shellCommandService.ts`]:
    "412b926a7df371c613b5006423d5b6d0062bb9052f0d34fbe7a26663d9e68006",
  [`${CORE}/features/swarm/session/agentRunBatch.ts`]:
    "6fc11370e81cb68ca1ae6dd89406790127dc3d2631d524bc0f3db908e050e5e4",
  [`${CORE}/features/swarm/session/sessionSwarmService.ts`]:
    "2c19fcf7b497dd899c46b255c71e17453374379bc529597f082c9fc4eafc68ab",
  [`${CORE}/features/swarm/swarmOps.ts`]:
    "d7fbf7172ceb102398caaf34293c6c0851efc171d66ffb4a9201807b4d72c15a",
  [`${CORE}/agent/loop/journal.ts`]:
    "1f0d65e07140ca5d016ebee288b9d7e5bbeedd34e966e514a0e3659bc198ec0b",
  [`${CORE}/agent/loop/turnOps.ts`]:
    "5d51992972fd82d864872421323753b07183c21241396128d3cb76eb20728c14",
  [`${CORE}/agent/loop/loopService.ts`]:
    "ebba5ac8bf3568b12c1322848530fef9a434628a780b9543198462d73b208f27",
  [`${CORE}/agent/loop/turnProjection.ts`]:
    "dac511ca6d22713d8cc9d23dc592f6ae2f3f517802f43cfb5ebaff5bad1867bc",
  [`${CORE}/agent/contextMemory/loopEventFold.ts`]:
    "a6e5faad0f894f3c8b2a9c41577b1a3c49ed0fcdd73374f5940db893ea1fe12a",
  [`${CORE}/session/subagent/mirrorAgentRun.ts`]:
    "7611459fe8b7bebc839dfae8157b8fdb65bdd08971efb5fb429bb45924bbb915",
  [`${CORE}/_base/di/scope.ts`]:
    "62118f732d5b27cf784a801b8cc46d51a202d2e690d5cc16003774d62d50b6ff",
  [`${CORE}/agent/loop/profileAdapter.ts`]:
    "66440bf899aa19e4a499235cae55f70ea4813061365ddec2b184e0ba4457cd2a",
  [`${CORE}/features/goal/goalService.ts`]:
    "cce679d4cfc51b8b1cb59ad632cb13e1c4f64d59de23d4f5ef620ac4e034a051",
  [`${CORE}/agent/toolDedupe/toolDedupeService.ts`]:
    "4d47d0d798946652571fc6f653a235ba0de6cb3088a37878eb37e6ad9a33cb98",
  [`${CORE}/agent/toolSelect/toolSelectService.ts`]:
    "bf2d7a745614f466a10d03b228b84123764ae76bf8614f30a28e0cbc60dca212",
  [`${CORE}/agent/mcp/mcpService.ts`]:
    "da1752847adbefd8ad9d15d4b85e82bb54271280c6b96e40a07b5434a62dfd30",
  [`${KAP}/protocol/ws-control.ts`]:
    "91cabbf7af237eb11437d6884ca9bb94d8a736e95afbf744cd14b46442eb2cc4",
  [`${KAP}/routes/sessionAgentConfig.ts`]:
    "6f9c15167ef1696d8726da70b01786fc0040eb0a098689ae1edfbd68c77e99e7",
  [`${CORE}/session/subagent/runAgentTurn.ts`]:
    "2e9769aa29c080a9513d8996ef68888607ade1779bab6d5357e4a6b0346265cb",
  [`${CORE}/_base/utils/abort.ts`]:
    "e8acf6b9bd0fadddfda105a64a2c5ad1cfb1b735b3dfb15736487e4a43db8991",
  [`${CORE}/agent/task/taskOutput.ts`]:
    "bf03ba076185fb141383f940f7b83ab5e9b26702bae8f3c0333561e3062425a2",
  [`${CORE}/features/tower/tools/spawn/spawnTool.ts`]:
    "ead25a16ac5da12646f1053dd91d7333f9b70f233ffe919c07312041a2bb0225",
  [`${CORE}/agent/tools/agent/agentTool.ts`]:
    "8a5fae16626e42892630e8c94f7cf46ead909c314cb1ab83eaa55705dc72f1f7",
  [`${CLI}/cli/sub/web/run.ts`]:
    "04b05b28ac88652779aee73f9e61bd959f5b7c3db1a326d12f09c5d0b66699a8",
  [`${KAP}/routes/meta.ts`]:
    "a959d04d8b97c6fee45e50b2a4fd40403f954c0b85e87fa60514b9484795974d",
  [`${KAP}/protocol/rest-meta.ts`]:
    "90c476fc3128f9741a6b23e2283444a245f6cbf4c995d4ea951bf93fb6859461",
  [`${KAP}/routes/registerApiV1Routes.ts`]:
    "06429bdf1c28fd9ee8863adfec7d621a6b449d75be9aeba67a7e3fbc0c2e981a",
  [`${KAP}/index.ts`]:
    "ac37b26fdec8937f8b9d8ccf0cd449e1ab0c080cce75633c6eef2c88bac25a5b",
  [`${CORE}/tool/executor/tool-executor.ts`]:
    "f4920ab7e585d545525291dab916a16f595ca4b64695f4dc18db7c9d0f29ac94",
  [`${CORE}/tool/executor/hook-composer.ts`]:
    "a59be3760c444a94fa8a4e1a6546fbc4eb2249c745e2b4f449dfa333c111609a",
  [`${CORE_RUNTIME}/tool/types.ts`]:
    "fa805ac6b8d4046e114440c1a7029c3fe4623b7bcd63ca198b825bd4da9fec2e",
  [`${CORE_RUNTIME}/tool/args.ts`]:
    "99360f02a783e65425f668dc3f8bd050fd36a2479a9945a9880d20c1ab905a83",
  [`${CORE_RUNTIME}/tool/output-store.ts`]:
    "7dd29fcbbadd66abe78d52452b7e4b0ebeb90a6554003f91f1e5480d555d0987",
  [`${CORE_RUNTIME}/tool/validate.ts`]:
    "5fc3d7906972395ab086425158ac9f691444deaac71a852f038ee31bbbcb1db1",
  [`${CORE_RUNTIME}/loop/create-loop.ts`]:
    "9f59c8b1ba1c8f5fceab450c2d0c45a52192638f55b2e019c1bfe5bada4e2814",
  [`${CORE_RUNTIME}/loop/hook/run.ts`]:
    "542d70e23711083dc0fd183a0976d1884e4710e7d1d9c68306ab1f9aac749d50",
  [`${CORE_RUNTIME}/loop/contract/emitted.ts`]:
    "255f5726604caaecf2b89f8b18edb90d7844227c3627724f29e9eeda488bafb2",
  [`${CORE_RUNTIME}/llm/policy/policy.ts`]:
    "9a099a68c991eae31f38de7fce6396e325a4fab027c7b5c2fed2c9b919accd96",
  [`${CORE_RUNTIME}/llm/policy/retry.ts`]:
    "8804d648c0f6b9208d4f3673a35d3c7456152a9d44bb3f1424b2fd1bc9adc864",
  [`${CORE_RUNTIME}/llm/policy/settle.ts`]:
    "cae307c86473943d71613f3021af72a981d0cc515e6be0c8fb4197e42ca61772",
  [`${CORE_RUNTIME}/llm/policy/recovery.ts`]:
    "a735e0e1cac0a3b890c8fb261282cb68ca15592f68af85f71a498d6b0d0357a8",
  [`${CORE_RUNTIME}/llm/policy/credentials.ts`]:
    "6a173360e94ce46a99f5714b11e15839000809adc4f0b8f4cb9261aa32832bf6",
  [`${CORE}/llm-adapter/contract/errors.ts`]:
    "7540ee2b673d2096be685ec8a3c635a711e20de29b819dc787dcbe16c47186c4",
  [`${CORE_RUNTIME}/llm/response.ts`]:
    "b67a243fe04142da5d6b0cefb53ceba4d3f9dcdde50b6bbe80b843f66aed752d",
  [`${CORE_RUNTIME}/llm/protocol/errors.ts`]:
    "f808584bebf6d3089752ad58193fb609dad67b3e63dbb19e08b58d228faec505",
  [`${CORE_RUNTIME}/llm/protocol/rules/status.ts`]:
    "5b04243211ca5dd683fe19b52055cb271acf880d59783590a248aa66727bea8d",
  [`${CORE_RUNTIME}/llm/requester.ts`]:
    "f10ad24cf1dccc7eb04b6bf71e352989207028629f187673f1f3ba333d626387",
  [`${CORE_RUNTIME}/utils/abort.ts`]:
    "d1b20d9f1862842419f49c5b259bbc6276ab13ad17a7d7abfc52eeffd56ac911",
  [`${CORE}/agent/loop/loopOps.ts`]:
    "b004538f156c0519c00fd1ab6e932837444c74cc90b90dfc86227a78df8ab070",
  [`${CORE}/features/promptPrediction/promptPrediction.ts`]:
    "aa6d0ede11af5df15407d8811c3ec655537573d0e562cc028b93ad23698c6cd5",
  [`${CORE}/features/promptPrediction/promptPredictionService.ts`]:
    "3d621b1f240a810385cb517df75466c25d2f4cd69ccfbbf42796a74f5ccf95cd",
  [`${SDK}/v2/resume-replay.ts`]:
    "9755904af88307320013d230fb2f8860cc7d563693a42d1ed1746b369175e31f",
  [`${KAP}/transport/ws/v1/taskRequests.ts`]:
    "ba3b5fff35fc372e94a69f3388616c8f1166823121256e096c980433219dda78",
  [`${KAP}/transport/ws/v1/registerWsV1.ts`]:
    "f0b2e5b8b65bc70c9ee7df92eb993ab1f64e36d717128083849fca772cfea50b",
  [`${CLI}/cli/commands.ts`]:
    "c801169c5a33b239f82795f9a5774090a79af0ca945225d7192da8f255a49873",
  [`${CLI}/cli/options.ts`]:
    "ffcbde708de9c4730814f246450f2bd211a51641e83b8dcd4d5b8e4d8f2832e2",
  [`${CLI}/cli/main.ts`]:
    "e0bccbe77e49768e4d85a4b5317226afc9faeecfdfbf711114b80f76ac4c8105",
  [`${CLI}/cli/update/preflight.ts`]:
    "5a72c0c69f846f2dfb2cd01862fb143cfe8735bbc6a681856f8bc80a00191cdb",
  [`${CLI}/cli/update/forced.ts`]:
    "3337af0706eb882fd56b2245a7491375c67ffe357f0730b8bd99e9d033377749",
  [`${CLI}/cli/update/native-swap.ts`]:
    "8aa424c2d9ae19e506c85bc917ff1deebf35562186152d57dddee4b8e1453739",
  [`${KLIENT}/core/facade/agent.ts`]:
    "4cf24cb790111b0fe7a0ac266198938d3b6023f6e2ec2d12804aa5b0436f314e",
  [`${ACP}/session.ts`]:
    "df7805cf2b677f6990720dcc0d3e072589c071db132777076dc90ee8c7f4fddc",
};
delete PINNED_HASHES["2.7.2"][`${CORE}/agent/loop/core/loop-actor.ts`];

/**
 * Every durable plan-state event type at the pinned tag. The journal taint scan
 * (runtime/native-v2-preflight.ts::scanJournalLines) treats any record whose
 * decoded `type` starts with `plan_mode.` or `plan.` as taint; this list is
 * what makes that prefix test complete rather than a guess.
 */
const EXPECTED_PLAN_EVENT_TYPES = [
  "plan_mode.enter",
  "plan_mode.cancel",
  "plan_mode.exit",
  "plan.revision",
];

/** Every production subscriber of the before-execute channel at the pinned tag. */
const EXPECTED_BEFORE_EXECUTE_SUBSCRIBERS = [
  `${CORE}/agent/permissionGate/permissionGateService.ts`,
  `${CORE}/agent/toolDedupe/toolDedupeService.ts`,
  `${CORE}/features/btw/btwService.ts`,
  `${CORE}/features/externalHooks/agent/agentExternalHooksService.ts`,
  `${CORE}/features/goal/goalService.ts`,
  `${CORE}/features/plan/planService.ts`,
  `${CORE}/features/swarm/agent/swarmService.ts`,
  `${CORE}/features/tower/towerService.ts`,
];

function abs(rel: string): string {
  return path.join(SOURCE ?? "", rel);
}

function read(rel: string): string {
  return readFileSync(abs(rel), "utf8");
}

function isProductionTs(rel: string): boolean {
  return rel.endsWith(".ts") && !rel.includes("/test/") && !rel.endsWith(".test.ts");
}

function* walk(rel: string): Generator<string> {
  const dir = abs(rel);
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const childRel = path.join(rel, entry);
    if (statSync(abs(childRel)).isDirectory()) {
      yield* walk(childRel);
    } else {
      yield childRel;
    }
  }
}

function filesContaining(roots: string[], needle: string | RegExp): string[] {
  const hits: string[] = [];
  for (const root of roots) {
    for (const rel of walk(root)) {
      if (!isProductionTs(rel)) continue;
      const contents = read(rel);
      const matched = typeof needle === "string" ? contents.includes(needle) : needle.test(contents);
      if (matched) hits.push(rel);
    }
  }
  return hits.sort();
}

function upstreamVersion(): string {
  const pkg = JSON.parse(read("apps/kimi-code/package.json")) as { version: string };
  return pkg.version;
}

suite("native-v2 tag scan: the no-plan construction holds at this source tree", () => {
  test("the tag is pinned and its load-bearing files are byte-identical to the audited bytes", () => {
    const version = upstreamVersion();
    const pins = PINNED_HASHES[version];
    expect(pins, `no pinned hashes for kimi-code ${version}; audit the diff and add a row`).toBeDefined();
    for (const [rel, expected] of Object.entries(pins ?? {})) {
      const actual = createHash("sha256").update(readFileSync(abs(rel))).digest("hex");
      expect(actual, `${rel} changed since the audited ${version} bytes`).toBe(expected);
    }
  });

  test("the plan-file guard is the ONLY final allow in the engine, CLI, and SDK", () => {
    const sites = filesContaining([CORE, CORE_RUNTIME, CLI, KAP, SDK, KLIENT, ACP], ".allow()");
    expect(sites).toEqual([`${CORE}/features/plan/planService.ts`]);
    const guard = read(`${CORE}/features/plan/planService.ts`);
    // The allow must stay gated on an active plan: `if (plan === null) return;`
    // precedes the allow inside guardToolExecution.
    const gateIndex = guard.indexOf("if (plan === null)");
    const allowIndex = guard.indexOf("event.allow()");
    expect(gateIndex).toBeGreaterThan(-1);
    expect(allowIndex).toBeGreaterThan(gateIndex);
  });

  test("plan service entry callers match the exact audited tool surface", () => {
    expect(filesContaining([CORE, CORE_RUNTIME, CLI, KAP, SDK, KLIENT, ACP], "new PlanModeEnter(")).toEqual([
      `${CORE}/features/plan/planService.ts`,
    ]);
    const enterCallers = filesContaining([CORE, CORE_RUNTIME, CLI, KAP, SDK, KLIENT, ACP], "IAgentPlanService").filter((rel) =>
      read(rel).includes(".enter("),
    );
    expect(enterCallers).toEqual([
      ...(["2.4.0", "2.4.1", "2.5.0", "2.5.1", "2.5.2", "2.5.3", "2.6.0", "2.6.2", "2.6.3", "2.7.2"].includes(upstreamVersion())
        ? []
        : [`${CORE}/features/plan/tools/enter-plan-mode/enterPlanModeTool.ts`]),
      `${CORE}/workspace/sessionLifecycle/sessionLifecycleService.ts`,
      `${KAP}/routes/sessionAgentConfig.ts`,
    ]);
    if (["2.4.0", "2.4.1", "2.5.0", "2.5.1", "2.5.2", "2.5.3", "2.6.0", "2.6.2", "2.6.3", "2.7.2"].includes(upstreamVersion())) {
      expect(filesContaining([CORE], "EnterPlanMode")).toEqual([]);
    }
  });

  test("2.7.2 host plan entry stays explicit and outside the print runner", () => {
    if (upstreamVersion() !== "2.7.2") return;
    expect(read(`${SDK}/sdk-rpc-client-v2.ts`)).toContain("return agent.enterPlan()");
    expect(read(`${KLIENT}/core/facade/agent.ts`)).toContain(
      "enterPlan: () => call(scope, 'agentPlanService', 'enter', []) as Promise<void>",
    );
    expect(read(`${ACP}/session.ts`)).toContain("await this.agent.enterPlan();");
    expect(read(`${CLI}/cli/v2/run-v2-print.ts`)).not.toContain("setPlanMode(");
  });

  test("2.5+ print bootstrap preserves provenance, local-selection, and host-only plan boundaries", () => {
    if (!["2.5.0", "2.5.1", "2.5.2", "2.5.3", "2.6.0", "2.6.2", "2.6.3", "2.7.2"].includes(upstreamVersion())) return;
    const runner = read(`${CLI}/cli/v2/run-v2-print.ts`);
    const marker = runner.indexOf("writeExperimentalVersion(");
    const sdk = runner.indexOf("new SDKRpcClientV2(");
    expect(marker).toBeGreaterThan(-1);
    expect(sdk).toBeGreaterThan(marker);
    expect(runner).not.toContain("setPlanMode(");
    expect(runner).toContain("environmentId: opts.environment");
    expect(runner).toContain("environmentCwd: opts.environmentCwd");
    expect(runner).toContain("permissionMode.setMode('auto')");
    expect(runner).toContain("agent.accessor.get(IAgentPermissionModeService).setMode('auto')");
    const sdkClient = read(`${SDK}/sdk-rpc-client-v2.ts`);
    expect(sdkClient).toContain("override async setPlanMode(");
    expect(sdkClient).toContain("return agent.enterPlan()");
  });

  test("2.5+ environment and workspace-trust dependencies are explicitly reviewed", () => {
    if (!["2.5.0", "2.5.1", "2.5.2", "2.5.3", "2.6.0", "2.6.2", "2.6.3", "2.7.2"].includes(upstreamVersion())) return;
    expect(read(`${CORE}/app/sessionManager/sessionManagerService.ts`)).toContain(
      "options.environmentId === LOCAL_ENVIRONMENT_ID",
    );
    expect(read(`${CORE}/workspace/sessionLifecycle/sessionLifecycleService.ts`)).toContain(
      "environment.environmentId === LOCAL_ENVIRONMENT_ID",
    );
    expect(read(`${CORE}/agent/environmentBinding/environmentBindingOps.ts`)).toContain(
      "static override readonly type = 'environment.set_binding'",
    );
    const trust = read(`${CORE}/workspace/workspaceTrust/configSection.ts`);
    expect(trust).toContain("requireTrust: z.boolean().optional()");
    expect(trust).toContain("requireTrust: true");
    expect(read(`${CORE}/workspace/workspaceTrust/workspaceTrustStore.ts`)).toContain(
      "if (!this.trustGateEnabled()) return true",
    );
    expect(read(`${CORE}/workspace/workspaceMcpConfig/workspaceMcpConfigService.ts`)).toContain(
      "includeProject: trusted",
    );
  });

  test("2.5+ WebSocket state proof remains authenticated and bound to the live main agent", () => {
    const version = upstreamVersion();
    if (!["2.5.0", "2.5.1", "2.5.2", "2.5.3", "2.6.0", "2.6.2", "2.6.3", "2.7.2"].includes(version)) return;
    const schema = read(`${KAP}/protocol/ws-agent.ts`);
    for (const field of ["session_id", "agent_id", "model", "permission_mode", "plan_mode", "swarm_mode", "tower_mode"]) {
      expect(schema).toContain(field);
    }
    expect(read(`${KAP}/transport/ws/bearerProtocol.ts`)).toContain("kimi-code.bearer.");
    expect(read(`${KAP}/transport/ws/v1/agentState.ts`)).toContain("readAgentState");
    const broadcaster = read(`${KAP}/transport/ws/v1/sessionEventBroadcaster.ts`);
    if (["2.6.0", "2.6.2", "2.6.3", "2.7.2"].includes(version)) {
      const control = read(`${KAP}/protocol/ws-control.ts`);
      expect(control).toContain("type: z.literal('subscribe')");
      expect(control).toContain("type: z.literal('response')");
      expect(control).toContain("request_id: z.string().min(1)");
      expect(control).toContain("session_id: z.string().min(1)");
      expect(control).toContain("agent_ids: z.array(z.string().min(1)).min(1).optional()");
      expect(control).not.toContain("server_hello");
      const connection = read(`${KAP}/transport/ws/v1/wsConnectionV1.ts`);
      expect(connection).toContain("agentIds ?? [MAIN_AGENT_ID]");
      expect(connection).toContain("this.respond(requestId, ErrorCode.SUCCESS)");
      expect(connection).not.toContain("client_hello");
      const accepted = broadcaster.indexOf("accepted?.();");
      const snapshot = broadcaster.indexOf("this.sendAgentLists(state, target, added);");
      expect(accepted).toBeGreaterThan(-1);
      expect(snapshot).toBeGreaterThan(accepted);
    } else {
      const snapshot = broadcaster.indexOf("this.sendAgentLists(state, target, transcriptGrades)");
      const transcript = broadcaster.indexOf("await this.subscribeTranscript(state, target, transcriptGrades");
      expect(snapshot).toBeGreaterThan(-1);
      expect(transcript).toBeGreaterThan(snapshot);
    }
    expect(read(`${KAP}/routes/environment.ts`)).toContain("path: '/sessions/{session_id}/environment'");
    const start = read(`${KAP}/start.ts`);
    expect(start).toContain("extractWsBearerToken(req.headers['sec-websocket-protocol'])");
    expect(start).toContain("ok = await validateCredential(candidate)");
    expect(start.indexOf("ok = await validateCredential(candidate)")).toBeLessThan(
      start.indexOf("wss.handleUpgrade(req, socket, head"),
    );
  });

  test("2.7.2 JSON bootstrap and meta preserve authenticated direct-subscription discovery", () => {
    if (upstreamVersion() !== "2.7.2") return;
    const web = read(`${CLI}/cli/sub/web/run.ts`);
    expect(web).toContain("randomBytes(32).toString('base64url')");
    expect(web).toContain("timingSafeEqual(actual, expected)");
    expect(web).toContain("'--json cannot be combined with --dangerous-bypass-auth.'");
    expect(web).toContain("'--json cannot be combined with --socket.'");
    expect(web).toContain("authTokenService: createEphemeralAuthTokenService(ephemeralToken!)");
    expect(web).toContain("skipInstanceRegistry: true");
    expect(web).toContain("logToStderr: true");
    expect(web).toContain("origin: normalizedOrigin");
    expect(web).toContain("ws_url: wsUrl");
    expect(web).toContain("kimi_agent_protocol_version: KIMI_AGENT_PROTOCOL_VERSION");
    expect(web).toContain("authTokenService: options.authTokenService");
    expect(web).toContain("disableAuth: options.dangerousBypassAuth");
    const meta = read(`${KAP}/routes/meta.ts`);
    expect(meta).toContain("KIMI_AGENT_PROTOCOL_VERSION = '1.0.0'");
    expect(meta).toContain("kimi_agent_protocol_version: KIMI_AGENT_PROTOCOL_VERSION");
    expect(meta).toContain("websocket: true as const");
    expect(meta).toContain("interactions_list: true as const");
    expect(meta).toContain("session_wait: true as const");
    expect(meta).toContain("dangerous_bypass_auth: opts.dangerousBypassAuth");
    const schema = read(`${KAP}/protocol/rest-meta.ts`);
    expect(schema).toContain("kimi_agent_protocol_version: z.string().min(1)");
    expect(schema).toContain("product: z.string().min(1).optional()");
    expect(schema).toContain("interactions_list: z.literal(true)");
    expect(schema).toContain("session_wait: z.literal(true)");
    const routes = read(`${KAP}/routes/registerApiV1Routes.ts`);
    expect(routes).toContain("product: opts.hostIdentity.productName");
    expect(routes).toContain("serverId: opts.serverId ?? ulid()");
    expect(read(`${KAP}/index.ts`)).toContain("export { KIMI_AGENT_PROTOCOL_VERSION } from './routes/meta';");
    const start = read(`${KAP}/start.ts`);
    expect(start).toContain("const disableAuth = opts.disableAuth === true || opts.socketPath !== undefined;");
    expect(start).toContain("if (!disableAuth) {");
    expect(start.indexOf("createAuthHook(authTokenService")).toBeLessThan(
      start.indexOf("await registerApiV1Routes("),
    );
  });

  test("default_plan_mode is a plain optional boolean with default false and no env binding", () => {
    const section = read(`${CORE}/features/plan/configSection.ts`);
    expect(section).toContain("z.boolean().optional()");
    expect(section).toContain("defaultValue: false");
    expect(section).not.toMatch(/\benv\s*:/);
    // The section is registered under the camelCase domain; the loader maps
    // every top-level TOML key through snakeToCamel with EXACTLY this regex
    // (the preflight mirrors it). The experimental section, by contrast,
    // registers a fromToml that keeps raw keys, so its flag ids stay
    // snake_case and the preflight must NOT normalize that table.
    expect(section).toContain("DEFAULT_PLAN_MODE_SECTION = 'defaultPlanMode'");
    const toml = read(`${CORE}/app/config/toml.ts`);
    expect(toml).toContain("return str.replaceAll(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());");
    expect(toml).toContain("const domain = snakeToCamel(key);");
    const flag = read(`${CORE}/app/flag/flag.ts`);
    expect(flag).toContain("isPlainObject(rawSnake) ? cloneRecord(rawSnake) : rawSnake");
    expect(flag).toContain("fromToml: experimentalFromToml");
    expect(read(`${CORE}/session/subagent/flag.ts`)).toContain("SUBAGENT_FORK_FLAG_ID = 'subagent_fork'");
    expect(read(`${CORE}/features/tower/tower.ts`)).toContain("TOWER_FLAG_ID = 'tower'");
  });

  test("print mode still rejects --plan and intercepts only /goal", () => {
    expect(read(`${CLI}/cli/options.ts`)).toContain("Cannot combine --prompt with --plan.");
    const runner = read(`${CLI}/cli/v2/run-v2-print.ts`);
    expect(runner).toContain("parseHeadlessGoalCreate(");
    expect(runner).not.toContain("dispatchInput(");
    expect(runner).not.toContain("'/plan'");
    if (["2.4.0", "2.4.1", "2.5.0", "2.5.1", "2.5.2", "2.5.3", "2.6.0", "2.6.2", "2.6.3", "2.7.2"].includes(upstreamVersion())) {
      expect(runner).toContain("plan.cancel();");
      expect(runner).toContain("await notePlanMode(agent, opts.session);");
      expect(runner).toContain("default_plan_mode is not applied in print mode");
    }
  });

  test("2.7.2 print and update boundaries remain local, noninteractive, and goal-scoped", () => {
    if (upstreamVersion() !== "2.7.2") return;
    const options = read(`${CLI}/cli/options.ts`);
    for (const flag of ["--yolo", "--auto", "--plan"]) {
      expect(options).toContain(`Cannot combine --prompt with ${flag}.`);
    }
    expect(options).toContain("Cannot combine --environment with --session/--continue:");
    const runner = read(`${CLI}/cli/v2/run-v2-print.ts`);
    expect(runner).toContain("nonInteractive: true");
    expect(runner).not.toMatch(/promptPrediction|predictNextPrompt/);
    const prediction = read(`${CORE}/features/promptPrediction/promptPredictionService.ts`);
    expect(prediction).toContain("type: 'operation'");
    expect(prediction).toContain("requestKind: 'prompt_prediction'");
    expect(prediction).toContain("if (plan !== null || !this.stillCurrent(active, scope, contextSnapshot))");
    const goal = read(`${CLI}/cli/goal-prompt.ts`);
    expect(goal).toContain("complete: 0");
    expect(goal).toContain("blocked: 3");
    expect(goal).toContain("paused: 6");
    expect(goal).toContain("if (parsed.kind !== 'create') return undefined;");
    expect(read(`${CLI}/cli/update/preflight.ts`)).toContain("env['KIMI_CODE_NO_AUTO_UPDATE']");
    expect(read(`${CLI}/cli/update/forced.ts`)).toContain("if (!isInteractive) return 'continue';");
    const swap = read(`${CLI}/cli/update/native-swap.ts`);
    expect(swap).toContain("staged.manual !== true &&");
    expect(swap).toContain("isAutoUpdateDisabledByEnv(deps.env)");
  });

  test("every tool execution passes the reviewed before-execute emitter composition", () => {
    const callers = filesContaining([CORE], "fireBeforeExecute(");
    expect(callers).toEqual([
      `${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`,
      ...(["2.6.0", "2.6.2", "2.6.3", "2.7.2"].includes(upstreamVersion()) ? [`${CORE}/agent/toolExecutor/legacyHooks.ts`] : []),
      `${CORE}/agent/toolExecutor/toolExecutorService.ts`,
    ]);
  });

  test("the before-execute subscriber population is exactly the audited set", () => {
    if (["2.6.0", "2.6.2", "2.6.3", "2.7.2"].includes(upstreamVersion())) {
      expect(filesContaining([CORE], "registerLegacyStarting(")).toEqual([
        `${CORE}/agent/toolExecutor/legacyHooks.ts`,
        `${CORE}/agent/toolExecutor/toolExecutor.ts`,
        `${CORE}/agent/toolExecutor/toolExecutorService.ts`,
        `${CORE}/features/btw/btwService.ts`,
        `${CORE}/features/externalHooks/agent/agentExternalHooksService.ts`,
        `${CORE}/features/goal/goalService.ts`,
        `${CORE}/features/plan/planService.ts`,
        `${CORE}/features/tower/towerService.ts`,
      ]);
      expect(filesContaining([CORE], "registerHook(")).toEqual([
        `${CORE}/agent/agentsMdReminder/agentsMdReminderService.ts`,
        `${CORE}/agent/mcp/mcpService.ts`,
        `${CORE}/agent/permissionGate/permissionGateService.ts`,
        `${CORE}/agent/shellCommand/shellCommandService.ts`,
        `${CORE}/agent/task/taskService.ts`,
        `${CORE}/agent/toolDedupe/toolDedupeService.ts`,
        `${CORE}/agent/toolExecutor/toolExecutor.ts`,
        `${CORE}/agent/toolExecutor/toolExecutorService.ts`,
        `${CORE}/agent/toolPolicy/toolPolicyService.ts`,
        `${CORE}/agent/toolSelect/toolSelectService.ts`,
        `${CORE}/features/externalHooks/agent/agentExternalHooksService.ts`,
        `${CORE}/features/fileHistory/fileHistoryService.ts`,
      ]);
      expect(filesContaining([CORE], "registerToolBatchStarting(")).toEqual([
        `${CORE}/agent/loop/loop.ts`,
        `${CORE}/agent/loop/loopService.ts`,
        `${CORE}/features/swarm/agent/swarmService.ts`,
      ]);
      return;
    }
    expect(filesContaining([CORE], "onBeforeExecuteTool(")).toEqual(
      EXPECTED_BEFORE_EXECUTE_SUBSCRIBERS,
    );
  });

  test("2.7.2 generic executors are constructed only inside the managed agent composition", () => {
    if (upstreamVersion() !== "2.7.2") return;
    expect(filesContaining([CORE, CORE_RUNTIME, CLI, KAP, SDK, KLIENT, ACP], "new ToolExecutor(")).toEqual([
      `${CORE}/agent/toolExecutor/toolExecutorService.ts`,
    ]);
    const service = read(`${CORE}/agent/toolExecutor/toolExecutorService.ts`);
    expect(service.indexOf("this.legacyStarting.fireBeforeExecute(")).toBeGreaterThan(-1);
    expect(service.indexOf("this.legacyStarting.fireBeforeExecute(")).toBeLessThan(service.indexOf("new ToolExecutor("));
    const loop = read(`${CORE_RUNTIME}/loop/loop-actor.ts`);
    expect(loop).toContain("executor.execute(");
  });

  test("2.6+ executor phases preserve managed-hook veto and execution ordering", () => {
    const version = upstreamVersion();
    if (!["2.6.0", "2.6.2", "2.6.3", "2.7.2"].includes(version)) return;
    const service = read(`${CORE}/agent/toolExecutor/toolExecutorService.ts`);
    expect(service).toContain("composeToolExecutorHooks([resetHook, legacyHook, ...hooks, internalHook])");
    if (version === "2.7.2") {
      const executor = read(`${CORE_RUNTIME}/tool/tool-executor.ts`);
      const starting = executor.indexOf("const starting = await this.decide('starting'");
      const conditional = executor.indexOf("if (starting === undefined || !('skipPermitting' in starting))");
      const permitting = executor.indexOf("const permitting = await this.decide('permitting'");
      const beforeExecute = executor.indexOf("await this.host.hook?.beforeExecute?.(this.decisionContext())");
      const execute = executor.indexOf("returned = await tool.execute(toolContext)");
      expect(starting).toBeGreaterThan(-1);
      expect(conditional).toBeGreaterThan(starting);
      expect(permitting).toBeGreaterThan(conditional);
      expect(beforeExecute).toBeGreaterThan(permitting);
      expect(execute).toBeGreaterThan(beforeExecute);
    } else {
      const executor = read(`${CORE}/tool/executor/tool-executor.ts`);
      const starting = executor.indexOf("await decide('starting'");
      const permitting = executor.indexOf("await decide('permitting'");
      const beforeExecute = executor.indexOf("await hook?.beforeExecute");
      const execute = executor.indexOf("returned = await tool.execute");
      expect(starting).toBeGreaterThan(-1);
      expect(permitting).toBeGreaterThan(starting);
      expect(beforeExecute).toBeGreaterThan(permitting);
      expect(execute).toBeGreaterThan(beforeExecute);
    }
    const legacy = read(`${CORE}/agent/toolExecutor/legacyHooks.ts`);
    expect(legacy).toContain("if (decision?.allow === true) return { skipPermitting: true };");
    expect(legacy).toContain("if (decision?.veto !== undefined)");
    const composer = version === "2.7.2"
      ? `${CORE_RUNTIME}/tool/hook-composer.ts`
      : `${CORE}/tool/executor/hook-composer.ts`;
    expect(read(composer)).toContain("if ('skipPermitting' in decision)");
    expect(read(`${CORE}/agent/permissionGate/permissionGateService.ts`)).toContain("event.pass(");
  });

  test("the external-hooks agent service is eager (present in every agent scope)", () => {
    const feature = read(`${CORE}/features/externalHooks/externalHooksFeature.ts`);
    expect(feature).toContain("contributeAgentService(IAgentExternalHooksService, AgentExternalHooksService)");
    expect(feature).not.toContain("OnDemand");
  });

  test("hook aggregation stays first-block-wins", () => {
    const match = read(`${CORE}/features/externalHooks/internal/matchHooks.ts`);
    expect(match).toContain("results.find((result) => result.action === 'block')");
  });

  test("tool schemas the allowlist reads keep their field names", () => {
    expect(read(`${CORE}/agent/tools/os/write/write.ts`)).toMatch(/\bpath:\s*z\b/);
    expect(read(`${CORE}/agent/tools/edit/edit.ts`)).toMatch(/\bpath:\s*z\b/);
    const bash = read(`${CORE}/agent/tools/os/bash/bash.ts`);
    expect(bash).toMatch(/\bcommand:\s*z\b/);
    // If upstream ever removes Bash.cwd the plugin's cwd policy becomes dead
    // code rather than unsafe; flag it so the audit notices either way.
    expect(bash).toMatch(/\bcwd:\s*z\b/);
  });

  test("session restore folds only the wire journal (the journal taint scan's premise)", () => {
    // scanSessionJournalsForPlan walks agents/<id>/wire.jsonl only. Its
    // completeness depends on restore() having no OTHER source of durable plan
    // state. Assert the folding loop still reads the wire journal and that no
    // snapshot/checkpoint LOADER was introduced as a second restore source
    // ("checkpoints" as an in-memory undo structure is fine; a read of a
    // persisted snapshot/checkpoint blob would be a new taint source).
    const dispatcher = read(`${CORE}/state/eventDispatcherService.ts`);
    expect(dispatcher).toContain("this.wire.readJournal()");
    expect(dispatcher).not.toMatch(/\b(loadSnapshot|readSnapshot|readCheckpoint|restoreSnapshot)\s*\(/);
    // Every read the dispatcher takes from the wire service must be one of the
    // journal readers. 0.43.0 added `readRestorable()` (undoable folds replay a
    // branch/undo-filtered view first); it must remain a filtered view of the
    // same on-disk log, never a second source.
    const wireReads = [...dispatcher.matchAll(/this\.wire\.(read\w*)\(/g)].map((m) => m[1]);
    expect(new Set(wireReads).size).toBeGreaterThan(0);
    for (const method of wireReads) {
      expect(["readJournal", "readRestorable", "readRestoreChains"]).toContain(method);
    }
    expect(read(`${CORE}/wire/record.ts`)).toContain("AGENT_WIRE_RECORD_KEY = 'wire.jsonl'");
    const wireService = read(`${CORE}/wire/wireService.ts`);
    if (["2.5.0", "2.5.1", "2.5.2", "2.5.3", "2.6.0", "2.6.2", "2.6.3", "2.7.2"].includes(upstreamVersion())) {
      expect(wireService).toContain("for await (const { record } of this.readEntries(false))");
    }
    // Every append-log read in the wire service names the single wire key.
    const logReads = wireService.match(/this\.log\.read(?:<[^>]*>)?\(\s*\n?\s*this\.wireScope,\s*\n?\s*(\w+)/g) ?? [];
    expect(logReads.length).toBeGreaterThan(0);
    for (const call of logReads) expect(call).toContain("AGENT_WIRE_RECORD_KEY");
    if (wireService.includes("readRestorable()")) {
      const body = wireService.slice(wireService.indexOf("async *readRestorable()"));
      const end = body.indexOf("\n  }\n");
      expect(end, "readRestorable() body delimiter not found — re-read wireService.ts").toBeGreaterThan(-1);
      const restorable = body.slice(0, end);
      expect(restorable).toContain("this.readStableEntries()");
      expect(restorable).toContain("restorableChain(entries, tree)");
      // restorableChain is a pure function over the entries it is handed.
      const fork = read(`${CORE}/wire/tree/fork.ts`);
      expect(fork).toMatch(/export function restorableChain\(\s*entries: readonly WireLine\[\],\s*tree: WireTree,?\s*\)/);
      expect(fork).not.toMatch(/from '(node:fs|#\/persist|#\/app\/storage)/);
    }
    if (wireReads.includes("readRestoreChains")) {
      // 2.0.1 materializes both passes once. Prove BOTH arrays derive from
      // the same stable wire entries; recognizing a method name is insufficient.
      const start = wireService.indexOf("async readRestoreChains()");
      expect(start, "readRestoreChains declaration missing").toBeGreaterThan(-1);
      const body = wireService.slice(start);
      const end = body.indexOf("\n  }\n");
      expect(end, "readRestoreChains body delimiter changed").toBeGreaterThan(-1);
      const chains = body.slice(0, end);
      expect(chains).toContain("const entries = await this.readStableEntries();");
      if (["2.6.0", "2.6.2", "2.6.3", "2.7.2"].includes(upstreamVersion())) {
        expect(chains).toContain(
          "restorable: normalizeLegacyTurnSteerRecords(restorableChain(entries, tree).map(({ record }) => record))",
        );
        const human = read(`${CORE}/wire/human.ts`);
        expect(human).toContain("normalized.push(record);");
        expect(human).not.toMatch(/plan_mode|["'`]plan\.|planMode|PlanMode/);
      } else {
        expect(chains).toContain("restorable: restorableChain(entries, tree).map(({ record }) => record)");
      }
      expect(chains).toContain("journal: entries.map(({ record }) => record)");
      expect(dispatcher).toContain("this.replayPass(chains.restorable, true, resolved)");
      expect(dispatcher).toContain("this.replayPass(chains.journal, false, resolved)");
    }
    // Fork must keep plan state out of the snapshot it copies to children.
    expect(read(`${CORE}/state/state.ts`)).toContain("snapshotExcluded");
    // restore() folds a journal record by its literal `type` string — so the
    // type strings declared on the plan event classes ARE what a resumed
    // session replays, and what the taint scan must recognise.
    expect(dispatcher).toContain("this.folded.events.get(record.type)");
  });

  test("wire migrations never rewrite a record type into the plan domain", () => {
    // readEntries() applies wire/migration/* to every journal line BEFORE
    // restore() folds by record.type, while the plugin's taint scan reads the
    // RAW line. A migration that mapped a legacy type onto `plan_mode.*` /
    // `plan.*` would therefore arm plan mode on resume unseen by the scan.
    // (Kimi 1.10.3 review.) Assert no migration source mentions the domain.
    const migrations = [...walk(`${CORE}/wire/migration`)].filter(isProductionTs);
    expect(migrations.length).toBeGreaterThan(0);
    for (const rel of migrations) {
      expect(read(rel), `${rel} references the plan domain`).not.toMatch(/plan_mode|["'`]plan\.|planMode|PlanMode/);
    }
  });

  test("every durable plan-state event type carries a prefix the journal taint scan keys on", () => {
    const ops = read(`${CORE}/features/plan/planOps.ts`);
    const declared = [...ops.matchAll(/static override readonly type = '([^']+)'/g)].map(
      (m) => m[1],
    );
    expect(declared).toEqual(EXPECTED_PLAN_EVENT_TYPES);
    for (const type of declared) {
      expect(
        type.startsWith("plan_mode.") || type.startsWith("plan."),
        `plan event type "${type}" would not be recognised by scanJournalLines`,
      ).toBe(true);
    }
    // The plan state key is defined in planOps.ts and no other production file
    // declares a plan-typed event: a new plan event elsewhere is a new taint
    // source the scan does not know about.
    expect(ops).toContain("defineState('plan'");
    const otherDeclarers = filesContaining(
      [CORE, CORE_RUNTIME, CLI, KAP],
      /static override readonly type = '(plan_mode|plan)\./,
    ).filter((rel) => rel !== `${CORE}/features/plan/planOps.ts`);
    expect(otherDeclarers).toEqual([]);
    // Permission mode is a separate state (manual|yolo|auto); it never carries
    // plan mode, so a `permission.set_mode` record is not a taint source.
    expect(read(`${CORE}/agent/permissionPolicy/types.ts`)).toContain(
      "export type PermissionMode = 'manual' | 'yolo' | 'auto';",
    );
  });

  test("the session store layout the journal scan walks is unchanged", () => {
    // <KIMI_CODE_HOME>/sessions/<workspaceId>/session_<uuid>/agents/<agentId>/wire.jsonl
    expect(read(`${CORE}/app/bootstrap/bootstrapService.ts`)).toContain(
      "this.sessionsDir = join(options.homeDir, 'sessions');",
    );
    expect(read(`${CORE}/workspace/sessionLifecycle/sessionLifecycleService.ts`)).toContain(
      "return `session_${randomUUID()}`;",
    );
    const wireScan = read(`${CORE}/app/sessionExport/wire-scan.ts`);
    expect(wireScan).toContain("const WIRE_FILENAME = 'wire.jsonl';");
    expect(wireScan).toContain("const agentsDir = join(sessionDir, 'agents');");
  });

  test("the legacy engine selector is gone (v2-only print mode)", () => {
    expect(filesContaining([CLI, CORE], "KIMI_CODE_LEGACY_FLAG")).toEqual([]);
    expect(read(`${CLI}/cli/run-prompt.ts`)).toContain("runV2Print");
  });
});

// These assertions pin the upstream premises of the plugin's bounded-wave
// construction, including the cancellation weakness it must close. They do
// not assert that native maxConcurrency is repaired or replace binary controls.
const boundedSwarmSuite = SOURCE !== undefined && existsSync(SOURCE) && ["2.6.2", "2.6.3", "2.7.2"].includes(upstreamVersion())
  ? describe
  : describe.skip;

boundedSwarmSuite("exact bounded-swarm source premises", () => {
  function section(source: string, start: string, end: string): string {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first + start.length);
    expect(first, `missing audited section ${start}`).toBeGreaterThan(-1);
    expect(last, `missing end of audited section ${start}`).toBeGreaterThan(first);
    return source.slice(first, last);
  }

  test("strict input constructs exactly one foreground task per new or resumed entry", () => {
    const schema = read(`${CORE}/features/swarm/tools/agent-swarm/agent-swarm.ts`);
    expect(schema).toContain(".strict()");
    expect(schema).toMatch(/items:\s*z\s*\.array\(z\.string\(\)\.trim\(\)\.min\(1\)\)/);
    expect(schema).toMatch(/resume_agent_ids:\s*z\s*\.record\(z\.string\(\)\.trim\(\)\.min\(1\), z\.string\(\)\.trim\(\)\.min\(1\)\)/);
    expect(schema).not.toMatch(/\b(?:timeout|run_in_background)\s*:/);
    const tool = read(`${CORE}/features/swarm/tools/agent-swarm/agentSwarmTool.ts`);
    expect(tool).toContain("const totalCount = resumeCount + itemCount;");
    expect(tool).toContain("return resumeCount > 0 || itemCount >= 2;");
    const specs = section(tool, "const specs: AgentSwarmSpec[] = [];", "return specs;");
    expect(specs).toContain("for (const entry of resumeEntries)");
    expect(specs).toContain("items.forEach((item, index) =>");
    expect(specs.match(/specs\.push\(/g)).toHaveLength(2);
    expect(tool).toContain("const tasks: SessionSwarmTask<AgentSwarmSpec>[] = specs.map((spec) =>");
    expect(tool).toContain("runInBackground: false,");
    expect(tool).toContain("const results = await this.swarmService.run({");
  });

  test("recovery reuses task identity after completion and ordinary retry awaits loop settlement", () => {
    const batch = read(`${CORE}/features/swarm/session/agentRunBatch.ts`);
    expect(batch).toContain("this.states = tasks.map((task, index) =>");
    expect(batch).toContain("this.pending = [...this.states];");
    expect(batch).toContain("const completion = await handle.completion;");
    const outcome = section(batch, "private handleAttemptOutcome(", "private handleAttemptError(");
    expect(outcome.indexOf("this.releaseAttempt(attempt)")).toBeLessThan(outcome.indexOf("this.requeueRateLimited(attempt, outcome.agentId)"));
    expect(batch).toContain("state.retryAgentId = agentId;");
    expect(batch).toContain("this.pending.unshift(state);");
    expect(batch).toContain("this.launcher.retry(attempt.state.retryAgentId, runOptions)");
    const runner = read(`${CORE}/session/subagent/runAgentTurn.ts`);
    if (["2.6.3", "2.7.2"].includes(upstreamVersion())) {
      expect(runner).toContain("return awaitRunCompletion(target, loop, loop.retry(), options);");
      const quiescent = section(runner, "async function awaitQuiescent(", "async function stopChildTasks(");
      expect(quiescent).toContain("const result = await loop.settled();");
      expect(quiescent).toContain("await Promise.all(active.map((task) => tasks.wait(task.taskId)));");
    } else {
      expect(runner).toContain("const result = await turn.result;");
      expect(runner).toContain("await abortable(loop.retry(), controller.signal)");
    }
    const loop = read(`${CORE}/agent/loop/loopService.ts`);
    expect(section(loop, "async retry():", "private maybeSettle()")).toContain("await this.settled();");
    expect(loop).toContain("await loop.waitForIdle();\n    await this.turns.drain();");
  });

  test("active swarm rejects parallel model batches and holds the tool lease until return", () => {
    const mode = read(`${CORE}/features/swarm/agent/swarmService.ts`);
    const guard = section(mode, "loop.registerToolBatchStarting(", "enter(trigger:");
    expect(guard).toContain("if (!this.isActive) return undefined;");
    expect(guard).toContain("(toolCall) => toolCall.name === 'AgentSwarm'");
    expect(guard).toContain("agentSwarmCount === 1 && event.toolCalls.length === 1");
    expect(guard).toContain("reason: 'agent_swarm_batch'");
    expect(read(`${CORE}/features/swarm/tools/agent-swarm/agentSwarmTool.ts`)).toContain("accesses: ToolAccesses.all(),");
    const executor = read(`${CORE}/agent/toolExecutor/toolExecutorService.ts`);
    expect(executor).toContain("const release = await batch.scheduler.lease(");
    expect(executor).toContain("context.prepared.onExecuted = () => {");
    const scheduler = read(`${CORE}/agent/toolExecutor/toolScheduler.ts`);
    expect(scheduler).toContain("return { result: new Promise<void>((resolve) => { release = resolve; }) };");
    expect(scheduler).toContain("ToolAccesses.conflict(task.accesses, candidate.accesses)");
  });

  test("fresh children have per-agent inactive swarm state and cannot enter it as a tool", () => {
    const feature = read(`${CORE}/features/swarm/swarmFeature.ts`);
    expect(feature).toContain("this.contributeAgentService(IAgentSwarmService, AgentSwarmService, {");
    expect(feature).toContain("activation: ScopeActivation.OnScopeCreated");
    const state = read(`${CORE}/features/swarm/swarmOps.ts`);
    expect(state).toContain("defineState('swarm', (): SwarmModeTrigger | null => null)");
    expect(state).toContain("if (e.trigger === 'tool') return s;");
    const mode = read(`${CORE}/features/swarm/agent/swarmService.ts`);
    expect(mode).toMatch(/if \(trigger === 'tool'\) \{\s*throw new Error2\(ErrorCodes\.VALIDATION_FAILED, 'Only the user can turn on swarm mode\.'/);
    const tool = read(`${CORE}/features/swarm/tools/agent-swarm/agentSwarmTool.ts`);
    expect(tool.match(/if \(!this\.swarmMode\.isActive\) return SWARM_MODE_OFF_RESULT;/g)).toHaveLength(2);
    const profiles = read(`${CORE}/session/agentLifecycle/profile/profiles.ts`);
    expect(section(profiles, "const CODER_TOOLS = [", "const EXPLORE_TOOLS = [")).not.toContain("'AgentSwarm'");
    expect(filesContaining([CORE, CLI, KAP, SDK], "new SwarmModeEnter(")).toEqual([
      `${CORE}/features/swarm/agent/swarmService.ts`,
    ]);
  });

  test("resume uses only idle children owned by the caller in the current session", () => {
    const service = read(`${CORE}/features/swarm/session/sessionSwarmService.ts`);
    const resume = section(service, "private async resumeAttempt(", "private async observe(");
    expect(resume).toContain("await this.requireOwnedSubagent(callerAgentId, agentId)");
    expect(resume).toContain("this.requireIdleSubagent(agentId, child);");
    const ownership = section(service, "private async requireOwnedSubagent(", "export type _AgentRunUsage");
    expect(ownership).toContain("meta === undefined || !isSubagentMeta(meta)");
    expect(ownership).toContain("subagentParentAgentId(meta) !== callerAgentId");
    expect(ownership).toContain("const meta = await this.metadata.read();");
    expect(ownership).toContain("return meta.agents?.[agentId];");
    expect(service).toContain("child.accessor.get(IAgentLoopService).snapshot().state === 'running'");
    const metadata = read(`${CORE}/session/agentLifecycle/subagentMetadata.ts`);
    expect(metadata).toContain("return meta.type === 'sub';");
    expect(metadata).toContain("firstNonEmpty(meta.labels?.['parentAgentId'], meta.parentAgentId ?? undefined)");
  });

  test("fork stays explicit and copies profile tools and history without swarm activation", () => {
    const tool = read(`${CORE}/features/swarm/tools/agent-swarm/agentSwarmTool.ts`);
    expect(tool).toContain("const fork = args.fork === true;");
    expect(tool).toContain("if (fork && !this.flags.enabled(SUBAGENT_FORK_FLAG_ID))");
    expect(tool).toContain("if (fork && Object.keys(args.resume_agent_ids ?? {}).length > 0)");
    expect(read(`${CORE}/session/subagent/flag.ts`)).toContain("default: false,");
    const compatibility = read(`${CORE}/session/subagent/spawn.ts`);
    expect(compatibility).toContain("requestedProfileName !== own.profileName");
    expect(compatibility).toContain("args.model !== own.modelAlias");
    const lifecycle = read(`${CORE}/session/agentLifecycle/agentLifecycleService.ts`);
    const fork = section(lifecycle, "async fork(sourceContext:", "get(agentId:");
    expect(fork).toContain("initialProfile: override?.profile === undefined ? sourceData : undefined");
    expect(fork).toContain("initialTools: override?.profile === undefined ? sourceLoop.baselineTools() : undefined");
    expect(fork).toContain(".initializeHistory(historyFromContextPreservingToolNotes(");
    expect(fork).not.toMatch(/swarm|Swarm/);
  });

  test("native timeout accepts the positive maximum timer and has no model-input override", () => {
    const config = read(`${CORE}/features/swarm/configSection.ts`);
    expect(config).toContain("export const SWARM_TIMEOUT_ENV = 'KIMI_CODE_SWARM_TIMEOUT_MS';");
    expect(config).toContain("return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;");
    expect(config).toContain("timeoutMs: { env: SWARM_TIMEOUT_ENV, parse: parseTimeoutMsEnv }");
    const timer = read(`${CORE}/_base/utils/timer.ts`);
    expect(timer).toContain("export const MAX_TIMER_DELAY_MS = 0x7fffffff;");
    expect(timer).toContain("setTimeout(callback, Math.min(timeoutMs, MAX_TIMER_DELAY_MS))");
    const tool = read(`${CORE}/features/swarm/tools/agent-swarm/agentSwarmTool.ts`);
    expect(tool).toContain("const timeoutMs = resolveSwarmTimeoutMs(this.config);");
    expect(tool).toContain("timeout: timeoutMs,");
    const batch = read(`${CORE}/features/swarm/session/agentRunBatch.ts`);
    expect(batch).toContain("task.timeout === undefined || task.timeout <= 0");
    expect(batch).toContain("attempt.controller.abort(new Error('Subagent timed out.'))");
    const defaults = read(`${CORE}/agent/task/printDefaults.ts`);
    expect(defaults).toContain("if (!isUnset(inspected, key)) return;");
    expect(defaults).toContain("PRINT_SWARM_TIMEOUT_MS_DEFAULT = 0");
  });

  test("native cancellation still needs the plugin deadline and quiescence closure", () => {
    const batch = read(`${CORE}/features/swarm/session/agentRunBatch.ts`);
    expect(batch).toContain("this.controller.abort(this.batchSignal?.reason);");
    const abort = read(`${CORE}/_base/utils/abort.ts`);
    expect(section(abort, "export function abortable<T>(", "export function linkAbortSignal(")).toContain("reject(abortReason(signal));");
    const runner = read(`${CORE}/session/subagent/runAgentTurn.ts`);
    if (["2.6.3", "2.7.2"].includes(upstreamVersion())) {
      const completion = section(runner, "async function awaitRunCompletion(", "async function awaitQuiescent(");
      expect(completion).toContain("loop.cancel(undefined, reason);");
      expect(completion).toContain("abortCleanup ??= stopChildTasks(target, loop, reason);");
      expect(completion).toContain("lastResult = await awaitQuiescent(target, loop);");
      const stop = section(runner, "async function stopChildTasks(", "function classifyTurnResult(");
      expect(stop).toContain("loop.suppressTaskNotifications(active.map((task) => task.taskId));");
      expect(stop).toContain("await Promise.all(active.map((task) => tasks.stop(task.taskId, message)));");
    } else {
      expect(runner).toContain("await abortable(loop.retry(), controller.signal)");
    }
    const mirror = read(`${CORE}/session/subagent/mirrorAgentRun.ts`);
    expect(mirror.indexOf("await subagents?.hooks.onWillStartAgentTask.run(")).toBeLessThan(mirror.indexOf("const result = await run.completion;"));
    const hooks = read(`${CORE}/features/externalHooks/session/sessionExternalHooksService.ts`);
    expect(hooks).toContain("subagents.hooks.onWillStartAgentTask.register('externalHooks'");
    expect(hooks).toContain("ctx.signal.throwIfAborted();");
    const external = read(`${CORE}/features/externalHooks/app/externalHooksRunnerService.ts`);
    expect(external).toContain("return this.triggerInner(event, args).catch((error: unknown): HookResult[] => {");
    expect(external).toContain("return Promise.resolve([]);");
  });

  test("detached completion can wake a finished child and must be prevented", () => {
    const version = upstreamVersion();
    const loop = read(version === "2.7.2"
      ? `${CORE_RUNTIME}/loop/loop-actor.ts`
      : `${CORE}/agent/loop/core/loop-actor.ts`);
    const finish = section(loop, "private finishTurn(", "private appendPendingReminders(");
    expect(finish).toContain("if (slot.turnId !== turn.id || slot.detached) continue;");
    expect(finish).toContain("this.phase = this.phase === 'closed' ? 'closed' : 'idle';");
    const completion = section(loop, "private drainDetachedCompletions():", "private deferForCompletion(");
    expect(completion).toContain("type: 'tool.async_ended'");
    expect(completion).toContain(version === "2.7.2"
      ? "this.mailbox.queue([message]);"
      : "this.mailbox.queue([entry]);");
    expect(completion).toContain("if (!this.resetting) this.held = false;");
    expect(completion).toContain("this.schedule();");
    expect(loop).toContain("return this.normal.length > 0 || this.notifyEntries.length > 0;");
    if (version === "2.7.2") {
      const schedule = section(loop, "private canSchedule(): boolean {", "private schedule(): boolean {");
      expect(schedule).toContain("this.phase === 'idle' &&");
      expect(schedule).toContain("!this.held &&");
      expect(schedule).toContain("!this.hasPendingCompletions &&");
      expect(schedule).toContain("(this.mailbox.hasTrigger || this.mailbox.hasReminders)");
    } else {
      expect(loop).toContain("this.phase === 'idle' && !this.held && !this.hasPendingCompletions && this.mailbox.hasTrigger");
    }
    expect(read(`${CORE}/agent/task/taskOutput.ts`)).toContain("source: 'async-tool'");
  });

  test("native TaskStop disablement prevents explicit and timeout-triggered Bash detachment", () => {
    const bash = read(`${CORE}/agent/tools/os/bash/bashTool.ts`);
    const allowed = section(bash, "private allowBackground():", "private autoBackgroundOnTimeout():");
    expect(allowed).toContain("this.toolPolicy.isToolActive('TaskList') &&");
    expect(allowed).toContain("this.toolPolicy.isToolActive('TaskOutput') &&");
    expect(allowed).toContain("this.toolPolicy.isToolActive('TaskStop')");
    expect(bash).toContain("bashAutoBackgroundOnTimeout ?? true");
    expect(bash).toContain("if (this.allowBackground() && this.autoBackgroundOnTimeout() && !detached)");
    expect(bash).toContain("timedOut = true;\n        stopReason = 'Timed out';\n        void proc.kill('SIGTERM')");
    const validate = section(bash, "private validateRunRequest(", "private backgroundStartedResult(");
    expect(validate).toContain("if (args.run_in_background !== true) return undefined;");
    expect(validate).toContain("if (!this.allowBackground())");
    expect(read(`${CORE}/agent/tools/os/bash/bash.ts`)).toContain("export const MAX_TIMEOUT_S = 5 * 60;");
    const config = read(`${CORE}/agent/task/configSection.ts`);
    expect(section(config, "export const taskEnvBindings:", "export const stripTaskEnv")).not.toContain("bashAutoBackgroundOnTimeout");
  });

  test("cold-loaded session policy is shared by every agent and overrides profile tool allowance", () => {
    const policy = read(`${CORE}/session/sessionToolPolicy/sessionToolPolicyService.ts`);
    expect(policy).toContain("const STATE_KEY = 'state.json';");
    expect(policy).toContain("this.scope = sessionContext.scope('tool-policy');");
    expect(policy).toContain("this.ready = this.load();");
    expect(policy).toContain("const stored = await this.store.get<SessionToolPolicyState>(this.scope, STATE_KEY);");
    expect(policy).toContain("this.state = { disabledTools: [...new Set(stored.disabledTools)] };");
    expect(policy).toContain("LifecycleScope.Session,\n  ISessionToolPolicy,");
    const lifecycle = read(`${CORE}/workspace/sessionLifecycle/sessionLifecycleService.ts`);
    expect(lifecycle).toContain("await handle.accessor.get(ISessionToolPolicy).ready;");
    const agentPolicy = read(`${CORE}/agent/toolPolicy/toolPolicyService.ts`);
    expect(section(agentPolicy, "isToolActiveForProfile(", "async setSessionDisabledTools(")).toContain("sessionDisabledTools: this.sessionToolPolicy.disabledTools()");
    expect(read(`${CORE}/agent/toolPolicy/evaluate.ts`)).toContain("isToolActive({ disallowedTools: layers.sessionDisabledTools }, name, source)");
    expect(read(`${CORE}/session/sessionContext/sessionContext.ts`)).toContain("`${sessionScope}/${subKey}`");
    expect(read(`${CORE}/workspace/sessionLifecycle/internal/addressing.ts`)).toContain("return join(homeDir, sessionScopeOf(handlerScope, sessionId));");
    const store = read(`${CORE}/persistence/backends/node-fs/atomicDocumentStore.ts`);
    expect(store).toContain("JSON.parse(textDecoder.decode(bytes))");
    expect(store).toContain("await this.storage.write(scope, key, this.codec.encode(value), { atomic: true });");
    expect(read(`${CORE}/persistence/backends/node-fs/fileStorageService.ts`)).toContain("return join(this.baseDir, scope, key);");
  });

  test("2.7.2 moved retry code preserves per-attempt settlement and cancellation", () => {
    if (upstreamVersion() !== "2.7.2") return;
    const policy = read(`${CORE_RUNTIME}/llm/policy/policy.ts`);
    const settled = policy.indexOf("const result = await settleLlmRequest(resolvedRequest, { signal, onEvent });");
    const retryIndex = policy.indexOf("if (shouldRetry(policy.retry, attempt, result.error, listOf(policy.retryables)))");
    const delayed = policy.indexOf("if (!(await delay(delayMs, signal)))");
    expect(settled).toBeGreaterThan(-1);
    expect(retryIndex).toBeGreaterThan(settled);
    expect(delayed).toBeGreaterThan(retryIndex);
    expect(policy).toContain("return abortedOf(result, signal.reason);");
    expect(policy.indexOf("attempt += 1;")).toBeGreaterThan(delayed);
    const retrySource = read(`${CORE_RUNTIME}/llm/policy/retry.ts`);
    expect(retrySource).toContain("return isRetryableError(error, extras) && attempt < resolveMaxAttempts(options);");
    expect(retrySource).toContain("error.kind === 'syntax' || error.kind === 'abort' || error.kind === 'context_overflow';");
    const settle = read(`${CORE_RUNTIME}/llm/policy/settle.ts`);
    expect(settle).toContain("if (isAbortError(error) || signal.aborted)");
    expect(settle).toContain("return aborted();");
    expect(read(`${CORE_RUNTIME}/llm/policy/credentials.ts`)).toContain(
      "appliedRecoveries.some((record) => record.strategy === 'credentials')",
    );
    const batch = read(`${CORE}/features/swarm/session/agentRunBatch.ts`);
    expect(batch).toContain("this.maxConcurrency !== undefined && this.active.size >= this.maxConcurrency");
    expect(batch).toContain("this.rateLimitCapacity += 1;");
  });

  test("2.7.2 structured errors retain swarm rate-limit classification", () => {
    if (upstreamVersion() !== "2.7.2") return;
    const errors = read(`${CORE}/llm-adapter/contract/errors.ts`);
    expect(errors).toContain("if (error instanceof APIProviderQuotaExhaustedError) return false;");
    expect(errors).toContain("if (error instanceof APIProviderRateLimitError) return true;");
    expect(errors).toContain("if (statusCode !== undefined) return statusCode === 429;");
    const turn = read(`${CORE}/session/subagent/runAgentTurn.ts`);
    const direct = turn.indexOf("if (isProviderRateLimitError(error)) throw error;");
    const converted = turn.indexOf("if (payload.code === ErrorCodes.PROVIDER_RATE_LIMIT)");
    expect(direct).toBeGreaterThan(-1);
    expect(converted).toBeGreaterThan(direct);
    const response = read(`${CORE_RUNTIME}/llm/response.ts`);
    expect(response).toContain("| 'rate_limit'");
    expect(response).toContain("case 'rate_limit':");
    expect(response).toContain("return 'APIProviderRateLimitError';");
    const batch = read(`${CORE}/features/swarm/session/agentRunBatch.ts`);
    expect(batch).toContain("import { isProviderRateLimitError } from '#/llm-adapter/contract/errors';");
    expect(batch).toContain("if (isProviderRateLimitError(error)) {");
  });

  test("2.7.2 host task.background remains outside the model-tool detachment census", () => {
    if (upstreamVersion() !== "2.7.2") return;
    const requests = read(`${KAP}/transport/ws/v1/taskRequests.ts`);
    expect(requests).toContain("const background = taskBackgroundMessageSchema.safeParse(frame);");
    expect(requests).toContain("handler?.detach();");
    expect(read(`${KAP}/transport/ws/v1/registerWsV1.ts`)).toContain("const taskSource = createTaskSource(core);");
  });

  test("other builtin model detachment callers remain the separately denied delegation and question tools", () => {
    // Source census only: managed policy tests must separately prove these
    // three non-Bash callers are denied. External UI/SDK detach is outside
    // the owned, stopped-activation-server print lifecycle.
    expect(filesContaining([`${CORE}/agent/tools`, `${CORE}/features`], /\bdetach\?\.\(/)).toEqual([
      `${CORE}/agent/tools/agent/agentTool.ts`,
      `${CORE}/agent/tools/ask-user-question/askUserQuestionTool.ts`,
      `${CORE}/agent/tools/os/bash/bashTool.ts`,
      `${CORE}/features/tower/tools/spawn/spawnTool.ts`,
    ]);
    expect(read(`${CORE}/features/swarm/tools/agent-swarm/agentSwarmTool.ts`)).toContain("runInBackground: false,");
  });
});
