import { RuntimeError } from "../errors.js";

export interface ReviewFinding {
  severity: "low" | "medium" | "high";
  confidence: "low" | "medium" | "high";
  title: string;
  file: string;
  start_line: number;
  end_line: number;
  body: string;
  suggested_fix: string | null;
}

export interface ReviewOutput {
  summary: string;
  verdict: "approve" | "concern" | "block";
  findings: ReviewFinding[];
}

const ALLOWED_LEVELS = new Set(["low", "medium", "high"]);
const ALLOWED_VERDICTS = new Set(["approve", "concern", "block"]);

export function parseReviewOutput(text: string): ReviewOutput {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RuntimeError(
      "REVIEW_PARSE_FAILED",
      `Review output is not valid JSON: ${(error as Error).message}`,
      "review.parse",
      { cause: error as Error },
    );
  }

  if (!isObject(parsed)) {
    throw new RuntimeError("REVIEW_PARSE_FAILED", "Review output must be a JSON object.", "review.parse");
  }

  const { summary, verdict, findings } = parsed;
  if (typeof summary !== "string" || !ALLOWED_VERDICTS.has(String(verdict)) || !Array.isArray(findings)) {
    throw new RuntimeError(
      "REVIEW_PARSE_FAILED",
      "Review output must contain string summary, valid verdict, and findings array.",
      "review.parse",
    );
  }

  const normalizedFindings = findings.map((finding, index) => normalizeFinding(finding, index));

  if (normalizedFindings.length === 0 && verdict !== "approve") {
    throw new RuntimeError(
      "REVIEW_PARSE_FAILED",
      "Review output may only omit findings when verdict is approve.",
      "review.parse",
    );
  }

  return {
    summary,
    verdict: verdict as ReviewOutput["verdict"],
    findings: normalizedFindings,
  };
}

function normalizeFinding(finding: unknown, index: number): ReviewFinding {
  if (!isObject(finding)) {
    throw new RuntimeError(
      "REVIEW_PARSE_FAILED",
      `Review finding ${index + 1} must be an object.`,
      "review.parse",
    );
  }

  const {
    severity,
    confidence,
    title,
    file,
    start_line: startLine,
    end_line: endLine,
    body,
    suggested_fix: suggestedFix,
  } = finding;

  if (
    !ALLOWED_LEVELS.has(String(severity)) ||
    !ALLOWED_LEVELS.has(String(confidence)) ||
    typeof title !== "string" ||
    typeof file !== "string" ||
    !isPositiveInteger(startLine) ||
    typeof body !== "string"
  ) {
    throw new RuntimeError(
      "REVIEW_PARSE_FAILED",
      `Review finding ${index + 1} is missing a required field or uses an invalid enum value.`,
      "review.parse",
    );
  }

  if (endLine !== undefined && !isPositiveInteger(endLine)) {
    throw new RuntimeError(
      "REVIEW_PARSE_FAILED",
      `Review finding ${index + 1} has an invalid end_line.`,
      "review.parse",
    );
  }

  if (suggestedFix !== undefined && suggestedFix !== null && typeof suggestedFix !== "string") {
    throw new RuntimeError(
      "REVIEW_PARSE_FAILED",
      `Review finding ${index + 1} has an invalid suggested_fix.`,
      "review.parse",
    );
  }

  return {
    severity: severity as ReviewFinding["severity"],
    confidence: confidence as ReviewFinding["confidence"],
    title,
    file,
    start_line: startLine,
    end_line: endLine ?? startLine,
    body,
    suggested_fix: suggestedFix ?? null,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
