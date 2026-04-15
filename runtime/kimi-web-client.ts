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
const KIMI_WEB_HEALTH_TIMEOUT_MS = 500;
const KIMI_WEB_PATCH_TIMEOUT_MS = 2_000;

export interface KimiWebClientOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface KimiWebClient {
  baseUrl: string;
  healthCheck(): Promise<boolean>;
  setSessionTitle(sessionId: string, title: string): Promise<KimiWebTitleResult>;
}

export type KimiWebTitleResult =
  | { ok: true; title: string }
  | { ok: false; reason: "unreachable" | "rejected" | "invalid-title"; detail?: string };

export function resolveKimiWebBaseUrl(env: NodeJS.ProcessEnv | undefined): string {
  const override = env?.KIMI_PLUGIN_CC_WEB_URL?.trim();
  if (!override) return DEFAULT_KIMI_WEB_BASE_URL;
  return override.replace(/\/+$/, "");
}

export function createKimiWebClient(options: KimiWebClientOptions = {}): KimiWebClient {
  const baseUrl = resolveKimiWebBaseUrl(options.env);
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    baseUrl,
    async healthCheck() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), KIMI_WEB_HEALTH_TIMEOUT_MS);
      try {
        const response = await fetchImpl(`${baseUrl}${KIMI_WEB_HEALTH_PATH}`, {
          method: "GET",
          signal: controller.signal,
        });
        return response.ok;
      } catch {
        return false;
      } finally {
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
        const response = await fetchImpl(
          `${baseUrl}${KIMI_WEB_SESSION_PATH}/${encodeURIComponent(sessionId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: trimmed }),
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          return { ok: false, reason: "rejected", detail: `HTTP ${response.status}` };
        }
        return { ok: true, title: trimmed };
      } catch (error) {
        return {
          ok: false,
          reason: "unreachable",
          detail: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// Best-effort helper for managed commands: rename the session if kimi web is
// reachable, otherwise silently skip. Returns the outcome so the caller can
// log or surface it, but never throws.
export async function announceSessionTitle(
  sessionId: string,
  title: string,
  options: KimiWebClientOptions = {},
): Promise<KimiWebTitleResult> {
  const client = createKimiWebClient(options);
  const healthy = await client.healthCheck();
  if (!healthy) {
    return { ok: false, reason: "unreachable", detail: "healthz probe failed" };
  }
  return client.setSessionTitle(sessionId, title);
}
