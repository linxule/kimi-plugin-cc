import { RuntimeError } from "../errors.js";
import { isThinkOnlyEvent } from "./types.js";

/**
 * Watchdog over a single prompt() turn's reasoning stream. Owns the
 * stall timer, the duplicate-payload hash window, and the resulting
 * stall verdict so WireClient can stay focused on transport.
 *
 * Construction arms the time-based watchdog at `thinkStallMs`. Each
 * forward-progress event (any non-think event) re-arms the timer and
 * clears the hash window. Each think-only event pushes a payload hash
 * onto a bounded ring and, if the last `thinkLoopDuplicateThreshold`
 * hashes match, latches the "loop" verdict and invokes
 * `onStallVerdict` once with the reason.
 *
 * The guard is constructed fresh per prompt and disposed in the
 * caller's `finally` so timers never outlive their turn.
 */

const DEFAULT_THINK_STALL_MS = 120_000;
const DEFAULT_THINK_LOOP_DUPLICATE_THRESHOLD = 8;

export type StallReason = "stall" | "loop";

export interface ThinkStallGuardOptions {
  /**
   * Threshold (ms) for the stall watchdog. If only `ContentPart{type:
   * "think"}` events arrive for this long, the guard latches `"stall"`
   * and fires `onStallVerdict`. Default 120000. Pass 0 to disable the
   * time-based watchdog (loop detection still runs).
   */
  thinkStallMs?: number;
  /**
   * Number of consecutive identical `ContentPart{type:"think"}`
   * payload hashes that latches the `"loop"` verdict before the
   * time-based deadline. Default 8. Pass 0 to disable loop detection
   * (the time-based watchdog still runs).
   */
  thinkLoopDuplicateThreshold?: number;
  /**
   * Invoked at most once when the guard latches its stall or loop
   * verdict. Receives the reason ("stall" | "loop"). The guard reports
   * the verdict; the caller decides what to do — typically a wire-side
   * cancel, but the action is not the guard's concern. Synchronous;
   * the guard does not await it.
   */
  onStallVerdict: (reason: StallReason) => void;
  /**
   * Invoked when the guard observes a `ContentPart{type:"think"}`
   * whose payload has no recognized text field. Lets the caller own
   * the suppression scope (typically a per-WireClient one-shot flag,
   * symmetric with `warnedUnknownContentPartSubtypes`) instead of the
   * guard maintaining process-wide mutable state. The guard always
   * skips loop-detection for unrecognized payloads regardless of
   * whether this callback is provided.
   */
  onUnknownPayloadShape?: () => void;
}

export class ThinkStallGuard {
  private readonly thinkStallMs: number;
  private readonly thinkLoopDuplicateThreshold: number;
  private readonly onStallVerdict: (reason: StallReason) => void;
  private readonly onUnknownPayloadShape?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private hashes: number[] = [];
  private thinkEventsSeen = 0;
  private duplicatePayloadsSeen = 0;
  private unknownPayloadsSeen = 0;
  private reason: StallReason | null = null;
  private verdictFired = false;
  private disposed = false;

  constructor(options: ThinkStallGuardOptions) {
    this.thinkStallMs = options.thinkStallMs ?? DEFAULT_THINK_STALL_MS;
    this.thinkLoopDuplicateThreshold =
      options.thinkLoopDuplicateThreshold ?? DEFAULT_THINK_LOOP_DUPLICATE_THRESHOLD;
    this.onStallVerdict = options.onStallVerdict;
    this.onUnknownPayloadShape = options.onUnknownPayloadShape;
    this.arm();
  }

  /** High-level entry point: forward EVERY wire event through here.
   *  The guard owns the routing policy (think-only vs forward-progress)
   *  so WireClient stays transport-only — no longer needs to know
   *  which subtype is the magic one. */
  observeEvent(type: string, payload: Record<string, unknown>): void {
    if (this.disposed || this.reason !== null) {
      return;
    }
    if (isThinkOnlyEvent(type, payload)) {
      this.observeThinkPart(payload);
    } else {
      this.observeForwardProgress();
    }
  }

  /** Any non-think event arrived. Reset the stall timer and clear the
   *  duplicate-think buffer so think-then-text-then-think cannot
   *  accumulate enough identical hashes to look like a loop.
   *  Private — call `observeEvent` from production code. Exposed via
   *  protected-ish naming for tests that need direct routing. */
  private observeForwardProgress(): void {
    this.hashes = [];
    this.arm();
  }

  /** A `ContentPart{type:"think"}` event arrived. Hash its text payload
   *  and check whether the last N hashes are all identical. Private —
   *  call `observeEvent` from production code. */
  private observeThinkPart(payload: Record<string, unknown>): void {
    this.thinkEventsSeen += 1;
    const text = extractThinkPayloadText(payload);
    if (text === null) {
      this.unknownPayloadsSeen += 1;
      this.onUnknownPayloadShape?.();
      return;
    }
    this.recordHash(text);
  }

