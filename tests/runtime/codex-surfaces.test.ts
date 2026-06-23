import { describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  checkGeneratedCodexSurfaces,
  checkGeneratedTextOrphans,
  checkRuntimeMirror,
  generatedCodexSurfaceFiles,
  verifyClaudeSurfaceHashes,
} from "../../scripts/generate-surfaces.js";
import {
  CODEX_MARKETPLACE,
  CODEX_PLUGIN_MANIFEST,
  CODEX_PLUGIN_SUBDIR,
  CODEX_SKILLS,
  PLUGIN_VERSION,
} from "../../scripts/surface-registry.js";
import { KIMI_PLUGIN_CC_VERSION } from "../../runtime/version.js";
import { resolvePluginPaths } from "../../runtime/paths.js";

const repoRoot = path.resolve(import.meta.dir, "..", "..");

async function exists(relPath: string): Promise<boolean> {
  try {
    await access(path.join(repoRoot, relPath), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

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

  test("no orphaned generated text surfaces under the subfolder", async () => {
    const result = await checkGeneratedTextOrphans(repoRoot);
    expect(result.messages).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("bundled runtime mirror matches the root and has no orphans", async () => {
    const result = await checkRuntimeMirror(repoRoot);
    expect(result.messages).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("Codex plugin manifest is shell-only and skill-backed", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(repoRoot, CODEX_PLUGIN_SUBDIR, ".codex-plugin/plugin.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(manifest).toEqual(CODEX_PLUGIN_MANIFEST);
    expect(manifest.name).toBe("kimi");
    expect(manifest.skills).toBe("./skills/");
    expect(manifest).not.toHaveProperty("mcpServers");
    expect(manifest).not.toHaveProperty("hooks");
  });

  test("Codex marketplace stays at repo root and points into the subfolder", async () => {
    const marketplace = JSON.parse(
      await readFile(path.join(repoRoot, ".agents/plugins/marketplace.json"), "utf8"),
    ) as typeof CODEX_MARKETPLACE;

    expect(marketplace).toEqual(CODEX_MARKETPLACE);
    expect(marketplace.name).toBe("kimi-marketplace");
    expect(marketplace.plugins[0].name).toBe("kimi");
    expect(marketplace.plugins[0].source.path).toBe("./plugins/kimi-codex");
    expect(marketplace.plugins[0].policy.installation).toBe("AVAILABLE");
    expect(marketplace.plugins[0].policy.authentication).toBe("ON_INSTALL");
  });

  test("hook config is accepted by Codex's strict hook schema", async () => {
    const hooks = JSON.parse(
      await readFile(path.join(repoRoot, "hooks/hooks.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(Object.keys(hooks)).toEqual(["hooks"]);
    expect(hooks.hooks).toBeTruthy();
  });

  test("skill frontmatter and implicit-invocation policy are generated for every Codex skill", async () => {
    const generated = generatedCodexSurfaceFiles();

    for (const skill of CODEX_SKILLS) {
      const skillFile = generated.find(
        (file) => file.path === `${CODEX_PLUGIN_SUBDIR}/skills/${skill.name}/SKILL.md`,
      );
      const openAiFile = generated.find(
        (file) => file.path === `${CODEX_PLUGIN_SUBDIR}/skills/${skill.name}/agents/openai.yaml`,
      );

      expect(skillFile?.content).toContain(`name: ${skill.name}`);
      expect(skillFile?.content).toContain("Do not use MCP");
      expect(skillFile?.content).toContain(`"<plugin-root>/scripts/companion.sh" ${skill.command}`);
      expect(openAiFile?.content).toContain(
        `allow_implicit_invocation: ${skill.implicit ? "true" : "false"}`,
      );
    }
  });
});

describe("Codex/Claude surface separation", () => {
  test("repo root has NO skills/ dir (Claude Code must not auto-discover Codex skills)", async () => {
    expect(await exists("skills")).toBe(false);
  });

  test("repo root has NO .codex-plugin/ (Codex plugin root is the subfolder)", async () => {
    expect(await exists(".codex-plugin")).toBe(false);
  });

  test("the self-contained Codex subfolder holds skills, manifest, scripts, and bundled dist", async () => {
    expect(await exists(`${CODEX_PLUGIN_SUBDIR}/skills`)).toBe(true);
    expect(await exists(`${CODEX_PLUGIN_SUBDIR}/.codex-plugin/plugin.json`)).toBe(true);
    expect(await exists(`${CODEX_PLUGIN_SUBDIR}/scripts/companion.sh`)).toBe(true);
    expect(await exists(`${CODEX_PLUGIN_SUBDIR}/scripts/review-gate-hook.sh`)).toBe(true);
    expect(await exists(`${CODEX_PLUGIN_SUBDIR}/dist/companion.js`)).toBe(true);
  });

  test("bundled companion.sh is a byte copy of the root entrypoint", async () => {
    const root = await readFile(path.join(repoRoot, "scripts/companion.sh"));
    const bundled = await readFile(path.join(repoRoot, CODEX_PLUGIN_SUBDIR, "scripts/companion.sh"));
    expect(bundled.equals(root)).toBe(true);
  });
});

describe("version single-sourcing", () => {
  test("PLUGIN_VERSION === KIMI_PLUGIN_CC_VERSION === package.json version", async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      version: string;
    };
    expect(PLUGIN_VERSION).toBe(KIMI_PLUGIN_CC_VERSION);
    expect(PLUGIN_VERSION).toBe(pkg.version);
  });

  test("the generated Codex manifest carries the single-sourced version", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(repoRoot, CODEX_PLUGIN_SUBDIR, ".codex-plugin/plugin.json"), "utf8"),
    ) as { version: string };
    expect(manifest.version).toBe(KIMI_PLUGIN_CC_VERSION);
  });
});

describe("plugin data dir precedence (Claude vs Codex env aliases)", () => {
  test("CLAUDE_PLUGIN_DATA wins when both it and PLUGIN_DATA are set", () => {
    const resolved = resolvePluginPaths({
      CLAUDE_PLUGIN_DATA: "/tmp/claude-data",
      PLUGIN_DATA: "/tmp/codex-data",
    } as NodeJS.ProcessEnv);
    expect(resolved.claudePluginData).toBe("/tmp/claude-data");
  });

  test("PLUGIN_DATA is used as the Codex fallback when CLAUDE_PLUGIN_DATA is unset", () => {
    const resolved = resolvePluginPaths({ PLUGIN_DATA: "/tmp/codex-data" } as NodeJS.ProcessEnv);
    expect(resolved.claudePluginData).toBe("/tmp/codex-data");
  });
});
