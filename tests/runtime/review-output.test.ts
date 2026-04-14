import { describe, expect, test } from "bun:test";

import { parseReviewOutput } from "../../runtime/schemas/review-output.js";

describe("parseReviewOutput", () => {
  test("defaults end_line to start_line", () => {
    const parsed = parseReviewOutput(
      JSON.stringify({
        summary: "One issue.",
        verdict: "concern",
        findings: [
          {
            severity: "medium",
            confidence: "high",
            title: "Issue",
            file: "src.ts",
            start_line: 4,
            body: "Problem body.",
          },
        ],
      }),
    );

    expect(parsed.findings[0]?.end_line).toBe(4);
  });

  test("fails when confidence is missing", () => {
    expect(() =>
      parseReviewOutput(
        JSON.stringify({
          summary: "Malformed.",
          verdict: "concern",
          findings: [
            {
              severity: "medium",
              title: "Issue",
              file: "src.ts",
              start_line: 1,
              body: "Missing confidence.",
            },
          ],
        }),
      ),
    ).toThrow("missing a required field");
  });
});
