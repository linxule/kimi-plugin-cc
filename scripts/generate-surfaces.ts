#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CLAUDE_SURFACE_HASHES,
  CODEX_MARKETPLACE,
  CODEX_PLUGIN_MANIFEST,
  CODEX_PLUGIN_SUBDIR,
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

// Shell entrypoints the Codex plugin needs at runtime. Codex copies the plugin
// root to its install cache and forbids ../ escapes, so these (and dist/**) must
// be mirrored INSIDE the subfolder. Dev-only scripts (surface-registry.ts,
// generate-surfaces.ts) are intentionally NOT mirrored.
const RUNTIME_SHELL_SCRIPTS = ["scripts/companion.sh", "scripts/review-gate-hook.sh"];

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
      // Codex plugin manifest lives INSIDE the self-contained subfolder root.
      path: `${CODEX_PLUGIN_SUBDIR}/.codex-plugin/plugin.json`,
      content: `${JSON.stringify(CODEX_PLUGIN_MANIFEST, null, 2)}\n`,
    },
    {
      // The repo-scope Codex marketplace stays at the repo root and POINTS INTO
      // the subfolder via source.path; it is not part of the plugin payload.
      path: ".agents/plugins/marketplace.json",
      content: `${JSON.stringify(CODEX_MARKETPLACE, null, 2)}\n`,
    },
  ];

  for (const skill of CODEX_SKILLS) {
    files.push({
      path: `${CODEX_PLUGIN_SUBDIR}/skills/${skill.name}/SKILL.md`,
      content: renderSkillMarkdown(skill),
    });
    files.push({
      path: `${CODEX_PLUGIN_SUBDIR}/skills/${skill.name}/agents/openai.yaml`,
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

// Repo-relative source paths the subfolder must mirror byte-for-byte:
// the two shell entrypoints plus every file under root dist/.
async function runtimeMirrorSourceRelPaths(repoRoot: string): Promise<string[]> {
  const distFiles = await listFilesRecursive(repoRoot, "dist");
  return [...RUNTIME_SHELL_SCRIPTS, ...distFiles].sort();
}

// Verify the bundled runtime mirror (scripts + dist) under the subfolder matches
// the freshly built root, AND that the subfolder holds no orphaned runtime files.
export async function checkRuntimeMirror(repoRoot: string): Promise<SurfaceCheckResult> {
  const messages: string[] = [];

  let sources: string[];
  try {
    sources = await runtimeMirrorSourceRelPaths(repoRoot);
  } catch (error) {
    return {
      ok: false,
      messages: [
        `runtime mirror: unable to enumerate root runtime (${formatError(error)}) — run \`bun run build\` first`,
      ],
    };
  }

  const expectedTargets = new Set<string>();
  for (const rel of sources) {
    const target = `${CODEX_PLUGIN_SUBDIR}/${rel}`;
    expectedTargets.add(target);

    let srcData: Buffer;
    try {
      srcData = await readFile(path.join(repoRoot, rel));
    } catch (error) {
      messages.push(`${rel}: unable to read root source (${formatError(error)})`);
      continue;
    }

    let destData: Buffer;
    try {
      destData = await readFile(path.join(repoRoot, target));
    } catch {
      messages.push(`${target}: bundled runtime mirror is missing (run \`bun run generate:surfaces\`)`);
      continue;
    }

    if (!srcData.equals(destData)) {
      messages.push(`${target}: bundled runtime mirror is out of date (run \`bun run generate:surfaces\`)`);
    }
  }

  // Orphan detection: any file under the subfolder's mirrored runtime roots that
  // is NOT a current mirror target is stale (e.g. a renamed/removed dist chunk).
  for (const sub of ["dist", "scripts"]) {
    const subfolderFiles = await listFilesRecursive(repoRoot, path.join(CODEX_PLUGIN_SUBDIR, sub));
    for (const rel of subfolderFiles) {
      if (!expectedTargets.has(rel)) {
        messages.push(
          `${rel}: orphaned bundled file (no matching root runtime file — run \`bun run generate:surfaces\`)`,
        );
      }
    }
  }

  return { ok: messages.length === 0, messages };
}

// Orphan detection for generated TEXT surfaces under the subfolder (catches a
// renamed/removed skill leaving a stale SKILL.md behind).
export async function checkGeneratedTextOrphans(repoRoot: string): Promise<SurfaceCheckResult> {
  const expected = new Set(generatedCodexSurfaceFiles().map((file) => file.path));
  const messages: string[] = [];

  for (const sub of [".codex-plugin", "skills"]) {
    const files = await listFilesRecursive(repoRoot, path.join(CODEX_PLUGIN_SUBDIR, sub));
    for (const rel of files) {
      if (!expected.has(rel)) {
        messages.push(`${rel}: orphaned generated file (run \`bun run generate:surfaces\`)`);
      }
    }
  }

  return { ok: messages.length === 0, messages };
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

  // Prune stale skill dirs before writing the current set.
  await pruneStaleSkillDirs(repoRoot);

  for (const file of generatedCodexSurfaceFiles()) {
    const absolutePath = path.join(repoRoot, file.path);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.content, "utf8");
  }

  await mirrorRuntimePayload(repoRoot);
}

// Copy the two shell entrypoints + the whole root dist/ into the subfolder,
// preserving 0755 on shell scripts, and prune any mirrored file that no longer
// has a root source.
async function mirrorRuntimePayload(repoRoot: string): Promise<void> {
  const sources = await runtimeMirrorSourceRelPaths(repoRoot);
  const expectedTargets = new Set(sources.map((rel) => `${CODEX_PLUGIN_SUBDIR}/${rel}`));

  // Prune stale mirrored files first.
  for (const sub of ["dist", "scripts"]) {
    const subfolderFiles = await listFilesRecursive(repoRoot, path.join(CODEX_PLUGIN_SUBDIR, sub));
    for (const rel of subfolderFiles) {
      if (!expectedTargets.has(rel)) {
        await rm(path.join(repoRoot, rel));
      }
    }
  }

  for (const rel of sources) {
    const src = path.join(repoRoot, rel);
    const dest = path.join(repoRoot, CODEX_PLUGIN_SUBDIR, rel);
    const data = await readFile(src);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, data);
    await chmod(dest, rel.endsWith(".sh") ? 0o755 : 0o644);
  }
}

async function pruneStaleSkillDirs(repoRoot: string): Promise<void> {
  const skillsRoot = path.join(repoRoot, CODEX_PLUGIN_SUBDIR, "skills");
  const valid = new Set(CODEX_SKILLS.map((skill) => skill.name));
  let entries;
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !valid.has(entry.name)) {
      await rm(path.join(skillsRoot, entry.name), { recursive: true });
    }
  }
}

