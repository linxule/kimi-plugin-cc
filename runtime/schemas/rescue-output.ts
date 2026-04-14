import { RuntimeError } from "../errors.js";

export interface RescueChange {
  file: string;
  action: "create" | "edit" | "delete";
  description: string;
}

export interface RescueCommandRun {
  command: string;
  exit_code: number;
  note: string;
}

export interface RescueTestResult {
  name: string;
  status: "passed" | "failed" | "not-run";
  details: string;
}

export interface RescueOutput {
  status: "success" | "partial" | "blocked";
  summary: string;
  changes: RescueChange[];
  commands_run: RescueCommandRun[];
  tests: RescueTestResult[];
  followups: string[];
}

const RESCUE_STATUSES = new Set(["success", "partial", "blocked"]);
const CHANGE_ACTIONS = new Set(["create", "edit", "delete"]);
const TEST_STATUSES = new Set(["passed", "failed", "not-run"]);

export function parseRescueOutput(text: string): RescueOutput {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RuntimeError(
      "RESCUE_PARSE_FAILED",
      `Rescue output is not valid JSON: ${(error as Error).message}`,
      "rescue.parse",
      { cause: error as Error },
    );
  }

  if (!isObject(parsed)) {
    throw new RuntimeError("RESCUE_PARSE_FAILED", "Rescue output must be a JSON object.", "rescue.parse");
  }

  const { status, summary, changes, commands_run: commandsRun, tests, followups } = parsed;
  if (
    !RESCUE_STATUSES.has(String(status)) ||
    typeof summary !== "string" ||
    !Array.isArray(changes) ||
    !Array.isArray(commandsRun) ||
    !Array.isArray(tests) ||
    !Array.isArray(followups)
  ) {
    throw new RuntimeError(
      "RESCUE_PARSE_FAILED",
      "Rescue output must contain status, summary, changes, commands_run, tests, and followups.",
      "rescue.parse",
    );
  }

  return {
    status: status as RescueOutput["status"],
    summary,
    changes: changes.map(normalizeChange),
    commands_run: commandsRun.map(normalizeCommand),
    tests: tests.map(normalizeTest),
    followups: followups.map((followup, index) => {
      if (typeof followup !== "string") {
        throw new RuntimeError(
          "RESCUE_PARSE_FAILED",
          `Rescue followup ${index + 1} must be a string.`,
          "rescue.parse",
        );
      }

      return followup;
    }),
  };
}

function normalizeChange(change: unknown, index: number): RescueChange {
  if (!isObject(change)) {
    throw new RuntimeError(
      "RESCUE_PARSE_FAILED",
      `Rescue change ${index + 1} must be an object.`,
      "rescue.parse",
    );
  }

  if (
    typeof change.file !== "string" ||
    !CHANGE_ACTIONS.has(String(change.action)) ||
    typeof change.description !== "string"
  ) {
    throw new RuntimeError(
      "RESCUE_PARSE_FAILED",
      `Rescue change ${index + 1} is missing a required field.`,
      "rescue.parse",
    );
  }

  return change as unknown as RescueChange;
}

function normalizeCommand(command: unknown, index: number): RescueCommandRun {
  if (!isObject(command)) {
    throw new RuntimeError(
      "RESCUE_PARSE_FAILED",
      `Rescue command ${index + 1} must be an object.`,
      "rescue.parse",
    );
  }

  if (
    typeof command.command !== "string" ||
    typeof command.exit_code !== "number" ||
    !Number.isInteger(command.exit_code) ||
    typeof command.note !== "string"
  ) {
    throw new RuntimeError(
      "RESCUE_PARSE_FAILED",
      `Rescue command ${index + 1} is missing a required field.`,
      "rescue.parse",
    );
  }

  return command as unknown as RescueCommandRun;
}

function normalizeTest(test: unknown, index: number): RescueTestResult {
  if (!isObject(test)) {
    throw new RuntimeError(
      "RESCUE_PARSE_FAILED",
      `Rescue test ${index + 1} must be an object.`,
      "rescue.parse",
    );
  }

  if (
    typeof test.name !== "string" ||
    !TEST_STATUSES.has(String(test.status)) ||
    typeof test.details !== "string"
  ) {
    throw new RuntimeError(
      "RESCUE_PARSE_FAILED",
      `Rescue test ${index + 1} is missing a required field.`,
      "rescue.parse",
    );
  }

  return test as unknown as RescueTestResult;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
