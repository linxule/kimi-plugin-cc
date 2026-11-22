import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

const exec = promisify(execFile);

test("emitted JavaScript resolves and terminates its redaction worker under Node", async () => {
  const root = await createTestPluginDataRoot("redaction-compiled");
  try {
    await writeFile(
      path.join(root, ".kimi-plugin.toml"),
      `[redaction]\npatterns = ["secret-[A-Za-z0-9]+"]\n`,
      "utf8",
    );
    const moduleUrl = pathToFileURL(path.join(process.cwd(), "dist/redaction.js")).href;
    const { stdout, stderr } = await exec("node", [
      "--input-type=module",
      "--eval",
      `import { redactPromptForWorkspace } from ${JSON.stringify(moduleUrl)};
       const result = await redactPromptForWorkspace(process.argv[1], "before secret-Ab123 after");
       process.stdout.write(JSON.stringify(result));`,
      root,
    ]);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ text: "before [REDACTED-0] after", replacements: 1 });
  } finally {
    await cleanupTestPath(root);
  }
});
