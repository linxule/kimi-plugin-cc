import { KIMI_PLUGIN_CC_VERSION } from "../runtime/version.js";

export const PLUGIN_NAME = "kimi";
export const MARKETPLACE_NAME = "kimi-marketplace";
// Single source of truth: the Codex manifest/marketplace and DSH index derive
// from runtime/version.ts so a release bump propagates without a second edit.
export const PLUGIN_VERSION = KIMI_PLUGIN_CC_VERSION;

// Self-contained Codex plugin root. Codex copies this directory to its install
// cache and forbids ../ escapes, so it mirrors the canonical skill, companion.sh,
// and compiled dist/ inside the subfolder.
export const CODEX_PLUGIN_SUBDIR = "plugins/kimi-codex";

export const CANONICAL_SKILL_NAME = "kimi";
export const CANONICAL_SKILL_FILES = [
  "skills/kimi/SKILL.md",
  "skills/kimi/agents/openai.yaml",
] as const;

export interface ClaudeSurfaceHash {
  path: string;
  sha256: string;
}

export const CLAUDE_SURFACE_HASHES: readonly ClaudeSurfaceHash[] = [
  { path: ".claude-plugin/plugin.json", sha256: "8ca513c5126ccbcb72edb802a147944c215a7433a825e5e8777273e76e3772fe" },
  { path: ".claude-plugin/marketplace.json", sha256: "3f3aea040c98c3cca3285a913eeb812294e563b4af4d68b09affd8f22d16724c" },
  { path: ".mcp.json", sha256: "a48d8f07eed5d99bafba5b11a0fdb681ab4960b59c53ea68c7c04e350f618ded" },
  { path: "plugin.json", sha256: "4a9cdaa07e7ade93956396b5f53ec9cdcdf8bfa0510fd7ed2c91416d59882b5d" },
  { path: "mcp_config.json", sha256: "0be7f9fbb8a75863bf96738b99e624fba80f2e160ebae66281d15610c83ab215" },
  { path: "assets/logo.svg", sha256: "2216c896ac716fd40adfe1eacd353e8af9e5824012e903ce52a3bd06f114f8fb" },
  { path: "skills/kimi/SKILL.md", sha256: "ff7e0263d608eeb3c859a918b2b87f3296de5735ce68c680cb75f6a4ee905966" },
  { path: "skills/kimi/agents/openai.yaml", sha256: "56f4a779b2eda411d9e4e35857c2534511b7f8878287b4b82d32dbf56b76e7fe" },
];

export const CODEX_MCP_CONFIG = {
  mcpServers: {
    kimi: {
      type: "stdio",
      command: "./scripts/companion.sh",
      args: ["mcp"],
      cwd: ".",
      env_vars: [
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
      ],
    },
  },
} as const;

export const CODEX_PLUGIN_MANIFEST = {
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  description:
    "Universal Kimi Code connector for Codex: 4-tool MCP (kimi_read, kimi_write, kimi_job, kimi_setup), progressive kimi skill, and canonical PreToolUse safety hook.",
  author: {
    name: "linxule",
  },
  homepage: "https://github.com/linxule/kimi-plugin-cc",
  repository: "https://github.com/linxule/kimi-plugin-cc",
  license: "Apache-2.0",
  keywords: ["kimi", "kimi-code", "review", "code-review", "delegation", "multi-model", "mcp", "model-context-protocol"],
  skills: "./skills/",
  mcpServers: "./.mcp.json",
  interface: {
    displayName: "Kimi",
    shortDescription: "Ask, review, challenge, and build with Kimi",
    longDescription:
      "Kimi Code workflows for Codex: read-only questions, diff reviews, adversarial challenges, parallel swarms, bounded workspace fixes, autonomous goals, and worktree patches through the 4-tool MCP server and progressive $kimi skill.",
    developerName: "linxule",
    category: "Developer Tools",
    capabilities: ["Code Review", "Local Shell", "Write"],
    websiteURL: "https://github.com/linxule/kimi-plugin-cc",
    defaultPrompt: [
      "Use $kimi to review my current uncommitted diff.",
      "Use $kimi to challenge the design tradeoffs in this module.",
      "Use $kimi to delegate a bounded fix with kimi_write.",
    ],
    brandColor: "#0F766E",
  },
} as const;

