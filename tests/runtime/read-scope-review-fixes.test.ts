import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertNetworkResumeConfined } from "../../runtime/commands/cli-helpers.js";
import { decideHookOutcome } from "../../runtime/hooks/approval-policy.js";
import { isAllowedFetchUrl, parseScopeEnvironment, readScopeEnvironment, resolveReadScope, serializeReadScope } from "../../runtime/read-scope.js";

let base: string;
let workspace: string;
let narrow: string;
let wide: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "kimi-read-scope-fixes-")));
  workspace = path.join(base, "workspace");
  wide = path.join(base, "wide");
  narrow = path.join(wide, "narrow");
  for (const dir of [workspace, narrow]) await mkdir(dir, { recursive: true });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("S-1 path spellings the hook and kimi-code could resolve differently are denied", () => {
  const scope = () => ({ readRoots: JSON.stringify([workspace]) });
  test.each([
    ["Read", { path: "\\etc\\passwd" }],
    ["Read", { path: "..\\..\\etc\\passwd" }],
    ["Read", { path: "src\\a.ts" }],
    ["Read", { path: "C:\\Windows\\win.ini" }],
    ["Read", { path: "C:x" }],
    ["ReadMediaFile", { path: "\\etc\\x.png" }],
    ["Grep", { pattern: "x", path: "\\etc" }],
    ["Grep", { pattern: "x", path: "C:/" }],
    ["Grep", { pattern: "x", glob: "\\etc\\**" }],
    ["Glob", { pattern: "*.ts", path: "..\\.." }],
    ["Glob", { pattern: "\\etc\\*" }],
    ["Glob", { pattern: "C:/*" }],
  ] as const)("%s %j", async (tool_name, tool_input) => {
    const result = await decideHookOutcome({ tool_name, tool_input }, { commandLabel: "ask", ...scope() });
    expect(result.decision).toBe("deny");
  });

  test("ordinary forward-slash spellings inside the root stay allowed", async () => {
    for (const [tool_name, tool_input] of [
      ["Read", { path: "src/a.ts" }],
      ["Grep", { pattern: "a\\.b", glob: "*.ts" }],
      ["Glob", { pattern: "**/*.ts" }],
    ] as const) {
      expect(await decideHookOutcome({ tool_name, tool_input }, { commandLabel: "ask", ...scope() }))
        .toEqual({ decision: "allow" });
    }
  });
});

describe("S-1 roots whose spelling kimi-code would resolve differently are refused", () => {
  let slashed: string;
  beforeAll(async () => {
    slashed = path.join(base, "a\\b");
    await mkdir(slashed, { recursive: true });
  });

  test("a --read-root or workspace with a backslash refuses before spawn", async () => {
    await expect(resolveReadScope([slashed], undefined, "ask.parse")).rejects.toMatchObject({ code: "INVALID_ARGS" });
    expect(() => readScopeEnvironment({ readRoots: [], network: true }, slashed))
      .toThrow(expect.objectContaining({ code: "READ_SCOPE_INVALID" }));
  });

  test("the hook fails closed on a backslash root", () => {
    expect(parseScopeEnvironment(JSON.stringify([slashed]), undefined)).toEqual({ confined: true, roots: [], network: false });
  });
});

describe("S-2 networked resume requires earlier roots inside the current roots", () => {
  const job = (id: string, cwd: string, readRoots: string[], resumedFrom: string | null = null) => ({
    job_id: id, cwd, resumed_from_job_id: resumedFrom,
    read_scope: serializeReadScope({ readRoots, network: false }) ?? serializeReadScope({ readRoots: [], network: true }),
  });
  const store = (jobs: ReturnType<typeof job>[]) => ({
    listJobsBySessionId: () => jobs,
    getJob: (id: string) => jobs.find((entry) => entry.job_id === id) ?? null,
  }) as never;
  const resolution = (sourceId: string) =>
    ({ reusedSession: true, kimiSessionId: "s", resumedFromJobId: sourceId, sourceJob: { job_id: sourceId } }) as never;

  test("an earlier --read-root / or a wider earlier root refuses", () => {
    for (const history of [[job("a", workspace, ["/"])], [job("a", workspace, [wide])]]) {
      expect(() => assertNetworkResumeConfined(store(history), "ask", resolution("a"), [workspace, narrow]))
        .toThrow(expect.objectContaining({ code: "INVALID_ARGS", message: expect.stringContaining("ask --fresh --network") }));
    }
  });

  test("an earlier workspace outside the current roots refuses, including on the resume chain", () => {
    expect(() => assertNetworkResumeConfined(store([job("a", base, [])]), "ask", resolution("a"), [workspace]))
      .toThrow(expect.objectContaining({ code: "INVALID_ARGS" }));
    const chain = [job("b", workspace, [], "a"), job("a", workspace, [wide])];
    const sessionOnly = { listJobsBySessionId: () => [chain[0]], getJob: (id: string) => chain.find((entry) => entry.job_id === id) ?? null } as never;
    expect(() => assertNetworkResumeConfined(sessionOnly, "ask", resolution("b"), [workspace, narrow]))
      .toThrow(expect.objectContaining({ code: "INVALID_ARGS" }));
  });

  test("earlier roots equal to or inside the current roots are allowed", () => {
    expect(() => assertNetworkResumeConfined(store([job("a", workspace, [narrow])]), "ask", resolution("a"), [workspace, wide]))
      .not.toThrow();
    expect(() => assertNetworkResumeConfined(store([job("a", path.join(workspace), [])]), "ask", resolution("a"), [workspace]))
      .not.toThrow();
  });
});

describe("S-3 FetchURL allows only global unicast literals", () => {
  test.each([
    "http://192.0.0.8/", "http://192.0.2.1/", "http://198.18.0.1/", "http://198.19.255.255/", "http://198.51.100.7/",
    "http://203.0.113.9/", "http://224.0.0.251/", "http://239.255.255.250/", "http://240.0.0.1/", "http://255.255.255.255/",
    "http://[ff02::1]/", "http://[2001:db8::1]/", "http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/", "http://[2002:7f00:1::]/",
    "http://[64:ff9b::7f00:1]/", "http://[64:ff9b::a00:1]/", "http://[::ffff:8.8.8.8]/", "http://[100::1]/", "http://[4000::1]/",
  ])("denies %s", (url) => {
    expect(isAllowedFetchUrl(url)).toBe(false);
  });

  test.each([
    "https://8.8.8.8/", "https://198.20.0.1/", "https://223.255.255.1/", "https://[2606:4700::1111]/",
    "https://[2001:4860:4860::8888]/", "https://[64:ff9b::808:808]/", "https://example.com/",
  ])("allows %s", (url) => {
    expect(isAllowedFetchUrl(url)).toBe(true);
  });
});
