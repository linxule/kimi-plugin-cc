import { describe, expect, test } from "bun:test";

import { retryIncompleteCapture } from "../../runtime/process-tree.js";

// A process snapshot that overlaps a process exit can come back incomplete on
// Linux (a row read in mid-release). One incomplete capture used to make a
// clean web shutdown unverifiable; the capture is now looked at again.
describe("retryIncompleteCapture", () => {
  function scripted<T>(results: T[]) {
    let calls = 0;
    return { capture: async () => results[Math.min(calls++, results.length - 1)]!, calls: () => calls };
  }

  test("a complete first capture is not repeated", async () => {
    const run = scripted([{ complete: true, tag: "first" }]);
    expect(await retryIncompleteCapture(run.capture, [0, 0])).toEqual({ complete: true, tag: "first" });
    expect(run.calls()).toBe(1);
  });

  test("an incomplete capture is retried and the complete retry wins", async () => {
    const run = scripted([{ complete: false, tag: "mid-exit" }, { complete: true, tag: "gone" }]);
    expect(await retryIncompleteCapture(run.capture, [0, 0])).toEqual({ complete: true, tag: "gone" });
    expect(run.calls()).toBe(2);
  });

  test("a capture that stays incomplete still fails, after every retry", async () => {
    const run = scripted([{ complete: false, tag: "unreadable" }]);
    expect(await retryIncompleteCapture(run.capture, [0, 0])).toEqual({ complete: false, tag: "unreadable" });
    expect(run.calls()).toBe(3);
  });

  test("a timed-out capture is not retried", async () => {
    const run = scripted([{ complete: false, timedOut: true }, { complete: true }]);
    expect(await retryIncompleteCapture(run.capture, [0, 0])).toEqual({ complete: false, timedOut: true });
    expect(run.calls()).toBe(1);
  });
});
