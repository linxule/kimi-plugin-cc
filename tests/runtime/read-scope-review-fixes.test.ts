import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decideHookOutcome } from "../../runtime/hooks/approval-policy.js";

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
