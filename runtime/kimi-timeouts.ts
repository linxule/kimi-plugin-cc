import { RuntimeError } from "./errors.js";

export const KIMI_START_TIMEOUT_MS = 10_000;
export const KIMI_INITIALIZE_TIMEOUT_MS = 15_000;
export const KIMI_ASK_PROMPT_TIMEOUT_MS = 300_000;
export const KIMI_REVIEW_PROMPT_TIMEOUT_MS = 600_000;
export const KIMI_REVIEW_GATE_TIMEOUT_MS = 8_000;
export const KIMI_SETUP_INITIALIZE_TIMEOUT_MS = 5_000;
export const KIMI_SETUP_PROMPT_TIMEOUT_MS = 10_000;

/**
 * Discriminates which lifecycle phase a timeout fired during. Lets callers
 * (and downstream classifiers) distinguish "Kimi never started" from "Kimi
 * started but never responded" — historically both surfaced as `TIMEOUT`.
 */
export type TimeoutKind = "startup" | "initialize" | "response";

const TIMEOUT_KIND_CODES: Record<TimeoutKind, string> = {
  startup: "STARTUP_TIMEOUT",
  initialize: "INITIALIZE_TIMEOUT",
  response: "RESPONSE_TIMEOUT",
};

export function isTimeoutCode(code: string): boolean {
  return (
    code === "TIMEOUT" ||
    code === "STARTUP_TIMEOUT" ||
    code === "INITIALIZE_TIMEOUT" ||
    code === "RESPONSE_TIMEOUT"
  );
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  stage: string,
  kind?: TimeoutKind,
): Promise<T> {
  const code = kind ? TIMEOUT_KIND_CODES[kind] : "TIMEOUT";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new RuntimeError(code, `${stage} timed out after ${timeoutMs}ms.`, stage));
    }, timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
