#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CANONICAL_SKILL_FILES,
  CANONICAL_SKILL_NAME,
  CLAUDE_SURFACE_HASHES,
  CODEX_MARKETPLACE,
  CODEX_MCP_CONFIG,
  CODEX_PLUGIN_MANIFEST,
  CODEX_PLUGIN_SUBDIR,
  DSH_BUNDLE_PATCH,
  DSH_DISCOVERY_INDEX,
} from "./surface-registry.js";

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface SurfaceCheckResult {
  ok: boolean;
  messages: string[];
}

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Shell entrypoints the Codex plugin needs at runtime. Codex copies the plugin
// root to its install cache and forbids ../ escapes, so companion.sh and dist/**
// must be mirrored INSIDE plugins/kimi-codex/.
const RUNTIME_SHELL_SCRIPTS = ["scripts/companion.sh"];

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

export function generatedCodexSurfaceFiles(repoRoot = DEFAULT_REPO_ROOT): GeneratedFile[] {
  const files: GeneratedFile[] = [
    {
      path: `${CODEX_PLUGIN_SUBDIR}/.codex-plugin/plugin.json`,
      content: `${JSON.stringify(CODEX_PLUGIN_MANIFEST, null, 2)}\n`,
    },
    {
      path: `${CODEX_PLUGIN_SUBDIR}/.mcp.json`,
      content: `${JSON.stringify(CODEX_MCP_CONFIG, null, 2)}\n`,
    },
    {
      path: ".agents/plugins/marketplace.json",
      content: `${JSON.stringify(CODEX_MARKETPLACE, null, 2)}\n`,
    },
  ];

  for (const relPath of CANONICAL_SKILL_FILES) {
    files.push({
      path: `${CODEX_PLUGIN_SUBDIR}/${relPath}`,
      content: readFileSync(path.join(repoRoot, relPath), "utf8"),
    });
  }

  return files;
}

export function generatedDshSurfaceFiles(): GeneratedFile[] {
  return [
    {
      path: "cordis.patch.yml",
      content: DSH_BUNDLE_PATCH,
    },
    {
      path: "dsh/index.json",
      content: `${JSON.stringify(DSH_DISCOVERY_INDEX, null, 2)}\n`,
    },
  ];
}

export async function checkGeneratedDshSurfaces(repoRoot: string): Promise<SurfaceCheckResult> {
  return checkGeneratedContent(repoRoot, generatedDshSurfaceFiles());
}

export async function checkGeneratedCodexSurfaces(repoRoot: string): Promise<SurfaceCheckResult> {
  return checkGeneratedContent(repoRoot, generatedCodexSurfaceFiles(repoRoot));
}

async function checkGeneratedContent(repoRoot: string, files: readonly GeneratedFile[]): Promise<SurfaceCheckResult> {
  const messages: string[] = [];
  for (const file of files) {
    let actual: string;
    try {
      actual = await readFile(path.join(repoRoot, file.path), "utf8");
    } catch (error) {
      messages.push(`${file.path}: unable to read (${formatError(error)})`);
      continue;
    }
    if (actual !== file.content) messages.push(`${file.path}: generated content is not current`);
  }
  return { ok: messages.length === 0, messages };
}

// Orphans are regular files directly under packageRoot plus every file under
// the listed subdirectories that no generator owns.
async function checkTextOrphans(
  repoRoot: string,
  packageRoot: string,
  expectedPaths: readonly string[],
  recursiveSubdirs: readonly string[],
): Promise<SurfaceCheckResult> {
  const expected = new Set(expectedPaths);
  const candidates: string[] = [];
  const entries = await readdir(path.join(repoRoot, packageRoot), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile()) candidates.push(`${packageRoot}/${entry.name}`);
  }
  for (const sub of recursiveSubdirs) {
    candidates.push(...(await listFilesRecursive(repoRoot, path.join(packageRoot, sub))));
  }
  const messages = candidates
    .filter((rel) => !expected.has(rel))
    .map((rel) => `${rel}: orphaned generated file (run \`bun run generate:surfaces\`)`);
  return { ok: messages.length === 0, messages };
}

// Repo-relative source paths the Codex subfolder must mirror byte-for-byte:
// scripts/companion.sh plus every file under root dist/.
async function runtimeMirrorSourceRelPaths(repoRoot: string): Promise<string[]> {
  const distFiles = await listFilesRecursive(repoRoot, "dist");
  return [...RUNTIME_SHELL_SCRIPTS, ...distFiles].sort();
}

