import { describe, expect, test } from "bun:test";

import {
  MAX_STREAM_JSON_LINE_BYTES,
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

  test("H3: an unknown string role is forward-compat (unknownRecord, NOT malformed)", () => {
    const parser = new StreamJsonParser();
    const [outcome] = parser.push('{"role":"system","content":"x"}\n');
    // Tolerated as a future-role record, surfaced out-of-band — not malformed,
    // not in records[].
    expect(outcome!.malformedLine).toBeUndefined();
    expect(outcome!.record).toBeUndefined();
    expect(outcome!.unknownRecord).toEqual({
      role: "system",
      raw: { role: "system", content: "x" },
    });
  });

  test("H3: a role-less line that isn't goal.summary is still malformed", () => {
    const parser = new StreamJsonParser();
    const [outcome] = parser.push('{"content":"x"}\n');
    expect(outcome!.unknownRecord).toBeUndefined();
    expect(outcome!.malformedReason).toContain("unknown role");
  });

  test("H3: a non-string role is still malformed (not forward-compat)", () => {
    const parser = new StreamJsonParser();
    const [outcome] = parser.push('{"role":123,"content":"x"}\n');
    expect(outcome!.unknownRecord).toBeUndefined();
    expect(outcome!.malformedReason).toContain("unknown role");
  });

  test("parses the kimi 0.23.5 turn.step.retrying meta record", () => {
    // Exact PromptJsonRetryMetaMessage fixture from upstream's 0.23.5
    // apps/kimi-code/test/cli/run-prompt.test.ts coverage.
    const parser = new StreamJsonParser();
    const line = JSON.stringify({
      role: "meta",
      type: "turn.step.retrying",
      failed_attempt: 1,
      next_attempt: 2,
      max_attempts: 3,
      delay_ms: 300,
      error_name: "APIProviderRateLimitError",
      error_message: "llmproxy/openai/responses/resp_abc.json status_code=429",
      status_code: 429,
    });
    const [outcome] = parser.push(`${line}\n`);
    expect(outcome!.malformedLine).toBeUndefined();
    expect(outcome!.record).toEqual({
      role: "meta",
      type: "turn.step.retrying",
      failedAttempt: 1,
      nextAttempt: 2,
      maxAttempts: 3,
      delayMs: 300,
      errorName: "APIProviderRateLimitError",
      errorMessage: "llmproxy/openai/responses/resp_abc.json status_code=429",
      statusCode: 429,
    });
  });

  test.each([
    ["failed_attempt", "1"],
    ["next_attempt", null],
    ["max_attempts", undefined],
    ["delay_ms", Number.POSITIVE_INFINITY],
    ["error_name", 429],
    ["error_message", false],
    ["status_code", "429"],
  ] as const)("rejects malformed retry metadata field %s", (field, value) => {
    const retry: Record<string, unknown> = {
      role: "meta",
      type: "turn.step.retrying",
      failed_attempt: 1,
      next_attempt: 2,
      max_attempts: 3,
      delay_ms: 300,
      error_name: "APIProviderRateLimitError",
      error_message: "rate limited",
      status_code: 429,
    };
    retry[field] = value;

    const [outcome] = new StreamJsonParser().push(`${JSON.stringify(retry)}\n`);
    expect(outcome?.record).toBeUndefined();
    expect(outcome?.malformedReason).toBe("meta.turn.step.retrying field has unexpected type");
  });

  test("parses the kimi 0.2.0 session.resume_hint meta record", () => {
    // PR #47 (07ed2cf) moved the resume hint from stderr to a stream-json
    // meta record on stdout. The session_id token uses kimi 0.2.0's
    // `session_<uuid>` shape — round-trip it verbatim.
    const parser = new StreamJsonParser();
    const line = JSON.stringify({
      role: "meta",
      type: "session.resume_hint",
      session_id: "session_233450b2-f558-499b-b133-bd4d5650d583",
      command: "kimi -r session_233450b2-f558-499b-b133-bd4d5650d583",
      content: "To resume this session: kimi -r session_233450b2-f558-499b-b133-bd4d5650d583",
    });
    const [outcome] = parser.push(`${line}\n`);
    expect(outcome!.record).toEqual({
      role: "meta",
      type: "session.resume_hint",
      sessionId: "session_233450b2-f558-499b-b133-bd4d5650d583",
    });
  });

  test("reports meta.session.resume_hint with missing session_id as malformed", () => {
    const parser = new StreamJsonParser();
    const [outcome] = parser.push(
      '{"role":"meta","type":"session.resume_hint","command":"kimi -r x","content":"y"}\n',
    );
    expect(outcome!.malformedReason).toContain("session_id not non-empty string");
  });

  test("reports unknown meta.type as malformed without crashing", () => {
    // Forward-compat: kimi-code may add new meta types in 0.3.x; the
    // parser should surface them through the malformed channel for
    // diagnostics, not throw.
    const parser = new StreamJsonParser();
    const [outcome] = parser.push(
      '{"role":"meta","type":"some.future.thing","payload":1}\n',
    );
    expect(outcome!.malformedReason).toContain("unknown meta.type");
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

  test("emits malformed on line exceeding MAX_STREAM_JSON_LINE_BYTES", () => {
    const parser = new StreamJsonParser();
    const oversized = "x".repeat(MAX_STREAM_JSON_LINE_BYTES + 1);
    const malformed = parser.push(oversized);
    expect(malformed).toHaveLength(1);
    expect(malformed[0]!.record).toBeUndefined();
    expect(malformed[0]!.malformedReason).toContain("exceeded");
    expect(malformed[0]!.malformedLine).toBe(`${"x".repeat(200)}[truncated]`);

    const valid = parser.push('{"role":"assistant","content":"after"}\n');
    expect(valid).toHaveLength(1);
    expect(valid[0]!.record).toEqual({ role: "assistant", content: "after" });
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

  test("captures a full UUID when the announce line is the only content", () => {
    expect(
      extractSessionIdFromStderr(
        "To resume this session: kimi -r abcdef01-2345-6789-abcd-ef0123456789\n",
      ),
    ).toBe("abcdef01-2345-6789-abcd-ef0123456789");
  });

  test("captures the 0.2.0+ session_<uuid> token shape from stderr fallback", () => {
    // kimi-code 0.2.0 emits the resume hint as a stream-json meta record
    // on stdout when --output-format is stream-json, so the stderr path
    // is a 0.1.x fallback. But if a user runs in text-output mode (or a
    // future version re-introduces stderr emission with the new token
    // shape), the regex should still capture.
    expect(
      extractSessionIdFromStderr(
        "To resume this session: kimi -r session_233450b2-f558-499b-b133-bd4d5650d583\n",
      ),
    ).toBe("session_233450b2-f558-499b-b133-bd4d5650d583");
  });

  test("rejects malformed session_-prefixed tokens that aren't full UUIDs", () => {
    // Review-smoke (kimi 0.2.0 review against alpha.5 candidate) caught
    // the previous loose pattern `session_[0-9a-f-]{8,}` which would
    // accept `session_--------` (8 dashes), `session_aaaaaaaa` (too
    // short to be a UUID), or arbitrarily long noise. The tightened
    // pattern anchors session_<uuid> to a full UUID shape exactly like
    // the bare-UUID branch.
    for (const malformed of [
      "To resume this session: kimi -r session_--------\n",
      "To resume this session: kimi -r session_aaaaaaaa\n",
      "To resume this session: kimi -r session_deadbeef-cafe-1234-5678-90abcdef000\n", // last group too short
      "To resume this session: kimi -r session_deadbeefcafe12345678-90abcdef0000\n", // missing dashes
      "To resume this session: kimi -r session_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx\n", // non-hex
    ]) {
      expect(extractSessionIdFromStderr(malformed)).toBeUndefined();
    }
  });

  test("rejects commentary appearing after the session id", () => {
    const stderr =
      "To resume this session: kimi -r deadbeef-cafe-1234-5678-90abcdef0000 (latest)\n";
    expect(extractSessionIdFromStderr(stderr)).toBeUndefined();
  });

  test("rejects mid-line and unanchored announce matches", () => {
    expect(
      extractSessionIdFromStderr(
        "prefix To resume this session: kimi -r deadbeef-cafe-1234-5678-90abcdef0000\n",
      ),
    ).toBeUndefined();
    expect(
      extractSessionIdFromStderr(
        "To resume this session: kimi -r deadbeef-cafe-1234-5678-90abcdef0000 suffix\n",
      ),
    ).toBeUndefined();
  });

  test("requires full UUID shape", () => {
    expect(extractSessionIdFromStderr("To resume this session: kimi -r abcdef01234567\n")).toBeUndefined();
    expect(
      extractSessionIdFromStderr("To resume this session: kimi -r deadbeef-cafe-1234-5678-90abcdef000\n"),
    ).toBeUndefined();
  });

  test("requires the announce text at the start of a line", () => {
    expect(
      extractSessionIdFromStderr(
        "warning: To resume this session: kimi -r deadbeef-cafe-1234-5678-90abcdef0000\n",
      ),
    ).toBeUndefined();
  });

  test("returns the first canonical session id when stderr contains multiple announces", () => {
    const stderr =
      "To resume this session: kimi -r 11111111-1111-1111-1111-111111111111\n" +
      "To resume this session: kimi -r 22222222-2222-2222-2222-222222222222\n";
    expect(extractSessionIdFromStderr(stderr)).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
  });
});

describe("goal.summary record (kimi-code 0.8.0+ headless goal mode)", () => {
  const COMPLETE_LINE =
    '{"type":"goal.summary","goalId":"goal_abc","status":"complete","reason":null,' +
    '"turnsUsed":4,"tokensUsed":1200,"wallClockMs":53000}\n';

  test("a complete goal.summary surfaces on the goalSummary channel, not record/malformed", () => {
    const parser = new StreamJsonParser();
    const [outcome] = parser.push(COMPLETE_LINE);
    expect(outcome).toBeDefined();
    expect(outcome!.malformedLine).toBeUndefined();
    expect(outcome!.record).toBeUndefined();
    expect(outcome!.goalSummary).toEqual({
      type: "goal.summary",
      goalId: "goal_abc",
      status: "complete",
      reason: null,
      turnsUsed: 4,
      tokensUsed: 1200,
      wallClockMs: 53000,
    });
  });

  test("a blocked goal.summary carries terminalReason and is not malformed", () => {
    const parser = new StreamJsonParser();
    const [outcome] = parser.push(
      '{"type":"goal.summary","goalId":"goal_x","status":"blocked",' +
        '"reason":"A configured budget was reached","turnsUsed":12,"tokensUsed":99,"wallClockMs":1}\n',
    );
    expect(outcome!.goalSummary?.status).toBe("blocked");
    expect(outcome!.goalSummary?.reason).toBe("A configured budget was reached");
  });

  test("an all-null goal.summary (no goal snapshot) is accepted", () => {
    const parser = new StreamJsonParser();
    const [outcome] = parser.push(
      '{"type":"goal.summary","goalId":null,"status":null,"reason":null,' +
        '"turnsUsed":null,"tokensUsed":null,"wallClockMs":null}\n',
    );
    expect(outcome!.malformedLine).toBeUndefined();
    expect(outcome!.goalSummary).toEqual({
      type: "goal.summary",
      goalId: null,
      status: null,
      reason: null,
      turnsUsed: null,
      tokensUsed: null,
      wallClockMs: null,
    });
  });

  test("a goal.summary with a wrong-typed field is malformed (shape drift surfaces, not silently coerced)", () => {
    const parser = new StreamJsonParser();
    const [outcome] = parser.push(
      '{"type":"goal.summary","goalId":"g","status":"complete","reason":null,' +
        '"turnsUsed":"four","tokensUsed":1,"wallClockMs":1}\n',
    );
    expect(outcome!.goalSummary).toBeUndefined();
    expect(outcome!.malformedLine).toBeDefined();
    expect(outcome!.malformedReason).toContain("goal.summary");
  });

  test("the goal.summary then session.resume_hint ordering both parse on their own channels", () => {
    const parser = new StreamJsonParser();
    const outcomes = parser.push(
      COMPLETE_LINE +
        '{"role":"meta","type":"session.resume_hint","session_id":"session_dead",' +
        '"command":"kimi -r session_dead","content":"To resume this session: kimi -r session_dead"}\n',
    );
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]!.goalSummary?.goalId).toBe("goal_abc");
    expect(outcomes[1]!.record).toEqual({
      role: "meta",
      type: "session.resume_hint",
      sessionId: "session_dead",
    });
  });
});
