import { SETUP_SUPPORTED_FLAGS } from "../parsing.js";
// Managed-block installer for the load-bearing kimi-code PreToolUse hook.
// Without it, `kimi -p` auto-approves tool calls, including from read-only
// commands.
//
// Setup atomically publishes the bundled self-contained approval hook to
// `<pluginRoot>/hook/approval-hook.js`, then writes or refreshes a single
// canonical BEGIN/END block in ~/.kimi-code/config.toml containing
// `'<absolute-node>' '<absolute-hook-script>'` from
// resolveNodeBinary/buildHookShellCommand. Setup probes the hook directly with
// the parsed Node binary and through `/bin/sh -c` using the exact installed bytes.

import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { RuntimeError } from "../errors.js";
import { HOOK_TIMEOUT_S } from "../hooks/hook-timing.js";
import {
  normalizeTopLevelInlineHooks,
  validateKimiHookSetForEnvironment,
  withKimiConfigLock,
} from "../hooks/config-safety.js";
import {
  buildHookShellCommand,
  parseHookShellCommand,
  resolveBundledHookSourcePath,
  resolveHookScriptPath,
  resolveNodeBinary,
  verifyManagedHookArtifact,
} from "../hooks/install-paths.js";
import {
  countCleanEntriesInFile,
  decodeManagedCommandLine,
  describeHookTimeout,
  evaluateInstalled,
  findShortHookTimeout,
  findUnmanagedApprovalHookBlocks,
  ORPHAN_MARKER_REMEDY,
  pairBlocks,
  parseManagedBlock,
  scanTomlLines,
  type ManagedBlockEntry,
  type ManagedBlockState,
} from "../hooks/managed-block.js";
import {
  formatVersionOutOfRangeWarning,
  KIMI_MINIMUM_CERTIFIED_VERSION,
  probeKimiVersion,
} from "../kimi-version-probe.js";
import { inspectPluginOwnedKimi, selectKimiBinary } from "../kimi-command.js";
import {
  isNativeV2CertifiedVersion,
  NATIVE_V2_ANY_OPERATION_VERSIONS,
  NATIVE_V2_CERTIFIED_VERSIONS,
  NATIVE_V2_NON_SWARM_VERSIONS,
} from "../kimi-engine.js";
import { resolveKimiCodeConfigPath, resolveKimiHome } from "../kimi-home.js";
import { formatVersionChoice, kimiReleaseHas, kimiVersionsWith } from "../kimi-releases.js";
import { ensurePluginPaths, resolveKimiBinDir, resolvePluginPaths } from "../paths.js";
import type { CommandContext } from "../types.js";
import { KIMI_PLUGIN_CC_VERSION } from "../version.js";
import { parse as parseToml } from "../vendor/smol-toml/parse.js";

const BEGIN_MARKER_PREFIX = "# === BEGIN kimi-plugin-cc-managed";

const DEFAULT_HOOK_TIMEOUT_S = HOOK_TIMEOUT_S;

// Probe timing. The direct script probe is local and fast; allow 5s for
// node startup on cold CI runners. The shell probe adds /bin/sh fork
// overhead but should still complete well within the same budget.
const PROBE_TIMEOUT_MS = 5_000;

// Reject the specific control characters, double quotes, and backslashes matched
// below, including newlines and tabs; this is not a general shell-metacharacter
// filter. Normal install paths do not contain them, so a match indicates an
// unsafe override or an unusual layout that needs an explicit path change.
const PATH_FORBIDDEN_RE = /[\x00-\x1f"\\\n\r\t]/;

export type SetupAction = "install" | "uninstall" | "check" | "install-kimi";

export interface SetupResult {
  /** What the command did. */
  action: SetupAction;
  summary: string;
  /** Path that was inspected / written. */
  configPath: string;
  /** Resolved absolute path to the hook script the block references. */
  hookScriptPath: string;
  /** True when the install path wrote (or replaced) the managed block. */
  blockWritten: boolean;
  /** True when the uninstall path removed a managed block (or orphan). */
  blockRemoved: boolean;
  /** Probe outcome. Always `"skipped"` for uninstall. */
  probe: "ok" | "failed" | "skipped";
  /** Failure detail when probe === "failed". */
  probeError?: string;
  /** Warnings about user-side config that may interfere. */
  warnings: string[];
  nextStep: string;
  details: string[];
  /** Present only for `--install-kimi`. */
  kimiInstall?: KimiInstallReport;
}

export interface KimiInstallReport {
  ok: boolean;
  /** `--json` was requested. */
  json: boolean;
  version: string;
  /** True when this run downloaded; false when a verified install was reused. */
  downloaded: boolean;
  binary?: string;
  current?: string;
  /** Binary jobs will use after this run, and why. */
  selectedBinary?: string;
  selectedSource?: string;
  error?: { code: string; message: string; details: Record<string, unknown> };
}

interface ParsedArgs {
  mode: SetupAction;
  json: boolean;
}

export async function runSetup(argv: string[], context: CommandContext): Promise<SetupResult> {
  const parsed = parseArgs(argv);
  if (parsed.mode === "install-kimi") {
    return await runInstallKimi(parsed.json, context);
  }

  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);

  const configPath = resolveKimiCodeConfigPath(context.env);
  const hookScriptPath = resolveHookScriptPath(context.env);
  assertHookPathTomlSafe(hookScriptPath);

  const warnings: string[] = [];

  switch (parsed.mode) {
    case "uninstall":
      return await runUninstall(
        configPath,
        hookScriptPath,
        warnings,
        context,
      );
    case "check":
      return await runCheck(configPath, hookScriptPath, warnings, context);
    case "install":
      return await runInstall(paths, configPath, hookScriptPath, warnings, context);
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  let mode: SetupAction = "install";
  let installKimi = false;
  let json = false;

  for (const token of argv) {
    switch (token) {
      case "--install-kimi":
        installKimi = true;
        break;
      case "--json":
        json = true;
        break;
      case "--check":
        if (mode === "uninstall") {
          throw new RuntimeError(
            "INVALID_ARGS",
            "setup accepts at most one of --check, --uninstall.",
            "setup.parse",
          );
        }
        mode = "check";
        break;
      case "--uninstall":
        if (mode === "check") {
          throw new RuntimeError(
            "INVALID_ARGS",
            "setup accepts at most one of --check, --uninstall.",
            "setup.parse",
          );
        }
        mode = "uninstall";
        break;
      default:
        throw new RuntimeError(
          "INVALID_ARGS",
          `Unknown setup flag ${token}. Supported flags: ${SETUP_SUPPORTED_FLAGS}.`,
          "setup.parse",
        );
    }
  }

  if (installKimi) {
    if (argv.some((token) => token !== "--install-kimi" && token !== "--json")) {
      throw new RuntimeError(
        "INVALID_ARGS",
        "--install-kimi does not combine with other setup flags except --json.",
        "setup.parse",
      );
    }
    return { mode: "install-kimi", json };
  }
  if (json) {
    throw new RuntimeError(
      "INVALID_ARGS",
      "--json is only valid with --install-kimi or --models.",
      "setup.parse",
    );
  }

  return { mode, json };
}

async function assertNonSymlinkDirectory(target: string, label: string): Promise<string> {
  let info;
  try {
    info = await lstat(target);
  } catch (err) {
    throw new RuntimeError(
      "SETUP_HOOK_PATH_UNSAFE",
      `Unable to inspect ${label} at ${target}: ${(err as Error).message}`,
      "setup.hook-script",
      err instanceof Error ? { cause: err, details: { target } } : { details: { target } },
    );
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new RuntimeError(
      "SETUP_HOOK_PATH_UNSAFE",
      `Refusing to publish hook into ${label} at ${target}: path is a symlink or not a directory.`,
      "setup.hook-script",
      { details: { target } },
    );
  }
  return await realpath(target);
}

async function assertAbsentOrRegularFile(target: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new RuntimeError(
      "SETUP_HOOK_PATH_UNSAFE",
      `Unable to inspect ${label} at ${target}: ${(err as Error).message}`,
      "setup.hook-script",
      err instanceof Error ? { cause: err, details: { target } } : { details: { target } },
    );
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new RuntimeError(
      "SETUP_HOOK_PATH_UNSAFE",
      `Refusing to overwrite ${label} at ${target}: path is a symlink or not a regular file.`,
      "setup.hook-script",
      { details: { target } },
    );
  }
}

