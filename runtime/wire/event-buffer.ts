import {
  createTurnCapture,
  finalizeTurnCapture,
  observeTurnEvent,
} from "./turn-capture.js";
import type { CompletedTurn, PromptResult } from "./types.js";

export class TurnEventBuffer {
  private readonly state = createTurnCapture();

  observeEvent(type: string, payload: Record<string, unknown>): void {
    observeTurnEvent(this.state, type, payload);
  }

  finalize(promptResult: PromptResult): CompletedTurn {
    return finalizeTurnCapture(this.state, promptResult);
  }
}
