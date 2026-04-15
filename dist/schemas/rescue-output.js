import { RuntimeError } from "../errors.js";
const RESCUE_STATUSES = new Set(["success", "partial", "blocked"]);
const CHANGE_ACTIONS = new Set(["create", "edit", "delete"]);
const TEST_STATUSES = new Set(["passed", "failed", "not-run"]);
export function parseRescueOutput(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        throw new RuntimeError("RESCUE_PARSE_FAILED", `Rescue output is not valid JSON: ${error.message}`, "rescue.parse", { cause: error });
    }
    if (!isObject(parsed)) {
        throw new RuntimeError("RESCUE_PARSE_FAILED", "Rescue output must be a JSON object.", "rescue.parse");
    }
    const { status, summary, changes, commands_run: commandsRun, tests, followups } = parsed;
    if (!RESCUE_STATUSES.has(String(status)) ||
        typeof summary !== "string" ||
        !Array.isArray(changes) ||
        !Array.isArray(commandsRun) ||
        !Array.isArray(tests) ||
        !Array.isArray(followups)) {
        throw new RuntimeError("RESCUE_PARSE_FAILED", "Rescue output must contain status, summary, changes, commands_run, tests, and followups.", "rescue.parse");
    }
    return {
        status: status,
        summary,
        changes: changes.map(normalizeChange),
        commands_run: commandsRun.map(normalizeCommand),
        tests: tests.map(normalizeTest),
        followups: followups.map((followup, index) => {
            if (typeof followup !== "string") {
                throw new RuntimeError("RESCUE_PARSE_FAILED", `Rescue followup ${index + 1} must be a string.`, "rescue.parse");
            }
            return followup;
        }),
    };
}
function normalizeChange(change, index) {
    if (!isObject(change)) {
        throw new RuntimeError("RESCUE_PARSE_FAILED", `Rescue change ${index + 1} must be an object.`, "rescue.parse");
    }
    if (typeof change.file !== "string" ||
        !CHANGE_ACTIONS.has(String(change.action)) ||
        typeof change.description !== "string") {
        throw new RuntimeError("RESCUE_PARSE_FAILED", `Rescue change ${index + 1} is missing a required field.`, "rescue.parse");
    }
    return change;
}
function normalizeCommand(command, index) {
    if (!isObject(command)) {
        throw new RuntimeError("RESCUE_PARSE_FAILED", `Rescue command ${index + 1} must be an object.`, "rescue.parse");
    }
    if (typeof command.command !== "string" ||
        typeof command.exit_code !== "number" ||
        !Number.isInteger(command.exit_code) ||
        typeof command.note !== "string") {
        throw new RuntimeError("RESCUE_PARSE_FAILED", `Rescue command ${index + 1} is missing a required field.`, "rescue.parse");
    }
    return command;
}
function normalizeTest(test, index) {
    if (!isObject(test)) {
        throw new RuntimeError("RESCUE_PARSE_FAILED", `Rescue test ${index + 1} must be an object.`, "rescue.parse");
    }
    if (typeof test.name !== "string" ||
        !TEST_STATUSES.has(String(test.status)) ||
        typeof test.details !== "string") {
        throw new RuntimeError("RESCUE_PARSE_FAILED", `Rescue test ${index + 1} is missing a required field.`, "rescue.parse");
    }
    return test;
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