async function publishHookArtifactIfManaged(
  paths: ReturnType<typeof resolvePluginPaths>,
  hookScriptPath: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (env.KIMI_PLUGIN_CC_HOOK_SCRIPT && env.KIMI_PLUGIN_CC_HOOK_SCRIPT.length > 0) {
    return;
  }
  const sourcePath = resolveBundledHookSourcePath();
  let sourceBytes: string;
  try {
    sourceBytes = await readFile(sourcePath, "utf8");
  } catch (err) {
    throw new RuntimeError(
      "SETUP_HOOK_SCRIPT_MISSING",
      `Bundled hook script ${sourcePath} is missing or unreadable. Run \`bun run build\` or reinstall the plugin.`,
      "setup.hook-script",
      err instanceof Error ? { cause: err, details: { sourcePath } } : { details: { sourcePath } },
    );
  }
  if (sourceBytes.trim().length === 0) {
    throw new RuntimeError(
      "SETUP_HOOK_SCRIPT_MISSING",
      `Bundled hook script ${sourcePath} is empty. Run \`bun run build\` or reinstall the plugin.`,
      "setup.hook-script",
      { details: { sourcePath } },
    );
  }

  // Validate pluginRoot before acquiring the hook lock or creating hookDir.
  const pluginRootReal = await assertNonSymlinkDirectory(paths.pluginRoot, "plugin data directory");

  await withKimiConfigLock(path.join(paths.pluginRoot, "hook"), async () => {
    let hookDirExisted = true;
    try {
      const info = await lstat(paths.hookDir);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new RuntimeError(
          "SETUP_HOOK_PATH_UNSAFE",
          `Refusing to publish hook into ${paths.hookDir}: path is a symlink or not a directory.`,
          "setup.hook-script",
          { details: { hookDir: paths.hookDir } },
        );
      }
    } catch (err) {
      if (err instanceof RuntimeError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        hookDirExisted = false;
      } else {
        throw new RuntimeError(
          "SETUP_HOOK_PATH_UNSAFE",
          `Unable to inspect hook directory ${paths.hookDir}: ${(err as Error).message}`,
          "setup.hook-script",
          err instanceof Error ? { cause: err, details: { hookDir: paths.hookDir } } : { details: { hookDir: paths.hookDir } },
        );
      }
    }

    if (!hookDirExisted) {
      await mkdir(paths.hookDir, { mode: 0o700 });
    }
    const hookDirReal = await assertNonSymlinkDirectory(paths.hookDir, "hook directory");
    const expectedHookDirReal = path.join(pluginRootReal, "hook");
    if (hookDirReal !== expectedHookDirReal) {
      throw new RuntimeError(
        "SETUP_HOOK_PATH_UNSAFE",
        `Hook directory ${paths.hookDir} resolves to ${hookDirReal}, outside ${expectedHookDirReal}.`,
        "setup.hook-script",
        { details: { hookDir: paths.hookDir, hookDirReal, expectedHookDirReal } },
      );
    }

    if (process.platform !== "win32") {
      await chmod(paths.hookDir, 0o700);
    }

    const livePackageJsonPath = path.join(paths.hookDir, "package.json");
    await assertAbsentOrRegularFile(livePackageJsonPath, "hook package.json");
    await assertAbsentOrRegularFile(hookScriptPath, "hook script");

    const stagingDir = await mkdtemp(path.join(paths.hookDir, ".staging-"));
    try {
      if (process.platform !== "win32") {
        await chmod(stagingDir, 0o700);
      }
      const stagedPackageJsonPath = path.join(stagingDir, "package.json");
      const stagedHookScriptPath = path.join(stagingDir, "approval-hook.js");
      await writeFileAtomic(stagedPackageJsonPath, '{"type":"module"}\n', 0o644);
      await writeFileAtomic(stagedHookScriptPath, sourceBytes, 0o644);

      const stagedCommand = buildHookShellCommand(stagedHookScriptPath, env);
      const stagedProbe = await probeHook(stagedHookScriptPath, stagedCommand, env);
      if (!stagedProbe.ok) {
        throw new RuntimeError(
          "SETUP_HOOK_PROBE_FAILED",
          `Staged hook probe failed before activation (${stagedProbe.reason}). Existing live hook and kimi-code config were left unchanged.`,
          "setup.hook-probe",
          { details: { sourcePath, hookScriptPath, reason: stagedProbe.reason } },
        );
      }

      // Re-check targets immediately before atomic swap from the same directory.
      await assertAbsentOrRegularFile(livePackageJsonPath, "hook package.json");
      await assertAbsentOrRegularFile(hookScriptPath, "hook script");
      await rename(stagedPackageJsonPath, livePackageJsonPath);
      await rename(stagedHookScriptPath, hookScriptPath);
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  });
}

