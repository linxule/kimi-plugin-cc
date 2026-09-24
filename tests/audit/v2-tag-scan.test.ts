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

  test("the plan-file guard is the ONLY final allow in the engine and the CLI", () => {
    const sites = filesContaining([CORE, CLI], ".allow()");
    expect(sites).toEqual([`${CORE}/features/plan/planService.ts`]);
    const guard = read(`${CORE}/features/plan/planService.ts`);
    // The allow must stay gated on an active plan: `if (plan === null) return;`
    // precedes the allow inside guardToolExecution.
    const gateIndex = guard.indexOf("if (plan === null)");
    const allowIndex = guard.indexOf("event.allow()");
    expect(gateIndex).toBeGreaterThan(-1);
    expect(allowIndex).toBeGreaterThan(gateIndex);
  });

  test("plan mode can only be entered from the three audited call sites", () => {
    expect(filesContaining([CORE, CLI, KAP], "new PlanModeEnter(")).toEqual([
      `${CORE}/features/plan/planService.ts`,
    ]);
    const enterCallers = filesContaining([CORE, CLI, KAP], "IAgentPlanService").filter((rel) =>
      read(rel).includes(".enter("),
    );
    expect(enterCallers).toEqual([
      `${CORE}/features/plan/tools/enter-plan-mode/enterPlanModeTool.ts`,
      `${CORE}/workspace/sessionLifecycle/sessionLifecycleService.ts`,
      `${KAP}/routes/sessionAgentConfig.ts`,
    ]);
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
