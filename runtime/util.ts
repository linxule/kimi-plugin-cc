/** Small helpers shared across the runtime. Imports nothing. */

// Uses the global timer on purpose: tests observe globalThis.setTimeout.
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Collapse whitespace and cut to `max` characters, ending in an ellipsis when cut. */
export function shorten(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Where a smol-toml parse failed. Its own message quotes the neighbouring
 * source lines, and lines of kimi-code's config can hold credentials, so that
 * message must never reach an error, log or artifact.
 */
export function tomlErrorLocation(error: unknown): string {
  // `codeblock` marks a smol-toml TomlError; plain Errors also carry line/column under Bun.
  const { line, column, codeblock } = (typeof error === "object" && error !== null ? error : {}) as {
    line?: unknown;
    column?: unknown;
    codeblock?: unknown;
  };
  return typeof codeblock === "string" && typeof line === "number" && typeof column === "number"
    ? `syntax error at line ${line}, column ${column}`
    : "syntax error";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
