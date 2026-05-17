import process from "node:process";
export function createCancellationHandlers(options) {
    const { escalationMs } = options;
    let cancelling = false;
    let cancelEscalationTimer;
    let attachedClient;
    const requestCancellation = () => {
        if (cancelling) {
            return;
        }
        cancelling = true;
        if (!attachedClient) {
            // Signal arrived during wire-client startup. The startup retry path
            // observes `cancelling` and short-circuits; nothing more to do here.
            return;
        }
        attachedClient.beginCancellation();
        void attachedClient.cancel().catch(() => { });
        cancelEscalationTimer = setTimeout(() => {
            attachedClient?.terminateChild("SIGTERM");
        }, escalationMs);
        cancelEscalationTimer.unref();
    };
    process.once("SIGTERM", requestCancellation);
    process.once("SIGINT", requestCancellation);
    return {
        get cancelling() {
            return cancelling;
        },
        attachClient(client) {
            attachedClient = client;
            if (cancelling) {
                // Cancel landed during start: the requestCancellation above ran
                // before attachClient, so we still need to fan it out now.
                attachedClient.beginCancellation();
                void attachedClient.cancel().catch(() => { });
                cancelEscalationTimer = setTimeout(() => {
                    attachedClient?.terminateChild("SIGTERM");
                }, escalationMs);
                cancelEscalationTimer.unref();
            }
        },
        clearEscalation() {
            if (cancelEscalationTimer) {
                clearTimeout(cancelEscalationTimer);
                cancelEscalationTimer = undefined;
            }
        },
        dispose() {
            process.removeListener("SIGTERM", requestCancellation);
            process.removeListener("SIGINT", requestCancellation);
            if (cancelEscalationTimer) {
                clearTimeout(cancelEscalationTimer);
                cancelEscalationTimer = undefined;
            }
        },
    };
}