function assertManagedBlocksSafeToReplace(
  contents: string,
  blocks: readonly ManagedBlockEntry[],
  configPath: string,
  stage: string,
): void {
  if (blocks.length === 0) return;
  const lines = splitPreservingEnding(contents);
  const { tables } = scanTomlLines(contents);
  for (const block of blocks) {
    let hooksTables = 0;
    for (let lineNo = block.beginLine + 1; lineNo < block.endLine; lineNo += 1) {
      if (!tables.has(lineNo)) continue;
      const trimmed = lines[lineNo]!.trim();
      if (/^\[\[hooks\]\]\s*(?:#.*)?$/.test(trimmed)) {
        hooksTables += 1;
        if (hooksTables > 1) {
          throw new RuntimeError(
            "SETUP_INVALID_HOOKS_CONFIG",
            `kimi-code config at ${configPath} has a managed block (lines ${block.beginLine + 1}-${block.endLine + 1}) containing multiple [[hooks]] tables; refusing to overwrite or strip user content. Inspect and repair the block manually; the existing config was left unchanged.`,
            stage,
            { details: { configPath, beginLine: block.beginLine + 1, endLine: block.endLine + 1 } },
          );
        }
      } else {
        throw new RuntimeError(
          "SETUP_INVALID_HOOKS_CONFIG",
          `kimi-code config at ${configPath} has a managed block (lines ${block.beginLine + 1}-${block.endLine + 1}) containing a non-hooks TOML table at line ${lineNo + 1}; refusing to overwrite or strip user content. Inspect and repair the block manually; the existing config was left unchanged.`,
          stage,
          { details: { configPath, beginLine: block.beginLine + 1, endLine: block.endLine + 1, line: lineNo + 1 } },
        );
      }
    }
  }
}

async function runInstall(
  paths: ReturnType<typeof resolvePluginPaths>,
  configPath: string,
  hookScriptPath: string,
  warnings: string[],
  context: CommandContext,
): Promise<SetupResult> {
  if (context.env.KIMI_PLUGIN_CC_HOOK_SCRIPT && context.env.KIMI_PLUGIN_CC_HOOK_SCRIPT.length > 0) {
    await assertHookScriptExists(hookScriptPath);
  }

  const mutation = await withKimiConfigLock(configPath, async () => {
    const original = await readConfigSafe(configPath);
    const lineEnding = detectLineEnding(original);
    try { parseToml(original); } catch { await assertKimiHookSetValid(original, configPath, "setup.install", context.env); }
    const repaired = removeOrphanMarkers(original);
    if (repaired.count > 0) {
      warnings.push(`Removed ${repaired.count} orphaned managed marker comment(s); surrounding config was preserved.`);
    }
    const inlineHooks = normalizeTopLevelInlineHooks(repaired.contents, lineEnding);
    if (inlineHooks.found) {
      // Validate before normalizing so an invalid inline entry is reported
      // against the user's original bytes and the config remains untouched.
      await assertKimiHookSetValid(original, configPath, "setup.install", context.env);
      if (!inlineHooks.converted) {
        throw new RuntimeError(
          "SETUP_INVALID_HOOKS_CONFIG",
          `Could not safely convert the top-level inline hooks assignment in ${configPath}; the existing config was left unchanged.`,
          "setup.install",
          { details: { configPath } },
        );
      }
      warnings.push(
        `Converted the top-level inline hooks array (${inlineHooks.entryCount} entr${inlineHooks.entryCount === 1 ? "y" : "ies"}) to canonical [[hooks]] tables before installing. Surrounding config bytes were preserved; formatting and comments inside that hooks assignment were normalized.`,
      );
    }

    const expectedCommand = buildHookShellCommand(hookScriptPath, context.env);
    const shortBefore = findShortHookTimeout(inlineHooks.contents, expectedCommand);
    const { pruned, count: prunedCount, commands: prunedCommands } =
      pruneOrphanApprovalHooks(inlineHooks.contents, expectedCommand);
    const existing = pruned;
    if (prunedCount > 0) {
      const readorned = prunedCommands.includes(expectedCommand);
      warnings.push(
        readorned
          ? shortBefore === null
            ? `Re-adorned the managed-block markers: kimi-code rewrites its config on login/settings changes and strips all comments (markers included), leaving the hook enforcing but unmarked. Replaced ${prunedCount} bare hook table(s) with one freshly marked canonical block. Enforcement was never interrupted.`
            : `Re-adorned the managed-block markers: replaced ${prunedCount} bare hook table(s) with one freshly marked canonical block.`
          : `Pruned ${prunedCount} stale marker-less kimi-plugin-cc hook block(s) left by earlier installs. This is a cleanup — your active hook is unaffected.`,
      );
    }

    const { state, blocks } = parseManagedBlock(existing);

    if (state.kind === "orphan") {
      throw new RuntimeError(
        "SETUP_ORPHAN_MARKERS",
        [
          `kimi-code config at ${configPath} contains an orphaned ${state.detail} marker.`,
          "Inspect the managed marker comments and re-run setup.",
        ].join(" "),
        "setup.install",
        { details: { configPath, orphan: state.detail } },
      );
    }

    assertManagedBlocksSafeToReplace(existing, blocks, configPath, "setup.install");

    const block = buildManagedBlock(expectedCommand, lineEnding);
    let next: string;
    if (state.kind === "duplicate") {
      const hasLegacyBlock = blocks.some((entry) => entry.hostId !== null);
      if (!hasLegacyBlock) {
        throw new RuntimeError(
          "SETUP_DUPLICATE_BLOCKS",
          [
            `kimi-code config at ${configPath} contains ${state.beginLines.length} kimi-plugin-cc managed blocks (lines ${state.beginLines
              .map((line) => line + 1)
              .join(", ")}).`,
            "Run `scripts/companion.sh setup --uninstall` to clear them, then re-run setup.",
          ].join(" "),
          "setup.install",
          { details: { configPath, beginLines: state.beginLines } },
        );
      }
      warnings.push(
        `Consolidated ${blocks.length} legacy host-scoped managed block(s) into one canonical block.`,
      );
      next = consolidateManagedBlocks(existing, blocks, block, lineEnding);
    } else if (state.kind === "found") {
      next = spliceBlock(existing, state.beginLine, state.endLine, block, lineEnding);
    } else {
      next = appendBlock(existing, block, lineEnding);
    }

    await assertKimiHookSetValid(next, configPath, "setup.install", context.env);
    const shortAfter = findShortHookTimeout(next, expectedCommand);
    if (shortAfter !== null) {
      throw new RuntimeError(
        "SETUP_INVALID_HOOKS_CONFIG",
        `kimi-code config at ${configPath} has another [[hooks]] entry with the hook command and ${describeHookTimeout(shortAfter.timeout)}; kimi-code runs only one entry per command and reads a hook that runs past its timeout as allow. Remove that entry before rerunning setup; the existing config was left unchanged.`,
        "setup.install",
        { details: { configPath, timeout: describeHookTimeout(shortAfter.timeout) } },
      );
    }
    if (shortBefore !== null) {
      warnings.push(
        `Rewrote hook entry from ${describeHookTimeout(shortBefore.timeout)} to timeout = ${HOOK_TIMEOUT_S}: kimi-code reads a hook that runs past its timeout as allow, so the earlier entry did not reliably enforce.`,
      );
    }

    // Stage, probe, and atomically publish the managed hook artifact under the
    // config lock (and inner hook lock) before writing config.toml so a failed
    // staged probe leaves both the live hook and config.toml untouched.
    await publishHookArtifactIfManaged(paths, hookScriptPath, context.env);
    await assertHookScriptExists(hookScriptPath);

    const blockWritten = next !== original;
    if (blockWritten) await writeConfigAtomic(configPath, next);
    return { blockWritten, next, expectedCommand };
  });
  const { blockWritten, next, expectedCommand } = mutation;

  collectPermissionRuleWarnings(next, warnings);
  const kimiBinary = describeKimiBinary(context.env, warnings);
  await collectKimiVersionWarnings(context.env, warnings);
  await collectInstalledKimiPluginsNotice(context.env, warnings);

  const probe = await probeHook(hookScriptPath, expectedCommand, context.env);

  const summary = probe.ok
    ? blockWritten
      ? `Installed kimi-plugin-cc PreToolUse hook in ${configPath}.`
      : `kimi-plugin-cc PreToolUse hook already up to date in ${configPath}.`
    : `Wrote managed block to ${configPath} but the hook script probe failed.`;
  return {
    action: "install",
    summary,
    configPath,
    hookScriptPath,
    blockWritten,
    blockRemoved: false,
    probe: probe.ok ? "ok" : "failed",
    probeError: probe.ok ? undefined : probe.reason,
    warnings,
    nextStep: probe.ok
      ? "Run `kimi_read` / `kimi_write` via MCP or `scripts/companion.sh read` / `write`."
      : "Re-run setup after installing kimi-code and Node >=22.5. If the probe keeps failing, run `scripts/companion.sh setup --uninstall` and inspect ~/.kimi-code/config.toml manually.",
    details: buildDetails({
      configPath,
      hookScriptPath,
      probe,
      warnings,
      kimiBinary,
    }),
  };
}

async function runCheck(
  configPath: string,
  hookScriptPath: string,
  warnings: string[],
  context: CommandContext,
): Promise<SetupResult> {
  const failedCheck = (result: {
    summary: string;
    reason: string;
    detailReason?: string;
    nextStep: string;
  }): SetupResult => ({
    action: "check",
    summary: result.summary,
    configPath,
    hookScriptPath,
    blockWritten: false,
    blockRemoved: false,
    probe: "failed",
    probeError: result.reason,
    warnings,
    nextStep: result.nextStep,
    details: buildDetails({
      configPath,
      hookScriptPath,
      probe: { ok: false, reason: result.detailReason ?? result.reason },
      warnings,
      kimiBinary,
    }),
  });

  // Reported on every check path, including early failures.
  const kimiBinary = describeKimiBinary(context.env, warnings);
  const existing = await readConfigSafe(configPath);
  const hookSet = await validateKimiHookSetForEnvironment(existing, context.env);
  if (!hookSet.valid) {
    return failedCheck({
      summary: `kimi-code hook configuration is invalid; the configured hooks array will not load.`,
      reason: hookSet.reason ?? "configured hooks failed validation",
      nextStep:
        "Repair or remove the invalid [[hooks]] entry named above, then run setup --check again. No model call is required.",
    });
  }
  const expectedCommand = buildHookShellCommand(hookScriptPath, context.env);
  const installedCheck = evaluateInstalled(existing, expectedCommand, {
    nodeExists: (binPath) => existsSync(binPath),
    env: context.env,
  });

  const bareTables = findUnmanagedApprovalHookBlocks(existing);
  const staleBare = bareTables.filter((t) => t.command !== expectedCommand);
  if (staleBare.length > 0) {
    warnings.push(
      `Found ${staleBare.length} stale marker-less kimi-plugin-cc hook block(s) from earlier installs. Run setup to clean them up.`,
    );
  }
  if (installedCheck.installed && installedCheck.note !== undefined) {
    warnings.push(`Note: ${installedCheck.note}`);
  }

  if (!installedCheck.installed) {
    return failedCheck({
      summary:
        installedCheck.timeoutTooShort === true
          ? `kimi-plugin-cc PreToolUse hook in ${configPath} does not enforce: ${installedCheck.reason}`
          : installedCheck.state.kind === "absent"
          ? `kimi-plugin-cc managed block is NOT installed in ${configPath}.`
          : `kimi-plugin-cc managed block is present but invalid: ${installedCheck.reason}.`,
      reason: installedCheck.reason ?? "managed block missing or invalid",
      detailReason: installedCheck.reason ?? "block missing/invalid",
      nextStep:
        installedCheck.timeoutTooShort === true
          ? "Run setup (without --check) to rewrite the hook timeout."
          : installedCheck.drift?.dataOverrideFromCanonical === true
            ? "Unset KIMI_PLUGIN_CC_DATA in your host environment (for example in ~/.claude/settings.json), restart the host, and run setup --check again."
            : installedCheck.state.kind === "absent"
              ? "Run setup (without --check) to install the managed block."
              : installedCheck.state.kind === "orphan"
                ? ORPHAN_MARKER_REMEDY
                : installedCheck.state.kind === "duplicate" &&
                    parseManagedBlock(existing).blocks.some((entry) => entry.hostId !== null)
                  ? 'Run `kimi_setup` (action "install") or `scripts/companion.sh setup` to consolidate legacy host-scoped blocks into one canonical block.'
                  : "Run setup --uninstall, then setup to repair.",
    });
  }

  collectPermissionRuleWarnings(existing, warnings);
  await collectKimiVersionWarnings(context.env, warnings);
  await collectInstalledKimiPluginsNotice(context.env, warnings);

  const artifact = await verifyManagedHookArtifact(context.env, hookScriptPath);
  if (!artifact.ok) {
    return failedCheck({
      summary:
        artifact.kind === "sha256-mismatch"
          ? `Managed hook script ${hookScriptPath} does not match the bundled hook artifact (SHA-256 mismatch).`
          : artifact.kind === "unsafe-path"
            ? `Managed hook path ${hookScriptPath} failed safety checks.`
            : artifact.kind === "bundle-missing"
              ? `Bundled hook artifact is missing or unreadable.`
              : `Managed block references ${hookScriptPath} but that path is unreadable.`,
      reason: artifact.reason,
      nextStep:
        artifact.kind === "unsafe-path"
          ? "Remove or replace the unsafe symlink/non-regular path under the plugin hook directory, then re-run setup."
          : artifact.kind === "bundle-missing"
            ? "Run `bun run build` or reinstall the plugin, then re-run setup."
            : "Run setup (without --check) to republish the hook script and refresh the managed block.",
    });
  }

  try {
    await assertHookScriptExists(hookScriptPath);
  } catch (err) {
    return failedCheck({
      summary: `Managed block references ${hookScriptPath} but that path is unreadable.`,
      reason: err instanceof Error ? err.message : String(err),
      nextStep: "Run setup (without --check) to republish the hook script and refresh the managed block.",
    });
  }

  const probe = await probeHook(hookScriptPath, expectedCommand, context.env);

  return {
    action: "check",
    summary: probe.ok
      ? `kimi-plugin-cc PreToolUse hook is installed and probe passed.`
      : `Managed block is installed but probe failed (${probe.reason}).`,
    configPath,
    hookScriptPath,
    blockWritten: false,
    blockRemoved: false,
    probe: probe.ok ? "ok" : "failed",
    probeError: probe.ok ? undefined : probe.reason,
    warnings,
    nextStep: !probe.ok
      ? "Run setup to repair the managed block, or setup --uninstall to remove the integration."
      : installedCheck.via === "bare-table"
        ? "Enforcement is active. Run setup to re-adorn the managed-block markers — kimi-code stripped comments on its last config write. Your hook keeps working meanwhile."
        : "No action needed.",
    details: buildDetails({
      configPath,
      hookScriptPath,
      probe,
      warnings,
      kimiBinary,
    }),
  };
}

async function runUninstall(
  configPath: string,
  hookScriptPath: string,
  warnings: string[],
  context: CommandContext,
): Promise<SetupResult> {
  return await withKimiConfigLock(configPath, async () => {
    const existing = await readConfigSafe(configPath);
    if (existing.length === 0) {
      return {
        action: "uninstall",
        summary: `Nothing to remove — ${configPath} does not exist or is empty.`,
        configPath,
        hookScriptPath,
        blockWritten: false,
        blockRemoved: false,
        probe: "skipped",
        warnings,
        nextStep: "Run setup to install the managed block again.",
        details: buildDetails({
          configPath,
          hookScriptPath,
          probe: { ok: true, reason: "no-op (config absent)" },
          warnings,
        }),
      };
    }

    const lineEnding = detectLineEnding(existing);
    const inlineHooks = normalizeTopLevelInlineHooks(existing, lineEnding);
    if (inlineHooks.found && !inlineHooks.converted) {
      throw new RuntimeError(
        "SETUP_INVALID_HOOKS_CONFIG",
        `Could not safely convert the top-level inline hooks assignment in ${configPath} during uninstall; the existing config was left unchanged.`,
        "setup.uninstall",
        { details: { configPath } },
      );
    }

    const working = inlineHooks.contents;
    const { blocks } = pairBlocks(splitPreservingEnding(working));
    assertManagedBlocksSafeToReplace(working, blocks, configPath, "setup.uninstall");

    const { stripped: strippedMarkers, removedBlocks, orphansLeft } = stripManagedBlocks(working);
    const expectedCommand = buildHookShellCommand(hookScriptPath, context.env);
    const { pruned: stripped, count: prunedCount } = pruneOrphanApprovalHooks(
      strippedMarkers,
      expectedCommand,
    );
    const removedAnything = removedBlocks > 0 || orphansLeft.length > 0 || prunedCount > 0;
    const finalContents = removedAnything ? stripped : existing;

    if (
      evaluateInstalled(finalContents, expectedCommand).installed ||
      countCleanEntriesInFile(finalContents, expectedCommand) > 0
    ) {
      throw new RuntimeError(
        "SETUP_UNINSTALL_INCOMPLETE",
        `Could not safely remove all kimi-plugin-cc hook entries from ${configPath}; an active hook entry for this plugin still remains. Inspect ${configPath} manually; the existing config was left unchanged.`,
        "setup.uninstall",
        { details: { configPath } },
      );
    }

    const changed = removedAnything && finalContents !== existing;
    if (changed) {
      if (inlineHooks.found) {
        warnings.push(
          `Converted the top-level inline hooks array (${inlineHooks.entryCount} entr${inlineHooks.entryCount === 1 ? "y" : "ies"}) to canonical [[hooks]] tables while removing kimi-plugin-cc entries and preserving foreign hooks.`,
        );
      }
      await writeConfigAtomic(configPath, finalContents);
    }

    if (orphansLeft.length > 0) {
      warnings.push(
        `Detected ${orphansLeft.length} orphan marker line(s) at ${orphansLeft
          .map((line) => `line ${line + 1}`)
          .join(", ")}. Removed the marker line(s) but preserved surrounding user content — verify the config visually.`,
      );
    }
    if (prunedCount > 0) {
      warnings.push(
        `Pruned ${prunedCount} orphaned kimi-plugin-cc hook block(s) with no managed marker.`,
      );
    }

    return {
      action: "uninstall",
      summary: changed
        ? `Removed ${removedBlocks} managed block(s)${prunedCount > 0 ? ` + ${prunedCount} orphan hook block(s)` : ""} from ${configPath}.`
        : `No kimi-plugin-cc managed block to remove from ${configPath}.`,
      configPath,
      hookScriptPath,
      blockWritten: false,
      blockRemoved: changed,
      probe: "skipped",
      warnings,
      nextStep: changed
        ? "Run setup again to reinstall the hook, or leave the plugin uninstalled."
        : "Run setup to install the hook.",
      details: buildDetails({
        configPath,
        hookScriptPath,
        probe: { ok: true, reason: changed ? `removed ${removedBlocks} block(s)` : "no-op (no markers)" },
        warnings,
      }),
    };
  });
}

// ----- Config IO ---------------------------------------------------------

async function readConfigSafe(configPath: string): Promise<string> {
  try {
    return await readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new RuntimeError(
      "SETUP_CONFIG_READ_FAILED",
      `Failed to read kimi-code config at ${configPath}: ${(err as Error).message}`,
      "setup.read-config",
      err instanceof Error ? { cause: err, details: { configPath } } : { details: { configPath } },
    );
  }
}

async function writeFileAtomic(targetPath: string, contents: string, mode: number): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const suffix = randomBytes(8).toString("hex");
  const tmpPath = `${targetPath}.kimi-plugin-cc.${process.pid}.${suffix}.tmp`;
  const openFlags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    (fsConstants.O_NOFOLLOW ?? 0);
  try {
    const handle = await open(tmpPath, openFlags, mode);
    try {
      if (process.platform !== "win32") {
        await handle.chmod(mode);
      }
      await handle.writeFile(contents, "utf8");
    } finally {
      await handle.close();
    }
    await rename(tmpPath, targetPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

async function writeConfigAtomic(configPath: string, contents: string): Promise<void> {
  // Pass 0o600 at creation so credentials in config.toml never exist with wider mode.
  await writeFileAtomic(configPath, contents, 0o600);
}

async function assertKimiHookSetValid(
  contents: string,
  configPath: string,
  stage: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const validation = await validateKimiHookSetForEnvironment(contents, env);
  if (validation.valid) return;
  throw new RuntimeError(
    "SETUP_INVALID_HOOKS_CONFIG",
    `${validation.reason ?? "Configured hooks failed validation"} Repair or remove that [[hooks]] entry before rerunning setup; the existing config was left unchanged.`,
    stage,
    {
      details: {
        configPath,
        hookEntry: validation.entry,
        line: validation.line,
      },
    },
  );
}

// ----- Line endings -----------------------------------------------------

function detectLineEnding(contents: string): "\n" | "\r\n" {
  // Heuristic: if the file contains any `\r\n`, treat it as CRLF.
  // Otherwise use LF (also covers the empty-file case where we're
  // writing fresh content). This keeps the file's line-ending shape
  // stable across install/uninstall on Windows users' configs.
  return contents.includes("\r\n") ? "\r\n" : "\n";
}

function spliceBlock(
  contents: string,
  beginLine: number,
  endLine: number,
  replacement: string,
  lineEnding: "\n" | "\r\n",
): string {
  const lines = contents.split(/(?<=\n)/);
  const before = lines.slice(0, beginLine).join("");
  const after = lines.slice(endLine + 1).join("");
  const beforeWithSep = before.endsWith("\n") || before.length === 0 ? before : `${before}${lineEnding}`;
  const replacementWithEnding = replacement.endsWith(lineEnding) ? replacement : `${replacement}${lineEnding}`;
  return `${beforeWithSep}${replacementWithEnding}${after}`;
}

// Keep every host's block in one contiguous run. Magpie's table rewrite drops
// comments that follow a table it owns (yetone/magpie#5614): a block appended
// after such a table loses its BEGIN marker and header, leaving an orphan END.
// Insert after the last managed END only when nothing but blanks/comments
// precedes the next header AND the real parser proves the result equals the
// appended form apart from hook order, so no field can rebind and no value can
// be split; otherwise append.
function insertBlockNearManagedBlocks(
  contents: string,
  blocks: readonly ManagedBlockEntry[],
  block: string,
  lineEnding: "\n" | "\r\n",
): string {
  if (blocks.length === 0) return appendBlock(contents, block, lineEnding);
  const anchor = Math.max(...blocks.map((b) => b.endLine));
  const lines = splitPreservingEnding(contents);
  for (let i = anchor + 1; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith("[")) break;
    if (trimmed.length > 0 && !trimmed.startsWith("#")) return appendBlock(contents, block, lineEnding);
  }
  const rawLines = contents.split(/(?<=\n)/);
  const head = rawLines.slice(0, anchor + 1).join("");
  const tail = rawLines.slice(anchor + 1).join("");
  const appended = appendBlock(contents, block, lineEnding);
  if (tail.length === 0) return appended;
  const headWithEnding = head.endsWith("\n") ? head : `${head}${lineEnding}`;
  const body = block.endsWith(lineEnding) ? block : `${block}${lineEnding}`;
  const tailSeparator = /^\r?\n/.test(tail) ? "" : lineEnding;
  const inserted = `${headWithEnding}${lineEnding}${body}${tailSeparator}${tail}`;
  return sameTomlIgnoringHookOrder(inserted, appended) ? inserted : appended;
}

function sameTomlIgnoringHookOrder(a: string, b: string): boolean {
  const canonical = (text: string): string => {
    const parsed = parseToml(text) as Record<string, unknown>;
    const hooks = Array.isArray(parsed.hooks)
      ? parsed.hooks.map((entry) => JSON.stringify(entry)).sort()
      : parsed.hooks;
    return JSON.stringify({ ...parsed, hooks });
  };
  try {
    return canonical(a) === canonical(b);
  } catch {
    return false;
  }
}

function appendBlock(contents: string, block: string, lineEnding: "\n" | "\r\n"): string {
  const base = contents.length === 0 || contents.endsWith(lineEnding) ? contents : `${contents}${lineEnding}`;
  const separator = base.length === 0 ? "" : lineEnding;
  const body = block.endsWith(lineEnding) ? block : `${block}${lineEnding}`;
  return `${base}${separator}${body}`;
}

function splitPreservingEnding(contents: string): string[] {
  // We canonicalize to '\n' for the split, then strip any '\r' that
  // came from CRLF. Rejoining is the caller's responsibility (they
  // pass the desired line ending).
  return contents.split("\n").map((line) => line.replace(/\r$/, ""));
}

// A partial upstream hooks-array rewrite can leave one marker comment behind.
// Remove only unpaired marker comments, never the intervening content. The
// normal full-file validation still gates writes.
function removeOrphanMarkers(
  contents: string,
): { contents: string; count: number } {
  const remove = new Set(pairBlocks(splitPreservingEnding(contents)).orphans.map((marker) => marker.line));
  return remove.size === 0
    ? { contents, count: 0 }
    : { contents: removeLines(contents, remove), count: remove.size };
}

function consolidateManagedBlocks(
  contents: string,
  blocks: readonly ManagedBlockEntry[],
  replacement: string,
  lineEnding: "\n" | "\r\n",
): string {
  const [first, ...rest] = blocks;
  const spliced = spliceBlock(contents, first!.beginLine, first!.endLine, replacement, lineEnding);
  const deltaLines = splitPreservingEnding(replacement).length - (first!.endLine - first!.beginLine + 1);
  const remove = new Set<number>();
  for (const extra of rest) {
    for (let i = extra.beginLine + deltaLines; i <= extra.endLine + deltaLines; i += 1) {
      remove.add(i);
    }
  }
  return removeLines(spliced, remove);
}

/**
 * Remove all managed blocks and orphan markers while preserving surrounding content.
 */
function stripManagedBlocks(contents: string): {
  stripped: string;
  removedBlocks: number;
  orphansLeft: number[];
} {
  const lines = splitPreservingEnding(contents);
  const { blocks, orphans } = pairBlocks(lines);

  const orphansLeft = orphans.map((orphan) => orphan.line);
  const remove = new Set(orphansLeft);
  let removedBlocks = 0;
  for (const block of blocks) {
    removedBlocks += 1;
    for (let i = block.beginLine; i <= block.endLine; i += 1) remove.add(i);
  }

  return { stripped: removeLines(contents, remove), removedBlocks, orphansLeft };
}

function removeLines(contents: string, remove: ReadonlySet<number>): string {
  return contents.split(/(?<=\n)/).filter((_, index) => !remove.has(index)).join("");
}

/**
 * Remove orphaned, marker-less `[[hooks]]` tables that belong to kimi-plugin-cc
 * (see `findUnmanagedApprovalHookBlocks`). Returns the cleaned text, the count
 * removed, and decoded commands so install can distinguish re-adorning from cleanup.
 */
function pruneOrphanApprovalHooks(
  contents: string,
  alsoMatchCommand?: string,
): { pruned: string; count: number; commands: string[] } {
  const ranges = findUnmanagedApprovalHookBlocks(contents, alsoMatchCommand);
  if (ranges.length === 0) return { pruned: contents, count: 0, commands: [] };

  const remove = new Set<number>();
  for (const { start, end } of ranges) {
    for (let i = start; i < end; i += 1) remove.add(i);
  }
  const lines = contents.split(/(?<=\n)/);
  const kept = lines.filter((_, idx) => !remove.has(idx));
  return {
    pruned: kept.join(""),
    count: ranges.length,
    commands: ranges.map((range) => range.command),
  };
}

// ----- Block content -----------------------------------------------------

function buildManagedBlock(
  shellCommand: string,
  lineEnding: "\n" | "\r\n" = "\n",
): string {
  const commandLine = `command = ${tomlBasicString(shellCommand)}`;
  return [
    `${BEGIN_MARKER_PREFIX} (v${KIMI_PLUGIN_CC_VERSION}) ===`,
    `# DO NOT EDIT — managed by kimi-plugin-cc setup. Run \`scripts/companion.sh setup --uninstall\` to remove.`,
    `# Purpose:`,
    `#   kimi-code's \`kimi -p\` mode hard-codes permission='auto' and`,
    `#   auto-approves every tool call. This hook enforces each managed command's`,
    `#   read-only or workspace-bound approval policy. Without this block,`,
    `#   the plugin's safety contract collapses.`,
    `# Matcher field is intentionally OMITTED — kimi-code compiles the`,
    `#   matcher with \`new RegExp(...)\`. An empty/missing matcher means`,
    `#   "fire for every tool". The string "*" would throw and silently`,
    `#   disable the hook. Do not "fix" this.`,
    `# The Node binary path is absolute so kimi-code's \`/bin/sh -c\``,
    `#   hook spawn doesn't need \`node\` on its PATH (GUI launches,`,
    `#   LaunchAgents, etc.).`,
    `[[hooks]]`,
    `event = "PreToolUse"`,
    commandLine,
    `timeout = ${DEFAULT_HOOK_TIMEOUT_S}`,
    `# === END kimi-plugin-cc-managed ===`,
  ].join(lineEnding);
}

/**
 * Encode a TOML basic string, including quotes, backslashes, and control
 * escapes. Raw shell output must not be interpolated directly: TOML reserves
 * `\'`, and a compliant parser rejects that escape.
 */
function tomlBasicString(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("\b", "\\b")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\f", "\\f")
    .replaceAll("\r", "\\r");
  return `"${escaped}"`;
}

function assertHookPathTomlSafe(hookScriptPath: string): void {
  if (!PATH_FORBIDDEN_RE.test(hookScriptPath)) return;
  throw new RuntimeError(
    "SETUP_HOOK_PATH_UNSAFE",
    [
      `Hook script path ${JSON.stringify(hookScriptPath)} contains characters`,
      `(control chars, quotes, backslashes, or newlines) that cannot be safely`,
      `written into kimi-code's TOML config. Set KIMI_PLUGIN_CC_HOOK_SCRIPT`,
      `to an unambiguous absolute path or reinstall the plugin to a location`,
      `without these characters.`,
    ].join(" "),
    "setup.hook-path",
    { details: { hookScriptPath } },
  );
}

// ----- Path resolution ---------------------------------------------------

async function assertHookScriptExists(hookScriptPath: string): Promise<void> {
  try {
    await access(hookScriptPath, fsConstants.R_OK);
  } catch (err) {
    throw new RuntimeError(
      "SETUP_HOOK_SCRIPT_MISSING",
      `Hook script ${hookScriptPath} is missing or unreadable. Reinstall the plugin so dist/hooks/approval-hook.js is present.`,
      "setup.hook-script",
      err instanceof Error ? { cause: err, details: { hookScriptPath } } : { details: { hookScriptPath } },
    );
  }
}

// ----- Probe -------------------------------------------------------------

interface ProbeOutcome {
  ok: boolean;
  reason: string;
}

/**
 * Two-layer probe; both layers require exit 2 and a non-empty denial reason.
 *
 *   1. Directly spawn the hook with the absolute Node path parsed back from
 *      `command`, catching missing/broken scripts and incorrect hook exit
 *      behavior without relying on PATH.
 *   2. Execute `command`, the exact canonical bytes from buildHookShellCommand,
 *      through `/bin/sh -c`: two shell-quoted absolute tokens for Node and the
 *      script.
 *      This catches pinned-interpreter execution and quoting failures. It does
 *      NOT test PATH discovery or compatibility of some other `node` on PATH.
 *
 * The shell layer is skipped where `/bin/sh` is unsupported; the runtime
 * otherwise assumes POSIX.
 */
async function probeHook(
  hookScriptPath: string,
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<ProbeOutcome> {
  const directResult = await probeHookDirect(hookScriptPath, command, env);
  if (!directResult.ok) return directResult;

  const shellResult = await probeHookViaShell(command, env);
  if (!shellResult.ok) return shellResult;

  return {
    ok: true,
    reason: `${directResult.reason}; shell probe also ok`,
  };
}

async function probeHookDirect(
  hookScriptPath: string,
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<ProbeOutcome> {
  // Parsed back from the command, never re-resolved; the fallback is unreachable.
  const nodeBin = parseHookShellCommand(command)?.nodeBin ?? resolveNodeBinary(env);
  return await spawnProbe(
    nodeBin,
    [hookScriptPath],
    env,
    `direct probe via ${nodeBin}`,
  );
}

async function probeHookViaShell(
  shellCommand: string,
  env: NodeJS.ProcessEnv,
): Promise<ProbeOutcome> {
  if (process.platform === "win32") {
    // The hook runner shells out via `/bin/sh -c` per agent-core; on
    // Windows the entire kimi-code launcher is unsupported. Skip the
    // shell probe so we don't false-fail on a platform we don't run on.
    return { ok: true, reason: "shell probe skipped (Windows)" };
  }
  // The exact command string the managed block wrote into kimi-code's config,
  // so probe and runtime cannot drift.
  return await spawnProbe(
    "/bin/sh",
    ["-c", shellCommand],
    env,
    `shell probe via /bin/sh -c`,
  );
}

function spawnProbe(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  label: string,
): Promise<ProbeOutcome> {
  const payload = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "kimi-plugin-cc-setup-probe",
    cwd: process.cwd(),
    tool_name: "Bash",
    tool_input: { command: "echo probe" },
    tool_call_id: "probe-1",
  });

  return new Promise<ProbeOutcome>((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        env: {
          ...env,
          KIMI_PLUGIN_CC_CMD: "review",
          KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ ok: false, reason: `${label}: spawn failed: ${(err as Error).message}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
      resolve({
        ok: false,
        reason: `${label}: timed out after ${PROBE_TIMEOUT_MS}ms (no exit). stderr: ${truncate(stderr, 200)}`,
      });
    }, PROBE_TIMEOUT_MS);
    timer.unref();

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `${label}: process error: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stderrTrimmed = stderr.trim();
      if (code === 2 && stderrTrimmed.length > 0) {
        resolve({ ok: true, reason: `${label}: deny reason captured (${stderrTrimmed.slice(0, 80)}…)` });
      } else {
        resolve({
          ok: false,
          reason: `${label}: expected exit 2 with deny reason, got exit ${code ?? "<null>"}. stdout=${truncate(stdout, 120)} stderr=${truncate(stderrTrimmed, 200)}`,
        });
      }
    });

    try {
      child.stdin?.write(payload);
      child.stdin?.end();
    } catch (err) {
      clearTimeout(timer);
      resolve({ ok: false, reason: `${label}: failed to write probe stdin: ${(err as Error).message}` });
    }
  });
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

// ----- Plugin-owned kimi-code (--install-kimi) ---------------------------

const KIMI_PACKAGE = "@moonshot-ai/kimi-code";
const KIMI_INSTALL_TIMEOUT_MS = 300_000;
const KIMI_INSTALL_KILL_GRACE_MS = 2_000;
// First start of a fresh install loads a large bundle; allow more than the
// 5s job-time probe.
const KIMI_INSTALL_PROBE_TIMEOUT_MS = 30_000;
const STDERR_TAIL_BYTES = 2_000;
const STAGING_PREFIX = ".staging-";
// A staging directory younger than this may belong to a concurrent install
// still inside its npm timeout and probe window, so it is not stale yet.
const STALE_STAGING_AGE_MS = 2 * (KIMI_INSTALL_TIMEOUT_MS + KIMI_INSTALL_PROBE_TIMEOUT_MS);

/** Numeric, not lexical: "2.10.0" is above "2.9.0". */
export function highestCertifiedKimiVersion(
  versions: readonly string[] = NATIVE_V2_CERTIFIED_VERSIONS,
): string {
  const parse = (v: string) => v.split(".").map(Number);
  const sorted = [...versions].sort((a, b) => {
    const [x, y] = [parse(a), parse(b)];
    for (let i = 0; i < 3; i += 1) {
      if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
    }
    return 0;
  });
  const highest = sorted[sorted.length - 1];
  if (highest === undefined || !/^\d+\.\d+\.\d+$/.test(highest)) {
    throw new RuntimeError("KIMI_INSTALL_FAILED", "No exact certified kimi-code version is available to install.", "setup.install-kimi");
  }
  return highest;
}

function compareExactVersions(a: string, b: string): number {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}

interface KimiInstallOutcome {
  version: string;
  downloaded: boolean;
  binary: string;
  current: string;
}

async function runInstallKimi(json: boolean, context: CommandContext): Promise<SetupResult> {
  let version = "";
  try {
    version = highestCertifiedKimiVersion();
    const outcome = await installPluginOwnedKimi(version, context.env);
    const selection = selectKimiBinary(context.env);
    const jobsUseIt = selection.source === "plugin-owned" && selection.command === outcome.binary;
    const summary = outcome.downloaded
      ? `Installed kimi-code ${version} for kimi-plugin-cc.`
      : `kimi-code ${version} is already installed for kimi-plugin-cc; nothing was downloaded.`;
    const jobsLine = jobsUseIt
      ? "Jobs will now use this binary."
      : selection.source === "override"
        ? `KIMI_PLUGIN_CC_KIMI_BIN is set, so jobs keep using ${selection.command} until it is unset.`
        : `Jobs do not use this binary yet: ${selection.pluginOwned.reason ?? "selection did not pick it"}.`;
    return installKimiResult({
      summary,
      failed: false,
      details: [
        `Version:          ${version}`,
        `Binary:           ${outcome.binary}`,
        `Current link:     ${outcome.current} -> ${path.join(version, "node_modules", ".bin", "kimi")}`,
        `Jobs:             ${jobsLine}`,
      ],
      nextStep: jobsUseIt
        ? "Run setup --check to confirm the hook and the selected binary."
        : "Unset KIMI_PLUGIN_CC_KIMI_BIN to use the plugin-owned binary, then run setup --check.",
      report: {
        ok: true,
        json,
        version,
        downloaded: outcome.downloaded,
        binary: outcome.binary,
        current: outcome.current,
        selectedBinary: selection.command,
        selectedSource: selection.source,
      },
    });
  } catch (error) {
    const runtimeError = error instanceof RuntimeError
      ? error
      : new RuntimeError("KIMI_INSTALL_FAILED", error instanceof Error ? error.message : String(error), "setup.install-kimi");
    return installKimiResult({
      summary: `Failed to install kimi-code${version ? ` ${version}` : ""} for kimi-plugin-cc; the selected binary is unchanged.`,
      failed: true,
      probeError: `[${runtimeError.code}] ${runtimeError.message}`,
      details: [`Error:            [${runtimeError.code}] ${runtimeError.message}`],
      nextStep: "Fix the cause above and re-run setup --install-kimi. Jobs keep using the previously selected binary.",
      report: {
        ok: false,
        json,
        version,
        downloaded: false,
        error: { code: runtimeError.code, message: runtimeError.message, details: runtimeError.details },
      },
    });
  }
}

function installKimiResult(args: {
  summary: string;
  failed: boolean;
  probeError?: string;
  details: string[];
  nextStep: string;
  report: KimiInstallReport;
}): SetupResult {
  return {
    action: "install-kimi",
    summary: args.summary,
    configPath: "",
    hookScriptPath: "",
    blockWritten: false,
    blockRemoved: false,
    // "failed" makes the companion exit 1; the hook itself is not probed here.
    probe: args.failed ? "failed" : "skipped",
    probeError: args.probeError,
    warnings: [],
    nextStep: args.nextStep,
    details: args.details,
    kimiInstall: args.report,
  };
}

/**
 * Install exactly `version` into `<data root>/kimi-plugin-cc/kimi-bin/<version>/` and point
 * `current` at it. A verified existing install is reused without network
 * access. Downloads stage in a sibling directory that is verified with the
 * exact-version probe before it is renamed into place; any failure removes
 * the staging directory and leaves `current` untouched.
 */
async function installPluginOwnedKimi(version: string, env: NodeJS.ProcessEnv): Promise<KimiInstallOutcome> {
  if (process.platform === "win32") {
    throw new RuntimeError(
      "KIMI_INSTALL_UNSUPPORTED_PLATFORM",
      "setup --install-kimi is not supported on Windows. Install kimi-code yourself and set KIMI_PLUGIN_CC_KIMI_BIN to its path.",
      "setup.install-kimi",
    );
  }
  const binDir = resolveKimiBinDir(env);
  await mkdir(binDir, { recursive: true });
  await removeStaleStaging(binDir);
  const versionDir = path.join(binDir, version);
  const binRelative = path.join(version, "node_modules", ".bin", "kimi");
  const binPath = path.join(binDir, binRelative);
  const currentPath = path.join(binDir, "current");

  const existing = await verifyKimiBinary(binPath, binDir, version, version, env);
  if (existing.ok) {
    await pointCurrentAt(binDir, binRelative, currentPath, env);
    return { version, downloaded: false, binary: await realpath(binPath), current: currentPath };
  }

  const staging = await mkdtemp(path.join(binDir, `${STAGING_PREFIX}${version}-`));
  let trash: string | undefined;
  try {
    await writeFile(
      path.join(staging, "package.json"),
      `${JSON.stringify({ name: "kimi-plugin-cc-kimi-bin", private: true })}\n`,
      "utf8",
    );
    await runNpmInstall(staging, version, env);
    const staged = await verifyKimiBinary(
      path.join(staging, "node_modules", ".bin", "kimi"),
      binDir,
      path.basename(staging),
      version,
      env,
    );
    if (!staged.ok) {
      throw new RuntimeError(
        "KIMI_INSTALL_VERIFY_FAILED",
        `The installed kimi-code did not verify as exactly ${version}: ${staged.reason}.`,
        "setup.install-kimi",
        { details: { expected_version: version } },
      );
    }
    if (await pathExists(versionDir)) {
      // A present but unverifiable version directory is set aside, not reused.
      trash = path.join(binDir, `.trash-${version}-${randomBytes(4).toString("hex")}`);
      await rename(versionDir, trash);
    }
    try {
      await rename(staging, versionDir);
    } catch (error) {
      if (trash) {
        await rename(trash, versionDir).catch(() => undefined);
        trash = undefined;
      }
      throw error;
    }
    await pointCurrentAt(binDir, binRelative, currentPath, env);
    return { version, downloaded: true, binary: await realpath(binPath), current: currentPath };
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (trash) await rm(trash, { recursive: true, force: true });
  }
}

/** Remove staging directories an interrupted install left directly in kimi-bin/. */
async function removeStaleStaging(binDir: string, now = Date.now()): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(binDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    const entry = path.join(binDir, name);
    try {
      const info = await lstat(entry);
      if (!info.isDirectory() || now - info.mtimeMs < STALE_STAGING_AGE_MS) continue;
      await rm(entry, { recursive: true, force: true });
    } catch {
      // Best effort: a leftover never affects binary resolution.
    }
  }
}

/**
 * Containment comes before execution: `binary` must resolve to an executable
 * regular file physically inside `<realpath(binDir)>/<dirName>/`, and only
 * that resolved path is probed. Anchoring at the real kimi-bin plus the
 * expected name rejects a version or staging directory that is itself a link.
 */
async function verifyKimiBinary(
  binary: string,
  binDir: string,
  dirName: string,
  version: string,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let resolved: string;
  let root: string;
  try {
    resolved = await realpath(binary);
    root = path.join(await realpath(binDir), dirName);
  } catch {
    return { ok: false, reason: `${binary} is missing` };
  }
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    return { ok: false, reason: `${binary} resolves to ${resolved}, outside ${root}${path.sep}` };
  }
  try {
    const info = await lstat(resolved);
    if (!info.isFile()) return { ok: false, reason: `${resolved} is not a regular file` };
    await access(resolved, fsConstants.X_OK);
  } catch {
    return { ok: false, reason: `${resolved} is not executable` };
  }
  const probe = await probeKimiVersion({ kimiBin: resolved, env, timeoutMs: KIMI_INSTALL_PROBE_TIMEOUT_MS });
  if (probe.kind !== "ok") return { ok: false, reason: probe.reason };
  const observed = probe.version.replace(/^v/, "");
  return observed === version ? { ok: true } : { ok: false, reason: `\`--version\` reported ${probe.version}` };
}

