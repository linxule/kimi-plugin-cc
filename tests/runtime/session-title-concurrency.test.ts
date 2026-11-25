import { afterAll, describe, expect, mock, test } from "bun:test";
import * as realFs from "node:fs/promises";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

// Runs a callback after the temp state file is written and before the atomic
// replacement re-reads state.json: the window a concurrent writer can hit.
// Bun patches the module namespace in place, so keep the original binding and
// restore it for later test files in the same process.
const originalWriteFile = realFs.writeFile;
let afterTempWrite: (() => Promise<void>) | undefined;
mock.module("node:fs/promises", () => ({
  ...realFs,
  writeFile: async (...args: Parameters<typeof originalWriteFile>) => {
    await originalWriteFile(...args);
    if (String(args[0]).endsWith(".tmp") && afterTempWrite) {
      const hook = afterTempWrite;
      afterTempWrite = undefined;
      await hook();
    }
  },
}));
afterAll(() => { mock.module("node:fs/promises", () => ({ ...realFs, writeFile: originalWriteFile })); });
const { syncKimiSessionTitle } = await import("../../runtime/session-title.js");

describe("syncKimiSessionTitle concurrent change", () => {
  test("a state change between read and write means no write", async () => {
    const home = await createTestPluginDataRoot("kimi-v2-concurrent");
    const id = "session_concurrent";
    try {
      const sessionDir = path.join(home, "sessions", "wd_repo_123", id);
      await mkdir(sessionDir, { recursive: true });
      await originalWriteFile(path.join(home, "session_index.jsonl"), `${JSON.stringify({ sessionId: id, sessionDir })}\n`);
      const statePath = path.join(sessionDir, "state.json");
      await originalWriteFile(statePath, JSON.stringify({ id, version: 2, title: "Manual", titleKind: "custom", lastPrompt: "Older request" }));
      const concurrent = JSON.stringify({ id, version: 2, title: "Manual", titleKind: "custom", lastPrompt: "Typed natively meanwhile" });
      afterTempWrite = () => originalWriteFile(statePath, concurrent);
      expect(await syncKimiSessionTitle({ env: { KIMI_CODE_HOME: home }, sessionId: id,
        title: "Kimi Ask: New request", promptText: "New request" })).toBe("state-changed");
      expect(afterTempWrite).toBeUndefined();
      expect(await readFile(statePath, "utf8")).toBe(concurrent);
      expect((await readdir(sessionDir)).sort()).toEqual(["state.json"]);
    } finally {
      afterTempWrite = undefined;
      await cleanupTestPath(home);
    }
  });
});
