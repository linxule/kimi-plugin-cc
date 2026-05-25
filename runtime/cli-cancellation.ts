import process from "node:process";

/**
 * AbortController-based cancellation for cli-client commands.
 *
 * Replaces the wire-flavored `createCancellationHandlers` from
 * `runtime/cancellation.ts` for v1.0 commands. The shape is similar
 * enough that ask/rescue/review can swap one for the other without
 * restructuring their try/catch/finally skeleton:
 *
 *     const handlers = createCliCancellationHandlers();
 *     try {
 *       const result = await runCliPrompt({ signal: handlers.signal, ... });
 *       if (handlers.cancelling) { ... cancelled after success ... }
 *     } catch (err) {
 *       if (handlers.cancelling) { ... mark cancelled ... }
 *     } finally {
 *       handlers.dispose();
 *     }
 *
 * The handler registers SIGTERM/SIGINT listeners immediately so a
 * signal fired before runCliPrompt awaits will still latch
 * `cancelling = true` and abort the controller. The controller's
 * AbortSignal is exposed via `handlers.signal` for the cli-client.
 *
 * SIGKILL escalation is deliberately NOT implemented in PR 2 — cli-client's
 * AbortSignal-driven `child.kill("SIGTERM")` is the only escalation
 * layer for now. PR 3 adds SIGKILL escalation as part of the rescue
 * port (matching v0.4's `cancellation.ts` pattern).
 *
 * Why not reuse `cancellation.ts`?
 *
 *   - The v0.4 handler attaches a WireClient and calls
 *     `beginCancellation` / `cancel` / `terminateChild` — none of those
 *     exist on the cli-client surface.
 *   - cli-client takes an AbortSignal; the cleanest seam is an
 *     AbortController owned by the handler.
 *   - PR 4 deletes `cancellation.ts` along with the wire/ tree.
 *     Keeping the v1 implementation in its own module makes the
 *     deletion mechanical.
 */
export interface CliCancellationHandlers {
  /** True once SIGTERM/SIGINT has been observed. */
  readonly cancelling: boolean;
  /** AbortSignal to forward to `runCliPrompt`. */
  readonly signal: AbortSignal;
  /**
   * Remove the SIGTERM/SIGINT listeners. Call once in a `finally` block;
   * idempotent. The internal AbortController is left in whatever state
   * the signal handler put it — disposing does NOT abort.
   */
  dispose(): void;
}

export function createCliCancellationHandlers(): CliCancellationHandlers {
  const controller = new AbortController();
  let cancelling = false;
  let disposed = false;

  const onSignal = () => {
    if (cancelling) return;
    cancelling = true;
    // Abort BEFORE running through dispose — the cli-client may still be
    // in its pre-spawn signal check or its post-spawn wait, both of which
    // honor signal.aborted.
    try {
      controller.abort();
    } catch {
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
      if (disposed) return;
      disposed = true;
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    },
  };
}