  /** Verdict for the turn. `null` until the watchdog or loop detector
   *  latches; `"stall"` or `"loop"` after. WireClient.prompt() reads
   *  this once the JSON-RPC `prompt` response settles. */
  get stallReason(): StallReason | null {
    return this.reason;
  }

  /** Convenience: returns a populated RuntimeError when stalled or
   *  looped, else null. Caller pattern: `const err = guard.stallError();
   *  if (err) throw err;`. */
  stallError(): RuntimeError | null {
    if (this.reason === "loop") {
      return new RuntimeError(
        "KIMI_THINK_LOOP_DETECTED",
        `Kimi emitted ${this.thinkLoopDuplicateThreshold} consecutive identical \`think\` payloads; ` +
          `cancelled to recover the session. Likely an upstream reasoning-loop bug (kimi-cli ≥1.44.0). ` +
          `Retry with --no-thinking or a more focused prompt.`,
        "wire.prompt",
        {
          details: {
            stall_kind: "loop",
            duplicates_seen: this.duplicatePayloadsSeen,
            duplicate_threshold: this.thinkLoopDuplicateThreshold,
            think_events_seen: this.thinkEventsSeen,
            unknown_payloads_seen: this.unknownPayloadsSeen,
          },
        },
      );
    }
    if (this.reason === "stall") {
      return new RuntimeError(
        "KIMI_THINK_STALLED",
        `Kimi reasoning stream produced only \`think\` events for over ${this.thinkStallMs}ms; ` +
          `cancelled to recover the session. Retry with --no-thinking or a more focused prompt.`,
        "wire.prompt",
        {
          details: {
            stall_kind: "stall",
            stall_ms: this.thinkStallMs,
            think_events_seen: this.thinkEventsSeen,
            duplicate_threshold: this.thinkLoopDuplicateThreshold,
            unknown_payloads_seen: this.unknownPayloadsSeen,
          },
        },
      );
    }
    return null;
  }

  /** Clear the timer and mark disposed. Idempotent. Must be called from
   *  the caller's `finally` so the timer never outlives the prompt. */
  dispose(): void {
    this.disposed = true;
    this.disarm();
  }

  private arm(): void {
    this.disarm();
    if (this.thinkStallMs <= 0) {
      return;
    }
    this.timer = setTimeout(() => {
      if (this.disposed || this.reason !== null) {
        return;
      }
      this.reason = "stall";
      process.stderr.write(
        `[kimi-plugin-cc] think-stall watchdog fired after ${this.thinkStallMs}ms with no non-think events; cancelling.\n`,
      );
      this.fireVerdict();
    }, this.thinkStallMs);
    this.timer.unref();
  }

  private disarm(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private recordHash(text: string): void {
    const threshold = this.thinkLoopDuplicateThreshold;
    if (threshold <= 0) {
      return;
    }
    const hash = hashThinkPayload(text);
    this.hashes.push(hash);
    if (this.hashes.length > threshold) {
      this.hashes.shift();
    }
    if (this.hashes.length < threshold) {
      return;
    }
    const first = this.hashes[0];
    if (this.hashes.every((h) => h === first)) {
      this.reason = "loop";
      this.duplicatePayloadsSeen = threshold;
      process.stderr.write(
        `[kimi-plugin-cc] think-loop detected: ${threshold} consecutive identical think payloads; cancelling.\n`,
      );
      this.fireVerdict();
    }
  }

  private fireVerdict(): void {
    if (this.verdictFired || this.reason === null) {
      return;
    }
    this.verdictFired = true;
    try {
      this.onStallVerdict(this.reason);
    } catch (error) {
      // onStallVerdict is a fire-and-forget notification — the caller's
      // throw must not abort the guard. Log to stderr so a broken
      // verdict-handler is visible; silent swallow would hide real
      // failures, especially when combined with cancel-coalescing
      // flags that suppress retries.
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[kimi-plugin-cc] ThinkStallGuard onStallVerdict callback threw: ${message}\n`,
      );
    }
  }
}

/**
 * DJB2 hash to a 32-bit signed integer. Cheap, well-distributed enough
 * for the duplicate-think detector; the alternative (full payload
 * retention) would balloon memory on long reasoning turns.
 */
function hashThinkPayload(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Returns the textual content of a think ContentPart payload for
 * hashing, or null if the shape is unfamiliar (caller skips
 * loop-detection in that case but still benefits from the time-based
 * watchdog).
 */
function extractThinkPayloadText(payload: Record<string, unknown>): string | null {
  if (typeof payload.text === "string") {
    return payload.text;
  }
  return null;
}
