import { RuntimeError } from "../errors.js";
export function createTurnCapture() {
    const state = {
        steps: new Map(),
        orderedStepNumbers: [],
        currentStep: 0,
        turnEnded: false,
        textAfterLastToolResult: [],
    };
    ensureStep(state, 0);
    return state;
}
export function observeTurnEvent(state, type, payload) {
    switch (type) {
        case "StepBegin": {
            const rawStep = payload.n;
            const stepNumber = typeof rawStep === "number" ? rawStep : Number(rawStep);
            state.currentStep = Number.isFinite(stepNumber) ? stepNumber : state.currentStep;
            ensureStep(state, state.currentStep);
            break;
        }
        case "ContentPart": {
            if (payload.type === "text" && typeof payload.text === "string") {
                ensureStep(state, state.currentStep).textParts.push(payload.text);
                state.textAfterLastToolResult.push(payload.text);
            }
            break;
        }
        case "ToolResult": {
            state.textAfterLastToolResult = [];
            break;
        }
        case "StepRetry": {
            // kimi-cli 1.42.0+ emits StepRetry before tenacity sleeps between attempts of the
            // same step. The retried attempt re-streams ContentPart text under the same step
            // number, so we drop whatever the failed attempt accumulated to avoid leaking
            // partial output into either the per-step record or the final-text slice.
            const rawStep = payload.n;
            const retryStep = typeof rawStep === "number" ? rawStep : Number(rawStep);
            const targetStep = Number.isFinite(retryStep) ? retryStep : state.currentStep;
            const step = ensureStep(state, targetStep);
            step.textParts = [];
            state.currentStep = targetStep;
            state.textAfterLastToolResult = [];
            break;
        }
        case "TurnEnd": {
            state.turnEnded = true;
            break;
        }
        default:
            break;
    }
}
export function finalizeTurnCapture(state, promptResult) {
    if (promptResult.status !== "finished") {
        throw new RuntimeError("TURN_INTERRUPTED", `Wire turn ended with status '${promptResult.status}', so no final output was committed.`, "wire.prompt");
    }
    if (!state.turnEnded) {
        throw new RuntimeError("MISSING_TURN_END", "Wire turn finished without a TurnEnd event. Treating the output as malformed.", "wire.prompt");
    }
    return {
        finalText: state.textAfterLastToolResult.join(""),
        steps: state.orderedStepNumbers.map((stepNumber) => state.steps.get(stepNumber)),
        promptResult,
    };
}
function ensureStep(state, stepNumber) {
    const existing = state.steps.get(stepNumber);
    if (existing) {
        return existing;
    }
    const created = {
        step: stepNumber,
        textParts: [],
    };
    state.steps.set(stepNumber, created);
    state.orderedStepNumbers.push(stepNumber);
    return created;
}