/**
 * Atomically replace `current` (POSIX rename over the old link), then confirm
 * binary resolution accepts the new link; otherwise restore the old one.
 */
async function pointCurrentAt(
  binDir: string,
  binRelative: string,
  currentPath: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  let previous: string | undefined;
  try {
    previous = await readlink(currentPath);
  } catch {
    previous = undefined;
  }
  if (previous === binRelative && inspectPluginOwnedKimi(env).status === "active") return;
  const swap = async (target: string) => {
    const temp = path.join(binDir, `.current-${randomBytes(4).toString("hex")}`);
    await symlink(target, temp);
    try {
      await rename(temp, currentPath);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  };
  await swap(binRelative);
  const state = inspectPluginOwnedKimi(env);
  if (state.status !== "active") {
    if (previous !== undefined) await swap(previous);
    else await rm(currentPath, { force: true });
    throw new RuntimeError(
      "KIMI_INSTALL_VERIFY_FAILED",
      `The new ${currentPath} link was not accepted by binary resolution: ${state.reason ?? state.status}. The previous link was restored.`,
      "setup.install-kimi",
    );
  }
}

async function runNpmInstall(prefix: string, version: string, env: NodeJS.ProcessEnv): Promise<void> {
  // Never a global install, whatever the caller's npm environment says.
  const npmEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(npmEnv)) {
    if (/^npm_config_(global|location|prefix)$/i.test(key)) delete npmEnv[key];
  }
  const args = [
    "install",
    "--prefix", prefix,
    "--no-global",
    // kimi-code's postinstall only acts on global installs and no runtime
    // dependency declares an install script.
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-update-notifier",
    "--save-exact",
    `${KIMI_PACKAGE}@${version}`,
  ];
  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("npm", args, { cwd: prefix, env: npmEnv, stdio: ["ignore", "ignore", "pipe"], detached: true });
    } catch (error) {
      reject(npmFailure(`could not start npm: ${(error as Error).message}`, version));
      return;
    }
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });
    let timedOut = false;
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), KIMI_INSTALL_KILL_GRACE_MS).unref();
    }, KIMI_INSTALL_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(npmFailure(`could not start npm: ${error.message}`, version));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(npmFailure(`npm install timed out after ${KIMI_INSTALL_TIMEOUT_MS / 1000}s`, version, stderr));
      } else if (code !== 0) {
        reject(npmFailure(`npm install exited ${code ?? signal}`, version, stderr));
      } else {
        resolve();
      }
    });
  });
}

