import { RuntimeError } from "./errors.js";
export const KIMI_START_TIMEOUT_MS = 10_000;
export const KIMI_INITIALIZE_TIMEOUT_MS = 15_000;
export const KIMI_ASK_PROMPT_TIMEOUT_MS = 300_000;
export const KIMI_REVIEW_PROMPT_TIMEOUT_MS = 600_000;
export const KIMI_REVIEW_GATE_TIMEOUT_MS = 8_000;
export const KIMI_SETUP_INITIALIZE_TIMEOUT_MS = 5_000;
export const KIMI_SETUP_PROMPT_TIMEOUT_MS = 10_000;
const TIMEOUT_KIND_CODES = {
    startup: "STARTUP_TIMEOUT",
    initialize: "INITIALIZE_TIMEOUT",
    response: "RESPONSE_TIMEOUT",
};
export function isTimeoutCode(code) {
    return (code === "TIMEOUT" ||
        code === "STARTUP_TIMEOUT" ||
        code === "INITIALIZE_TIMEOUT" ||
        code === "RESPONSE_TIMEOUT");
}
export async function withTimeout(promise, timeoutMs, stage, kind) {
    const code = kind ? TIMEOUT_KIND_CODES[kind] : "TIMEOUT";
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new RuntimeError(code, `${stage} timed out after ${timeoutMs}ms.`, stage));
        }, timeoutMs);
        timer.unref();
    });
    try {
        return await Promise.race([promise, timeout]);
    }
    finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}
