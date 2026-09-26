// Offline evidence for D1 in docs/subscription-switching-spec.md.
// Execute selected, hash-pinned upstream pure functions with synthetic config.
// This is a counterexample probe, not a certification or feature implementation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { selectPinnedDeclarations, transpileProbe } from "./audit-source.js";

const root = process.argv[2];
if (!root || process.argv.length !== 3) {
  throw new Error("Usage: bun scripts/audit-subscription-routing.ts <exact-2.0.1-source-directory>");
}

const select = (file: string, hash: string, names: string[]) =>
  selectPinnedDeclarations(path.join(root, file), hash, names);

const code = [
  await select("packages/oauth/src/constants.ts", "030d2b874ba94b77a9b068ba502b6706addb7b90279122c8f91f5796d6205444", ["DEFAULT_KIMI_CODE_OAUTH_HOST"]),
  await select("packages/oauth/src/managed-usage.ts", "130afd97e8c8e9d3b53f8ccaaa7bb1181af1f878a2e5d5c72f53bfab4e46ece9", ["DEFAULT_KIMI_CODE_BASE_URL", "kimiCodeBaseUrl"]),
  await select("packages/oauth/src/managed-kimi-code.ts", "965265f113b15ac40ed02c0a262de7e6dfb8ac0b3097137f9d5285c595186d07", [
    "KIMI_CODE_OAUTH_KEY", "KIMI_CODE_SCOPED_OAUTH_KEY_PREFIX", "SHARED_DEFAULT_BASE_URLS",
    "defaultBaseUrl", "normalizeBaseUrl", "normalizeEndpoint", "persistedOAuthHost",
    "managedOAuthRef", "configuredOAuthRef", "kimiCodeEnvBaseUrl", "kimiCodeEnvOAuthHost",
    "resolveKimiCodeOAuthKey", "resolveKimiCodeOAuthRef", "resolveKimiCodeRuntimeAuth",
  ]),
  await select("packages/agent-core-v2/src/llm-adapter/model/model-auth.ts", "e18408281dd273071e5482f98c9fc179e5e66d5a9aa5e11a72b25b8194ec3a53", ["resolveEndpointBaseUrl", "nonEmpty"]),
  "globalThis.audit = { resolveKimiCodeRuntimeAuth, resolveEndpointBaseUrl };",
].join("\n");

type Ref = { key: string; oauthHost?: string; storage: string };
type Auth = { baseUrl: string; oauthRef: Ref };
const sandbox: {
  createHash: typeof createHash;
  process: { env: Record<string, string> };
  explainProviderEndpoint: () => never;
  audit?: {
    resolveKimiCodeRuntimeAuth: (options: { configuredBaseUrl: string; configuredOAuthRef?: Ref; env: Record<string, string> }) => Auth;
    resolveEndpointBaseUrl: (model: { baseUrl?: string }, provider: { baseUrl: string }) => string;
  };
} = {
  createHash,
  process: { env: {} }, // Never inherit host routing or authentication.
  explainProviderEndpoint: () => { throw new Error("Probe must stay on the configured endpoint path"); },
};
runInNewContext(transpileProbe(code), sandbox, { timeout: 1_000 });
assert.ok(sandbox.audit);
const api = sandbox.audit;
const profiles = [
  { region: "kimi.com", host: "https://auth.kimi.com", base: "https://api.kimi.com/coding/v1" },
  { region: "kimi.ai", host: "https://auth.kimi.ai", base: "https://api.kimi.ai/coding/v1" },
];
const cases = [];
for (const [i, configured] of profiles.entries()) {
  const alternate = profiles[1 - i]!;
  const initial = api.resolveKimiCodeRuntimeAuth({ configuredBaseUrl: configured.base,
    env: { KIMI_CODE_OAUTH_HOST: configured.host, KIMI_CODE_BASE_URL: configured.base } });
  const baseline = api.resolveKimiCodeRuntimeAuth({ configuredBaseUrl: configured.base,
    configuredOAuthRef: initial.oauthRef, env: {} });
  assert.equal(baseline.oauthRef.key, initial.oauthRef.key);
  assert.equal(baseline.baseUrl, configured.base);
  for (const modelHasEndpoint of [false, true]) {
    const runtime = api.resolveKimiCodeRuntimeAuth({ configuredBaseUrl: configured.base,
      configuredOAuthRef: initial.oauthRef,
      env: { KIMI_CODE_OAUTH_HOST: alternate.host, KIMI_CODE_BASE_URL: alternate.base } });
    const modelEndpoint = api.resolveEndpointBaseUrl(modelHasEndpoint ? { baseUrl: configured.base } : {}, { baseUrl: configured.base });
    assert.equal(runtime.baseUrl, alternate.base);
    // The default mainland slot intentionally omits its default OAuth host.
    assert.equal(runtime.oauthRef.oauthHost ?? profiles[0]!.host, alternate.host);
    assert.notEqual(runtime.oauthRef.key, initial.oauthRef.key);
    assert.equal(modelEndpoint, configured.base);
    assert.notEqual(runtime.baseUrl, modelEndpoint);
    cases.push({ configured: configured.region, requested: alternate.region,
      modelHasEndpoint, runtimeAuthEndpoint: runtime.baseUrl, configuredModelEndpoint: modelEndpoint,
      split: true });
  }
}
console.log(JSON.stringify({
  upstream: "2.0.1", commit: "caf7d4e2fef06967280b325da06e44a4b0516eba",
  result: "D1_BLOCKED", baselineControls: 2, counterexamples: cases,
  limitation: "Pure-function counterexamples with synthetic configuration; no HTTP request, credentials, or full lifecycle execution. Exit zero means the documented blocker reproduced, not that switching is supported.",
}, null, 2));