function npmFailure(reason: string, version: string, stderr = ""): RuntimeError {
  return new RuntimeError(
    "KIMI_INSTALL_FAILED",
    `Could not install ${KIMI_PACKAGE}@${version}: ${reason}.`,
    "setup.install-kimi",
    { details: { package: `${KIMI_PACKAGE}@${version}`, ...(stderr.trim() ? { npm_stderr_tail: stderr.trim() } : {}) } },
  );
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Which binary jobs will use and why, plus a note when the plugin-owned one is stale or unusable. */
function describeKimiBinary(env: NodeJS.ProcessEnv, warnings: string[]): string {
  const selection = selectKimiBinary(env);
  const owned = selection.pluginOwned;
  const highest = highestCertifiedKimiVersion();
  if (owned.status === "active" && owned.version && compareExactVersions(owned.version, highest) < 0) {
    warnings.push(
      `NOTE: the plugin-owned kimi-code ${owned.version} is behind the highest certified version ${highest}. Run setup --install-kimi to install ${highest}.`,
    );
  }
  if (owned.status === "rejected") {
    warnings.push(
      `The plugin-owned kimi-code install is not used: ${owned.reason}. Run setup --install-kimi to repair it.`,
    );
  }
  switch (selection.source) {
    case "override":
      return `${selection.command} (KIMI_PLUGIN_CC_KIMI_BIN override)`;
    case "plugin-owned":
      return `${selection.command} (plugin-owned kimi-code ${owned.version} from setup --install-kimi)`;
    case "path":
      return owned.status === "absent"
        ? `kimi on PATH (no plugin-owned install; setup --install-kimi installs ${highest})`
        : `kimi on PATH (plugin-owned install ${owned.status}${owned.reason ? `: ${owned.reason}` : ""})`;
  }
}

// ----- Permission rules scan --------------------------------------------

/**
 * Warn only when the installed kimi is demonstrably outside the certified
 * range. Probe failure records nothing here because the hook probe reports the
 * more direct problem; setup may finish, but model spawn still refuses an
 * uncertified binary. KIMI_PLUGIN_CC_SKIP_VERSION_PROBE is a test/CI bypass,
 * not a production compatibility override.
 */
async function collectKimiVersionWarnings(
  env: NodeJS.ProcessEnv,
  warnings: string[],
): Promise<void> {
  if (env.KIMI_PLUGIN_CC_SKIP_VERSION_PROBE === "1") return;
  // The same binary jobs select (override, plugin-owned, then PATH).
  const probe = await probeKimiVersion({
    kimiBin: selectKimiBinary(env).command,
    env,
  });
  if (probe.kind === "failed") {
    warnings.push(
      `WARNING: could not verify the selected kimi-code binary version (${probe.reason}). Model-spawning operations will refuse until a working kimi-code >= ${KIMI_MINIMUM_CERTIFIED_VERSION} binary is available; run \`kimi_setup\` (action "install_kimi") or \`scripts/companion.sh setup --install-kimi\`, or check KIMI_PLUGIN_CC_KIMI_BIN.`,
    );
    return;
  }
  if (!isNativeV2CertifiedVersion(probe.version)) {
    warnings.push(formatVersionOutOfRangeWarning(probe, KIMI_PLUGIN_CC_VERSION, NATIVE_V2_ANY_OPERATION_VERSIONS, env));
    return;
  }
  if (kimiReleaseHas(probe.version, "bounded-swarm")) {
    warnings.push(
      `NOTE: kimi-code ${probe.version} is certified for all operations. Swarm uses bounded waves with concurrency 2 or more, and one direct worker at concurrency 1. The finite job budget stops the whole run.`,
    );
    return;
  }
  if (NATIVE_V2_NON_SWARM_VERSIONS.includes(probe.version)) {
    warnings.push(
      `NOTE: kimi-code ${probe.version} is certified for review, challenge, ask, rescue, review gate, and pursue only. Read-only swarm and write swarm refuse before model spawn on this exact release. Select exact kimi-code ${formatVersionChoice(kimiVersionsWith("bounded-swarm"))} for this plugin's certified bounded waves and single-worker path.`,
    );
  }
}

/**
 * Non-blocking notice for kimi-code's own enabled plugins from
 * ~/.kimi-code/plugins/installed.json. Their tools can register on every
 * session, but read-only commands deny everything outside READ_ONLY_TOOLS
 * (Read, Grep, Glob, ReadMediaFile, TaskList, TaskOutput, WaitFor), which can waste model
 * turns. Missing, unreadable, or malformed manifests produce no notice; setup
 * never blocks on or mutates the plugin list.
 */
async function collectInstalledKimiPluginsNotice(
  env: NodeJS.ProcessEnv,
  warnings: string[],
): Promise<void> {
  const home = resolveKimiHome(env);
  const installedPath = path.join(home, "plugins", "installed.json");
  let raw: string;
  try {
    raw = await readFile(installedPath, "utf8");
  } catch {
    return; // ENOENT / unreadable — kimi-code's plugin system isn't in use here.
  }
  let enabledIds: string[];
  try {
    const parsed = JSON.parse(raw) as { plugins?: unknown };
    if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.plugins)) {
      return;
    }
    enabledIds = parsed.plugins
      .filter(
        (entry): entry is { id?: unknown; enabled?: unknown } =>
          entry !== null && typeof entry === "object",
      )
      // `enabled !== false` so an explicitly-disabled plugin is hidden while an
      // enabled or format-ambiguous one is surfaced (it can still register tools).
      .filter((entry) => entry.enabled !== false)
      .map((entry) => (typeof entry.id === "string" ? entry.id : ""))
      .filter((id) => id.length > 0);
  } catch {
    return; // Malformed JSON — don't guess.
  }
  if (enabledIds.length === 0) return;
  warnings.push(
    [
      `NOTE: ${enabledIds.length} kimi-code plugin(s) installed and enabled: ${enabledIds.join(", ")}.`,
      "  kimi-code registers their tools (including MCP) on every session. Under kimi-plugin-cc's",
      "  read-only operations (kimi_read and companion.sh read) the",
      "  PreToolUse hook denies every tool that is not on its read-only list, so calls to these plugins' tools",
      "  are blocked — safe, but they can waste model turns. This is expected; no action needed.",
      "  (kimi_write, companion.sh write, and swarm modes apply their own allowlists.) To avoid the turn-waste, disable",
      "  kimi-code plugins you don't need for delegated work in your kimi-code config.",
    ].join("\n"),
  );
}

