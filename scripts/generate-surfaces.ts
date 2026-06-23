#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CLAUDE_SURFACE_HASHES,
  CODEX_MARKETPLACE,
  CODEX_PLUGIN_MANIFEST,
  CODEX_SKILLS,
  type CodexSkillSpec,
} from "./surface-registry.js";

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface SurfaceCheckResult {
  ok: boolean;
  messages: string[];
}

export async function verifyClaudeSurfaceHashes(repoRoot: string): Promise<SurfaceCheckResult> {
  const messages: string[] = [];

  for (const expected of CLAUDE_SURFACE_HASHES) {
    const absolutePath = path.join(repoRoot, expected.path);
    let data: Buffer;
    try {
      data = await readFile(absolutePath);
    } catch (error) {
      messages.push(`${expected.path}: unable to read (${formatError(error)})`);
      continue;
    }

    const actual = createHash("sha256").update(data).digest("hex");
    if (actual !== expected.sha256) {
      messages.push(`${expected.path}: expected ${expected.sha256}, got ${actual}`);
    }
  }

  return {
    ok: messages.length === 0,
    messages,
  };
}

export function generatedCodexSurfaceFiles(): GeneratedFile[] {
  const files: GeneratedFile[] = [
    {
      path: ".codex-plugin/plugin.json",
      content: `${JSON.stringify(CODEX_PLUGIN_MANIFEST, null, 2)}\n`,
    },
    {
      path: ".agents/plugins/marketplace.json",
      content: `${JSON.stringify(CODEX_MARKETPLACE, null, 2)}\n`,
    },
  ];

  for (const skill of CODEX_SKILLS) {
    files.push({
      path: `skills/${skill.name}/SKILL.md`,
      content: renderSkillMarkdown(skill),
    });
    files.push({
      path: `skills/${skill.name}/agents/openai.yaml`,
      content: renderOpenAiYaml(skill),
    });
  }

  return files;
}

export async function checkGeneratedCodexSurfaces(repoRoot: string): Promise<SurfaceCheckResult> {
  const messages: string[] = [];
  for (const file of generatedCodexSurfaceFiles()) {
    const absolutePath = path.join(repoRoot, file.path);
    let actual: string;
    try {
      actual = await readFile(absolutePath, "utf8");
    } catch (error) {
      messages.push(`${file.path}: unable to read (${formatError(error)})`);
      continue;
    }

    if (actual !== file.content) {
      messages.push(`${file.path}: generated content is not current`);
    }
  }

  return {
    ok: messages.length === 0,
    messages,
  };
}

export async function writeGeneratedCodexSurfaces(repoRoot: string): Promise<void> {
  const claudeCheck = await verifyClaudeSurfaceHashes(repoRoot);
  if (!claudeCheck.ok) {
    throw new Error(
      [
        "Refusing to write Codex surfaces because the Claude surface gate failed.",
        ...claudeCheck.messages,
      ].join("\n"),
    );
  }

  for (const file of generatedCodexSurfaceFiles()) {
    const absolutePath = path.join(repoRoot, file.path);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.content, "utf8");
  }
}

export async function checkAllSurfaces(repoRoot: string): Promise<SurfaceCheckResult> {
  const claude = await verifyClaudeSurfaceHashes(repoRoot);
  const codex = await checkGeneratedCodexSurfaces(repoRoot);
  return {
    ok: claude.ok && codex.ok,
    messages: [
      ...claude.messages.map((message) => `Claude: ${message}`),
      ...codex.messages.map((message) => `Codex: ${message}`),
    ],
  };
}

function renderSkillMarkdown(skill: CodexSkillSpec): string {
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${yamlDoubleQuote(skill.description)}`,
    "---",
    "",
    `# ${skill.title}`,
    "",
    "Forward this request to the local kimi-code companion runtime by shell. Do not use MCP for this skill.",
    "",
    "## Invocation",
    "",
    "- Resolve the plugin root from this skill source path: use the parent directory of the `skills/` directory that contains this `SKILL.md`. If `PLUGIN_ROOT` is already set, use that value.",
    "- Launch the shell command from the user's current workspace directory so `scripts/companion.sh` captures the intended workspace cwd.",
    `- Run: \`PLUGIN_ROOT=\"<plugin-root>\" \"<plugin-root>/scripts/companion.sh\" ${skill.command} <args>\``,
    "- If the plugin host provides `PLUGIN_DATA` instead of `CLAUDE_PLUGIN_DATA`, the shell wrapper exports the Claude-compatible alias for the runtime. If neither is set, the wrapper uses a Codex data directory under `$CODEX_HOME/plugins/data/kimi-marketplace-kimi`, `~/.codex/plugins/data/kimi-marketplace-kimi`, or `/tmp/kimi-plugin-cc-codex-data/kimi-marketplace-kimi` in a fully sanitized environment.",
    "",
    "## Arguments",
    "",
    `Pass through: \`${skill.argumentSummary}\``,
    "",
    "## Handling",
    "",
    ...skill.guidance.map((line) => `- ${line}`),
    "",
  ].join("\n");
}

function renderOpenAiYaml(skill: CodexSkillSpec): string {
  return [
    "interface:",
    `  display_name: ${yamlDoubleQuote(skill.displayName)}`,
    `  short_description: ${yamlDoubleQuote(skill.shortDescription)}`,
    `  default_prompt: ${yamlDoubleQuote(skill.defaultPrompt)}`,
    "policy:",
    `  allow_implicit_invocation: ${skill.implicit ? "true" : "false"}`,
    "",
  ].join("\n");
}

function yamlDoubleQuote(value: string): string {
  return JSON.stringify(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const checkOnly = process.argv.includes("--check");

  if (checkOnly) {
    const result = await checkAllSurfaces(repoRoot);
    if (!result.ok) {
      process.stderr.write(`${result.messages.join("\n")}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write("surface generation check passed\n");
    return;
  }

  await writeGeneratedCodexSurfaces(repoRoot);
  process.stdout.write("generated Codex sidecar surfaces\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  });
}
