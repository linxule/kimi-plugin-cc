import { describe, expect, test } from "bun:test";

import {
  StreamJsonParser,
  extractSessionIdFromStderr,
  type AssistantRecord,
  type ToolResultRecord,
} from "../../runtime/stream-json.js";

describe("StreamJsonParser", () => {
  test("parses a single assistant content record", () => {
    const parser = new StreamJsonParser();
    const outcomes = parser.push('{"role":"assistant","content":"hello"}\n');
    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    expect(outcome).toBeDefined();
    expect(outcome!.malformedLine).toBeUndefined();
    expect(outcome!.record).toEqual({ role: "assistant", content: "hello" });
  });

  test("parses an assistant record with tool_calls", () => {
    const parser = new StreamJsonParser();
    const line =
      '{"role":"assistant","content":"running","tool_calls":[{"type":"function","id":"call_1","function":{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}\n';
    const [outcome] = parser.push(line);
    expect(outcome).toBeDefined();
    expect(outcome!.malformedLine).toBeUndefined();
    const record = outcome!.record as AssistantRecord;
    expect(record.role).toBe("assistant");
    expect(record.content).toBe("running");
    expect(record.tool_calls).toHaveLength(1);
    expect(record.tool_calls?.[0]).toEqual({
      type: "function",
      id: "call_1",
      function: { name: "Bash", arguments: '{"command":"ls"}' },
    });
  });

  test("parses a tool result record", () => {
    const parser = new StreamJsonParser();
    const [outcome] = parser.push(
      '{"role":"tool","tool_call_id":"call_1","content":"file1\\nfile2"}\n',
    );
    expect(outcome).toBeDefined();
    const record = outcome!.record as ToolResultRecord;
    expect(record).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "file1\nfile2",
    });
  });

  test("buffers a partial line across two pushes", () => {
    const parser = new StreamJsonParser();
    const first = parser.push('{"role":"assistant","content":"hel');
    expect(first).toEqual([]);
    const second = parser.push('lo"}\n');
    expect(second).toHaveLength(1);
    expect(second[0]!.record).toEqual({ role: "assistant", content: "hello" });
  });

  test("emits multiple records from one chunk with multiple newlines", () => {
    const parser = new StreamJsonParser();
    const chunk =
      '{"role":"assistant","content":"a"}\n' +
      '{"role":"assistant","content":"b"}\n' +
      '{"role":"tool","tool_call_id":"c1","content":"ok"}\n';
    const outcomes = parser.push(chunk);
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((o) => o.malformedLine === undefined)).toBe(true);
    expect((outcomes[0]!.record as AssistantRecord).content).toBe("a");
    expect((outcomes[1]!.record as AssistantRecord).content).toBe("b");
    expect((outcomes[2]!.record as ToolResultRecord).tool_call_id).toBe("c1");
  });

  test("reports malformed JSON as a structured outcome, no throw", () => {
    const parser = new StreamJsonParser();
    const outcomes = parser.push('not-json\n');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.record).toBeUndefined();
    expect(outcomes[0]!.malformedLine).toBe("not-json");
    expect(outcomes[0]!.malformedReason).toContain("json parse");
  });

  test("reports unknown role as malformed", () => {
    const parser = new StreamJsonParser();
    const [outcome] = parser.push('{"role":"system","content":"x"}\n');
    expect(outcome!.malformedReason).toContain("unknown role");
    expect(outcome!.malformedLine).toBe('{"role":"system","content":"x"}');
  });

  test("reports assistant with neither content nor tool_calls as malformed", () => {
    const parser = new StreamJsonParser();
    const [outcome] = parser.push('{"role":"assistant"}\n');
    expect(outcome!.malformedReason).toContain("neither content nor tool_calls");
  });

  test("reports assistant with empty tool_calls array as malformed", () => {
    const parser = new StreamJsonParser();
    const [outcome] = parser.push('{"role":"assistant","tool_calls":[]}\n');
    expect(outcome!.malformedReason).toContain("neither content nor tool_calls");
  });

  test("reports assistant.content of wrong type as malformed", () => {
    const parser = new StreamJsonParser();
    const [outcome] = parser.push('{"role":"assistant","content":123}\n');
    expect(outcome!.malformedReason).toContain("content not string");
  });

  test("reports tool_call missing required fields as malformed", () => {
    const parser = new StreamJsonParser();
    const [outcome] = parser.push(
      '{"role":"assistant","content":"x","tool_calls":[{"type":"function","id":"c","function":{"name":"Bash"}}]}\n',
    );
    // Missing function.arguments
    expect(outcome!.malformedReason).toContain("tool_calls entry invalid");
  });

  test("reports tool record missing tool_call_id as malformed", () => {
    const parser = new StreamJsonParser();
    const [outcome] = parser.push('{"role":"tool","content":"x"}\n');
    expect(outcome!.malformedReason).toContain("tool_call_id");
  });

  test("reports tool record with non-string content as malformed", () => {
    const parser = new StreamJsonParser();
    const [outcome] = parser.push(
      '{"role":"tool","tool_call_id":"c","content":42}\n',
    );
    expect(outcome!.malformedReason).toContain("content not string");
  });

  test("skips blank lines silently", () => {
    const parser = new StreamJsonParser();
    const outcomes = parser.push("\n\n\n");
    expect(outcomes).toEqual([]);
  });

  test("tolerates CRLF line endings", () => {
    const parser = new StreamJsonParser();
    const outcomes = parser.push('{"role":"assistant","content":"hi"}\r\n');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.record).toEqual({ role: "assistant", content: "hi" });
  });

  test("flush returns the unterminated trailing line", () => {
    const parser = new StreamJsonParser();
    const pushed = parser.push('{"role":"assistant","content":"trailing"}');
    expect(pushed).toEqual([]);
    const flushed = parser.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.record).toEqual({ role: "assistant", content: "trailing" });
  });

  test("flush returns empty when buffer is empty", () => {
    const parser = new StreamJsonParser();
    expect(parser.flush()).toEqual([]);
  });

  test("flush returns empty when buffer holds only CR/whitespace remnants", () => {
    const parser = new StreamJsonParser();
    parser.push("\r");
    expect(parser.flush()).toEqual([]);
  });

  test("accepts Buffer input", () => {
    const parser = new StreamJsonParser();
    const outcomes = parser.push(Buffer.from('{"role":"assistant","content":"b"}\n', "utf8"));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.record).toEqual({ role: "assistant", content: "b" });
  });

  test("handles a kimi-code-shaped multi-step sequence", () => {
    // Simulates one assistant message with a tool_call, the tool result, then
    // a final assistant content message — the shape v0.4 commands need to
    // reconstruct prose from.
    const parser = new StreamJsonParser();
    const sequence =
      '{"role":"assistant","content":"Let me check.","tool_calls":[{"type":"function","id":"call_a","function":{"name":"Read","arguments":"{\\"file_path\\":\\"/x\\"}"}}]}\n' +
      '{"role":"tool","tool_call_id":"call_a","content":"file contents"}\n' +
      '{"role":"assistant","content":"Final answer."}\n';
    const outcomes = parser.push(sequence);
    expect(outcomes).toHaveLength(3);
    expect((outcomes[0]!.record as AssistantRecord).tool_calls?.[0]?.function.name).toBe("Read");
    expect((outcomes[1]!.record as ToolResultRecord).content).toBe("file contents");
    expect((outcomes[2]!.record as AssistantRecord).content).toBe("Final answer.");
  });
});

describe("extractSessionIdFromStderr", () => {
  test("captures the session id from the canonical announce line", () => {
    const stderr =
      "Some warning blah\nTo resume this session: kimi -r 26242650-d95f-4805-80d9-c947d309b2c6\nmore stderr\n";
    expect(extractSessionIdFromStderr(stderr)).toBe("26242650-d95f-4805-80d9-c947d309b2c6");
  });

  test("returns undefined when stderr lacks the announce line", () => {
    expect(extractSessionIdFromStderr("error: model unavailable\n")).toBeUndefined();
  });

  test("returns undefined for empty stderr", () => {
    expect(extractSessionIdFromStderr("")).toBeUndefined();
  });

  test("captures even when the announce line is the only content", () => {
    expect(extractSessionIdFromStderr("To resume this session: kimi -r abcdef01234567\n")).toBe(
      "abcdef01234567",
    );
  });

  test("ignores commentary appearing after the session id", () => {
    const stderr =
      "To resume this session: kimi -r deadbeef-cafe-1234-5678-90abcdef0000 (latest)\n";
    expect(extractSessionIdFromStderr(stderr)).toBe(
      "deadbeef-cafe-1234-5678-90abcdef0000",
    );
  });
});
