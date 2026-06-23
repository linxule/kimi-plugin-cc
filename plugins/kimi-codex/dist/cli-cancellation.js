import process from "node:process";
export function createCliCancellationHandlers() {
    const controller = new AbortController();
    let cancelling = false;
    let disposed = false;
    const onSignal = () => {
        if (cancelling)
            return;
        cancelling = true;
        // Abort BEFORE running through dispose — the cli-client may still be
        // in its pre-spawn signal check or its post-spawn wait, both of which
        // honor signal.aborted.
        try {
            controller.abort();
        }
        catch {
            // AbortController.abort() can't throw in standard runtimes, but
            // belt-and-suspenders for runtime quirks (e.g. test harnesses
            // overriding global AbortController).
        }
    };
    // Use `process.on` (not `once`) so dispose() can remove the listener
    // via the function reference. `process.once` wraps the callback
    // internally and depending on Node version removeListener may miss it.
    // Idempotency comes from the `if (cancelling) return` guard.
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    return {
        get cancelling() {
            return cancelling;
        },
        get signal() {
            return controller.signal;
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            process.off("SIGTERM", onSignal);
            process.off("SIGINT", onSignal);
        },
    };
}
