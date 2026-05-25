import { describe, expect, test } from "bun:test";

import { assertCliResultSuccess, reassembleProseFromRecords } from "../../runtime/commands/cli-helpers.js";
import { RuntimeError } from "../../runtime/errors.js";
import type { CliClientResult } from "../../runtime/cli-client.js";
import type { StreamJsonRecord } from "../../runtime/stream-json.js";

describe("reassembleProseFromRecords", () => {
  test("concatenates assistant content in order", () => {
    const records: StreamJsonRecord[] = [
      { role: "assistant", content: "Hello, " },
      { role: "assistant", content: "world." },
    ];
    expect(reassembleProseFromRecords(records)).toBe("Hello, world.");
  });

  test("skips tool result records", () => {
    const records: StreamJsonRecord[] = [
      { role: "assistant", content: "Reading file. " },
      { role: "tool", tool_call_id: "abc", content: "<file contents>" },
      { role: "assistant", content: "Done." },
    ];
    expect(reassembleProseFromRecords(records)).toBe("Reading file. Done.");
  });

  test("skips assistant records that are tool_calls without content", () => {
    const records: StreamJsonRecord[] = [
      { role: "assistant", content: "Checking. " },
      {
        role: "assistant",
        tool_calls: [
          { type: "function", id: "x", function: { name: "Read", arguments: "{}" } },
        ],
      },
      { role: "assistant", content: "Done." },
    ];
    expect(reassembleProseFromRecords(records)).toBe("Checking. Done.");
  });

  test("returns empty string for empty input", () => {
    expect(reassembleProseFromRecords([])).toBe("");
  });

  test("preserves whitespace within content fragments", () => {
    const records: StreamJsonRecord[] = [
      { role: "assistant", content: "Line one\n" },
      { role: "assistant", content: "Line two\n\n" },
      { role: "assistant", content: "  indented" },
    ];
    expect(reassembleProseFromRecords(records)).toBe("Line one\nLine two\n\n  indented");
  });

  test("fragmented JSON across multiple assistant records reassembles to parseable JSON", () => {
    // review_gate parses the concatenated finalText as JSON. If kimi
    // streams the JSON across multiple records (token-by-token), the
    // helper must concatenate them WITHOUT introducing separators so
    // the resulting string is still valid JSON. Regression test for
    // the Codex finding (reports/18-pr2-codex-adversarial.md).
    const records: StreamJsonRecord[] = [
      { role: "assistant", content: '{"decision":"' },
      { role: "assistant", content: 'BLOCK","confidence":"high",' },
      { role: "assistant", content: '"summary":"reassembled across fragments",' },
      { role: "assistant", content: '"issues":[]}' },
    ];
    const reassembled = reassembleProseFromRecords(records);
    expect(() => JSON.parse(reassembled)).not.toThrow();
    const parsed = JSON.parse(reassembled) as { decision: string; summary: string };
    expect(parsed.decision).toBe("BLOCK");
    expect(parsed.summary).toBe("reassembled across fragments");
  });
});

describe("assertCliResultSuccess", () => {
  function makeResult(overrides: Partial<CliClientResult>): CliClientResult {
    return {
      sessionId: undefined,
      records: [],
      malformed: [],
      stderrTail: "",
      exitCode: 0,
      signal: null,
      aborted: false,
      ...overrides,
    };
  }

  test("returns normally on exit 0, non-aborted", () => {
    expect(() => assertCliResultSuccess(makeResult({}), "ask.runtime")).not.toThrow();
  });

  test("throws CLI_ABORTED when aborted", () => {
    try {
      assertCliResultSuccess(makeResult({ aborted: true, exitCode: 143, signal: "SIGTERM" }), "ask.runtime");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeError);
      const re = err as RuntimeError;
      expect(re.code).toBe("CLI_ABORTED");
      expect(re.stage).toBe("ask.runtime");
      expect(re.details.signal).toBe("SIGTERM");
    }
  });

  test("throws CLI_NONZERO_EXIT on non-zero exit code", () => {
    try {
      assertCliResultSuccess(makeResult({ exitCode: 1, stderrTail: "Error: kimi failed" }), "review.runtime");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeError);
      const re = err as RuntimeError;
      expect(re.code).toBe("CLI_NONZERO_EXIT");
      expect(re.stage).toBe("review.runtime");
      expect(re.message).toContain("exited with code 1");
      expect(re.message).toContain("Error: kimi failed");
    }
  });

  test("CLI_NONZERO_EXIT message handles empty stderr gracefully", () => {
    try {
      assertCliResultSuccess(makeResult({ exitCode: 2 }), "challenge.runtime");
      throw new Error("should have thrown");
    } catch (err) {
      const re = err as RuntimeError;
      expect(re.message).toContain("exited with code 2");
      expect(re.message.endsWith(".")).toBe(true);
    }
  });

  test("CLI_NONZERO_EXIT details capture record/malformed counts", () => {
    const result = makeResult({
      exitCode: 1,
      records: [{ role: "assistant", content: "partial" }],
      malformed: [{ line: "bad", reason: "json parse" }],
    });
    try {
      assertCliResultSuccess(result, "ask.runtime");
      throw new Error("should have thrown");
    } catch (err) {
      const re = err as RuntimeError;
      expect(re.details.record_count).toBe(1);
      expect(re.details.malformed_count).toBe(1);
    }
  });

  test("aborted check beats non-zero exit check (cancellation surfaced first)", () => {
    try {
      assertCliResultSuccess(makeResult({ aborted: true, exitCode: 143 }), "ask.runtime");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as RuntimeError).code).toBe("CLI_ABORTED");
    }
  });
});