// List files under repoRoot/<subdir> as repo-relative POSIX paths. Returns [] if
// the directory does not exist.
async function listFilesRecursive(repoRoot: string, subdir: string): Promise<string[]> {
  const base = path.join(repoRoot, subdir);
  let rels: string[];
  try {
    rels = await readdir(base, { recursive: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const rel of rels) {
    const abs = path.join(base, rel);
    let info;
    try {
      info = await stat(abs);
    } catch {
      continue;
    }
    if (info.isFile()) {
      files.push(path.join(subdir, rel).split(path.sep).join("/"));
    }
  }
  return files.sort();
}

export async function checkAllSurfaces(repoRoot: string): Promise<SurfaceCheckResult> {
  const claude = await verifyClaudeSurfaceHashes(repoRoot);
  const codex = await checkGeneratedCodexSurfaces(repoRoot);
  const textOrphans = await checkGeneratedTextOrphans(repoRoot);
  const runtime = await checkRuntimeMirror(repoRoot);
  return {
    ok: claude.ok && codex.ok && textOrphans.ok && runtime.ok,
    messages: [
      ...claude.messages.map((message) => `Claude: ${message}`),
      ...codex.messages.map((message) => `Codex: ${message}`),
      ...textOrphans.messages.map((message) => `Codex: ${message}`),
      ...runtime.messages.map((message) => `Codex runtime: ${message}`),
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
    "- Resolve the plugin root: prefer `$PLUGIN_ROOT` if the host sets it; otherwise use the directory that CONTAINS the `skills/` directory (i.e. two levels up from this `SKILL.md`).",
    "- Sanity check: `<plugin-root>/scripts/companion.sh` must exist — it is the bundled entrypoint that resolves Node and runs the compiled runtime from `<plugin-root>/dist/`.",
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
  process.stdout.write("generated Codex sidecar surfaces (text + bundled runtime)\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  });
}
