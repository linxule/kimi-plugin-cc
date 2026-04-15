import { describe, expect, test } from "bun:test";

import {
  KIMI_SESSION_TITLE_MAX_LENGTH,
  buildSessionTitle,
  shortenForTitle,
  stripLeadingLabel,
} from "../../runtime/session-title.js";

describe("buildSessionTitle", () => {
  test("ask gets plain prefix plus excerpt", () => {
    expect(buildSessionTitle("ask", "refactor auth middleware to use OAuth2")).toBe(
      "Kimi Task: refactor auth middleware to use OAuth2",
    );
  });

  test("review with focus uses the focus text as excerpt", () => {
    expect(buildSessionTitle("review", "check the new retry logic")).toBe(
      "Kimi Task: check the new retry logic",
    );
  });

  test("rescue gets the [write] capability tag", () => {
    expect(buildSessionTitle("rescue", "fix flaky test in job-store")).toBe(
      "Kimi Task: fix flaky test in job-store [write]",
    );
  });

  test("challenge review does not get the write tag", () => {
    expect(buildSessionTitle("challenge", "pending changes (challenge)")).toBe(
      "Kimi Task: pending changes (challenge)",
    );
  });

  test("empty or whitespace prompt falls back to the bare prefix", () => {
    expect(buildSessionTitle("ask", "")).toBe("Kimi Task");
    expect(buildSessionTitle("ask", "   \n  ")).toBe("Kimi Task");
    expect(buildSessionTitle("ask", undefined)).toBe("Kimi Task");
  });

  test("rescue with empty prompt still emits the [write] tag", () => {
    expect(buildSessionTitle("rescue", "")).toBe("Kimi Task [write]");
  });

  test("long prompts are truncated to the 56-char excerpt budget", () => {
    const prompt =
      "this is an extremely long prompt that goes on and on and on so we can verify the truncation ellipsis";
    const title = buildSessionTitle("ask", prompt);
    expect(title.startsWith("Kimi Task: ")).toBe(true);
    expect(title.endsWith("…")).toBe(true);
    // "Kimi Task: " is 11 chars + 56-char excerpt = 67 chars max
    expect(title.length).toBeLessThanOrEqual(67);
  });

  test("multi-line prompts are collapsed to a single line in the excerpt", () => {
    const title = buildSessionTitle("ask", "line one\nline two\tline three");
    expect(title).toBe("Kimi Task: line one line two line three");
  });

  test("final title never exceeds the 200-char API limit", () => {
    const veryLongButNormalized = "x".repeat(500);
    const title = buildSessionTitle("rescue", veryLongButNormalized);
    expect(title.length).toBeLessThanOrEqual(KIMI_SESSION_TITLE_MAX_LENGTH);
  });
});

describe("stripLeadingLabel", () => {
  test("strips a leading 'Task:' so the title does not render doubled", () => {
    expect(stripLeadingLabel("Task: rename adversarial-review to challenge")).toBe(
      "rename adversarial-review to challenge",
    );
  });

  test("case-insensitive: strips TASK:, task:, Task:", () => {
    expect(stripLeadingLabel("TASK: one")).toBe("one");
    expect(stripLeadingLabel("task: two")).toBe("two");
    expect(stripLeadingLabel("Task: three")).toBe("three");
  });

  test("strips other common labels (TODO, Job, Ticket)", () => {
    expect(stripLeadingLabel("TODO: fix this")).toBe("fix this");
    expect(stripLeadingLabel("Job: run the thing")).toBe("run the thing");
    expect(stripLeadingLabel("Ticket: ABC-123")).toBe("ABC-123");
  });

  test("only strips the first label, not recursive labels", () => {
    expect(stripLeadingLabel("Task: Task: doubled")).toBe("Task: doubled");
  });

  test("leaves non-label text untouched", () => {
    expect(stripLeadingLabel("rename the command")).toBe("rename the command");
    expect(stripLeadingLabel("refactor: extract helper")).toBe("refactor: extract helper");
  });

  test("integration with buildSessionTitle: prompt starting with Task: produces a clean title", () => {
    expect(buildSessionTitle("rescue", "Task: rename adversarial-review to challenge")).toBe(
      "Kimi Task: rename adversarial-review to challenge [write]",
    );
  });
});

describe("shortenForTitle", () => {
  test("collapses internal whitespace and trims", () => {
    expect(shortenForTitle("  hello   world\n\ttest  ", 50)).toBe("hello world test");
  });

  test("returns empty string for whitespace-only input", () => {
    expect(shortenForTitle("   \n\t  ", 50)).toBe("");
  });

  test("truncates with ellipsis when over limit", () => {
    const result = shortenForTitle("abcdefghijklmnopqrstuvwxyz", 10);
    expect(result).toHaveLength(10);
    expect(result).toBe("abcdefghi…");
  });

  test("does not append ellipsis when exactly at the limit", () => {
    expect(shortenForTitle("abcdefghij", 10)).toBe("abcdefghij");
  });
});
