// Offline counterexamples for D2/D3 in docs/subscription-switching-spec.md.
// Hash-pinned source extraction with synthetic events; not a lifecycle certification.
import assert from "node:assert/strict";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { selectPinnedDeclarations, transpileProbe } from "./audit-source.js";

const root = process.argv[2];
if (!root || process.argv.length !== 3) {
  throw new Error("Usage: bun scripts/audit-subscription-recovery.ts <exact-2.0.1-source-directory>");
}

const select = (file: string, hash: string, names: string[]) =>
  selectPinnedDeclarations(path.join(root, file), hash, names);

const code = [
  await select("apps/kimi-code/src/cli/v2/run-v2-print.ts", "3ea99b7615abe152cb040c78b77d2a5b9e990ffd8d53703ac34226dc179de95d", ["dispatchNativeEvent"]),
  await select("apps/kimi-code/src/cli/prompt-render.ts", "d413a0678dcebb5a0a6f9dda8ce51d53e4b70d55b162afe6635a7d8c1a1536c4", ["PromptJsonWriter"]),
  await select("packages/agent-core-v2/src/human/llm-kimi/errors.ts", "82c62cef8d5c467c0886076fdbbab1ece30dfa328e07e48a78da50ec4edd4a11", [
    "KIMI_QUOTA_EXHAUSTED_ERROR_CODES", "KIMI_QUOTA_EXHAUSTED_MESSAGE_PATTERNS",
    "readStringProp", "readErrorObjectProp", "collectErrorCodes", "classifyKimiQuotaError",
  ]),
  await select("packages/agent-core-v2/src/agent/contextMemory/vacuousContent.ts", "43e8022d837c236727592bc5ff8b99f14001a08755a33028f4878e7d488e6ed0", ["isVacuousContentPart"]),
  await select("packages/agent-core-v2/src/agent/contextMemory/loopEventFold.ts", "818a656daddf7fbb58a516ff4b1691c9081630beb119ddd2d2b819cce7d173e1", ["createLoopEventFold", "createLoopEventFoldWithState"]),
  `
  const lines = [];
  const writer = new PromptJsonWriter({ write: text => { lines.push(text); return true; } });
  const stderr = { write: () => { throw new Error("Unexpected stderr in synthetic probe"); } };
  dispatchNativeEvent(writer, { type: "assistant.delta", delta: "partial failed answer" }, stderr);
  dispatchNativeEvent(writer, { type: "turn.ended", reason: "failed", turnId: 3,
    error: { code: "provider.quota_exhausted" } }, stderr);
  assert.equal(lines.length, 0, "turn.ended must reproduce the missing terminal event");
  writer.finish();
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).content, "partial failed answer");

  const quotaCases = [
    { name: "structured quota", input: { status: 429, error: { type: "exceeded_current_quota_error" } }, expected: "quota_exhausted" },
    { name: "generic 429", input: { status: 429, message: "Too many requests" }, expected: null },
    { name: "wording only", input: { status: 429, message: "Please recharge your account" }, expected: "quota_exhausted" },
    { name: "non-429 quota wording", input: { status: 403, message: "Please recharge your account" }, expected: null },
  ].map(test => {
    const output = classifyKimiQuotaError(test.input);
    assert.equal(output?.kind ?? null, test.expected);
    if (output !== undefined) {
      for (const key of ["scope", "region", "sessionId", "turnId", "continuation"]) {
        assert.equal(Object.hasOwn(output, key), false);
      }
    }
    return { name: test.name, kind: output?.kind ?? null };
  });

  function probeFold(text) {
    const events = [];
    const unexpected = () => { throw new Error("Unexpected tool/message branch in text-only fold probe"); };
    const fold = createLoopEventFold({
      openAssistant: () => events.push("open"),
      appendOpenContent: part => events.push("content:" + part.text),
      sealOpenAssistant: () => events.push("seal"),
      dropOpenAssistant: () => events.push("drop"),
      appendOpenToolCall: unexpected, pushToolMessage: unexpected, pushMessage: unexpected,
    });
    fold.loopEvent({ type: "step.begin", uuid: "synthetic-step" });
    fold.loopEvent({ type: "content.part", stepUuid: "synthetic-step", part: { type: "text", text } });
    fold.loopEvent({ type: "step.end", uuid: "synthetic-step", finishReason: "error" });
    assert.equal(events.length, 2, "error ending leaves the assistant open");
    fold.settle();
    return events;
  }
  const nonemptyFold = probeFold("partial failed answer");
  const emptyFold = probeFold("   ");
  assert.equal(nonemptyFold.at(-1), "seal");
  assert.equal(emptyFold.at(-1), "drop");
  globalThis.result = {
    terminalEventEmitted: false,
    finishFlushesFailedPartialText: true,
    quotaCases,
    failedTextFold: { nonempty: nonemptyFold, emptyControl: emptyFold },
  };
  `,
].join("\n");

const sandbox: { assert: typeof assert; parseRetryAfterMs: () => null; headersToRecord: () => null; result?: unknown } = {
  assert,
  // No headers in synthetic errors. These dependency stubs make no claims about
  // reset times or header parsing, which are outside this classification probe.
  parseRetryAfterMs: () => null,
  headersToRecord: () => null,
};
runInNewContext(transpileProbe(code), sandbox, { timeout: 1_000 });
assert.ok(sandbox.result);
console.log(JSON.stringify({
  upstream: "2.0.1", commit: "caf7d4e2fef06967280b325da06e44a4b0516eba",
  result: "D2_D3_BLOCKED", probes: sandbox.result,
  limitation: "Pure-function counterexamples with synthetic events and header stubs; no HTTP, credentials, session files, full turn recovery, or concurrency execution. Exit zero means the documented blockers reproduced, not that switching is supported.",
}, null, 2));
