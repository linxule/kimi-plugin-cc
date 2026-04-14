import { RuntimeError } from "./errors.js";

export const KIMI_START_TIMEOUT_MS = 10_000;
export const KIMI_INITIALIZE_TIMEOUT_MS = 15_000;
export const KIMI_ASK_PROMPT_TIMEOUT_MS = 300_000;
export const KIMI_REVIEW_PROMPT_TIMEOUT_MS = 600_000;
export const KIMI_REVIEW_GATE_TIMEOUT_MS = 8_000;
export const KIMI_SETUP_INITIALIZE_TIMEOUT_MS = 5_000;
export const KIMI_SETUP_PROMPT_TIMEOUT_MS = 10_000;

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  stage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new RuntimeError("TIMEOUT", `${stage} timed out after ${timeoutMs}ms.`, stage));
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
