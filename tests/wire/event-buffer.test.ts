import { describe, expect, test } from "bun:test";

import { TurnEventBuffer } from "../../runtime/wire/event-buffer.js";

describe("TurnEventBuffer", () => {
  test("collects text parts per step and commits on TurnEnd", () => {
    const buffer = new TurnEventBuffer();

    buffer.observeEvent("TurnBegin", { user_input: "hello" });
    buffer.observeEvent("StepBegin", { n: 1 });
    buffer.observeEvent("ContentPart", { type: "text", text: "Hello " });
    buffer.observeEvent("ContentPart", { type: "think", think: "hidden" });
    buffer.observeEvent("StepBegin", { n: 2 });
    buffer.observeEvent("ContentPart", { type: "text", text: "world" });
    buffer.observeEvent("TurnEnd", {});

    const completed = buffer.finalize({ status: "finished" });

    expect(completed.finalText).toBe("Hello world");
    expect(completed.steps).toEqual([
      { step: 0, textParts: [] },
      { step: 1, textParts: ["Hello "] },
      { step: 2, textParts: ["world"] },
    ]);
  });

  test("commits only text after the last ToolResult", () => {
    const buffer = new TurnEventBuffer();

    buffer.observeEvent("StepBegin", { n: 1 });
    buffer.observeEvent("ContentPart", { type: "text", text: "intermediate text " });
    buffer.observeEvent("ToolResult", {
      tool_call_id: "tool-1",
      return_value: { is_error: false, output: "", message: "", display: [] },
    });
    buffer.observeEvent("StepBegin", { n: 2 });
    buffer.observeEvent("ContentPart", { type: "text", text: "{\"summary\":\"final only\"}" });
    buffer.observeEvent("TurnEnd", {});

    const completed = buffer.finalize({ status: "finished" });

    expect(completed.finalText).toBe("{\"summary\":\"final only\"}");
    expect(completed.steps).toEqual([
      { step: 0, textParts: [] },
      { step: 1, textParts: ["intermediate text "] },
      { step: 2, textParts: ["{\"summary\":\"final only\"}"] },
    ]);
  });

  test("commits an empty final slice when the last step has no trailing text", () => {
    const buffer = new TurnEventBuffer();

    buffer.observeEvent("StepBegin", { n: 1 });
    buffer.observeEvent("ContentPart", { type: "text", text: "tool prelude" });
    buffer.observeEvent("ToolResult", {
      tool_call_id: "tool-2",
      return_value: { is_error: false, output: "", message: "", display: [] },
    });
    buffer.observeEvent("StepBegin", { n: 2 });
    buffer.observeEvent("TurnEnd", {});

    const completed = buffer.finalize({ status: "finished" });

    expect(completed.finalText).toBe("");
  });

  test("StepRetry discards failed-attempt text for the retried step", () => {
    const buffer = new TurnEventBuffer();

    buffer.observeEvent("TurnBegin", { user_input: "hello" });
    buffer.observeEvent("StepBegin", { n: 1 });
    buffer.observeEvent("ContentPart", { type: "text", text: "bad partial" });
    buffer.observeEvent("StepRetry", {
      n: 1,
      next_attempt: 2,
      max_attempts: 3,
      wait_s: 0.5,
      error_type: "RateLimitError",
      status_code: 429,
    });
    buffer.observeEvent("ContentPart", { type: "text", text: "good final" });
    buffer.observeEvent("TurnEnd", {});

    const completed = buffer.finalize({ status: "finished" });

    expect(completed.finalText).toBe("good final");
    expect(completed.steps).toEqual([
      { step: 0, textParts: [] },
      { step: 1, textParts: ["good final"] },
    ]);
  });

  test("StepRetry with missing n still clears the current step's stale text", () => {
    const buffer = new TurnEventBuffer();

    buffer.observeEvent("StepBegin", { n: 2 });
    buffer.observeEvent("ContentPart", { type: "text", text: "bad" });
    buffer.observeEvent("StepRetry", {});
    buffer.observeEvent("ContentPart", { type: "text", text: "good" });
    buffer.observeEvent("TurnEnd", {});

    const completed = buffer.finalize({ status: "finished" });

    expect(completed.finalText).toBe("good");
    const lastStep = completed.steps[completed.steps.length - 1];
    expect(lastStep?.textParts).toEqual(["good"]);
  });

  test("StepRetry leaves prior completed steps intact", () => {
    const buffer = new TurnEventBuffer();

    buffer.observeEvent("StepBegin", { n: 1 });
    buffer.observeEvent("ContentPart", { type: "text", text: "step one " });
    buffer.observeEvent("ToolResult", {
      tool_call_id: "tool-a",
      return_value: { is_error: false, output: "", message: "", display: [] },
    });
    buffer.observeEvent("StepBegin", { n: 2 });
    buffer.observeEvent("ContentPart", { type: "text", text: "bad partial" });
    buffer.observeEvent("StepRetry", {
      n: 2,
      next_attempt: 2,
      max_attempts: 3,
      wait_s: 0.25,
      error_type: "ServerError",
      status_code: 500,
    });
    buffer.observeEvent("ContentPart", { type: "text", text: "step two" });
    buffer.observeEvent("TurnEnd", {});

    const completed = buffer.finalize({ status: "finished" });

    expect(completed.finalText).toBe("step two");
    expect(completed.steps).toEqual([
      { step: 0, textParts: [] },
      { step: 1, textParts: ["step one "] },
      { step: 2, textParts: ["step two"] },
    ]);
  });

  test("fails when TurnEnd is missing", () => {
    const buffer = new TurnEventBuffer();
    buffer.observeEvent("ContentPart", { type: "text", text: "partial" });

    expect(() => buffer.finalize({ status: "finished" })).toThrow(
      "Wire turn finished without a TurnEnd event",
    );
  });

  test("fails on interrupted turns even if text exists", () => {
    const buffer = new TurnEventBuffer();
    buffer.observeEvent("ContentPart", { type: "text", text: "partial" });
    buffer.observeEvent("TurnEnd", {});

    expect(() => buffer.finalize({ status: "cancelled" })).toThrow(
      "Wire turn ended with status 'cancelled'",
    );
  });
});
