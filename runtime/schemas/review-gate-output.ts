import { RuntimeError } from "../errors.js";

export interface ReviewGateIssue {
  title: string;
  body: string;
  severity: "low" | "medium" | "high";
}

export interface ReviewGateOutput {
  decision: "ALLOW" | "BLOCK";
  confidence: "low" | "medium" | "high";
  summary: string;
  issues: ReviewGateIssue[];
}

const ALLOWED_DECISIONS = new Set(["ALLOW", "BLOCK"]);
const ALLOWED_SEVERITIES = new Set(["low", "medium", "high"]);
const ALLOWED_CONFIDENCE = new Set(["low", "medium", "high"]);

export function parseReviewGateOutput(text: string): ReviewGateOutput {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RuntimeError(
      "REVIEW_GATE_PARSE_FAILED",
      `Review gate output is not valid JSON: ${(error as Error).message}`,
      "review_gate.parse",
      { cause: error as Error },
    );
  }

  if (!isObject(parsed)) {
    throw new RuntimeError(
      "REVIEW_GATE_PARSE_FAILED",
      "Review gate output must be a JSON object.",
      "review_gate.parse",
    );
  }

  const { decision, confidence, summary, issues } = parsed;

  if (
    !ALLOWED_DECISIONS.has(String(decision)) ||
    !ALLOWED_CONFIDENCE.has(String(confidence)) ||
    typeof summary !== "string" ||
    !Array.isArray(issues)
  ) {
    throw new RuntimeError(
      "REVIEW_GATE_PARSE_FAILED",
      "Review gate output must contain decision, confidence, summary, and issues.",
      "review_gate.parse",
    );
  }

  return {
    decision: decision as ReviewGateOutput["decision"],
    confidence: confidence as ReviewGateOutput["confidence"],
    summary,
    issues: issues.map((issue, index) => normalizeIssue(issue, index)),
  };
}

function normalizeIssue(issue: unknown, index: number): ReviewGateIssue {
  if (!isObject(issue)) {
    throw new RuntimeError(
      "REVIEW_GATE_PARSE_FAILED",
      `Review gate issue ${index + 1} must be an object.`,
      "review_gate.parse",
    );
  }

  if (
    typeof issue.title !== "string" ||
    typeof issue.body !== "string" ||
    !ALLOWED_SEVERITIES.has(String(issue.severity))
  ) {
    throw new RuntimeError(
      "REVIEW_GATE_PARSE_FAILED",
      `Review gate issue ${index + 1} is missing a required field.`,
      "review_gate.parse",
    );
  }

  return issue as unknown as ReviewGateIssue;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
