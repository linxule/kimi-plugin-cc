import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { access, constants } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const replayCommandPath = path.join(repoRoot, "commands", "replay.md");

describe("replay command surface", () => {
  test("commands/replay.md exists", async () => {
    await new Promise<void>((resolve, reject) => {
      access(replayCommandPath, constants.R_OK, (err) =>
        err ? reject(new Error(`commands/replay.md does not exist: ${err.message}`)) : resolve(),
      );
    });
  });

  test("commands/replay.md contains companion.sh invocation", async () => {
    const content = await readFile(replayCommandPath, "utf8");
    expect(content).toContain("companion.sh replay");
  });

  test("commands/replay.md has disable-model-invocation: true in frontmatter", async () => {
    const content = await readFile(replayCommandPath, "utf8");
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatterMatch).toBeTruthy();
    expect(frontmatterMatch![1]).toContain("disable-model-invocation: true");
  });
});
