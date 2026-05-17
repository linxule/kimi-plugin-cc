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
export class ThinkStallGuard {
    thinkStallMs;
    thinkLoopDuplicateThreshold;
    onStallVerdict;
    onUnknownPayloadShape;
    timer;
    hashes = [];
    reason = null;
    verdictFired = false;
    disposed = false;
    constructor(options) {
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
    observeEvent(type, payload) {
        if (this.disposed || this.reason !== null) {
            return;
        }
        if (isThinkOnlyEvent(type, payload)) {
            this.observeThinkPart(payload);
        }
        else {
            this.observeForwardProgress();
        }
    }
    /** Any non-think event arrived. Reset the stall timer and clear the
     *  duplicate-think buffer so think-then-text-then-think cannot
     *  accumulate enough identical hashes to look like a loop.
     *  Private — call `observeEvent` from production code. Exposed via
     *  protected-ish naming for tests that need direct routing. */
    observeForwardProgress() {
        this.hashes = [];
        this.arm();
    }
    /** A `ContentPart{type:"think"}` event arrived. Hash its text payload
     *  and check whether the last N hashes are all identical. Private —
     *  call `observeEvent` from production code. */
    observeThinkPart(payload) {
        const text = extractThinkPayloadText(payload);
        if (text === null) {
            this.onUnknownPayloadShape?.();
            return;
        }
        this.recordHash(text);
    }
    /** Verdict for the turn. `null` until the watchdog or loop detector
     *  latches; `"stall"` or `"loop"` after. WireClient.prompt() reads
     *  this once the JSON-RPC `prompt` response settles. */
    get stallReason() {
        return this.reason;
    }
    /** Convenience: returns a populated RuntimeError when stalled or
     *  looped, else null. Caller pattern: `const err = guard.stallError();
     *  if (err) throw err;`. */
    stallError() {
        if (this.reason === "loop") {
            return new RuntimeError("KIMI_THINK_LOOP_DETECTED", `Kimi emitted ${this.thinkLoopDuplicateThreshold} consecutive identical \`think\` payloads; ` +
                `cancelled to recover the session. Likely an upstream reasoning-loop bug (kimi-cli ≥1.44.0). ` +
                `Retry with --no-thinking or a more focused prompt.`, "wire.prompt");
        }
        if (this.reason === "stall") {
            return new RuntimeError("KIMI_THINK_STALLED", `Kimi reasoning stream produced only \`think\` events for over ${this.thinkStallMs}ms; ` +
                `cancelled to recover the session. Retry with --no-thinking or a more focused prompt.`, "wire.prompt");
        }
        return null;
    }
    /** Clear the timer and mark disposed. Idempotent. Must be called from
     *  the caller's `finally` so the timer never outlives the prompt. */
    dispose() {
        this.disposed = true;
        this.disarm();
    }
    arm() {
        this.disarm();
        if (this.thinkStallMs <= 0) {
            return;
        }
        this.timer = setTimeout(() => {
            if (this.disposed || this.reason !== null) {
                return;
            }
            this.reason = "stall";
            process.stderr.write(`[kimi-plugin-cc] think-stall watchdog fired after ${this.thinkStallMs}ms with no non-think events; cancelling.\n`);
            this.fireVerdict();
        }, this.thinkStallMs);
        this.timer.unref();
    }
    disarm() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
    recordHash(text) {
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
            process.stderr.write(`[kimi-plugin-cc] think-loop detected: ${threshold} consecutive identical think payloads; cancelling.\n`);
            this.fireVerdict();
        }
    }
    fireVerdict() {
        if (this.verdictFired || this.reason === null) {
            return;
        }
        this.verdictFired = true;
        try {
            this.onStallVerdict(this.reason);
        }
        catch (error) {
            // onStallVerdict is a fire-and-forget notification — the caller's
            // throw must not abort the guard. Log to stderr so a broken
            // verdict-handler is visible; silent swallow would hide real
            // failures, especially when combined with cancel-coalescing
            // flags that suppress retries.
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`[kimi-plugin-cc] ThinkStallGuard onStallVerdict callback threw: ${message}\n`);
        }
    }
}
/**
 * DJB2 hash to a 32-bit signed integer. Cheap, well-distributed enough
 * for the duplicate-think detector; the alternative (full payload
 * retention) would balloon memory on long reasoning turns.
 */
function hashThinkPayload(text) {
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
function extractThinkPayloadText(payload) {
    if (typeof payload.text === "string") {
        return payload.text;
    }
    return null;
}
