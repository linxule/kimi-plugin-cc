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
    void attachedClient.cancel().catch(() => {});
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
        void attachedClient.cancel().catch(() => {});
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
