import { createTurnCapture, finalizeTurnCapture, observeTurnEvent, } from "./turn-capture.js";
export class TurnEventBuffer {
    state = createTurnCapture();
    observeEvent(type, payload) {
        observeTurnEvent(this.state, type, payload);
    }
    finalize(promptResult) {
        return finalizeTurnCapture(this.state, promptResult);
    }
}