// Verify the bundled runtime mirror (scripts + dist) under plugins/kimi-codex
// matches the freshly built root, AND that it holds no orphaned runtime files.
export async function checkRuntimeMirror(
  repoRoot: string,
  pluginSubdir = CODEX_PLUGIN_SUBDIR,
): Promise<SurfaceCheckResult> {
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
    const target = `${pluginSubdir}/${rel}`;
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

  for (const sub of ["dist", "scripts"]) {
    const subfolderFiles = await listFilesRecursive(repoRoot, path.join(pluginSubdir, sub));
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

export async function checkGeneratedTextOrphans(repoRoot: string): Promise<SurfaceCheckResult> {
  const expected = generatedCodexSurfaceFiles(repoRoot).map((file) => file.path);
  return checkTextOrphans(repoRoot, CODEX_PLUGIN_SUBDIR, expected, [".codex-plugin", "skills"]);
}

export async function writeGeneratedCodexSurfaces(repoRoot: string): Promise<void> {
  await assertClaudeSurfaceGate(repoRoot, "Codex");
  await pruneStaleSkillDirs(repoRoot);
  await writeGeneratedFiles(repoRoot, generatedCodexSurfaceFiles(repoRoot));
  await mirrorRuntimePayload(repoRoot);
}

export async function writeGeneratedDshSurfaces(repoRoot: string): Promise<void> {
  await assertClaudeSurfaceGate(repoRoot, "DSH");
  await writeGeneratedFiles(repoRoot, generatedDshSurfaceFiles());
}

async function assertClaudeSurfaceGate(repoRoot: string, host: string): Promise<void> {
  const result = await verifyClaudeSurfaceHashes(repoRoot);
  if (!result.ok) {
    throw new Error([`Refusing to write ${host} surfaces because the root surface gate failed.`, ...result.messages].join("\n"));
  }
}

async function writeGeneratedFiles(repoRoot: string, files: readonly GeneratedFile[]): Promise<void> {
  for (const file of files) {
    const absolutePath = path.join(repoRoot, file.path);
    try {
      if (await readFile(absolutePath, "utf8") === file.content) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.content, "utf8");
  }
}

async function mirrorRuntimePayload(repoRoot: string, pluginSubdir = CODEX_PLUGIN_SUBDIR): Promise<void> {
  const sources = await runtimeMirrorSourceRelPaths(repoRoot);
  const expectedTargets = new Set(sources.map((rel) => `${pluginSubdir}/${rel}`));

  for (const sub of ["dist", "scripts"]) {
    const subfolderFiles = await listFilesRecursive(repoRoot, path.join(pluginSubdir, sub));
    for (const rel of subfolderFiles) {
      if (!expectedTargets.has(rel)) await rm(path.join(repoRoot, rel));
    }
  }

  for (const rel of sources) {
    const src = path.join(repoRoot, rel);
    const dest = path.join(repoRoot, pluginSubdir, rel);
    const data = await readFile(src);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, data);
    await chmod(dest, rel.endsWith(".sh") || rel === "dist/companion.js" ? 0o755 : 0o644);
  }
}

async function pruneStaleSkillDirs(repoRoot: string): Promise<void> {
  const skillsRoot = path.join(repoRoot, CODEX_PLUGIN_SUBDIR, "skills");
  let entries;
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name !== CANONICAL_SKILL_NAME) {
      await rm(path.join(skillsRoot, entry.name), { recursive: true, force: true });
    }
  }
}

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
  const dsh = await checkGeneratedDshSurfaces(repoRoot);
  return {
    ok: claude.ok && codex.ok && textOrphans.ok && runtime.ok && dsh.ok,
    messages: [
      ...claude.messages.map((message) => `Root: ${message}`),
      ...codex.messages.map((message) => `Codex: ${message}`),
      ...textOrphans.messages.map((message) => `Codex: ${message}`),
      ...runtime.messages.map((message) => `Codex runtime: ${message}`),
      ...dsh.messages.map((message) => `DSH: ${message}`),
    ],
  };
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
  await writeGeneratedDshSurfaces(repoRoot);
  process.stdout.write("generated Codex and DSH surfaces (text + bundled runtime)\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  });
}
