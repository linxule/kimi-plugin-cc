import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertNetworkResumeConfined } from "../../runtime/commands/cli-helpers.js";
import { decideHookOutcome } from "../../runtime/hooks/approval-policy.js";
import { serializeReadScope } from "../../runtime/read-scope.js";

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