/**
 * Best-effort line scan for permission rules that deny common read tools. This
 * is not a TOML parse: it recognizes basic and literal quoted strings but misses
 * inline-table and multiline forms.
 */
function collectPermissionRuleWarnings(contents: string, warnings: string[]): void {
  const lines = contents.split("\n").map((line) => line.replace(/\r$/, ""));
  let inRule = false;
  let ruleStartLine = -1;
  let ruleDecision = "";
  let rulePattern = "";

  const flushRule = () => {
    if (!inRule) return;
    if (ruleDecision === "deny" && rulePattern.length > 0) {
      if (
        rulePattern === "*" ||
        /^\s*Read\b/.test(rulePattern) ||
        /^\s*Grep\b/.test(rulePattern) ||
        /^\s*Glob\b/.test(rulePattern)
      ) {
        warnings.push(
          `permission.rules at line ${ruleStartLine + 1}: deny pattern "${rulePattern}" may block read-only commands; consider scoping the deny narrower.`,
        );
      }
    }
    inRule = false;
    ruleStartLine = -1;
    ruleDecision = "";
    rulePattern = "";
  };

  // Accept either double-quoted basic strings or single-quoted literal
  // strings for `decision` and `pattern`.
  const decisionRE = /^\s*decision\s*=\s*(?:"([^"]*)"|'([^']*)')/;
  const patternRE = /^\s*pattern\s*=\s*(?:"([^"]*)"|'([^']*)')/;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === "[[permission.rules]]") {
      flushRule();
      inRule = true;
      ruleStartLine = i;
      continue;
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      flushRule();
      continue;
    }
    if (!inRule) continue;
    const decisionMatch = decisionRE.exec(line);
    if (decisionMatch) {
      ruleDecision = decisionMatch[1] ?? decisionMatch[2] ?? "";
      continue;
    }
    const patternMatch = patternRE.exec(line);
    if (patternMatch) {
      rulePattern = patternMatch[1] ?? patternMatch[2] ?? "";
      continue;
    }
  }
  flushRule();
}

