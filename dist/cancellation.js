import process from "node:process";
export function createCancellationHandlers(options) {
    const { escalationMs } = options;
    let cancelling = false;
    let cancelEscalationTimer;
    let attachedClient;
    let disposed = false;
    /**
     * Single chokepoint for fanning a cancel out to the wire client.
     * Called from BOTH `requestCancellation` (when the signal fires AFTER
     * the client is attached) and `attachClient` (when the signal fired
     * BEFORE the client existed) so the
     * `beginCancellation → cancel → setTimeout(SIGTERM)` sequence cannot
     * drift between paths.
     */
    const scheduleEscalation = (client) => {
        client.beginCancellation();
        void client.cancel().catch(() => { });
        cancelEscalationTimer = setTimeout(() => {
            client.terminateChild("SIGTERM");
        }, escalationMs);
        cancelEscalationTimer.unref();
    };
    const requestCancellation = () => {
        if (cancelling) {
            return;
        }
        cancelling = true;
        if (!attachedClient) {
            // Signal arrived during wire-client startup. The startup retry path
            // observes `cancelling` and short-circuits; nothing more to do
            // here. The eventual `attachClient` call will fan the cancel out.
            return;
        }
        scheduleEscalation(attachedClient);
    };
    // Use `process.on` (not `once`) so dispose() can reliably remove the
    // listener via the original function reference. DO NOT "simplify"
    // back to `process.once` — Node's `once` internally wraps the
    // listener, and the only reason `removeListener(once-wrapped-fn)`
    // works is via the `_originalListener` implementation detail.
    // Reverting would silently reintroduce a SIGTERM/SIGINT listener
    // leak on every dispose. The handler is idempotent via the
    // `if (cancelling) return` short-circuit, so a single registered
    // `on` listener behaves identically to `once` for our purposes.
    process.on("SIGTERM", requestCancellation);
    process.on("SIGINT", requestCancellation);
    return {
        get cancelling() {
            return cancelling;
        },
        attachClient(client) {
            // If the handler was already disposed (e.g., command finally ran
            // before the wire client finished starting in some racy teardown
            // path), bail before scheduling a fresh escalation timer that
            // would survive disposal.
            if (disposed) {
                return;
            }
            attachedClient = client;
            if (cancelling) {
                scheduleEscalation(client);
            }
        },
        clearEscalation() {
            if (cancelEscalationTimer) {
                clearTimeout(cancelEscalationTimer);
                cancelEscalationTimer = undefined;
            }
        },
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            process.off("SIGTERM", requestCancellation);
            process.off("SIGINT", requestCancellation);
            if (cancelEscalationTimer) {
                clearTimeout(cancelEscalationTimer);
                cancelEscalationTimer = undefined;
            }
        },
    };
}
