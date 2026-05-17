// Wire protocol version advertised to kimi-cli on the `initialize` handshake. Bumped to
// "1.10" alongside the StepRetry event kimi-cli 1.42.0 added. Centralized so every
// command-side initialize call agrees on a single value.
export const KIMI_WIRE_PROTOCOL_VERSION = "1.10";
/**
 * Returns true if the event is a reasoning-only `ContentPart` (i.e.
 * `params.type === "ContentPart"` carrying `payload.type === "think"`).
 *
 * Lives next to the wire types because the predicate is determined by
 * the wire schema, not by any downstream consumer: if kimi-cli adds a
 * new reasoning subtype, the update belongs here in lockstep with the
 * `WireNotification` shape, not in a downstream watchdog. Every other
 * event type (StepBegin, StepRetry, text ContentPart, ToolCall,
 * ToolResult, StatusUpdate, TurnEnd, ...) is "forward progress" from
 * the watchdog's perspective and should return false.
 *
 * Used by `ThinkStallGuard.observeEvent` to route think-only payloads
 * to the duplicate-hash window and everything else to the
 * forward-progress reset path.
 */
export function isThinkOnlyEvent(type, payload) {
    if (type !== "ContentPart") {
        return false;
    }
    return payload.type === "think";
}
