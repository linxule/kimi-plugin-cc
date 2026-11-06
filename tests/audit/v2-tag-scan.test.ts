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
const CLI = "apps/kimi-code/src";
const KAP = "packages/kap-server/src";
const SDK = "packages/node-sdk/src";

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
};

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
    const sites = filesContaining([CORE, CLI, SDK], ".allow()");
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
    expect(filesContaining([CORE, CLI, KAP, SDK], "new PlanModeEnter(")).toEqual([
      `${CORE}/features/plan/planService.ts`,
    ]);
    const enterCallers = filesContaining([CORE, CLI, KAP, SDK], "IAgentPlanService").filter((rel) =>
      read(rel).includes(".enter("),
    );
    expect(enterCallers).toEqual([
      ...(["2.4.0", "2.4.1", "2.5.0", "2.5.1"].includes(upstreamVersion())
        ? []
        : [`${CORE}/features/plan/tools/enter-plan-mode/enterPlanModeTool.ts`]),
      `${CORE}/workspace/sessionLifecycle/sessionLifecycleService.ts`,
      `${KAP}/routes/sessionAgentConfig.ts`,
    ]);
    if (["2.4.0", "2.4.1", "2.5.0", "2.5.1"].includes(upstreamVersion())) {
      expect(filesContaining([CORE], "EnterPlanMode")).toEqual([]);
    }
  });

  test("2.5 print bootstrap preserves provenance, local-selection, and host-only plan boundaries", () => {
    if (!["2.5.0", "2.5.1"].includes(upstreamVersion())) return;
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

  test("2.5 environment and workspace-trust dependencies are explicitly reviewed", () => {
    if (!["2.5.0", "2.5.1"].includes(upstreamVersion())) return;
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

  test("2.5 WebSocket state proof remains authenticated and bound to the live main agent", () => {
    if (!["2.5.0", "2.5.1"].includes(upstreamVersion())) return;
    const schema = read(`${KAP}/protocol/ws-agent.ts`);
    for (const field of ["session_id", "agent_id", "model", "permission_mode", "plan_mode", "swarm_mode", "tower_mode"]) {
      expect(schema).toContain(field);
    }
    expect(read(`${KAP}/transport/ws/bearerProtocol.ts`)).toContain("kimi-code.bearer.");
    expect(read(`${KAP}/transport/ws/v1/agentState.ts`)).toContain("readAgentState");
    const broadcaster = read(`${KAP}/transport/ws/v1/sessionEventBroadcaster.ts`);
    const snapshot = broadcaster.indexOf("this.sendAgentLists(state, target, transcriptGrades)");
    const transcript = broadcaster.indexOf("await this.subscribeTranscript(state, target, transcriptGrades");
    expect(snapshot).toBeGreaterThan(-1);
    expect(transcript).toBeGreaterThan(snapshot);
    expect(read(`${KAP}/routes/environment.ts`)).toContain("path: '/sessions/{session_id}/environment'");
    const start = read(`${KAP}/start.ts`);
    expect(start).toContain("extractWsBearerToken(req.headers['sec-websocket-protocol'])");
    expect(start).toContain("ok = await validateCredential(candidate)");
    expect(start.indexOf("ok = await validateCredential(candidate)")).toBeLessThan(
      start.indexOf("wss.handleUpgrade(req, socket, head"),
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
    if (["2.4.0", "2.4.1", "2.5.0", "2.5.1"].includes(upstreamVersion())) {
      expect(runner).toContain("plan.cancel();");
      expect(runner).toContain("await notePlanMode(agent, opts.session);");
      expect(runner).toContain("default_plan_mode is not applied in print mode");
    }
  });

  test("every tool execution passes the single before-execute emitter", () => {
    const callers = filesContaining([CORE], "fireBeforeExecute(");
    expect(callers).toEqual([
      `${CORE}/agent/toolExecutor/beforeToolExecuteEvent.ts`,
      `${CORE}/agent/toolExecutor/toolExecutorService.ts`,
    ]);
  });

  test("the before-execute subscriber population is exactly the audited set", () => {
    expect(filesContaining([CORE], "onBeforeExecuteTool(")).toEqual(
      EXPECTED_BEFORE_EXECUTE_SUBSCRIBERS,
    );
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
    if (["2.5.0", "2.5.1"].includes(upstreamVersion())) {
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
      expect(chains).toContain("restorable: restorableChain(entries, tree).map(({ record }) => record)");
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
      [CORE, CLI, KAP],
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
