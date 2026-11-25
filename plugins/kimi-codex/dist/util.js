/** Small helpers shared across the runtime. Imports nothing. */
// Uses the global timer on purpose: tests observe globalThis.setTimeout.
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Collapse whitespace and cut to `max` characters, ending in an ellipsis when cut. */
export function shorten(text, max) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= max) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
