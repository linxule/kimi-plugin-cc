import { describe, expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

import {
  checkGeneratedDshSurfaces,
  generatedDshSurfaceFiles,
} from "../../scripts/generate-surfaces.js";
import {
  DSH_BUNDLE_PATCH,
  DSH_DISCOVERY_INDEX,
  DSH_MCP_TOOL_NAMES,
  DSH_PLUGIN_PACKAGE_NAME,
  DSH_PUBLISH_TIMESTAMP,
  DSH_VERSION_RANGE,
} from "../../scripts/surface-registry.js";
import { KIMI_PLUGIN_CC_VERSION } from "../../runtime/version.js";

const repoRoot = path.resolve(import.meta.dir, "..", "..");

async function exists(relPath: string): Promise<boolean> {
  try {
    await access(path.join(repoRoot, relPath), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe("DSH generated surface", () => {
  test("generated root cordis.patch.yml and discovery index are current", async () => {
    const result = await checkGeneratedDshSurfaces(repoRoot);
    expect(result.messages).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("root package manifest points at ./cordis.patch.yml with no nested plugins/kimi-dsh tree", async () => {
    const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      name: string;
      version: string;
      dsh: { bundle: { patch: string } };
      engines: { dsh: string };
      exports: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    expect(manifest.name).toBe(DSH_PLUGIN_PACKAGE_NAME);
    expect(manifest.version).toBe(KIMI_PLUGIN_CC_VERSION);
    expect(manifest.dsh.bundle.patch).toBe("./cordis.patch.yml");
    expect(manifest.engines.dsh).toBe(DSH_VERSION_RANGE);
    expect(manifest.exports["./cordis.patch.yml"]).toBe("./cordis.patch.yml");
    expect(manifest.dependencies).toBeUndefined();
    expect(await exists("plugins/kimi-dsh")).toBe(false);
  });

  test("cordis.patch.yml mounts the 4-tool MCP client and canonical skill bundle without JS provider plugins", async () => {
    const patch = await readFile(path.join(repoRoot, "cordis.patch.yml"), "utf8");
    expect(patch).toBe(DSH_BUNDLE_PATCH);
    expect(patch).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(patch).toContain("serverName: kimi");
    expect(patch).toContain("transport: stdio");
    expect(patch).toContain("/scripts/companion.sh");
    expect(patch).toContain("toolCallTimeoutMs: 86400000");
    expect(patch).toContain("name: '@deepseek-ai/dsh-skill-filesystem'");
    expect(patch).toContain("providerName: kimi-plugin-cc");
    expect(patch).toContain("includeDefaultRoots: false");
    expect(patch).toContain("/skills");
    expect(patch).not.toContain("@deepseek-ai/dsh-tool-subagent");
    expect([...DSH_MCP_TOOL_NAMES]).toEqual([
      "mcp__kimi__kimi_read",
      "mcp__kimi__kimi_write",
      "mcp__kimi__kimi_job",
      "mcp__kimi__kimi_setup",
    ]);
  });

  test("generated DSH files are exactly cordis.patch.yml and dsh/index.json", () => {
    const files = generatedDshSurfaceFiles();
    expect(files.map((file) => file.path)).toEqual(["cordis.patch.yml", "dsh/index.json"]);
    for (const file of files) {
      expect(file.path).not.toContain("..");
    }
  });

  test("discovery index carries the current release metadata", async () => {
    const index = JSON.parse(await readFile(path.join(repoRoot, "dsh/index.json"), "utf8")) as typeof DSH_DISCOVERY_INDEX;
    expect(index).toEqual(DSH_DISCOVERY_INDEX);
    expect(index.plugins[0].versions[0].version).toBe(KIMI_PLUGIN_CC_VERSION);
    expect(index.plugins[0].versions[0].publishTimestamp).toBe(DSH_PUBLISH_TIMESTAMP);
    expect(index.plugins[0].versions[0].engines.dsh).toBe(DSH_VERSION_RANGE);
    expect(index.plugins[0].name).toBe(DSH_PLUGIN_PACKAGE_NAME);
  });
});