// ----- Detail rendering --------------------------------------------------

function buildDetails(args: {
  configPath: string;
  hookScriptPath: string;
  probe: ProbeOutcome;
  warnings: string[];
  kimiBinary?: string;
}): string[] {
  const details = [
    `Companion runtime: Node ${process.version}`,
    `Plugin version:   ${KIMI_PLUGIN_CC_VERSION}`,
    ...(args.kimiBinary ? [`Kimi binary:      ${args.kimiBinary}`] : []),
    `Config file:      ${args.configPath}`,
    `Hook script:      ${args.hookScriptPath}`,
    `Probe:            ${args.probe.ok ? "ok" : "failed"} — ${args.probe.reason}`,
  ];
  if (args.warnings.length > 0) {
    details.push("Warnings:");
    for (const warning of args.warnings) {
      details.push(`  - ${warning}`);
    }
  }
  return details;
}

export function renderSetupResult(result: SetupResult): string {
  if (result.kimiInstall) return renderInstallKimiResult(result, result.kimiInstall);
  return [
    result.summary,
    "",
    `Action:      ${result.action}`,
    `Block written:  ${result.blockWritten ? "yes" : "no"}`,
    `Block removed:  ${result.blockRemoved ? "yes" : "no"}`,
    `Probe:          ${result.probe}${result.probeError ? ` (${result.probeError})` : ""}`,
    "",
    "Details:",
    ...result.details.map((detail) => `- ${detail}`),
    "",
    `Next step: ${result.nextStep}`,
    "Models: run setup --models to list configured aliases and provider setup guidance without making a model call.",
  ].join("\n");
}

function renderInstallKimiResult(result: SetupResult, report: KimiInstallReport): string {
  if (report.json) {
    return JSON.stringify({
      action: "install-kimi",
      ok: report.ok,
      version: report.version,
      downloaded: report.downloaded,
      binary: report.binary ?? null,
      current: report.current ?? null,
      selected_binary: report.selectedBinary ?? null,
      selected_source: report.selectedSource ?? null,
      error: report.error ?? null,
      next_step: result.nextStep,
    }, null, 2);
  }
  return [
    result.summary,
    "",
    `Action:      ${result.action}`,
    "",
    "Details:",
    ...result.details.map((detail) => `- ${detail}`),
    "",
    `Next step: ${result.nextStep}`,
  ].join("\n");
}

export type { ManagedBlockState };