export const CODEX_MARKETPLACE = {
  name: MARKETPLACE_NAME,
  interface: {
    displayName: "Kimi Marketplace",
  },
  plugins: [
    {
      name: PLUGIN_NAME,
      source: {
        source: "local",
        path: `./${CODEX_PLUGIN_SUBDIR}`,
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL",
      },
      category: "Developer Tools",
    },
  ],
} as const;

export const DSH_PLUGIN_PACKAGE_NAME = "kimi-plugin-cc";
export const DSH_VERSION_RANGE = ">=0.2.1-rc.5 <0.3.0";
export const DSH_MCP_TOOL_NAMES = [
  "mcp__kimi__kimi_read",
  "mcp__kimi__kimi_write",
  "mcp__kimi__kimi_job",
  "mcp__kimi__kimi_setup",
] as const;

const DSH_PACKAGE_DIR_EXPR =
  "(ctx.get('pluginPackages')?.packageOf('kimi-plugin-cc', ctx.baseUrl)?.dir ?? (ctx.get('profileContext')?.dir + '/node_modules/kimi-plugin-cc'))";

export const DSH_BUNDLE_PATCH = [
  "- insert:",
  "    - id: kimi-mcp",
  "      name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  "        serverName: kimi",
  "        transport: stdio",
  `        command: !!js "${DSH_PACKAGE_DIR_EXPR} + '/scripts/companion.sh'"`,
  "        args:",
  "          - mcp",
  "        cwd: !!js \"ctx.get('profileContext')?.cwd ?? process.cwd()\"",
  "        toolCallTimeoutMs: 86400000",
  "    - id: kimi-skill",
  "      name: '@deepseek-ai/dsh-skill-filesystem'",
  "      config:",
  "        providerName: kimi-plugin-cc",
  "        includeDefaultRoots: false",
  `        bundledSkillDir: !!js "${DSH_PACKAGE_DIR_EXPR} + '/skills'"`,
  "        watch: false",
  "",
].join("\n");

export const DSH_PUBLISH_TIMESTAMP = 1795734162;

export const DSH_DISCOVERY_INDEX = {
  format: 1,
  title: {
    en: "Kimi for DeepSeek Harness",
    zh: "Kimi 用于 DeepSeek Harness",
  },
  description: {
    en: "Universal Kimi Code MCP server and skill bundle for DeepSeek Harness.",
    zh: "面向 DeepSeek Harness 的通用 Kimi Code MCP 服务与技能包。",
  },
  metadata: {
    categories: {
      "agents-orchestration": {
        title: {
          en: "Agents & Orchestration",
          zh: "代理与编排",
        },
      },
    },
  },
  plugins: [
    {
      name: DSH_PLUGIN_PACKAGE_NAME,
      title: {
        en: "Kimi for Claude Code, Codex, Antigravity, and DeepSeek Harness",
        zh: "Kimi 用于 Claude Code、Codex、Antigravity 和 DeepSeek Harness",
      },
      description: {
        en: "4-tool Kimi Code MCP server (kimi_read, kimi_write, kimi_job, kimi_setup), progressive kimi skill, and canonical PreToolUse safety hook.",
        zh: "四工具 Kimi Code MCP 服务（kimi_read、kimi_write、kimi_job、kimi_setup）、渐进式 kimi 技能与统一 PreToolUse 安全钩子。",
      },
      author: "Xule Lin",
      homepage: "https://github.com/linxule/kimi-plugin-cc#readme",
      repository: {
        url: "https://github.com/linxule/kimi-plugin-cc",
      },
      metadata: {
        category: "agents-orchestration",
      },
      versions: [
        {
          version: PLUGIN_VERSION,
          publishTimestamp: DSH_PUBLISH_TIMESTAMP,
          source: {
            type: "npm",
          },
          engines: {
            dsh: DSH_VERSION_RANGE,
          },
        },
      ],
    },
  ],
} as const;
