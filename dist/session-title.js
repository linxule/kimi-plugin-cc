// Derives a human-readable title for a Kimi session spawned by this plugin.
//
// Convention (ratified with Kimi itself in the 0.1.5 design round): a fixed
// "Kimi Task: " prefix, followed by a shortened excerpt of the user prompt,
// with an optional " [write]" suffix on rescue (the only write-capable command).
//
// A single prefix means one search string filters every plugin-created session
// in `kimi web`. Per-command grouping was considered and rejected because it
// fragments the query key. Capability (read vs write) matters more to a human
// scanning a session list than command name does.
export const KIMI_SESSION_TITLE_PREFIX = "Kimi Task";
export const KIMI_SESSION_TITLE_EXCERPT_LENGTH = 56;
export const KIMI_SESSION_TITLE_MAX_LENGTH = 200;
const WRITE_CAPABLE_COMMANDS = new Set(["rescue"]);
export function buildSessionTitle(commandType, prompt) {
    const excerpt = shortenForTitle(prompt ?? "", KIMI_SESSION_TITLE_EXCERPT_LENGTH);
    const base = excerpt ? `${KIMI_SESSION_TITLE_PREFIX}: ${excerpt}` : KIMI_SESSION_TITLE_PREFIX;
    const suffix = WRITE_CAPABLE_COMMANDS.has(commandType) ? " [write]" : "";
    const full = `${base}${suffix}`;
    return full.length <= KIMI_SESSION_TITLE_MAX_LENGTH
        ? full
        : `${full.slice(0, KIMI_SESSION_TITLE_MAX_LENGTH - 1)}…`;
}
export function shortenForTitle(text, maxLength) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized)
        return "";
    if (normalized.length <= maxLength)
        return normalized;
    return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}
