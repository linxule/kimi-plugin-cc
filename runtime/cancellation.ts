import process from "node:process";

import type { WireClient } from "./wire/client.js";

/**
 * Shared SIGTERM/SIGINT plumbing for managed commands that need to be
 * interruptable mid-flight.
 *
 * Before v0.3.1 this 30-line dance lived in `ask.ts`, `rescue.ts`, and
 * `review.ts` as three near-identical copies. Drift between the copies
 * caused real bugs (v0.2.3 review.ts didn't clear `cancelEscalationTimer`
 * before awaiting `markJobCancelled`, which could trigger a redundant
 * SIGTERM). Centralizing here makes that class of drift impossible.
 *
 * Usage:
 *
 *     const handlers = createCancellationHandlers({ escalationMs: 1_500 });
 *     try {
 *       client = await buildAndStartWireClient(...);
 *       handlers.attachClient(client);
 *       if (handlers.cancelling) { ... cancelled during start ... }
 *       // ... long-running work ...
 *     } catch (error) {
 *       if (handlers.cancelling) {
 *         handlers.clearEscalation();   // clear before awaiting disk I/O
 *         // ... markJobCancelled ...
 *       }
 *     } finally {
 *       handlers.dispose();
 *     }
 *
 * The handler registers SIGTERM/SIGINT listeners IMMEDIATELY so a signal
 * fired during the wire-client startup retry window still latches
 * `cancelling = true`. The actual wire-side cancel (`client.beginCancellation()`
 * → `client.cancel()` → SIGTERM escalation) only runs once `attachClient`
 * has been called.
 */
export interface CancellationHandlers {
  /** True once a SIGTERM/SIGINT has been observed. */
  readonly cancelling: boolean;
  /** Link the wire client so the handler can fan cancellation out to it. */
  attachClient(client: WireClient): void;
  /**
   * Clear the SIGTERM escalation timer. Call this in the catch path
   * BEFORE awaiting any disk I/O (e.g., `markJobCancelled`) — disk writes
   * under load can exceed the escalation interval and trigger a redundant
   * SIGTERM to the wire child if the timer is left armed.
   */
  clearEscalation(): void;
  /** Remove the process-level listeners and clear any pending timer. */
  dispose(): void;
}

export function createCancellationHandlers(options: {
  escalationMs: number;
}): CancellationHandlers {
  const { escalationMs } = options;

  let cancelling = false;
  let cancelEscalationTimer: ReturnType<typeof setTimeout> | undefined;
  let attachedClient: WireClient | undefined;
  let disposed = false;

  /**
   * Single chokepoint for fanning a cancel out to the wire client.
   * Called from BOTH `requestCancellation` (when the signal fires AFTER
   * the client is attached) and `attachClient` (when the signal fired
   * BEFORE the client existed). Pre-v0.3.2 these paths duplicated the
   * `beginCancellation → cancel → setTimeout(SIGTERM)` sequence, which
   * Kimi adversarial reviewer flagged as drift waiting to happen.
   */
  const scheduleEscalation = (client: WireClient): void => {
    client.beginCancellation();
    void client.cancel().catch(() => {});
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

  // v0.3.2: switched from `process.once` to `process.on` so dispose()
  // can reliably remove the listener via the original function
  // reference. (Node's `once` internally wraps the listener, and
  // removeListener happens to work via `_originalListener`, but that's
  // an implementation detail.) The handler is idempotent via the
  // `if (cancelling) return` short-circuit, so a single registered `on`
  // listener behaves identically to `once`.
  process.on("SIGTERM", requestCancellation);
  process.on("SIGINT", requestCancellation);

  return {
    get cancelling() {
      return cancelling;
    },
    attachClient(client) {
      // v0.3.3 (Kimi defect + Claude N1): if the handler was already
      // disposed (e.g., command finally ran before the wire client
      // finished starting in some racy teardown path), bail before
      // scheduling a fresh escalation timer that would survive disposal.
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
