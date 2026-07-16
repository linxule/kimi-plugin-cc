// Managed-block installer for the kimi-code PreToolUse hook.
//
// Replaces the v0.4 Wire-based setup probe. In v1.0 the load-bearing
// safety control is the PreToolUse hook (see runtime/hooks/approval-policy.ts) —
// without it, `kimi -p` auto-approves every tool call from review /
// challenge / review_gate / ask. PR 3 made rescue REFUSE to run when the
// hook is missing, so /kimi:setup is the only path that wires the
// plugin's safety story into ~/.kimi-code/config.toml.
//
// What this command does:
//
//   - Writes (or refreshes, idempotently) a BEGIN/END marker block to
//     `~/.kimi-code/config.toml` containing a [[hooks]] entry that
//     invokes `<process.execPath> /abs/path/to/dist/hooks/approval-hook.js`
//     on PreToolUse. The absolute Node binary is used (not bare `node`)
//     so the hook keeps working when kimi-code is launched from a
//     GUI/LaunchAgent with a sanitized PATH (nvm/asdf/mise users).
//   - Probes the installed hook in TWO ways: (a) directly via the same
//     in-process Node binary, and (b) via `/bin/sh -c "<command>"` to
//     mirror kimi-code's actual hook-runner spawn shape (kimi-code
//     shells out via `/bin/sh -c` per agent-core hooks/runner.ts).
//   - Scans the user's existing `[[permission.rules]]` for broad denies
//     that would interfere with read-only commands; warns on stdout.
//   - Detects and refuses to install over duplicate managed blocks,
//     orphan markers, or malformed blocks (matcher present, wrong
//     event, missing command). Same parser shared with PR 2's
//     runtime/hooks/install.ts verifier.
//
// Subcommands:
//
//   /kimi:setup                — install (idempotent) + probe
//   /kimi:setup --check        — probe only (no write)
//   /kimi:setup --uninstall    — remove managed block (and orphan markers)
//   /kimi:setup --enable-review-gate / --disable-review-gate
//                              — flip the plugin-side review-gate flag in
//                                CLAUDE_PLUGIN_DATA/config.json
//
// TOML manipulation is line-based, not via a TOML parser. The marker
// block is owned by us; the rest of the file is the user's, untouched.

import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { readPluginConfig, writePluginConfig } from "../config.js";
import { RuntimeError } from "../errors.js";
import {
  normalizeTopLevelInlineHooks,
  validateKimiHookSetForEnvironment,
  withKimiConfigLock,
} from "../hooks/config-safety.js";
import {
  buildHookShellCommand,
  hostIdFromHookCommand,
  resolveHookScriptPath,
  resolveHostId,
  resolveNodeBinary,
} from "../hooks/install-paths.js";
import {
  decodeManagedCommandLine,
  effectiveHost,
  evaluateInstalled,
  findUnmanagedApprovalHookBlocks,
  MARKERS,
  parseManagedBlock,
  type ManagedBlockState,
} from "../hooks/managed-block.js";
import {
  formatVersionOutOfRangeWarning,
  probeKimiVersion,
} from "../kimi-version-probe.js";
import { resolveKimiHome } from "../kimi-home.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import type { CommandContext } from "../types.js";
import { KIMI_PLUGIN_CC_VERSION } from "../version.js";

const BEGIN_MARKER_PREFIX = "# === BEGIN kimi-plugin-cc-managed";

const DEFAULT_HOOK_TIMEOUT_S = 15;

// Probe timing. The direct script probe is local and fast; allow 5s for
// node startup on cold CI runners. The shell probe adds /bin/sh fork
// overhead but should still complete well within the same budget.
const PROBE_TIMEOUT_MS = 5_000;

// Reject hook script paths that contain characters TOML basic strings
// reserve as escape sequences (other than the ones we already escape)
// or shell-special characters whose presence would force us into
// fragile quoting. The realistic install location lives under
// `${plugin_root}/dist/hooks/approval-hook.js` and never legitimately
// contains these — anyone hitting this hard error has either a hostile
// `KIMI_PLUGIN_CC_HOOK_SCRIPT` override or an unusual install layout.
const PATH_FORBIDDEN_RE = /[\x00-\x1f"\\\n\r\t]/;

export type SetupAction = "install" | "uninstall" | "check";

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
  /** Probe outcome. `"skipped"` when --uninstall and no block remains. */
  probe: "ok" | "failed" | "skipped";
  /** Failure detail when probe === "failed". */
  probeError?: string;
  /** Warnings about user-side config that may interfere. */
  warnings: string[];
  reviewGateEnabled: boolean;
  nextStep: string;
  details: string[];
}

interface ParsedArgs {
  mode: SetupAction;
  enableReviewGate: boolean;
  disableReviewGate: boolean;
  /** `--uninstall --all`: remove EVERY host's managed block + orphan cruft. */
  removeAllHosts: boolean;
}

