import { describe, expect, test } from "bun:test";

import {
  DEFAULT_KIMI_WEB_BASE_URL,
  announceSessionTitle,
  createKimiWebClient,
  resolveKimiWebBaseUrl,
} from "../../runtime/kimi-web-client.js";

type FetchRecord = {
  url: string;
  method: string;
  body?: string;
};

interface StubResponse {
  ok: boolean;
  status: number;
}

function makeFetchStub(handler: (url: string, init: RequestInit) => StubResponse | Error) {
  const calls: FetchRecord[] = [];
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = input instanceof URL ? input.toString() : String(input);
    calls.push({
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : undefined,
    });
    const result = handler(url, init);
    if (result instanceof Error) throw result;
    return {
      ok: result.ok,
      status: result.status,
    } as Response;
  };
  return { fetchImpl: fn as unknown as typeof fetch, calls };
}

describe("resolveKimiWebBaseUrl", () => {
  test("defaults to the local kimi web port", () => {
    expect(resolveKimiWebBaseUrl({})).toBe(DEFAULT_KIMI_WEB_BASE_URL);
  });

  test("respects KIMI_PLUGIN_CC_WEB_URL override and strips trailing slashes", () => {
    expect(resolveKimiWebBaseUrl({ KIMI_PLUGIN_CC_WEB_URL: "http://example.test:8080/" })).toBe(
      "http://example.test:8080",
    );
  });

  test("ignores whitespace-only override", () => {
    expect(resolveKimiWebBaseUrl({ KIMI_PLUGIN_CC_WEB_URL: "   " })).toBe(DEFAULT_KIMI_WEB_BASE_URL);
  });
});

describe("createKimiWebClient.healthCheck", () => {
  test("returns true when /healthz is reachable and 2xx", async () => {
    const { fetchImpl, calls } = makeFetchStub(() => ({ ok: true, status: 200 }));
    const client = createKimiWebClient({ fetchImpl });
    expect(await client.healthCheck()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${DEFAULT_KIMI_WEB_BASE_URL}/healthz`);
  });

  test("returns false when /healthz rejects", async () => {
    const { fetchImpl } = makeFetchStub(() => ({ ok: false, status: 500 }));
    const client = createKimiWebClient({ fetchImpl });
    expect(await client.healthCheck()).toBe(false);
  });

  test("returns false when fetch throws", async () => {
    const { fetchImpl } = makeFetchStub(() => new Error("ECONNREFUSED"));
    const client = createKimiWebClient({ fetchImpl });
    expect(await client.healthCheck()).toBe(false);
  });
});

describe("createKimiWebClient.setSessionTitle", () => {
  test("sends PATCH with JSON body containing the trimmed title", async () => {
    const { fetchImpl, calls } = makeFetchStub(() => ({ ok: true, status: 200 }));
    const client = createKimiWebClient({ fetchImpl });
    const result = await client.setSessionTitle("abc-123", "  Kimi Task: hello  ");
    expect(result).toEqual({ ok: true, title: "Kimi Task: hello" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe(`${DEFAULT_KIMI_WEB_BASE_URL}/api/sessions/abc-123`);
    expect(JSON.parse(calls[0].body!)).toEqual({ title: "Kimi Task: hello" });
  });

  test("percent-encodes the session id in the URL path", async () => {
    const { fetchImpl, calls } = makeFetchStub(() => ({ ok: true, status: 200 }));
    const client = createKimiWebClient({ fetchImpl });
    await client.setSessionTitle("id with space", "title");
    expect(calls[0].url).toBe(`${DEFAULT_KIMI_WEB_BASE_URL}/api/sessions/id%20with%20space`);
  });

  test("rejects empty-after-trim titles without calling fetch", async () => {
    const { fetchImpl, calls } = makeFetchStub(() => ({ ok: true, status: 200 }));
    const client = createKimiWebClient({ fetchImpl });
    const result = await client.setSessionTitle("abc", "   ");
    expect(result).toMatchObject({ ok: false, reason: "invalid-title" });
    expect(calls).toHaveLength(0);
  });

  test("rejects titles over the 200-char API limit without calling fetch", async () => {
    const { fetchImpl, calls } = makeFetchStub(() => ({ ok: true, status: 200 }));
    const client = createKimiWebClient({ fetchImpl });
    const result = await client.setSessionTitle("abc", "x".repeat(201));
    expect(result).toMatchObject({ ok: false, reason: "invalid-title" });
    expect(calls).toHaveLength(0);
  });

  test("reports 'rejected' on 4xx/5xx response", async () => {
    const { fetchImpl } = makeFetchStub(() => ({ ok: false, status: 404 }));
    const client = createKimiWebClient({ fetchImpl });
    const result = await client.setSessionTitle("missing-session", "title");
    expect(result).toEqual({ ok: false, reason: "rejected", detail: "HTTP 404" });
  });

  test("reports 'unreachable' when fetch throws", async () => {
    const { fetchImpl } = makeFetchStub(() => new Error("ECONNREFUSED"));
    const client = createKimiWebClient({ fetchImpl });
    const result = await client.setSessionTitle("abc", "title");
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
  });
});

describe("announceSessionTitle", () => {
  test("skips PATCH when health check fails", async () => {
    const { fetchImpl, calls } = makeFetchStub((url) => {
      if (url.endsWith("/healthz")) return new Error("down");
      return { ok: true, status: 200 };
    });
    const result = await announceSessionTitle("abc", "title", { fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
    expect(calls).toHaveLength(1); // only the healthz probe
    expect(calls[0].url).toEndWith("/healthz");
  });

  test("patches when health check succeeds", async () => {
    const { fetchImpl, calls } = makeFetchStub(() => ({ ok: true, status: 200 }));
    const result = await announceSessionTitle("abc", "Kimi Task: hello", { fetchImpl });
    expect(result).toEqual({ ok: true, title: "Kimi Task: hello" });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toEndWith("/healthz");
    expect(calls[1].method).toBe("PATCH");
    expect(calls[1].url).toEndWith("/api/sessions/abc");
  });

  test("never throws on any failure path", async () => {
    const { fetchImpl } = makeFetchStub(() => new Error("boom"));
    const result = await announceSessionTitle("abc", "title", { fetchImpl });
    expect(result.ok).toBe(false);
  });
});
