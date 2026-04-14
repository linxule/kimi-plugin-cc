import { RuntimeError } from "../errors.js";
import type { CompletedTurn, PromptResult, StepCapture } from "./types.js";

interface TurnCaptureState {
  steps: Map<number, StepCapture>;
  orderedStepNumbers: number[];
  currentStep: number;
  turnEnded: boolean;
  textAfterLastToolResult: string[];
}

export function createTurnCapture(): TurnCaptureState {
  const state: TurnCaptureState = {
    steps: new Map<number, StepCapture>(),
    orderedStepNumbers: [],
    currentStep: 0,
    turnEnded: false,
    textAfterLastToolResult: [],
  };

  ensureStep(state, 0);
  return state;
}

export function observeTurnEvent(
  state: TurnCaptureState,
  type: string,
  payload: Record<string, unknown>,
): void {
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
    case "TurnEnd": {
      state.turnEnded = true;
      break;
    }
    default:
      break;
  }
}

export function finalizeTurnCapture(
  state: TurnCaptureState,
  promptResult: PromptResult,
): CompletedTurn {
  if (promptResult.status !== "finished") {
    throw new RuntimeError(
      "TURN_INTERRUPTED",
      `Wire turn ended with status '${promptResult.status}', so no final output was committed.`,
      "wire.prompt",
    );
  }

  if (!state.turnEnded) {
    throw new RuntimeError(
      "MISSING_TURN_END",
      "Wire turn finished without a TurnEnd event. Treating the output as malformed.",
      "wire.prompt",
    );
  }

  return {
    finalText: state.textAfterLastToolResult.join(""),
    steps: state.orderedStepNumbers.map((stepNumber) => state.steps.get(stepNumber)!),
    promptResult,
  };
}

function ensureStep(state: TurnCaptureState, stepNumber: number): StepCapture {
  const existing = state.steps.get(stepNumber);
  if (existing) {
    return existing;
  }

  const created: StepCapture = {
    step: stepNumber,
    textParts: [],
  };

  state.steps.set(stepNumber, created);
  state.orderedStepNumbers.push(stepNumber);
  return created;
}