export async function runSetup(argv: string[], context: CommandContext): Promise<SetupResult> {
  const parsed = parseArgs(argv);

  const paths = resolvePluginPaths(context.env);
  await ensurePluginPaths(paths);

  // Reconcile the review-gate flag first — it's independent of the
  // kimi-code hook and we want the answer reflected in the result even
  // if the rest of setup fails.
  const existingConfig = await readPluginConfig(paths);
  const reviewGateEnabled = parsed.enableReviewGate
    ? true
    : parsed.disableReviewGate
      ? false
      : existingConfig.reviewGateEnabled;
  if (reviewGateEnabled !== existingConfig.reviewGateEnabled) {
    await writePluginConfig(paths, { reviewGateEnabled });
  }

  const configPath = resolveKimiCodeConfigPath(context.env);
  const hookScriptPath = resolveHookScriptPath(context.env);
  assertHookPathTomlSafe(hookScriptPath);
  // Host id keys the managed block so Claude Code and Codex share one
  // ~/.kimi-code/config.toml without clobbering each other (v1.7.0).
  const hostId = resolveHostId(context.env, hookScriptPath);

  const warnings: string[] = [];

  switch (parsed.mode) {
    case "uninstall":
      return await runUninstall(
        configPath,
        hookScriptPath,
        hostId,
        parsed.removeAllHosts,
        reviewGateEnabled,
        warnings,
        context,
      );
    case "check":
      return await runCheck(configPath, hookScriptPath, hostId, reviewGateEnabled, warnings, context);
    case "install":
      return await runInstall(configPath, hookScriptPath, hostId, reviewGateEnabled, warnings, context);
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  let mode: SetupAction = "install";
  let enableReviewGate = false;
  let disableReviewGate = false;
  let removeAllHosts = false;

  for (const token of argv) {
    switch (token) {
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
      case "--all":
        removeAllHosts = true;
        break;
      case "--enable-review-gate":
        enableReviewGate = true;
        break;
      case "--disable-review-gate":
        disableReviewGate = true;
        break;
      default:
        throw new RuntimeError(
          "INVALID_ARGS",
          `Unknown setup flag ${token}. Supported flags: --check, --uninstall, --all (with --uninstall), --enable-review-gate, --disable-review-gate.`,
          "setup.parse",
        );
    }
  }

  if (enableReviewGate && disableReviewGate) {
    throw new RuntimeError(
      "INVALID_ARGS",
      "setup accepts either --enable-review-gate or --disable-review-gate, not both.",
      "setup.parse",
    );
  }

  if (removeAllHosts && mode !== "uninstall") {
    throw new RuntimeError(
      "INVALID_ARGS",
      "--all is only valid with --uninstall (it removes EVERY host's managed block).",
      "setup.parse",
    );
  }

  return { mode, enableReviewGate, disableReviewGate, removeAllHosts };
}

async function runInstall(
  configPath: string,
  hookScriptPath: string,
  hostId: string,
  reviewGateEnabled: boolean,
  warnings: string[],
  context: CommandContext,
): Promise<SetupResult> {
  await assertHookScriptExists(hookScriptPath);

  const mutation = await withKimiConfigLock(configPath, async () => {
    const original = await readConfigSafe(configPath);
    const lineEnding = detectLineEnding(original);
    const inlineHooks = normalizeTopLevelInlineHooks(original, lineEnding);
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

    // Prune THIS HOST's orphaned, marker-less approval-hook [[hooks]] entries
    // BEFORE resolving the managed block, so line numbers used for splicing are
    // computed against the cleaned text. Host-scoped (v1.8.2): after a
    // kimi-code config rewrite strips marker comments, ANOTHER host's
    // marker-less table is that host's LIVE hook — pruning it here was the
    // pre-v1.8.2 seesaw where each host's setup disarmed the other.
    const expectedCommand = buildHookShellCommand(hookScriptPath, context.env);
    const { pruned, count: prunedCount, commands: prunedCommands } =
      pruneOrphanApprovalHooks(inlineHooks.contents, lineEnding, hostId, expectedCommand);
    const existing = pruned;
    if (prunedCount > 0) {
      const readorned = prunedCommands.includes(expectedCommand);
      warnings.push(
        readorned
          ? `Re-adorned this host's managed-block markers: kimi-code rewrites its config on login/settings changes and strips all comments (markers included), leaving the hook enforcing but unmarked. Replaced the bare hook table with a freshly marked block (${prunedCount} table(s) refreshed). Enforcement was never interrupted.`
          : `Pruned ${prunedCount} stale marker-less kimi-plugin-cc hook block(s) left by this host's earlier installs. This is a cleanup — your active hook is unaffected.`,
      );
    }

    const { state, blocks } = parseManagedBlock(existing, hostId);

    if (state.kind === "orphan") {
      throw new RuntimeError(
        "SETUP_ORPHAN_MARKERS",
        [
          `kimi-code config at ${configPath} contains an orphaned ${state.detail} marker.`,
          "Run `/kimi:setup --uninstall` to clean up, then re-run `/kimi:setup`.",
        ].join(" "),
        "setup.install",
        { details: { configPath, orphan: state.detail } },
      );
    }
    if (state.kind === "duplicate") {
      throw new RuntimeError(
        "SETUP_DUPLICATE_BLOCKS",
        [
          `kimi-code config at ${configPath} contains ${state.beginLines.length} kimi-plugin-cc managed blocks for host ${hostId} (lines ${state.beginLines
            .map((line) => line + 1)
            .join(", ")}).`,
          "This usually means two /kimi:setup runs raced. Run `/kimi:setup --uninstall` to clear them, then `/kimi:setup` again.",
        ].join(" "),
        "setup.install",
        { details: { configPath, beginLines: state.beginLines } },
      );
    }

    // Non-blocking note: other hosts (e.g. Codex) manage their own block in the
    // same shared config — surface so an operator understands the coexistence.
    const otherHosts = [
      ...new Set(blocks.map((b) => effectiveHost(b, hostId)).filter((h) => h !== hostId)),
    ];
    if (otherHosts.length > 0) {
      warnings.push(
        `Other host(s) also manage a block in this shared config: ${otherHosts.join(", ")}. ` +
          `They are left untouched — each host owns its own PreToolUse block.`,
      );
    }

    const block = buildManagedBlock(hookScriptPath, context.env, lineEnding, hostId);
    const next = state.kind === "found"
      ? spliceBlock(existing, state.beginLine, state.endLine, block, lineEnding)
      : appendBlock(existing, block, lineEnding);
    await assertKimiHookSetValid(next, configPath, "setup.install", context.env);

    const blockWritten = next !== original;
    if (blockWritten) await writeConfigAtomic(configPath, next);
    return { blockWritten, next };
  });
  const { blockWritten, next } = mutation;

  collectPermissionRuleWarnings(next, warnings);
  await collectKimiVersionWarnings(context.env, warnings);
  await collectInstalledKimiPluginsNotice(context.env, warnings);

  const probe = await probeHook(hookScriptPath, context.env);

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
    reviewGateEnabled,
    nextStep: probe.ok
      ? "Run /kimi:review, /kimi:challenge, /kimi:ask, or /kimi:rescue. Codex users can invoke the matching $kimi-* skills."
      : "Re-run /kimi:setup after installing kimi-code and Node. If the probe keeps failing, run /kimi:setup --uninstall and inspect ~/.kimi-code/config.toml manually.",
    details: buildDetails({
      configPath,
      hookScriptPath,
      reviewGateEnabled,
      probe,
      warnings,
      hostId,
    }),
  };
}

