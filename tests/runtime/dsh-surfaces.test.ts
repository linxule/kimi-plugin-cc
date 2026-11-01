import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  checkGeneratedDshSurfaces,
  checkGeneratedDshTextOrphans,
  checkRuntimeMirror,
  generatedDshSurfaceFiles,
} from "../../scripts/generate-surfaces.js";
import {
  DSH_BUNDLE_PATCH,
  DSH_OPERATION_NAMES,
  DSH_PLUGIN_MANIFEST,
  DSH_PLUGIN_SUBDIR,
  DSH_VERSION_RANGE,
} from "../../scripts/surface-registry.js";
import { DSH_COMPANION_OPERATIONS } from "../../runtime/dsh/companion.js";
import { KIMI_PLUGIN_CC_VERSION } from "../../runtime/version.js";

const repoRoot = path.resolve(import.meta.dir, "..", "..");

describe("DSH generated surface", () => {
  test("generated manifest, composition, and documentation are current", async () => {
    const result = await checkGeneratedDshSurfaces(repoRoot);
    expect(result.messages).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("no orphaned generated text files sit at the DSH package root", async () => {
    const result = await checkGeneratedDshTextOrphans(repoRoot);
    expect(result.messages).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("bundled runtime matches the root and has no orphans", async () => {
    const result = await checkRuntimeMirror(repoRoot, DSH_PLUGIN_SUBDIR);
    expect(result.messages).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("package manifest points at the compiled provider and carries single-sourced versions", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(repoRoot, DSH_PLUGIN_SUBDIR, "package.json"), "utf8"),
    ) as typeof DSH_PLUGIN_MANIFEST;
    expect(manifest).toEqual(DSH_PLUGIN_MANIFEST);
    expect(manifest.version).toBe(KIMI_PLUGIN_CC_VERSION);
    expect(manifest.main).toBe("dist/dsh/index.js");
    expect(manifest.dsh.bundle.patch).toBe("./cordis.patch.yml");
    expect(manifest.engines.dsh).toBe(DSH_VERSION_RANGE);
    expect(manifest.dependencies["@deepseek-ai/dsh-tool-subagent"]).toBe(DSH_VERSION_RANGE);
  });

  test("composition and runtime expose the same seven delegation tools", () => {
    expect([...DSH_OPERATION_NAMES]).toEqual([...DSH_COMPANION_OPERATIONS]);
    for (const operation of DSH_OPERATION_NAMES) {
      expect(DSH_BUNDLE_PATCH).toContain(`provider: kimi-${operation}`);
      expect(DSH_BUNDLE_PATCH).toContain(`toolName: kimi_${operation.replaceAll("-", "_")}`);
    }
    expect(DSH_BUNDLE_PATCH.match(/name: '@deepseek-ai\/dsh-tool-subagent'/g)).toHaveLength(7);
  });

  test("compiled provider uses DSH function-plugin exports and no default export", async () => {
    const provider = await import(path.join(repoRoot, DSH_PLUGIN_SUBDIR, "dist/dsh/index.js"));
    expect(provider.name).toBe("kimi-plugin-cc");
    expect(provider.inject).toEqual(["subagents", "subprocess"]);
    expect(provider.apply).toBeFunction();
    expect(provider.Config).toBeFunction();
    expect(provider).not.toHaveProperty("default");
  });

  test("generated files stay inside the self-contained DSH package", () => {
    for (const file of generatedDshSurfaceFiles()) {
      expect(file.path.startsWith(`${DSH_PLUGIN_SUBDIR}/`)).toBe(true);
      expect(file.path).not.toContain("..");
    }
  });
});
