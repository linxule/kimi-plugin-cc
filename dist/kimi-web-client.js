// Minimal HTTP client for the local `kimi web` server. Used to rename plugin
// sessions so they show up in the web UI with a human-readable title instead
// of Kimi's auto-generated excerpt. All calls are best-effort: if kimi web is
// not running, we silently skip the rename. Kimi's session persistence does
// not depend on the web server — only the title update does.
//
// Kimi does not currently expose a non-interactive CLI flag or wire-protocol
// method for setting a session title. PATCH /api/sessions/{id} is the
// documented HTTP API that powers the web UI's own rename flow, so we use it
// directly. See 2026-04-15 investigation memo for the full protocol survey.
import { KIMI_SESSION_TITLE_MAX_LENGTH } from "./session-title.js";
export const DEFAULT_KIMI_WEB_BASE_URL = "http://127.0.0.1:5494";
export const KIMI_WEB_HEALTH_PATH = "/healthz";
export const KIMI_WEB_SESSION_PATH = "/api/sessions";
// 200ms keeps the health probe inside an inter-keystroke budget: sessions
// sit in the hot path of every managed command, and the Kimi meta review on
// 0.1.5 flagged 500ms as too generous when the server is reachable-but-slow.
const KIMI_WEB_HEALTH_TIMEOUT_MS = 200;
const KIMI_WEB_PATCH_TIMEOUT_MS = 2_000;
export function resolveKimiWebBaseUrl(env) {
    const override = env?.KIMI_PLUGIN_CC_WEB_URL?.trim();
    if (!override)
        return DEFAULT_KIMI_WEB_BASE_URL;
    return override.replace(/\/+$/, "");
}
// Join a base URL (e.g. `http://127.0.0.1:5494` or `http://127.0.0.1:5494/`)
// with an absolute path (e.g. `/healthz`) without producing a double slash.
// Uses the WHATWG URL parser so the result is always canonical. Note:
// `new URL("/x", "http://host/sub/")` drops `/sub/`, which is correct here
// because `baseUrl` is always an origin-only URL as produced by
// `resolveKimiWebBaseUrl` — never a URL with a path suffix.
function joinUrl(baseUrl, path) {
    return new URL(path, baseUrl).toString();
}
export function createKimiWebClient(options = {}) {
    const baseUrl = resolveKimiWebBaseUrl(options.env);
    const fetchImpl = options.fetchImpl ?? fetch;
    return {
        baseUrl,
        async healthCheck() {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), KIMI_WEB_HEALTH_TIMEOUT_MS);
            try {
                const response = await fetchImpl(joinUrl(baseUrl, KIMI_WEB_HEALTH_PATH), {
                    method: "GET",
                    signal: controller.signal,
                });
                return response.ok;
            }
            catch {
                return false;
            }
            finally {
                clearTimeout(timer);
            }
        },
        async setSessionTitle(sessionId, title) {
            const trimmed = title.trim();
            if (!trimmed) {
                return { ok: false, reason: "invalid-title", detail: "title is empty after trim" };
            }
            if (trimmed.length > KIMI_SESSION_TITLE_MAX_LENGTH) {
                return {
                    ok: false,
                    reason: "invalid-title",
                    detail: `title exceeds ${KIMI_SESSION_TITLE_MAX_LENGTH} chars`,
                };
            }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), KIMI_WEB_PATCH_TIMEOUT_MS);
            try {
                const response = await fetchImpl(joinUrl(baseUrl, `${KIMI_WEB_SESSION_PATH}/${encodeURIComponent(sessionId)}`), {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ title: trimmed }),
                    signal: controller.signal,
                });
                if (!response.ok) {
                    return { ok: false, reason: "rejected", detail: `HTTP ${response.status}` };
                }
                return { ok: true, title: trimmed };
            }
            catch (error) {
                return {
                    ok: false,
                    reason: "unreachable",
                    detail: error instanceof Error ? error.message : String(error),
                };
            }
            finally {
                clearTimeout(timer);
            }
        },
    };
}
// Best-effort helper for managed commands: rename the session if kimi web is
// reachable, otherwise silently skip. Returns the outcome so the caller can
// log or surface it, but never throws.
//
// Respects KIMI_PLUGIN_CC_DISABLE_WEB_ANNOUNCE=1 as a kill switch. Tests set
// this to avoid burning the hot-path health-probe budget on every command
// invocation and to prevent pollution of any developer's actual `kimi web`
// session index with spurious rename attempts for invalid test session ids.
export async function announceSessionTitle(sessionId, title, options = {}) {
    if (options.env?.KIMI_PLUGIN_CC_DISABLE_WEB_ANNOUNCE === "1") {
        return { ok: false, reason: "unreachable", detail: "disabled via env" };
    }
    const client = createKimiWebClient(options);
    const healthy = await client.healthCheck();
    if (!healthy) {
        return { ok: false, reason: "unreachable", detail: "healthz probe failed" };
    }
    return client.setSessionTitle(sessionId, title);
}