async function runCheck(
  configPath: string,
  hookScriptPath: string,
  hostId: string,
  reviewGateEnabled: boolean,
  warnings: string[],
  context: CommandContext,
): Promise<SetupResult> {
  const existing = await readConfigSafe(configPath);
  const hookSet = await validateKimiHookSetForEnvironment(existing, context.env);
  if (!hookSet.valid) {
    const reason = hookSet.reason ?? "configured hooks failed validation";
    return {
      action: "check",
      summary: `kimi-code hook configuration is invalid; the configured hooks array will not load.`,
      configPath,
      hookScriptPath,
      blockWritten: false,
      blockRemoved: false,
      probe: "failed",
      probeError: reason,
      warnings,
      reviewGateEnabled,
      nextStep:
        "Repair or remove the invalid [[hooks]] entry named above, then run /kimi:setup --check again. No model call is required.",
      details: buildDetails({
        configPath,
        hookScriptPath,
        reviewGateEnabled,
        probe: { ok: false, reason },
        warnings,
        hostId,
      }),
    };
  }
  const expectedCommand = buildHookShellCommand(hookScriptPath, context.env);
  // nodeExists → a command mismatch is reported as a classified H4 drift
  // diagnosis (Node upgrade / version-manager switch vs. plugin path move).
  // hostId → check THIS host's block in the shared config (v1.7.0 scoping).
  const installedCheck = evaluateInstalled(existing, expectedCommand, {
    hostId,
    nodeExists: (binPath) => existsSync(binPath),
  });

  // Non-blocking coexistence + cruft notices.
  const { blocks: allBlocks } = parseManagedBlock(existing, hostId);
  const otherHosts = [
    ...new Set(allBlocks.map((b) => effectiveHost(b, hostId)).filter((h) => h !== hostId)),
  ];
  if (otherHosts.length > 0) {
    warnings.push(
      `Other host(s) also manage a block in this shared config: ${otherHosts.join(", ")} (coexisting, untouched).`,
    );
  }
  // Marker-less table triage (v1.8.2): after a kimi-code config rewrite strips
  // all comments, each host's [[hooks]] table survives unmarked and KEEPS
  // ENFORCING. Ours-with-the-exact-current-command is the live hook (covered
  // by the installedCheck note below, not "cruft"); ours-with-a-stale-command
  // is prunable by this host's setup; another host's is THEIR live hook —
  // report it informationally and leave it strictly alone.
  const bareTables = findUnmanagedApprovalHookBlocks(existing);
  const ownStale = bareTables.filter(
    (t) => hostIdFromHookCommand(t.command) === hostId && t.command !== expectedCommand,
  );
  const foreignHosts = [
    ...new Set(
      bareTables
        // Exclude any table whose command byte-equals what THIS host writes —
        // it is unambiguously ours even if a `KIMI_PLUGIN_CC_HOST_ID` override
        // makes its path-derived host differ from `hostId` (Opus review NIT:
        // otherwise runCheck would mislabel the host's own table as foreign).
        .filter((t) => t.command !== expectedCommand)
        .map((t) => hostIdFromHookCommand(t.command))
        .filter((h): h is string => h !== null && h !== hostId),
    ),
  ];
  if (ownStale.length > 0) {
    warnings.push(
      `Found ${ownStale.length} stale marker-less kimi-plugin-cc hook block(s) from this host's earlier installs. ` +
        `Run /kimi:setup to refresh, or /kimi:setup --uninstall --all to clear everything.`,
    );
  }
  for (const host of foreignHosts) {
    warnings.push(
      `Host "${host}" has a marker-less kimi-plugin-cc hook block (kimi-code config rewrites strip comments). ` +
        `It still enforces and is left untouched; run that host's setup to re-adorn its markers.`,
    );
  }
  if (installedCheck.installed && installedCheck.note !== undefined) {
    warnings.push(`Note: ${installedCheck.note}`);
  }

  if (!installedCheck.installed) {
    return {
      action: "check",
      summary:
        installedCheck.state.kind === "absent"
          ? `kimi-plugin-cc managed block is NOT installed in ${configPath}.`
          : `kimi-plugin-cc managed block is present but invalid: ${installedCheck.reason}.`,
      configPath,
      hookScriptPath,
      blockWritten: false,
      blockRemoved: false,
      probe: "failed",
      probeError: installedCheck.reason ?? "managed block missing or invalid",
      warnings,
      reviewGateEnabled,
      nextStep:
        installedCheck.state.kind === "absent"
          ? "Run /kimi:setup (without --check) to install the managed block."
          : "Run /kimi:setup --uninstall, then /kimi:setup to repair.",
      details: buildDetails({
        configPath,
        hookScriptPath,
        reviewGateEnabled,
        probe: { ok: false, reason: installedCheck.reason ?? "block missing/invalid" },
        warnings,
      }),
    };
  }

  collectPermissionRuleWarnings(existing, warnings);
  await collectKimiVersionWarnings(context.env, warnings);
  await collectInstalledKimiPluginsNotice(context.env, warnings);

  // Block is structurally valid AND points at the resolved hook
  // script — now confirm the script itself still loads and behaves.
  try {
    await assertHookScriptExists(hookScriptPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      action: "check",
      summary: `Managed block references ${hookScriptPath} but that path is unreadable.`,
      configPath,
      hookScriptPath,
      blockWritten: false,
      blockRemoved: false,
      probe: "failed",
      probeError: message,
      warnings,
      reviewGateEnabled,
      nextStep:
        "Reinstall the plugin so dist/hooks/approval-hook.js is present, or run /kimi:setup to refresh the managed block.",
      details: buildDetails({
        configPath,
        hookScriptPath,
        reviewGateEnabled,
        probe: { ok: false, reason: message },
        warnings,
      }),
    };
  }

  const probe = await probeHook(hookScriptPath, context.env);

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
    reviewGateEnabled,
    nextStep: !probe.ok
      ? "Run /kimi:setup to repair the managed block, or /kimi:setup --uninstall if you want to remove the integration."
      : installedCheck.via === "bare-table"
        // Enforcement is active via the marker-less table, but the markers are
        // gone (kimi-code stripped them). Don't say "No action needed" while a
        // warning tells the user to re-adorn — that contradiction confused
        // operators (Kimi review F3). Recommend the harmless re-adorn.
        ? "Enforcement is active. Run /kimi:setup to re-adorn this host's managed-block markers — kimi-code stripped them on its last config write (comments are not preserved). Your hook keeps working meanwhile."
        : "No action needed.",
    details: buildDetails({
      configPath,
      hookScriptPath,
      reviewGateEnabled,
      probe,
      warnings,
      hostId,
    }),
  };
}

