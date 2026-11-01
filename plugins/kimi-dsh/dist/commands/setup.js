import { SETUP_SUPPORTED_FLAGS } from "../parsing.js";
// Managed-block installer for the load-bearing kimi-code PreToolUse hook.
// Without it, `kimi -p` auto-approves tool calls, including from read-only
// commands.
//
// Setup writes or refreshes a host-scoped BEGIN/END block containing the
// canonical `'<absolute-node>' '<absolute-hook-script>'` command from
// resolveNodeBinary/buildHookShellCommand. Both tokens are shell-quoted and the
// absolute Node path avoids PATH dependence under sanitized launches. Setup
// probes the hook directly with resolveNodeBinary and through `/bin/sh -c`
// using the exact installed command bytes. It also warns about broad permission
// denies and refuses duplicate, orphaned, or malformed managed blocks.
//
// Subcommands: install (default), --check, --uninstall [--all], and
// --enable-review-gate/--disable-review-gate.
//
// Managed-block splicing is line-based and preserves user bytes outside owned
// edits; whole-file validation and inline-hook normalization use the TOML parser.
import { spawn } from "node:child_process";
import { access, mkdir, open, readFile, rename, unlink, } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { readPluginConfig, writePluginConfig } from "../config.js";
import { RuntimeError } from "../errors.js";
import { normalizeTopLevelInlineHooks, validateKimiHookSetForEnvironment, withKimiConfigLock, } from "../hooks/config-safety.js";
import { buildHookShellCommand, hostIdFromHookCommand, resolveHookScriptPath, resolveHostId, resolveNodeBinary, } from "../hooks/install-paths.js";
import { decodeManagedCommandLine, effectiveHost, evaluateInstalled, findUnmanagedApprovalHookBlocks, MARKERS, parseManagedBlock, } from "../hooks/managed-block.js";
import { formatVersionOutOfRangeWarning, probeKimiVersion, } from "../kimi-version-probe.js";
import { isNativeV2CertifiedVersion } from "../kimi-engine.js";
import { resolveKimiHome } from "../kimi-home.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { KIMI_PLUGIN_CC_VERSION } from "../version.js";
const BEGIN_MARKER_PREFIX = "# === BEGIN kimi-plugin-cc-managed";
const DEFAULT_HOOK_TIMEOUT_S = 15;
// Probe timing. The direct script probe is local and fast; allow 5s for
// node startup on cold CI runners. The shell probe adds /bin/sh fork
// overhead but should still complete well within the same budget.
const PROBE_TIMEOUT_MS = 5_000;
// Reject the specific control characters, double quotes, and backslashes matched
// below, including newlines and tabs; this is not a general shell-metacharacter
// filter. Normal install paths do not contain them, so a match indicates an
// unsafe override or an unusual layout that needs an explicit path change.
const PATH_FORBIDDEN_RE = /[\x00-\x1f"\\\n\r\t]/;
export async function runSetup(argv, context) {
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
    // Host id scopes each managed block so Claude Code and Codex can share one
    // ~/.kimi-code/config.toml without clobbering each other.
    const hostId = resolveHostId(context.env, hookScriptPath);
    const warnings = [];
    switch (parsed.mode) {
        case "uninstall":
            return await runUninstall(configPath, hookScriptPath, hostId, parsed.removeAllHosts, reviewGateEnabled, warnings, context);
        case "check":
            return await runCheck(configPath, hookScriptPath, hostId, reviewGateEnabled, warnings, context);
        case "install":
            return await runInstall(configPath, hookScriptPath, hostId, reviewGateEnabled, warnings, context);
    }
}
function parseArgs(argv) {
    let mode = "install";
    let enableReviewGate = false;
    let disableReviewGate = false;
    let removeAllHosts = false;
    for (const token of argv) {
        switch (token) {
            case "--check":
                if (mode === "uninstall") {
                    throw new RuntimeError("INVALID_ARGS", "setup accepts at most one of --check, --uninstall.", "setup.parse");
                }
                mode = "check";
                break;
            case "--uninstall":
                if (mode === "check") {
                    throw new RuntimeError("INVALID_ARGS", "setup accepts at most one of --check, --uninstall.", "setup.parse");
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
                throw new RuntimeError("INVALID_ARGS", `Unknown setup flag ${token}. Supported flags: ${SETUP_SUPPORTED_FLAGS}.`, "setup.parse");
        }
    }
    if (enableReviewGate && disableReviewGate) {
        throw new RuntimeError("INVALID_ARGS", "setup accepts either --enable-review-gate or --disable-review-gate, not both.", "setup.parse");
    }
    if (removeAllHosts && mode !== "uninstall") {
        throw new RuntimeError("INVALID_ARGS", "--all is only valid with --uninstall (it removes EVERY host's managed block).", "setup.parse");
    }
    return { mode, enableReviewGate, disableReviewGate, removeAllHosts };
}
async function runInstall(configPath, hookScriptPath, hostId, reviewGateEnabled, warnings, context) {
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
                throw new RuntimeError("SETUP_INVALID_HOOKS_CONFIG", `Could not safely convert the top-level inline hooks assignment in ${configPath}; the existing config was left unchanged.`, "setup.install", { details: { configPath } });
            }
            warnings.push(`Converted the top-level inline hooks array (${inlineHooks.entryCount} entr${inlineHooks.entryCount === 1 ? "y" : "ies"}) to canonical [[hooks]] tables before installing. Surrounding config bytes were preserved; formatting and comments inside that hooks assignment were normalized.`);
        }
        // Prune only this host's orphaned marker-less entries before computing
        // splice line numbers. Another host's marker-less table may be its live hook
        // after a config rewrite strips comments, so it must remain untouched.
        const expectedCommand = buildHookShellCommand(hookScriptPath, context.env);
        const { pruned, count: prunedCount, commands: prunedCommands } = pruneOrphanApprovalHooks(inlineHooks.contents, lineEnding, hostId, expectedCommand);
        const existing = pruned;
        if (prunedCount > 0) {
            const readorned = prunedCommands.includes(expectedCommand);
            warnings.push(readorned
                ? `Re-adorned this host's managed-block markers: kimi-code rewrites its config on login/settings changes and strips all comments (markers included), leaving the hook enforcing but unmarked. Replaced the bare hook table with a freshly marked block (${prunedCount} table(s) refreshed). Enforcement was never interrupted.`
                : `Pruned ${prunedCount} stale marker-less kimi-plugin-cc hook block(s) left by this host's earlier installs. This is a cleanup — your active hook is unaffected.`);
        }
        const { state, blocks } = parseManagedBlock(existing, hostId);
        if (state.kind === "orphan") {
            throw new RuntimeError("SETUP_ORPHAN_MARKERS", [
                `kimi-code config at ${configPath} contains an orphaned ${state.detail} marker.`,
                "Run `/kimi:setup --uninstall` to clean up, then re-run `/kimi:setup`.",
            ].join(" "), "setup.install", { details: { configPath, orphan: state.detail } });
        }
        if (state.kind === "duplicate") {
            throw new RuntimeError("SETUP_DUPLICATE_BLOCKS", [
                `kimi-code config at ${configPath} contains ${state.beginLines.length} kimi-plugin-cc managed blocks for host ${hostId} (lines ${state.beginLines
                    .map((line) => line + 1)
                    .join(", ")}).`,
                "This usually means two /kimi:setup runs raced. Run `/kimi:setup --uninstall` to clear them, then `/kimi:setup` again.",
            ].join(" "), "setup.install", { details: { configPath, beginLines: state.beginLines } });
        }
        // Non-blocking note: other hosts (e.g. Codex) manage their own block in the
        // same shared config — surface so an operator understands the coexistence.
        const otherHosts = [
            ...new Set(blocks.map((b) => effectiveHost(b, hostId)).filter((h) => h !== hostId)),
        ];
        if (otherHosts.length > 0) {
            warnings.push(`Other host(s) also manage a block in this shared config: ${otherHosts.join(", ")}. ` +
                `They are left untouched — each host owns its own PreToolUse block.`);
        }
        const block = buildManagedBlock(hookScriptPath, context.env, lineEnding, hostId);
        const next = state.kind === "found"
            ? spliceBlock(existing, state.beginLine, state.endLine, block, lineEnding)
            : appendBlock(existing, block, lineEnding);
        await assertKimiHookSetValid(next, configPath, "setup.install", context.env);
        const blockWritten = next !== original;
        if (blockWritten)
            await writeConfigAtomic(configPath, next);
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
async function runCheck(configPath, hookScriptPath, hostId, reviewGateEnabled, warnings, context) {
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
            nextStep: "Repair or remove the invalid [[hooks]] entry named above, then run /kimi:setup --check again. No model call is required.",
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
    // nodeExists refines mismatch prose into drift classification; hostId checks
    // only this host's block in the shared config.
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
        warnings.push(`Other host(s) also manage a block in this shared config: ${otherHosts.join(", ")} (coexisting, untouched).`);
    }
    // Config rewrites can strip markers while leaving each host's table enforcing.
    // Our exact-command table is live; our stale table is prunable; another host's
    // table is reported but left strictly alone.
    const bareTables = findUnmanagedApprovalHookBlocks(existing);
    const ownStale = bareTables.filter((t) => hostIdFromHookCommand(t.command) === hostId && t.command !== expectedCommand);
    const foreignHosts = [
        ...new Set(bareTables
            // Exact current command bytes identify this host even when a host-id
            // override disagrees with the path-derived host.
            .filter((t) => t.command !== expectedCommand)
            .map((t) => hostIdFromHookCommand(t.command))
            .filter((h) => h !== null && h !== hostId)),
    ];
    if (ownStale.length > 0) {
        warnings.push(`Found ${ownStale.length} stale marker-less kimi-plugin-cc hook block(s) from this host's earlier installs. ` +
            `Run /kimi:setup to refresh, or /kimi:setup --uninstall --all to clear everything.`);
    }
    for (const host of foreignHosts) {
        warnings.push(`Host "${host}" has a marker-less kimi-plugin-cc hook block (kimi-code config rewrites strip comments). ` +
            `It still enforces and is left untouched; run that host's setup to re-adorn its markers.`);
    }
    if (installedCheck.installed && installedCheck.note !== undefined) {
        warnings.push(`Note: ${installedCheck.note}`);
    }
    if (!installedCheck.installed) {
        return {
            action: "check",
            summary: installedCheck.state.kind === "absent"
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
            nextStep: installedCheck.state.kind === "absent"
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
    }
    catch (err) {
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
            nextStep: "Reinstall the plugin so dist/hooks/approval-hook.js is present, or run /kimi:setup to refresh the managed block.",
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
                // Enforcement remains active through the marker-less table, but recommend
                // re-adorning rather than claiming no action is needed.
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
async function runUninstall(configPath, hookScriptPath, hostId, removeAllHosts, reviewGateEnabled, warnings, context) {
    return await withKimiConfigLock(configPath, () => runUninstallLocked(configPath, hookScriptPath, hostId, removeAllHosts, reviewGateEnabled, warnings, context));
}
async function runUninstallLocked(configPath, hookScriptPath, hostId, removeAllHosts, reviewGateEnabled, warnings, context) {
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
    // Scoped uninstall removes only this host's marked and marker-less blocks;
    // other hosts' blocks and live marker-less tables remain intact. `--all` is
    // the explicit every-host sweep for all of this plugin's hook tables.
    const { stripped: strippedMarkers, removedBlocks, orphansLeft } = stripManagedBlocks(existing, hostId, removeAllHosts);
    const lineEnding = detectLineEnding(existing);
    // Exact current command bytes also identify this host's table when a host-id
    // override disagrees with path derivation or a dev path is outside the strict
    // ownership pattern.
    const expectedCommand = buildHookShellCommand(hookScriptPath, context.env);
    const { pruned: stripped, count: prunedCount } = pruneOrphanApprovalHooks(strippedMarkers, lineEnding, removeAllHosts ? undefined : hostId, expectedCommand);
    const changed = stripped !== existing;
    if (changed) {
        await writeConfigAtomic(configPath, stripped);
    }
    if (orphansLeft.length > 0) {
        warnings.push(`Detected ${orphansLeft.length} orphan marker line(s) at ${orphansLeft
            .map((line) => `line ${line + 1}`)
            .join(", ")}. Removed the marker line(s) but preserved surrounding user content — verify the config visually.`);
    }
    if (prunedCount > 0) {
        warnings.push(`Pruned ${prunedCount} orphaned kimi-plugin-cc hook block(s) with no managed marker.`);
    }
    const { blocks: remainingBlocks } = parseManagedBlock(stripped, hostId);
    const remainingHosts = [
        ...new Set(remainingBlocks.map((b) => effectiveHost(b, hostId))),
    ];
    if (!removeAllHosts && remainingHosts.length > 0) {
        warnings.push(`Left ${remainingHosts.length} other host block(s) in place: ${remainingHosts.join(", ")}. ` +
            `Use \`/kimi:setup --uninstall --all\` to remove every host's block.`);
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
async function readConfigSafe(configPath) {
    try {
        return await readFile(configPath, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT")
            return "";
        throw new RuntimeError("SETUP_CONFIG_READ_FAILED", `Failed to read kimi-code config at ${configPath}: ${err.message}`, "setup.read-config", err instanceof Error ? { cause: err, details: { configPath } } : { details: { configPath } });
    }
}
async function writeConfigAtomic(configPath, contents) {
    // Write a unique sibling temp file and atomically rename it. O_EXCL prevents
    // concurrent operations from sharing an intermediate path.
    //
    // Pass 0o600 at creation, not in a later chmod: the config can contain
    // credentials, so the temp file must never exist with a wider umask-derived
    // mode.
    await mkdir(path.dirname(configPath), { recursive: true });
    const suffix = randomBytes(8).toString("hex");
    const tmpPath = `${configPath}.kimi-plugin-cc.${process.pid}.${suffix}.tmp`;
    const openFlags = fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0);
    try {
        const handle = await open(tmpPath, openFlags, 0o600);
        try {
            if (process.platform !== "win32") {
                // Windows file modes are emulated; skip the chmod to avoid
                // platform-specific noise. The threat model excludes Windows.
                // Belt-and-suspenders alongside the create-time mode above,
                // matching createPrivateLockFile's pattern.
                await handle.chmod(0o600);
            }
            await handle.writeFile(contents, "utf8");
        }
        finally {
            await handle.close();
        }
        await rename(tmpPath, configPath);
    }
    catch (err) {
        // Best-effort cleanup so stale tmp files don't accumulate.
        try {
            await unlink(tmpPath);
        }
        catch {
            // ignore
        }
        throw err;
    }
}
async function assertKimiHookSetValid(contents, configPath, stage, env) {
    const validation = await validateKimiHookSetForEnvironment(contents, env);
    if (validation.valid)
        return;
    throw new RuntimeError("SETUP_INVALID_HOOKS_CONFIG", `${validation.reason ?? "Configured hooks failed validation"} Repair or remove that [[hooks]] entry before rerunning /kimi:setup; the existing config was left unchanged.`, stage, {
        details: {
            configPath,
            hookEntry: validation.entry,
            line: validation.line,
        },
    });
}
// ----- Line endings -----------------------------------------------------
function detectLineEnding(contents) {
    // Heuristic: if the file contains any `\r\n`, treat it as CRLF.
    // Otherwise use LF (also covers the empty-file case where we're
    // writing fresh content). This keeps the file's line-ending shape
    // stable across install/uninstall on Windows users' configs.
    return contents.includes("\r\n") ? "\r\n" : "\n";
}
function spliceBlock(contents, beginLine, endLine, replacement, lineEnding) {
    const lines = splitPreservingEnding(contents);
    const before = lines.slice(0, beginLine).join(lineEnding);
    const after = lines.slice(endLine + 1).join(lineEnding);
    const beforeWithSep = before.endsWith(lineEnding) || before.length === 0 ? before : `${before}${lineEnding}`;
    const replacementWithEnding = replacement.endsWith(lineEnding) ? replacement : `${replacement}${lineEnding}`;
    return `${beforeWithSep}${replacementWithEnding}${after}`;
}
function appendBlock(contents, block, lineEnding) {
    const base = contents.length === 0 || contents.endsWith(lineEnding) ? contents : `${contents}${lineEnding}`;
    const separator = base.length === 0 ? "" : lineEnding;
    const body = block.endsWith(lineEnding) ? block : `${block}${lineEnding}`;
    return `${base}${separator}${body}`;
}
function splitPreservingEnding(contents) {
    // We canonicalize to '\n' for the split, then strip any '\r' that
    // came from CRLF. Rejoining is the caller's responsibility (they
    // pass the desired line ending).
    return contents.split("\n").map((line) => line.replace(/\r$/, ""));
}
/**
 * Remove managed blocks owned by `currentHost`, or every host with `removeAll`.
 * Ownership comes from the marker suffix or a legacy command's derived host.
 * Orphan markers are removed individually so surrounding user content survives.
 */
function stripManagedBlocks(contents, currentHost, removeAll) {
    const lineEnding = detectLineEnding(contents);
    const lines = splitPreservingEnding(contents);
    const result = [];
    const orphansLeft = [];
    let removedBlocks = 0;
    // Suffixed blocks belong only to the matching host. Complete legacy blocks
    // use their command-derived host; an unattributable non-canonical command is
    // ambiguous and only --all removes it. Orphan marker lines have no command
    // and can be swept individually by a scoped uninstall.
    const shouldRemove = (markerHost, commandPath, isOrphanMarker) => {
        if (removeAll)
            return true;
        if (markerHost !== null)
            return markerHost === currentHost;
        if (isOrphanMarker)
            return true;
        const derived = commandPath !== null ? hostIdFromHookCommand(commandPath) : null;
        if (derived === null)
            return false;
        return derived === currentHost;
    };
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();
        const begin = MARKERS.BEGIN_LINE_RE.exec(trimmed);
        if (begin !== null) {
            const beginHost = begin[1]?.toLowerCase() ?? null;
            // Look ahead for the matching END, capturing the block's command en route.
            let endIdx = -1;
            let blockCommand = null;
            for (let j = i + 1; j < lines.length; j += 1) {
                const nextTrimmed = lines[j].trim();
                if (MARKERS.BEGIN_LINE_RE.test(nextTrimmed)) {
                    // Two BEGINs in a row — the outer one is an orphan.
                    break;
                }
                if (MARKERS.END_LINE_RE.test(nextTrimmed)) {
                    endIdx = j;
                    break;
                }
                const decoded = decodeManagedCommandLine(nextTrimmed);
                if (decoded !== null)
                    blockCommand = decoded;
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
            for (let k = i; k <= endIdx; k += 1)
                result.push(lines[k]);
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
    const collapsed = [];
    let blankRun = 0;
    for (const line of result) {
        if (line.length === 0) {
            blankRun += 1;
            if (blankRun <= 2)
                collapsed.push(line);
        }
        else {
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
function pruneOrphanApprovalHooks(contents, lineEnding, ownedBy, alsoMatchCommand) {
    const ranges = findUnmanagedApprovalHookBlocks(contents, ownedBy, alsoMatchCommand);
    if (ranges.length === 0)
        return { pruned: contents, count: 0, commands: [] };
    const remove = new Set();
    for (const { start, end } of ranges) {
        for (let i = start; i < end; i += 1)
            remove.add(i);
    }
    const lines = splitPreservingEnding(contents);
    const kept = lines.filter((_, idx) => !remove.has(idx));
    const collapsed = [];
    let blankRun = 0;
    for (const line of kept) {
        if (line.length === 0) {
            blankRun += 1;
            if (blankRun <= 2)
                collapsed.push(line);
        }
        else {
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
function buildManagedBlock(hookScriptPath, env, lineEnding = "\n", hostId = "") {
    const shellCommand = buildHookShellCommand(hookScriptPath, env);
    const commandLine = `command = ${tomlBasicString(shellCommand)}`;
    const suffix = hostId.length > 0 ? `:${hostId}` : "";
    return [
        `${BEGIN_MARKER_PREFIX}${suffix} (v${KIMI_PLUGIN_CC_VERSION}) ===`,
        `# DO NOT EDIT — managed by /kimi:setup. Run /kimi:setup --uninstall to remove.`,
        `# Host: ${hostId.length > 0 ? hostId : "(legacy)"} — each host owns a separate block in this shared`,
        `#   ~/.kimi-code/config.toml. Scoped setup/uninstall preserves other hosts;`,
        `#   /kimi:setup --uninstall --all removes every host's block.`,
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
        `# === END kimi-plugin-cc-managed${suffix} ===`,
    ].join(lineEnding);
}
/**
 * Encode a TOML basic string, including quotes, backslashes, and control
 * escapes. Raw shell output must not be interpolated directly: TOML reserves
 * `\'`, and a compliant parser rejects that escape.
 */
function tomlBasicString(value) {
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
function assertHookPathTomlSafe(hookScriptPath) {
    if (!PATH_FORBIDDEN_RE.test(hookScriptPath))
        return;
    throw new RuntimeError("SETUP_HOOK_PATH_UNSAFE", [
        `Hook script path ${JSON.stringify(hookScriptPath)} contains characters`,
        `(control chars, quotes, backslashes, or newlines) that cannot be safely`,
        `written into kimi-code's TOML config. Set KIMI_PLUGIN_CC_HOOK_SCRIPT`,
        `to an unambiguous absolute path or reinstall the plugin to a location`,
        `without these characters.`,
    ].join(" "), "setup.hook-path", { details: { hookScriptPath } });
}
// ----- Path resolution ---------------------------------------------------
function resolveKimiCodeConfigPath(env) {
    return path.join(resolveKimiHome(env), "config.toml");
}
async function assertHookScriptExists(hookScriptPath) {
    try {
        await access(hookScriptPath, fsConstants.R_OK);
    }
    catch (err) {
        throw new RuntimeError("SETUP_HOOK_SCRIPT_MISSING", `Hook script ${hookScriptPath} is missing or unreadable. Reinstall the plugin so dist/hooks/approval-hook.js is present.`, "setup.hook-script", err instanceof Error ? { cause: err, details: { hookScriptPath } } : { details: { hookScriptPath } });
    }
}
/**
 * Two-layer probe; both layers require exit 2 and a non-empty denial reason.
 *
 *   1. Directly spawn the hook with the absolute path from resolveNodeBinary,
 *      catching missing/broken scripts and incorrect hook exit behavior without
 *      relying on PATH.
 *   2. Execute the exact canonical command from buildHookShellCommand through
 *      `/bin/sh -c`: two shell-quoted absolute tokens for Node and the script.
 *      This catches pinned-interpreter execution and quoting failures. It does
 *      NOT test PATH discovery or compatibility of some other `node` on PATH.
 *
 * The shell layer is skipped where `/bin/sh` is unsupported; the runtime
 * otherwise assumes POSIX.
 */
async function probeHook(hookScriptPath, env) {
    const directResult = await probeHookDirect(hookScriptPath, env);
    if (!directResult.ok)
        return directResult;
    const shellResult = await probeHookViaShell(hookScriptPath, env);
    if (!shellResult.ok)
        return shellResult;
    return {
        ok: true,
        reason: `${directResult.reason}; shell probe also ok`,
    };
}
async function probeHookDirect(hookScriptPath, env) {
    const nodeBin = resolveNodeBinary(env);
    return await spawnProbe(nodeBin, [hookScriptPath], env, `direct probe via ${nodeBin}`);
}
async function probeHookViaShell(hookScriptPath, env) {
    if (process.platform === "win32") {
        // The hook runner shells out via `/bin/sh -c` per agent-core; on
        // Windows the entire kimi-code launcher is unsupported. Skip the
        // shell probe so we don't false-fail on a platform we don't run on.
        return { ok: true, reason: "shell probe skipped (Windows)" };
    }
    // Reuse the exact command string the managed block wrote into
    // kimi-code's config so probe and runtime cannot drift.
    const shellCommand = buildHookShellCommand(hookScriptPath, env);
    return await spawnProbe("/bin/sh", ["-c", shellCommand], env, `shell probe via /bin/sh -c`);
}
function spawnProbe(command, args, env, label) {
    const payload = JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "kimi-plugin-cc-setup-probe",
        cwd: process.cwd(),
        tool_name: "Bash",
        tool_input: { command: "echo probe" },
        tool_call_id: "probe-1",
    });
    return new Promise((resolve) => {
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
        }
        catch (err) {
            resolve({ ok: false, reason: `${label}: spawn failed: ${err.message}` });
            return;
        }
        let stdout = "";
        let stderr = "";
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr?.on("data", (chunk) => {
            stderr += chunk;
        });
        const timer = setTimeout(() => {
            try {
                child.kill("SIGKILL");
            }
            catch {
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
            }
            else {
                resolve({
                    ok: false,
                    reason: `${label}: expected exit 2 with deny reason, got exit ${code ?? "<null>"}. stdout=${truncate(stdout, 120)} stderr=${truncate(stderrTrimmed, 200)}`,
                });
            }
        });
        try {
            child.stdin?.write(payload);
            child.stdin?.end();
        }
        catch (err) {
            clearTimeout(timer);
            resolve({ ok: false, reason: `${label}: failed to write probe stdin: ${err.message}` });
        }
    });
}
function truncate(value, max) {
    if (value.length <= max)
        return value;
    return `${value.slice(0, max)}…`;
}
// ----- Permission rules scan --------------------------------------------
/**
 * Warn only when the installed kimi is demonstrably outside the certified
 * range. Probe failure records nothing here because the hook probe reports the
 * more direct problem; setup may finish, but model spawn still refuses an
 * uncertified binary. KIMI_PLUGIN_CC_SKIP_VERSION_PROBE is a test/CI bypass,
 * not a production compatibility override.
 */
async function collectKimiVersionWarnings(env, warnings) {
    if (env.KIMI_PLUGIN_CC_SKIP_VERSION_PROBE === "1")
        return;
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
    // Certified for EITHER engine is "in range": the legacy tested minors, or an
    // exact native-v2 certified version (which is deliberately outside
    // KIMI_TESTED_MINORS — that table never gains 0.42). Without this, setup on a
    // v2-certified binary would wrongly warn "not certified, commands will refuse".
    if (probe.inTestedRange || isNativeV2CertifiedVersion(probe.version))
        return;
    warnings.push(formatVersionOutOfRangeWarning(probe, KIMI_PLUGIN_CC_VERSION));
}
/**
 * Non-blocking notice for kimi-code's own enabled plugins from
 * ~/.kimi-code/plugins/installed.json. Their tools can register on every
 * session, but read-only commands deny everything outside READ_ONLY_TOOLS
 * (Read, Grep, Glob, ReadMediaFile, TaskList, TaskOutput), which can waste model
 * turns. Missing, unreadable, or malformed manifests produce no notice; setup
 * never blocks on or mutates the plugin list.
 */
async function collectInstalledKimiPluginsNotice(env, warnings) {
    const home = resolveKimiHome(env);
    const installedPath = path.join(home, "plugins", "installed.json");
    let raw;
    try {
        raw = await readFile(installedPath, "utf8");
    }
    catch {
        return; // ENOENT / unreadable — kimi-code's plugin system isn't in use here.
    }
    let enabledIds;
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.plugins)) {
            return;
        }
        enabledIds = parsed.plugins
            .filter((entry) => entry !== null && typeof entry === "object")
            // `enabled !== false` so an explicitly-disabled plugin is hidden while an
            // enabled or format-ambiguous one is surfaced (it can still register tools).
            .filter((entry) => entry.enabled !== false)
            .map((entry) => (typeof entry.id === "string" ? entry.id : ""))
            .filter((id) => id.length > 0);
    }
    catch {
        return; // Malformed JSON — don't guess.
    }
    if (enabledIds.length === 0)
        return;
    warnings.push([
        `NOTE: ${enabledIds.length} kimi-code plugin(s) installed and enabled: ${enabledIds.join(", ")}.`,
        "  kimi-code registers their tools (including MCP) on every session. Under kimi-plugin-cc's",
        "  read-only commands (/kimi:review, /kimi:challenge, /kimi:ask, and the review gate) the",
        "  PreToolUse hook denies any tool outside Read/Grep/Glob, so calls to these plugins' tools",
        "  are blocked — safe, but they can waste model turns. This is expected; no action needed.",
        "  (/kimi:rescue and /kimi:swarm apply their own allowlists.) To avoid the turn-waste, disable",
        "  kimi-code plugins you don't need for delegated work in your kimi-code config.",
    ].join("\n"));
}
/**
 * Best-effort line scan for permission rules that deny common read tools. This
 * is not a TOML parse: it recognizes basic and literal quoted strings but misses
 * inline-table and multiline forms.
 */
function collectPermissionRuleWarnings(contents, warnings) {
    const lines = contents.split("\n").map((line) => line.replace(/\r$/, ""));
    let inRule = false;
    let ruleStartLine = -1;
    let ruleDecision = "";
    let rulePattern = "";
    const flushRule = () => {
        if (!inRule)
            return;
        if (ruleDecision === "deny" && rulePattern.length > 0) {
            if (rulePattern === "*" ||
                /^\s*Read\b/.test(rulePattern) ||
                /^\s*Grep\b/.test(rulePattern) ||
                /^\s*Glob\b/.test(rulePattern)) {
                warnings.push(`permission.rules at line ${ruleStartLine + 1}: deny pattern "${rulePattern}" may block read-only commands; consider scoping the deny narrower.`);
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
        const line = lines[i];
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
        if (!inRule)
            continue;
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
function buildDetails(args) {
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
export function renderSetupResult(result) {
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
        "Models: run setup --models to list configured aliases and provider setup guidance without making a model call.",
    ].join("\n");
}
