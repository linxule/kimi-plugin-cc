import { describe, expect, test } from "bun:test";

import { parseReviewGateOutput } from "../../runtime/schemas/review-gate-output.js";

describe("parseReviewGateOutput", () => {
  test("accepts a valid block payload", () => {
    const parsed = parseReviewGateOutput(
      JSON.stringify({
        decision: "BLOCK",
        confidence: "high",
        summary: "Blocking issue found.",
        issues: [
          {
            title: "Incorrect completion claim",
            body: "The response says the task is done when it is not.",
            severity: "high",
          },
        ],
      }),
    );

    expect(parsed.decision).toBe("BLOCK");
    expect(parsed.confidence).toBe("high");
    expect(parsed.issues).toHaveLength(1);
  });

  test("fails when confidence is missing", () => {
    expect(() =>
      parseReviewGateOutput(
        JSON.stringify({
          decision: "ALLOW",
          summary: "Malformed.",
          issues: [],
        }),
      ),
    ).toThrow("must contain decision, confidence, summary, and issues");
  });
});