async function runUninstall(
  configPath: string,
  hookScriptPath: string,
  hostId: string,
  removeAllHosts: boolean,
  reviewGateEnabled: boolean,
  warnings: string[],
  context: CommandContext,
): Promise<SetupResult> {
  return await withKimiConfigLock(configPath, () =>
    runUninstallLocked(
      configPath,
      hookScriptPath,
      hostId,
      removeAllHosts,
      reviewGateEnabled,
      warnings,
      context,
    )
  );
}

async function runUninstallLocked(
  configPath: string,
  hookScriptPath: string,
  hostId: string,
  removeAllHosts: boolean,
  reviewGateEnabled: boolean,
  warnings: string[],
  context: CommandContext,
): Promise<SetupResult> {
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
      reviewGateEnabled,
      nextStep: "Run /kimi:setup to install the managed block again.",
      details: buildDetails({
        configPath,
        hookScriptPath,
        reviewGateEnabled,
        probe: { ok: true, reason: "no-op (config absent)" },
        warnings,
      }),
    };
  }

  // Default: remove THIS host's block(s) — its own suffixed block plus any
  // legacy block whose command path derives to this host — and THIS HOST's
  // orphaned marker-less hook entries, leaving OTHER hosts' blocks AND their
  // marker-less tables intact (a marker-less table is likely that host's LIVE
  // hook after a kimi-code comment strip — v1.8.2 host scoping). `--all`:
  // remove EVERY host's managed block and every one of our hook tables (the
  // full nuke).
  const { stripped: strippedMarkers, removedBlocks, orphansLeft } = stripManagedBlocks(
    existing,
    hostId,
    removeAllHosts,
  );
  const lineEnding = detectLineEnding(existing);
  // Pass `expectedCommand` as `alsoMatchCommand` (both scoped and --all) so
  // uninstall removes THIS host's own current hook table by byte-exact command
  // even when a `KIMI_PLUGIN_CC_HOST_ID` override disagrees with the command's
  // path-derived host, or when the hook lives under a non-standard (dev) path
  // that `isOurApprovalHookCommand` wouldn't recognize — the install path
  // already does this; uninstall now matches it (Codex P2 / Opus A / Kimi F4).
  const expectedCommand = buildHookShellCommand(hookScriptPath, context.env);
  const { pruned: stripped, count: prunedCount } = pruneOrphanApprovalHooks(
    strippedMarkers,
    lineEnding,
    removeAllHosts ? undefined : hostId,
    expectedCommand,
  );
  const changed = stripped !== existing;
  if (changed) {
    await writeConfigAtomic(configPath, stripped);
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
  const { blocks: remainingBlocks } = parseManagedBlock(stripped, hostId);
  const remainingHosts = [
    ...new Set(remainingBlocks.map((b) => effectiveHost(b, hostId))),
  ];
  if (!removeAllHosts && remainingHosts.length > 0) {
    warnings.push(
      `Left ${remainingHosts.length} other host block(s) in place: ${remainingHosts.join(", ")}. ` +
        `Use \`/kimi:setup --uninstall --all\` to remove every host's block.`,
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
    reviewGateEnabled,
    nextStep: changed
      ? "Run /kimi:setup again to reinstall the hook, or leave the plugin uninstalled."
      : "Run /kimi:setup to install the hook.",
    details: buildDetails({
      configPath,
      hookScriptPath,
      reviewGateEnabled,
      probe: { ok: true, reason: changed ? `removed ${removedBlocks} block(s)` : "no-op (no markers)" },
      warnings,
    }),
  };
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

async function writeConfigAtomic(configPath: string, contents: string): Promise<void> {
  // Two-phase write: write to a sibling temp file, then rename. Each
  // call uses a unique temp path so two concurrent installs/uninstalls
  // can race without clobbering each other's intermediate file (PR 4
  // reviewer finding — fixed-path tmp file was a race surface).
  //
  // Mode: tighten to 0o600 (owner-only read/write) BEFORE rename. The
  // kimi-code config file holds API keys and tokens; the user's existing
  // file is typically 0o600, and umask-only would silently downgrade it
  // to 0o644 after our rewrite. Audit report 28 (Codex M1) tracked this.
  // chmod the temp file before rename so the final inode never exists at
  // a wider mode.
  await mkdir(path.dirname(configPath), { recursive: true });
  const suffix = randomBytes(8).toString("hex");
  const tmpPath = `${configPath}.kimi-plugin-cc.${process.pid}.${suffix}.tmp`;
  try {
    await writeFile(tmpPath, contents, "utf8");
    if (process.platform !== "win32") {
      // Windows file modes are emulated; skip the chmod to avoid
      // platform-specific noise. The threat model excludes Windows.
      await chmod(tmpPath, 0o600);
    }
    await rename(tmpPath, configPath);
  } catch (err) {
    // Best-effort cleanup so stale tmp files don't accumulate.
    try {
      await unlink(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
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
    `${validation.reason ?? "Configured hooks failed validation"} Repair or remove that [[hooks]] entry before rerunning /kimi:setup; the existing config was left unchanged.`,
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
  const lines = splitPreservingEnding(contents);
  const before = lines.slice(0, beginLine).join(lineEnding);
  const after = lines.slice(endLine + 1).join(lineEnding);
  const beforeWithSep = before.endsWith(lineEnding) || before.length === 0 ? before : `${before}${lineEnding}`;
  const replacementWithEnding = replacement.endsWith(lineEnding) ? replacement : `${replacement}${lineEnding}`;
  return `${beforeWithSep}${replacementWithEnding}${after}`;
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

/**
 * Remove managed BEGIN/END marker pairs that belong to `currentHost` (or every
 * host when `removeAll`). A block's host is its marker suffix, or — for a legacy
 * un-suffixed block — the host derived from its command path (so a Claude
 * uninstall never removes a `~/.codex/…` legacy block another host still relies
 * on; Kimi review). Orphan marker lines are removed individually (no
 * destructive sweep of trailing content) so `--uninstall` on a corrupted config
 * doesn't take user data with it.
 */
function stripManagedBlocks(
  contents: string,
  currentHost: string,
  removeAll: boolean,
): {
  stripped: string;
  removedBlocks: number;
  orphansLeft: number[];
} {
  const lineEnding = detectLineEnding(contents);
  const lines = splitPreservingEnding(contents);
  const result: string[] = [];
  const orphansLeft: number[] = [];
  let removedBlocks = 0;

  // Decide whether a managed block/marker belongs to the host we're uninstalling
  // for. Suffixed blocks: only the matching host. Legacy (un-suffixed) COMPLETE
  // blocks: the host derived from the command path — but if the command can't be
  // attributed (not the canonical two-token shape), leave it (ambiguous
  // ownership; only `--all` removes it), so a scoped uninstall never destroys
  // another host's non-canonical block (Codex review). A bare/orphan marker line
  // has no command and is broken cruft, so a scoped uninstall does sweep it.
  const shouldRemove = (
    markerHost: string | null,
    commandPath: string | null,
    isOrphanMarker: boolean,
  ): boolean => {
    if (removeAll) return true;
    if (markerHost !== null) return markerHost === currentHost;
    if (isOrphanMarker) return true;
    const derived = commandPath !== null ? hostIdFromHookCommand(commandPath) : null;
    if (derived === null) return false;
    return derived === currentHost;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const begin = MARKERS.BEGIN_LINE_RE.exec(trimmed);
    if (begin !== null) {
      const beginHost = begin[1]?.toLowerCase() ?? null;
      // Look ahead for the matching END, capturing the block's command en route.
      let endIdx = -1;
      let blockCommand: string | null = null;
      for (let j = i + 1; j < lines.length; j += 1) {
        const nextTrimmed = lines[j]!.trim();
        if (MARKERS.BEGIN_LINE_RE.test(nextTrimmed)) {
          // Two BEGINs in a row — the outer one is an orphan.
          break;
        }
        if (MARKERS.END_LINE_RE.test(nextTrimmed)) {
          endIdx = j;
          break;
        }
        const decoded = decodeManagedCommandLine(nextTrimmed);
        if (decoded !== null) blockCommand = decoded;
      }
      if (endIdx === -1) {
        // Orphan BEGIN: drop only this line (if it's ours to remove).
        if (shouldRemove(beginHost, null, true)) {
          orphansLeft.push(i);
          i += 1;
          continue;
        }
        result.push(line);
        i += 1;
        continue;
      }
      if (shouldRemove(beginHost, blockCommand, false)) {
        // Complete pair we're removing — drop BEGIN..END inclusive.
        removedBlocks += 1;
        i = endIdx + 1;
        continue;
      }
      // Another host's block — keep it verbatim.
      for (let k = i; k <= endIdx; k += 1) result.push(lines[k]!);
      i = endIdx + 1;
      continue;
    }
    const end = MARKERS.END_LINE_RE.exec(trimmed);
    if (end !== null) {
      const endHost = end[1]?.toLowerCase() ?? null;
      // Orphan END with no preceding BEGIN: drop only this line (if ours).
      if (shouldRemove(endHost, null, true)) {
        orphansLeft.push(i);
        i += 1;
        continue;
      }
      result.push(line);
      i += 1;
      continue;
    }
    result.push(line);
    i += 1;
  }

  // Collapse runs of >= 3 blank lines created by removal back to 2.
  const collapsed: string[] = [];
  let blankRun = 0;
  for (const line of result) {
    if (line.length === 0) {
      blankRun += 1;
      if (blankRun <= 2) collapsed.push(line);
    } else {
      blankRun = 0;
      collapsed.push(line);
    }
  }
  return { stripped: collapsed.join(lineEnding), removedBlocks, orphansLeft };
}

/**
 * Remove orphaned, marker-less `[[hooks]]` tables that are unambiguously this
 * plugin's approval hook (see `findUnmanagedApprovalHookBlocks`). Returns the
 * cleaned text, the count removed, and the decoded commands of the removed
 * tables (so install can distinguish "re-adorning this host's live hook after
 * a kimi-code comment strip" from "sweeping stale cruft"). A no-op (returns
 * the input unchanged) when there is nothing to prune, so callers can compare
 * identity cheaply.
 *
 * `ownedBy` restricts the prune to tables whose command path derives to that
 * host — REQUIRED for scoped install/uninstall so one host never disarms the
 * other's live (marker-stripped) hook. Omit only for `--uninstall --all`.
 */
function pruneOrphanApprovalHooks(
  contents: string,
  lineEnding: "\n" | "\r\n",
  ownedBy?: string,
  alsoMatchCommand?: string,
): { pruned: string; count: number; commands: string[] } {
  const ranges = findUnmanagedApprovalHookBlocks(contents, ownedBy, alsoMatchCommand);
  if (ranges.length === 0) return { pruned: contents, count: 0, commands: [] };

  const remove = new Set<number>();
  for (const { start, end } of ranges) {
    for (let i = start; i < end; i += 1) remove.add(i);
  }
  const lines = splitPreservingEnding(contents);
  const kept = lines.filter((_, idx) => !remove.has(idx));

  // Collapse runs of >= 3 blank lines created by removal back to 2.
  const collapsed: string[] = [];
  let blankRun = 0;
  for (const line of kept) {
    if (line.length === 0) {
      blankRun += 1;
      if (blankRun <= 2) collapsed.push(line);
    } else {
      blankRun = 0;
      collapsed.push(line);
    }
  }
  return {
    pruned: collapsed.join(lineEnding),
    count: ranges.length,
    commands: ranges.map((range) => range.command),
  };
}

// ----- Block content -----------------------------------------------------

function buildManagedBlock(
  hookScriptPath: string,
  env: NodeJS.ProcessEnv,
  lineEnding: "\n" | "\r\n" = "\n",
  hostId = "",
): string {
  const shellCommand = buildHookShellCommand(hookScriptPath, env);
  const commandLine = `command = ${tomlBasicString(shellCommand)}`;
  const suffix = hostId.length > 0 ? `:${hostId}` : "";
  return [
    `${BEGIN_MARKER_PREFIX}${suffix} (v${KIMI_PLUGIN_CC_VERSION}) ===`,
    `# DO NOT EDIT — managed by /kimi:setup. Run /kimi:setup --uninstall to remove.`,
    `# Host: ${hostId.length > 0 ? hostId : "(legacy)"} — Claude Code and Codex each own a`,
    `#   separate block in this shared ~/.kimi-code/config.toml; setup in one host`,
    `#   never touches the other's.`,
    `# Purpose:`,
    `#   kimi-code's \`kimi -p\` mode hard-codes permission='auto' and`,
    `#   auto-approves every tool call. This hook enforces /kimi:review,`,
    `#   /kimi:challenge, /kimi:review_gate, and /kimi:ask as read-only,`,
    `#   and applies the workspace-bound rescue allowlist for /kimi:rescue.`,
    `#   Without this block the plugin's safety contract collapses.`,
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
    `# === END kimi-plugin-cc-managed${suffix} ===`,
  ].join(lineEnding);
}

/**
 * Encode a string for a TOML 1.0 basic string. Escapes the six required
 * escape sequences plus quotes/backslashes. Avoids the `\'` shell-quote
 * hazard that broke the v1.0-alpha.1 prototype: TOML basic strings
 * declare `\'` as a reserved escape, and a parser-compliant TOML
 * library (kimi-code uses smol-toml) raises an error on encounter.
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

function resolveKimiCodeConfigPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveKimiHome(env), "config.toml");
}

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
 * Two-layer probe:
 *
 *   1. **Direct probe.** Spawn the hook with `process.execPath` (the
 *      same Node binary running the companion) and assert exit 2 +
 *      non-empty stderr. Catches: missing script, broken hook code,
 *      hook misrouting a deny as exit 0. This probe is reliable under
 *      PATH-sanitized smoke tests because it uses an absolute Node
 *      path.
 *
 *   2. **Shell probe.** Run `/bin/sh -c "<nodeBin> <hookScript>"` (the
 *      exact shape kimi-code uses via agent-core hooks/runner.ts) with
 *      synthetic stdin. Catches: kimi-code's shell can't find the
 *      Node binary, shell-quoting in the managed block is wrong, the
 *      Node binary on PATH isn't compatible.
 *
 * Both must pass for the install to be considered healthy. The shell
 * probe is skipped on platforms without `/bin/sh` (Windows pure, etc.) —
 * but the rest of the runtime already assumes POSIX.
 */
async function probeHook(
  hookScriptPath: string,
  env: NodeJS.ProcessEnv,
): Promise<ProbeOutcome> {
  const directResult = await probeHookDirect(hookScriptPath, env);
  if (!directResult.ok) return directResult;

  const shellResult = await probeHookViaShell(hookScriptPath, env);
  if (!shellResult.ok) return shellResult;

  return {
    ok: true,
    reason: `${directResult.reason}; shell probe also ok`,
  };
}

async function probeHookDirect(
  hookScriptPath: string,
  env: NodeJS.ProcessEnv,
): Promise<ProbeOutcome> {
  const nodeBin = resolveNodeBinary(env);
  return await spawnProbe(
    nodeBin,
    [hookScriptPath],
    env,
    `direct probe via ${nodeBin}`,
  );
}

async function probeHookViaShell(
  hookScriptPath: string,
  env: NodeJS.ProcessEnv,
): Promise<ProbeOutcome> {
  if (process.platform === "win32") {
    // The hook runner shells out via `/bin/sh -c` per agent-core; on
    // Windows the entire kimi-code launcher is unsupported. Skip the
    // shell probe so we don't false-fail on a platform we don't run on.
    return { ok: true, reason: "shell probe skipped (Windows)" };
  }
  // Reuse the exact command string the managed block wrote into
  // kimi-code's config so probe and runtime cannot drift.
  const shellCommand = buildHookShellCommand(hookScriptPath, env);
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
        // best effort
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

// ----- Permission rules scan --------------------------------------------

/**
 * Best-effort scan for `[[permission.rules]]` entries that would
 * interfere with read-only commands. We don't parse TOML; we look for
 * deny rules against common read tools. This recognizes both
 * double-quoted basic strings and single-quoted literal strings, but
 * still misses inline-table and multi-line forms — those are flagged
 * as a known limitation in PR 4 docs.
 */
/**
 * Probe kimi-code's version and append a warning to `warnings` if the
 * installed kimi is outside the range kimi-plugin-cc was tested
 * against (H6, Codex post-hotfix audit Area 8).
 *
 * Soft-fail policy: if the probe itself fails (kimi not on PATH, spawn
 * error, unparseable output), we record nothing here — the hook probe
 * will surface a more direct error in that case. We only loud-warn when
 * the version is **demonstrably** out of range, so users with kimi
 * installed-and-working but unsupported get an explicit signal before
 * a silent breakage bites them.
 *
 * Override: `KIMI_PLUGIN_CC_SKIP_VERSION_PROBE=1` skips the probe
 * entirely — useful for tests, CI environments without kimi installed,
 * and for users who consciously want to silence this warning.
 */
async function collectKimiVersionWarnings(
  env: NodeJS.ProcessEnv,
  warnings: string[],
): Promise<void> {
  if (env.KIMI_PLUGIN_CC_SKIP_VERSION_PROBE === "1") return;
  const probe = await probeKimiVersion({
    kimiBin: env.KIMI_PLUGIN_CC_KIMI_BIN || undefined,
    env,
  });
  if (probe.kind === "failed") {
    // Don't warn about probe failure here — if kimi is genuinely
    // missing/broken, the hook probe path will catch it with a much
    // clearer message. Avoid double-noise.
    return;
  }
  if (probe.inTestedRange) return;
  warnings.push(formatVersionOutOfRangeWarning(probe, KIMI_PLUGIN_CC_VERSION));
}

/**
 * H8 — non-blocking notice listing kimi-code's OWN installed plugins (the
 * user-global plugin system kimi-code 0.4.0+ added; manifest at
 * `~/.kimi-code/plugins/installed.json`, shape verified through 0.12.0:
 * `{ plugins: [{ id, enabled, ... }] }`). kimi-code registers their tools
 * (incl. MCP) on every session. Under kimi-plugin-cc's read-only commands the
 * PreToolUse hook denies any tool outside Read/Grep/Glob, so calls to these
 * plugins' tools are blocked — safe, but they silently burn model turns. We
 * surface that expectation at setup time so a confused "kimi did nothing" report
 * doesn't follow. Best-effort: a missing/unreadable/malformed manifest yields no
 * notice. Never blocks setup; never mutates the plugin list.
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
      "  read-only commands (/kimi:review, /kimi:challenge, /kimi:ask, and the review gate) the",
      "  PreToolUse hook denies any tool outside Read/Grep/Glob, so calls to these plugins' tools",
      "  are blocked — safe, but they can waste model turns. This is expected; no action needed.",
      "  (/kimi:rescue and /kimi:swarm apply their own allowlists.) To avoid the turn-waste, disable",
      "  kimi-code plugins you don't need for delegated work in your kimi-code config.",
    ].join("\n"),
  );
}

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
  reviewGateEnabled: boolean;
  probe: ProbeOutcome;
  warnings: string[];
  hostId?: string;
}): string[] {
  const details = [
    `Companion runtime: Node ${process.version}`,
    `Plugin version:   ${KIMI_PLUGIN_CC_VERSION}`,
    ...(args.hostId ? [`Host id:          ${args.hostId}`] : []),
    `Config file:      ${args.configPath}`,
    `Hook script:      ${args.hookScriptPath}`,
    `Review gate:      ${args.reviewGateEnabled ? "enabled" : "disabled"}`,
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
  return [
    result.summary,
    "",
    `Action:      ${result.action}`,
    `Block written:  ${result.blockWritten ? "yes" : "no"}`,
    `Block removed:  ${result.blockRemoved ? "yes" : "no"}`,
    `Probe:          ${result.probe}${result.probeError ? ` (${result.probeError})` : ""}`,
    `Review gate:    ${result.reviewGateEnabled ? "enabled" : "disabled"}`,
    "",
    "Details:",
    ...result.details.map((detail) => `- ${detail}`),
    "",
    `Next step: ${result.nextStep}`,
  ].join("\n");
}

// Re-export the managed-block state type so downstream consumers can
// pattern-match against the same union the installer uses.
export type { ManagedBlockState };
