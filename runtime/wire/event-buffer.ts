import { RuntimeError } from "../errors.js";
import type { CompletedTurn, PromptResult, StepCapture } from "./types.js";

export class TurnEventBuffer {
  private readonly steps = new Map<number, StepCapture>();
  private readonly orderedStepNumbers: number[] = [];
  private currentStep = 0;
  private turnEnded = false;
  private textAfterLastToolResult: string[] = [];

  constructor() {
    this.ensureStep(0);
  }

  observeEvent(type: string, payload: Record<string, unknown>): void {
    switch (type) {
      case "StepBegin": {
        const rawStep = payload.n;
        const stepNumber = typeof rawStep === "number" ? rawStep : Number(rawStep);
        this.currentStep = Number.isFinite(stepNumber) ? stepNumber : this.currentStep;
        this.ensureStep(this.currentStep);
        break;
      }
      case "ContentPart": {
        if (payload.type === "text" && typeof payload.text === "string") {
          this.ensureStep(this.currentStep).textParts.push(payload.text);
          this.textAfterLastToolResult.push(payload.text);
        }
        break;
      }
      case "ToolResult": {
        this.textAfterLastToolResult = [];
        break;
      }
      case "TurnEnd": {
        this.turnEnded = true;
        break;
      }
      default:
        break;
    }
  }

  finalize(promptResult: PromptResult): CompletedTurn {
    if (promptResult.status !== "finished") {
      throw new RuntimeError(
        "TURN_INTERRUPTED",
        `Wire turn ended with status '${promptResult.status}', so no final output was committed.`,
        "wire.prompt",
      );
    }

    if (!this.turnEnded) {
      throw new RuntimeError(
        "MISSING_TURN_END",
        "Wire turn finished without a TurnEnd event. Treating the output as malformed.",
        "wire.prompt",
      );
    }

    const steps = this.orderedStepNumbers.map((stepNumber) => this.steps.get(stepNumber)!);

    return {
      finalText: this.textAfterLastToolResult.join(""),
      steps,
      promptResult,
    };
  }

  private ensureStep(stepNumber: number): StepCapture {
    const existing = this.steps.get(stepNumber);
    if (existing) {
      return existing;
    }

    const created: StepCapture = {
      step: stepNumber,
      textParts: [],
    };

    this.steps.set(stepNumber, created);
    this.orderedStepNumbers.push(stepNumber);

    return created;
  }
}
