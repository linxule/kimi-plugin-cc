import { describe, expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

import {
  checkGeneratedCodexSurfaces,
  checkGeneratedTextOrphans,
  checkRuntimeMirror,
  generatedCodexSurfaceFiles,
  verifyClaudeSurfaceHashes,
} from "../../scripts/generate-surfaces.js";
import {
  CANONICAL_SKILL_FILES,
  CANONICAL_SKILL_NAME,
  CODEX_MARKETPLACE,
  CODEX_MCP_CONFIG,
  CODEX_PLUGIN_MANIFEST,
  CODEX_PLUGIN_SUBDIR,
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

describe("Universal & Codex surfaces", () => {
  test("root surface gate matches the checked-in manifests, MCP configs, and canonical skill", async () => {
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

  test("Codex plugin manifest declares the single canonical skill and MCP launch config", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(repoRoot, CODEX_PLUGIN_SUBDIR, ".codex-plugin/plugin.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(manifest).toEqual(CODEX_PLUGIN_MANIFEST);
    expect(manifest.name).toBe("kimi");
    expect(manifest.skills).toBe("./skills/");
    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(manifest).not.toHaveProperty("hooks");
  });

  test("Claude MCP discovery launches the plugin companion with the project workspace", async () => {
    const mcp = JSON.parse(await readFile(path.join(repoRoot, ".mcp.json"), "utf8"));

    expect(mcp).toEqual({
      mcpServers: {
        kimi: {
          command: "${CLAUDE_PLUGIN_ROOT}/scripts/companion.sh",
          args: ["mcp"],
          env: {
            KIMI_PLUGIN_CC_MCP_WORKSPACE: "${CLAUDE_PROJECT_DIR}",
          },
        },
      },
    });
  });

  test("Codex MCP launch is plugin-relative and excludes host-split and dangerous environment variables", async () => {
    const supportedEnvVars = [
      "KIMI_PLUGIN_CC_DATA",
      "XDG_DATA_HOME",
      "LOCALAPPDATA",
      "KIMI_CODE_HOME",
      "KIMI_PLUGIN_CC_KIMI_BIN",
      "KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS",
      "KIMI_PLUGIN_CC_NODE_BIN",
      "KIMI_PLUGIN_CC_HOOK_SCRIPT",
      "KIMI_PLUGIN_CC_STRICT_VERSIONS",
      "KIMI_MODEL_NAME",
      "KIMI_MODEL_API_KEY",
      "KIMI_MODEL_PROVIDER_TYPE",
      "KIMI_MODEL_BASE_URL",
      "KIMI_MODEL_THINKING_EFFORT",
    ];
    const mcp = JSON.parse(
      await readFile(path.join(repoRoot, CODEX_PLUGIN_SUBDIR, ".mcp.json"), "utf8"),
    ) as {
      mcpServers: {
        kimi: {
          type: string;
          command: string;
          args: string[];
          cwd: string;
          env_vars: string[];
        };
      };
    };

    expect(mcp).toEqual(JSON.parse(JSON.stringify(CODEX_MCP_CONFIG)));
    expect(mcp.mcpServers.kimi.env_vars).toEqual(supportedEnvVars);

    for (const name of [
      "CLAUDE_PLUGIN_DATA",
      "PLUGIN_DATA",
      "KIMI_PLUGIN_CC_HOST_ID",
      "CLAUDE_PLUGIN_ROOT",
      "PLUGIN_ROOT",
      "CLAUDE_PROJECT_DIR",
      "KIMI_PLUGIN_CC_MCP_WORKSPACE",
      "KIMI_PLUGIN_CC_WORKSPACE_ROOT",
      "KIMI_PLUGIN_CC_WORKSPACE_CWD",
      "KIMI_PLUGIN_CC_SKIP_HOOK_CHECK",
      "KIMI_PLUGIN_CC_SKIP_VERSION_PROBE",
      "KIMI_CODE_TRUST_WORKSPACE",
      "KIMI_CODE_LEGACY_FLAG",
      "KIMI_CODE_EXPERIMENTAL_FLAG",
      "KIMI_CODE_EXPERIMENTAL_TOWER",
      "KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK",
      "KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND",
      "KIMI_PLUGIN_CC_READ_ROOTS",
      "KIMI_PLUGIN_CC_NETWORK",
    ]) {
      expect(mcp.mcpServers.kimi.env_vars).not.toContain(name);
    }
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

  test("canonical kimi skill is mirrored verbatim into plugins/kimi-codex", async () => {
    const generated = generatedCodexSurfaceFiles(repoRoot);
    const skillPath = `${CODEX_PLUGIN_SUBDIR}/skills/${CANONICAL_SKILL_NAME}/SKILL.md`;
    const openAiPath = `${CODEX_PLUGIN_SUBDIR}/skills/${CANONICAL_SKILL_NAME}/agents/openai.yaml`;
    const skillFile = generated.find((file) => file.path === skillPath);
    const openAiFile = generated.find((file) => file.path === openAiPath);

    expect(CANONICAL_SKILL_FILES).toEqual([
      "skills/kimi/SKILL.md",
      "skills/kimi/agents/openai.yaml",
    ]);
    expect(skillFile?.content).toContain("name: kimi");
    for (const tool of ["kimi_read", "kimi_write", "kimi_job", "kimi_setup"]) {
      expect(skillFile?.content).toContain(tool);
    }
    expect(skillFile?.content).toContain("scripts/companion.sh");
    expect(openAiFile?.content).toBe(
      await readFile(path.join(repoRoot, "skills/kimi/agents/openai.yaml"), "utf8"),
    );
  });
});

describe("Universal packaging layout", () => {
  test("repo root carries the canonical skills/kimi/ and Antigravity manifests, with legacy hooks removed", async () => {
    expect(await exists("skills/kimi/SKILL.md")).toBe(true);
    expect(await exists("skills/kimi/agents/openai.yaml")).toBe(true);
    expect(await exists("plugin.json")).toBe(true);
    expect(await exists("mcp_config.json")).toBe(true);
    expect(await exists("assets/logo.svg")).toBe(true);
    expect(await exists(".codex-plugin")).toBe(false);
    expect(await exists("hooks/hooks.json")).toBe(false);
    expect(await exists("scripts/review-gate-hook.sh")).toBe(false);
  });

  test("the self-contained Codex subfolder holds the canonical skill, manifest, companion.sh, and bundled dist", async () => {
    expect(await exists(`${CODEX_PLUGIN_SUBDIR}/skills/kimi/SKILL.md`)).toBe(true);
    expect(await exists(`${CODEX_PLUGIN_SUBDIR}/.codex-plugin/plugin.json`)).toBe(true);
    expect(await exists(`${CODEX_PLUGIN_SUBDIR}/.mcp.json`)).toBe(true);
    expect(await exists(`${CODEX_PLUGIN_SUBDIR}/scripts/companion.sh`)).toBe(true);
    expect(await exists(`${CODEX_PLUGIN_SUBDIR}/scripts/review-gate-hook.sh`)).toBe(false);
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

describe("canonical shared plugin data root", () => {
  test("KIMI_PLUGIN_CC_DATA is the sole env override and ignores legacy host variables", () => {
    const resolved = resolvePluginPaths({
      KIMI_PLUGIN_CC_TEST_NO_DEFAULT_DATA: "1",
      CLAUDE_PLUGIN_DATA: "/tmp/claude-data",
      PLUGIN_DATA: "/tmp/codex-data",
      KIMI_PLUGIN_CC_DATA: "/tmp/selected-kimi-data",
    });
    expect(resolved.dataRoot).toBe("/tmp/selected-kimi-data");
    expect(resolved.claudePluginData).toBe("/tmp/selected-kimi-data");
  });

  test("legacy host data variables alone do not satisfy data-root resolution when default data is disabled", () => {
    expect(() =>
      resolvePluginPaths({
        KIMI_PLUGIN_CC_TEST_NO_DEFAULT_DATA: "1",
        CLAUDE_PLUGIN_DATA: "/tmp/claude-data",
        PLUGIN_DATA: "/tmp/codex-data",
      } as NodeJS.ProcessEnv),
    ).toThrow(/KIMI_PLUGIN_CC_DATA|data/i);
  });
});
