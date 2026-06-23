import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  checkGeneratedCodexSurfaces,
  generatedCodexSurfaceFiles,
  verifyClaudeSurfaceHashes,
} from "../../scripts/generate-surfaces.js";
import {
  CODEX_MARKETPLACE,
  CODEX_PLUGIN_MANIFEST,
  CODEX_SKILLS,
} from "../../scripts/surface-registry.js";

const repoRoot = path.resolve(import.meta.dir, "..", "..");

describe("Codex sidecar surfaces", () => {
  test("Claude surface gate matches the checked-in Claude plugin bytes", async () => {
    const result = await verifyClaudeSurfaceHashes(repoRoot);
    expect(result.messages).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("generated Codex sidecars match the registry", async () => {
    const result = await checkGeneratedCodexSurfaces(repoRoot);
    expect(result.messages).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("Codex plugin manifest is shell-only and skill-backed", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(repoRoot, ".codex-plugin/plugin.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(manifest).toEqual(CODEX_PLUGIN_MANIFEST);
    expect(manifest.name).toBe("kimi");
    expect(manifest.skills).toBe("./skills/");
    expect(manifest).not.toHaveProperty("mcpServers");
    expect(manifest).not.toHaveProperty("hooks");
  });

  test("Codex marketplace points at the repo root without changing Claude ids", async () => {
    const marketplace = JSON.parse(
      await readFile(path.join(repoRoot, ".agents/plugins/marketplace.json"), "utf8"),
    ) as typeof CODEX_MARKETPLACE;

    expect(marketplace).toEqual(CODEX_MARKETPLACE);
    expect(marketplace.name).toBe("kimi-marketplace");
    expect(marketplace.plugins[0].name).toBe("kimi");
    expect(marketplace.plugins[0].source.path).toBe("./");
    expect(marketplace.plugins[0].policy.installation).toBe("AVAILABLE");
    expect(marketplace.plugins[0].policy.authentication).toBe("ON_INSTALL");
  });

  test("skill frontmatter and implicit-invocation policy are generated for every Codex skill", async () => {
    const generated = generatedCodexSurfaceFiles();

    for (const skill of CODEX_SKILLS) {
      const skillFile = generated.find((file) => file.path === `skills/${skill.name}/SKILL.md`);
      const openAiFile = generated.find(
        (file) => file.path === `skills/${skill.name}/agents/openai.yaml`,
      );

      expect(skillFile?.content).toContain(`name: ${skill.name}`);
      expect(skillFile?.content).toContain("Do not use MCP");
      expect(skillFile?.content).toContain(`"<plugin-root>/scripts/companion.sh" ${skill.command}`);
      expect(openAiFile?.content).toContain(`allow_implicit_invocation: ${skill.implicit ? "true" : "false"}`);
    }
  });
});
