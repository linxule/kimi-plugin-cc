import { SETUP_SUPPORTED_FLAGS } from "../parsing.js";
// Managed-block installer for the load-bearing kimi-code PreToolUse hook.
// Without it, `kimi -p` auto-approves tool calls, including from read-only
// commands.
//
// Setup writes or refreshes a host-scoped BEGIN/END block containing the
// canonical `'<absolute-node>' '<absolute-hook-script>'` command from
// resolveNodeBinary/buildHookShellCommand. Both tokens are shell-quoted and the
// absolute Node path avoids PATH dependence under sanitized launches. Setup
// probes the hook directly with the Node binary parsed back from that command
// and through `/bin/sh -c` using the exact installed command bytes. It also warns about broad permission
// denies, repairs orphan marker comments, and refuses remaining
// duplicate, orphaned, or malformed managed blocks.
//
// Subcommands: install (default), --check, --uninstall [--all],
// --enable-review-gate/--disable-review-gate, and the explicit, network-using
// --install-kimi [--json], which installs the highest certified kimi-code into
// plugin data. Nothing else in setup or any job installs or downloads.
//
// Managed-block splicing is line-based and preserves user bytes outside owned
// edits; whole-file validation and inline-hook normalization use the TOML parser.
import { spawn } from "node:child_process";
import { access, mkdir, lstat, mkdtemp, open, readdir, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile, } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { readPluginConfig, writePluginConfig } from "../config.js";
import { RuntimeError } from "../errors.js";
import { HOOK_TIMEOUT_S } from "../hooks/hook-timing.js";
import { olderHostHookWarnings } from "../hooks/install.js";
import { normalizeTopLevelInlineHooks, validateKimiHookSetForEnvironment, withKimiConfigLock, } from "../hooks/config-safety.js";
import { buildHookShellCommand, hostIdFromHookCommand, parseHookShellCommand, resolveHookScriptPath, resolveHostId, resolveNodeBinary, } from "../hooks/install-paths.js";
import { decodeManagedCommandLine, describeHookTimeout, effectiveHost, evaluateInstalled, findShortHookTimeout, findUnmanagedApprovalHookBlocks, ORPHAN_MARKER_REMEDY, pairBlocks, parseManagedBlock, } from "../hooks/managed-block.js";
import { formatVersionOutOfRangeWarning, probeKimiVersion, } from "../kimi-version-probe.js";
import { inspectPluginOwnedKimi, selectKimiBinary } from "../kimi-command.js";
import { isNativeV2CertifiedVersion, NATIVE_V2_ANY_OPERATION_VERSIONS, NATIVE_V2_CERTIFIED_VERSIONS, NATIVE_V2_NON_SWARM_VERSIONS, } from "../kimi-engine.js";
import { resolveKimiCodeConfigPath, resolveKimiHome } from "../kimi-home.js";
import { formatVersionChoice, kimiReleaseHas, kimiVersionsWith } from "../kimi-releases.js";
import { ensurePluginPaths, resolveKimiBinDir, resolvePluginPaths } from "../paths.js";
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
export async function runSetup(argv, context) {
    const parsed = parseArgs(argv);
    if (parsed.mode === "install-kimi") {
        return await runInstallKimi(parsed.json, context);
    }
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
    if (installKimi) {
        if (argv.some((token) => token !== "--install-kimi" && token !== "--json")) {
            throw new RuntimeError("INVALID_ARGS", "--install-kimi does not combine with other setup flags except --json.", "setup.parse");
        }
        return { mode: "install-kimi", json, enableReviewGate, disableReviewGate, removeAllHosts };
    }
    if (json) {
        throw new RuntimeError("INVALID_ARGS", "--json is only valid with --install-kimi or --models.", "setup.parse");
    }
    return { mode, json, enableReviewGate, disableReviewGate, removeAllHosts };
}
async function runInstall(configPath, hookScriptPath, hostId, reviewGateEnabled, warnings, context) {
    await assertHookScriptExists(hookScriptPath);
    const mutation = await withKimiConfigLock(configPath, async () => {
        const original = await readConfigSafe(configPath);
        const lineEnding = detectLineEnding(original);
        try {
            parseToml(original);
        }
        catch {
            await assertKimiHookSetValid(original, configPath, "setup.install", context.env);
        }
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
                throw new RuntimeError("SETUP_INVALID_HOOKS_CONFIG", `Could not safely convert the top-level inline hooks assignment in ${configPath}; the existing config was left unchanged.`, "setup.install", { details: { configPath } });
            }
            warnings.push(`Converted the top-level inline hooks array (${inlineHooks.entryCount} entr${inlineHooks.entryCount === 1 ? "y" : "ies"}) to canonical [[hooks]] tables before installing. Surrounding config bytes were preserved; formatting and comments inside that hooks assignment were normalized.`);
        }
        // Prune only this host's orphaned marker-less entries before computing
        // splice line numbers. Another host's marker-less table may be its live hook
        // after a config rewrite strips comments, so it must remain untouched.
        const expectedCommand = buildHookShellCommand(hookScriptPath, context.env);
        const shortBefore = findShortHookTimeout(inlineHooks.contents, expectedCommand);
        const { pruned, count: prunedCount, commands: prunedCommands } = pruneOrphanApprovalHooks(inlineHooks.contents, hostId, expectedCommand);
        const existing = pruned;
        if (prunedCount > 0) {
            const readorned = prunedCommands.includes(expectedCommand);
            warnings.push(readorned
                ? shortBefore === null
                    ? `Re-adorned this host's managed-block markers: kimi-code rewrites its config on login/settings changes and strips all comments (markers included), leaving the hook enforcing but unmarked. Replaced the bare hook table with a freshly marked block (${prunedCount} table(s) refreshed). Enforcement was never interrupted.`
                    : `Re-adorned this host's managed-block markers: replaced the bare hook table with a freshly marked block (${prunedCount} table(s) refreshed).`
                : `Pruned ${prunedCount} stale marker-less kimi-plugin-cc hook block(s) left by this host's earlier installs. This is a cleanup — your active hook is unaffected.`);
        }
        const { state, blocks } = parseManagedBlock(existing, hostId);
        if (state.kind === "orphan") {
            throw new RuntimeError("SETUP_ORPHAN_MARKERS", [
                `kimi-code config at ${configPath} contains an orphaned ${state.detail} marker.`,
                "Inspect the managed marker comments and re-run setup.",
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
        const block = buildManagedBlock(expectedCommand, lineEnding, hostId);
        const next = state.kind === "found"
            ? spliceBlock(existing, state.beginLine, state.endLine, block, lineEnding)
            : insertBlockNearManagedBlocks(existing, blocks, block, lineEnding);
        await assertKimiHookSetValid(next, configPath, "setup.install", context.env);
        // Setup rewrites only its own block and prunable tables. Any other copy of
        // this command (e.g. one with a matcher) can be the entry kimi-code runs.
        const shortAfter = findShortHookTimeout(next, expectedCommand);
        if (shortAfter !== null) {
            throw new RuntimeError("SETUP_INVALID_HOOKS_CONFIG", `kimi-code config at ${configPath} has another [[hooks]] entry with this host's hook command and ${describeHookTimeout(shortAfter.timeout)}; kimi-code runs only one entry per command and reads a hook that runs past its timeout as allow. Remove that entry before rerunning /kimi:setup; the existing config was left unchanged.`, "setup.install", { details: { configPath, timeout: describeHookTimeout(shortAfter.timeout) } });
        }
        if (shortBefore !== null) {
            warnings.push(`Rewrote this host's hook entry from ${describeHookTimeout(shortBefore.timeout)} to timeout = ${HOOK_TIMEOUT_S}: kimi-code reads a hook that runs past its timeout as allow, so the earlier entry did not reliably enforce.`);
        }
        const blockWritten = next !== original;
        if (blockWritten)
            await writeConfigAtomic(configPath, next);
        return { blockWritten, next, expectedCommand };
    });
    const { blockWritten, next, expectedCommand } = mutation;
    warnings.push(...await olderHostHookWarnings(next, hostId, expectedCommand));
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
        reviewGateEnabled,
        nextStep: probe.ok
            ? "Run /kimi:task, /kimi:review, /kimi:pursue or /kimi:swarm. Codex users can invoke the matching $kimi-* skills."
            : "Re-run /kimi:setup after installing kimi-code and Node. If the probe keeps failing, run /kimi:setup --uninstall and inspect ~/.kimi-code/config.toml manually.",
        details: buildDetails({
            configPath,
            hookScriptPath,
            reviewGateEnabled,
            probe,
            warnings,
            hostId,
            kimiBinary,
        }),
    };
}
async function runCheck(configPath, hookScriptPath, hostId, reviewGateEnabled, warnings, context) {
    const failedCheck = (result) => ({
        action: "check",
        summary: result.summary,
        configPath,
        hookScriptPath,
        blockWritten: false,
        blockRemoved: false,
        probe: "failed",
        probeError: result.reason,
        warnings,
        reviewGateEnabled,
        nextStep: result.nextStep,
        details: buildDetails({
            configPath,
            hookScriptPath,
            reviewGateEnabled,
            probe: { ok: false, reason: result.detailReason ?? result.reason },
            warnings,
            hostId: result.hostId,
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
            nextStep: "Repair or remove the invalid [[hooks]] entry named above, then run /kimi:setup --check again. No model call is required.",
            hostId,
        });
    }
    const expectedCommand = buildHookShellCommand(hookScriptPath, context.env);
    // nodeExists refines mismatch prose into drift classification; hostId checks
    // only this host's block in the shared config.
    const installedCheck = evaluateInstalled(existing, expectedCommand, {
        hostId,
        nodeExists: (binPath) => existsSync(binPath),
    });
    // Non-blocking coexistence + cruft notices.
    const { blocks: allBlocks, foreignOrphans } = parseManagedBlock(existing, hostId);
    for (const orphan of foreignOrphans) {
        warnings.push(`Host "${orphan.hostId}" has an orphaned ${orphan.detail} managed marker at line ${orphan.line + 1}; that host's commands refuse until it is repaired. ${ORPHAN_MARKER_REMEDY}`);
    }
    const otherHosts = [
        ...new Set(allBlocks.map((b) => effectiveHost(b, hostId)).filter((h) => h !== hostId)),
    ];
    if (otherHosts.length > 0) {
        warnings.push(`Other host(s) also manage a block in this shared config: ${otherHosts.join(", ")} (coexisting, untouched).`);
    }
    warnings.push(...await olderHostHookWarnings(existing, hostId, expectedCommand));
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
        return failedCheck({
            summary: installedCheck.timeoutTooShort === true
                ? `kimi-plugin-cc PreToolUse hook in ${configPath} does not enforce: ${installedCheck.reason}`
                : installedCheck.state.kind === "absent"
                    ? `kimi-plugin-cc managed block is NOT installed in ${configPath}.`
                    : `kimi-plugin-cc managed block is present but invalid: ${installedCheck.reason}.`,
            reason: installedCheck.reason ?? "managed block missing or invalid",
            detailReason: installedCheck.reason ?? "block missing/invalid",
            nextStep: installedCheck.timeoutTooShort === true
                ? "Run /kimi:setup (without --check) to rewrite the hook timeout."
                : installedCheck.state.kind === "absent"
                    ? "Run /kimi:setup (without --check) to install the managed block."
                    : installedCheck.state.kind === "orphan"
                        ? ORPHAN_MARKER_REMEDY
                        : "Run /kimi:setup --uninstall, then /kimi:setup to repair.",
        });
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
        return failedCheck({
            summary: `Managed block references ${hookScriptPath} but that path is unreadable.`,
            reason: err instanceof Error ? err.message : String(err),
            nextStep: "Reinstall the plugin so dist/hooks/approval-hook.js is present, or run /kimi:setup to refresh the managed block.",
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
            kimiBinary,
        }),
    };
}
async function runUninstall(configPath, hookScriptPath, hostId, removeAllHosts, reviewGateEnabled, warnings, context) {
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
        // Exact current command bytes also identify this host's table when a host-id
        // override disagrees with path derivation or a dev path is outside the strict
        // ownership pattern.
        const expectedCommand = buildHookShellCommand(hookScriptPath, context.env);
        const { pruned: stripped, count: prunedCount } = pruneOrphanApprovalHooks(strippedMarkers, removeAllHosts ? undefined : hostId, expectedCommand);
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
    });
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
function insertBlockNearManagedBlocks(contents, blocks, block, lineEnding) {
    if (blocks.length === 0)
        return appendBlock(contents, block, lineEnding);
    const anchor = Math.max(...blocks.map((b) => b.endLine));
    const lines = splitPreservingEnding(contents);
    for (let i = anchor + 1; i < lines.length; i += 1) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith("["))
            break;
        if (trimmed.length > 0 && !trimmed.startsWith("#"))
            return appendBlock(contents, block, lineEnding);
    }
    const rawLines = contents.split(/(?<=\n)/);
    const head = rawLines.slice(0, anchor + 1).join("");
    const tail = rawLines.slice(anchor + 1).join("");
    const appended = appendBlock(contents, block, lineEnding);
    if (tail.length === 0)
        return appended;
    const headWithEnding = head.endsWith("\n") ? head : `${head}${lineEnding}`;
    const body = block.endsWith(lineEnding) ? block : `${block}${lineEnding}`;
    const tailSeparator = /^\r?\n/.test(tail) ? "" : lineEnding;
    const inserted = `${headWithEnding}${lineEnding}${body}${tailSeparator}${tail}`;
    return sameTomlIgnoringHookOrder(inserted, appended) ? inserted : appended;
}
function sameTomlIgnoringHookOrder(a, b) {
    const canonical = (text) => {
        const parsed = parseToml(text);
        const hooks = Array.isArray(parsed.hooks)
            ? parsed.hooks.map((entry) => JSON.stringify(entry)).sort()
            : parsed.hooks;
        return JSON.stringify({ ...parsed, hooks });
    };
    try {
        return canonical(a) === canonical(b);
    }
    catch {
        return false;
    }
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
// A partial upstream hooks-array rewrite can leave one marker comment behind.
// Remove only unpaired marker comments, never the intervening content. The
// normal full-file validation still gates writes.
function removeOrphanMarkers(contents) {
    const remove = new Set(pairBlocks(splitPreservingEnding(contents)).orphans.map((marker) => marker.line));
    return remove.size === 0
        ? { contents, count: 0 }
        : { contents: removeLines(contents, remove), count: remove.size };
}
/**
 * Remove managed blocks owned by `currentHost`, or every host with `removeAll`.
 * Ownership comes from the marker suffix or a legacy command's derived host.
 * Orphan markers are removed individually so surrounding user content survives.
 */
function stripManagedBlocks(contents, currentHost, removeAll) {
    const lines = splitPreservingEnding(contents);
    const { blocks, orphans } = pairBlocks(lines);
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
    const orphansLeft = orphans
        .filter((orphan) => shouldRemove(orphan.hostId, null, true))
        .map((orphan) => orphan.line);
    const remove = new Set(orphansLeft);
    let removedBlocks = 0;
    for (const block of blocks) {
        // Attribute by the LAST command line in the body, even one after a line
        // that makes the block invalid (unlike the validator's commandPath).
        let blockCommand = null;
        for (const line of lines.slice(block.beginLine + 1, block.endLine)) {
            blockCommand = decodeManagedCommandLine(line.trim()) ?? blockCommand;
        }
        if (!shouldRemove(block.hostId, blockCommand, false))
            continue;
        removedBlocks += 1;
        for (let i = block.beginLine; i <= block.endLine; i += 1)
            remove.add(i);
    }
    return { stripped: removeLines(contents, remove), removedBlocks, orphansLeft };
}
function removeLines(contents, remove) {
    return contents.split(/(?<=\n)/).filter((_, index) => !remove.has(index)).join("");
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
function pruneOrphanApprovalHooks(contents, ownedBy, alsoMatchCommand) {
    const ranges = findUnmanagedApprovalHookBlocks(contents, ownedBy, alsoMatchCommand);
    if (ranges.length === 0)
        return { pruned: contents, count: 0, commands: [] };
    const remove = new Set();
    for (const { start, end } of ranges) {
        for (let i = start; i < end; i += 1)
            remove.add(i);
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
function buildManagedBlock(shellCommand, lineEnding = "\n", hostId = "") {
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
async function probeHook(hookScriptPath, command, env) {
    const directResult = await probeHookDirect(hookScriptPath, command, env);
    if (!directResult.ok)
        return directResult;
    const shellResult = await probeHookViaShell(command, env);
    if (!shellResult.ok)
        return shellResult;
    return {
        ok: true,
        reason: `${directResult.reason}; shell probe also ok`,
    };
}
async function probeHookDirect(hookScriptPath, command, env) {
    // Parsed back from the command, never re-resolved; the fallback is unreachable.
    const nodeBin = parseHookShellCommand(command)?.nodeBin ?? resolveNodeBinary(env);
    return await spawnProbe(nodeBin, [hookScriptPath], env, `direct probe via ${nodeBin}`);
}
async function probeHookViaShell(shellCommand, env) {
    if (process.platform === "win32") {
        // The hook runner shells out via `/bin/sh -c` per agent-core; on
        // Windows the entire kimi-code launcher is unsupported. Skip the
        // shell probe so we don't false-fail on a platform we don't run on.
        return { ok: true, reason: "shell probe skipped (Windows)" };
    }
    // The exact command string the managed block wrote into kimi-code's config,
    // so probe and runtime cannot drift.
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
export function highestCertifiedKimiVersion(versions = NATIVE_V2_CERTIFIED_VERSIONS) {
    const parse = (v) => v.split(".").map(Number);
    const sorted = [...versions].sort((a, b) => {
        const [x, y] = [parse(a), parse(b)];
        for (let i = 0; i < 3; i += 1) {
            if (x[i] !== y[i])
                return (x[i] ?? 0) - (y[i] ?? 0);
        }
        return 0;
    });
    const highest = sorted[sorted.length - 1];
    if (highest === undefined || !/^\d+\.\d+\.\d+$/.test(highest)) {
        throw new RuntimeError("KIMI_INSTALL_FAILED", "No exact certified kimi-code version is available to install.", "setup.install-kimi");
    }
    return highest;
}
function compareExactVersions(a, b) {
    const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
    for (let i = 0; i < 3; i += 1) {
        if (x[i] !== y[i])
            return (x[i] ?? 0) - (y[i] ?? 0);
    }
    return 0;
}
async function runInstallKimi(json, context) {
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
                ? "Run /kimi:setup --check to confirm the hook and the selected binary."
                : "Unset KIMI_PLUGIN_CC_KIMI_BIN to use the plugin-owned binary, then run /kimi:setup --check.",
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
    }
    catch (error) {
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
function installKimiResult(args) {
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
        reviewGateEnabled: false,
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
async function installPluginOwnedKimi(version, env) {
    if (process.platform === "win32") {
        throw new RuntimeError("KIMI_INSTALL_UNSUPPORTED_PLATFORM", "setup --install-kimi is not supported on Windows. Install kimi-code yourself and set KIMI_PLUGIN_CC_KIMI_BIN to its path.", "setup.install-kimi");
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
    let trash;
    try {
        await writeFile(path.join(staging, "package.json"), `${JSON.stringify({ name: "kimi-plugin-cc-kimi-bin", private: true })}\n`, "utf8");
        await runNpmInstall(staging, version, env);
        const staged = await verifyKimiBinary(path.join(staging, "node_modules", ".bin", "kimi"), binDir, path.basename(staging), version, env);
        if (!staged.ok) {
            throw new RuntimeError("KIMI_INSTALL_VERIFY_FAILED", `The installed kimi-code did not verify as exactly ${version}: ${staged.reason}.`, "setup.install-kimi", { details: { expected_version: version } });
        }
        if (await pathExists(versionDir)) {
            // A present but unverifiable version directory is set aside, not reused.
            trash = path.join(binDir, `.trash-${version}-${randomBytes(4).toString("hex")}`);
            await rename(versionDir, trash);
        }
        try {
            await rename(staging, versionDir);
        }
        catch (error) {
            if (trash) {
                await rename(trash, versionDir).catch(() => undefined);
                trash = undefined;
            }
            throw error;
        }
        await pointCurrentAt(binDir, binRelative, currentPath, env);
        return { version, downloaded: true, binary: await realpath(binPath), current: currentPath };
    }
    finally {
        await rm(staging, { recursive: true, force: true });
        if (trash)
            await rm(trash, { recursive: true, force: true });
    }
}
/** Remove staging directories an interrupted install left directly in kimi-bin/. */
async function removeStaleStaging(binDir, now = Date.now()) {
    let entries;
    try {
        entries = await readdir(binDir);
    }
    catch {
        return;
    }
    for (const name of entries) {
        if (!name.startsWith(STAGING_PREFIX))
            continue;
        const entry = path.join(binDir, name);
        try {
            const info = await lstat(entry);
            if (!info.isDirectory() || now - info.mtimeMs < STALE_STAGING_AGE_MS)
                continue;
            await rm(entry, { recursive: true, force: true });
        }
        catch {
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
async function verifyKimiBinary(binary, binDir, dirName, version, env) {
    let resolved;
    let root;
    try {
        resolved = await realpath(binary);
        root = path.join(await realpath(binDir), dirName);
    }
    catch {
        return { ok: false, reason: `${binary} is missing` };
    }
    if (!resolved.startsWith(`${root}${path.sep}`)) {
        return { ok: false, reason: `${binary} resolves to ${resolved}, outside ${root}${path.sep}` };
    }
    try {
        const info = await lstat(resolved);
        if (!info.isFile())
            return { ok: false, reason: `${resolved} is not a regular file` };
        await access(resolved, fsConstants.X_OK);
    }
    catch {
        return { ok: false, reason: `${resolved} is not executable` };
    }
    const probe = await probeKimiVersion({ kimiBin: resolved, env, timeoutMs: KIMI_INSTALL_PROBE_TIMEOUT_MS });
    if (probe.kind !== "ok")
        return { ok: false, reason: probe.reason };
    const observed = probe.version.replace(/^v/, "");
    return observed === version ? { ok: true } : { ok: false, reason: `\`--version\` reported ${probe.version}` };
}
/**
 * Atomically replace `current` (POSIX rename over the old link), then confirm
 * binary resolution accepts the new link; otherwise restore the old one.
 */
async function pointCurrentAt(binDir, binRelative, currentPath, env) {
    let previous;
    try {
        previous = await readlink(currentPath);
    }
    catch {
        previous = undefined;
    }
    if (previous === binRelative && inspectPluginOwnedKimi(env).status === "active")
        return;
    const swap = async (target) => {
        const temp = path.join(binDir, `.current-${randomBytes(4).toString("hex")}`);
        await symlink(target, temp);
        try {
            await rename(temp, currentPath);
        }
        catch (error) {
            await rm(temp, { force: true });
            throw error;
        }
    };
    await swap(binRelative);
    const state = inspectPluginOwnedKimi(env);
    if (state.status !== "active") {
        if (previous !== undefined)
            await swap(previous);
        else
            await rm(currentPath, { force: true });
        throw new RuntimeError("KIMI_INSTALL_VERIFY_FAILED", `The new ${currentPath} link was not accepted by binary resolution: ${state.reason ?? state.status}. The previous link was restored.`, "setup.install-kimi");
    }
}
async function runNpmInstall(prefix, version, env) {
    // Never a global install, whatever the caller's npm environment says.
    const npmEnv = { ...env };
    for (const key of Object.keys(npmEnv)) {
        if (/^npm_config_(global|location|prefix)$/i.test(key))
            delete npmEnv[key];
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
    await new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn("npm", args, { cwd: prefix, env: npmEnv, stdio: ["ignore", "ignore", "pipe"], detached: true });
        }
        catch (error) {
            reject(npmFailure(`could not start npm: ${error.message}`, version));
            return;
        }
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
        });
        let timedOut = false;
        const killGroup = (signal) => {
            try {
                if (child.pid !== undefined)
                    process.kill(-child.pid, signal);
            }
            catch {
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
            }
            else if (code !== 0) {
                reject(npmFailure(`npm install exited ${code ?? signal}`, version, stderr));
            }
            else {
                resolve();
            }
        });
    });
}
function npmFailure(reason, version, stderr = "") {
    return new RuntimeError("KIMI_INSTALL_FAILED", `Could not install ${KIMI_PACKAGE}@${version}: ${reason}.`, "setup.install-kimi", { details: { package: `${KIMI_PACKAGE}@${version}`, ...(stderr.trim() ? { npm_stderr_tail: stderr.trim() } : {}) } });
}
async function pathExists(target) {
    try {
        await access(target);
        return true;
    }
    catch {
        return false;
    }
}
/** Which binary jobs will use and why, plus a note when the plugin-owned one is stale or unusable. */
function describeKimiBinary(env, warnings) {
    const selection = selectKimiBinary(env);
    const owned = selection.pluginOwned;
    const highest = highestCertifiedKimiVersion();
    if (owned.status === "active" && owned.version && compareExactVersions(owned.version, highest) < 0) {
        warnings.push(`NOTE: the plugin-owned kimi-code ${owned.version} is behind the highest certified version ${highest}. Run setup --install-kimi to install ${highest}.`);
    }
    if (owned.status === "rejected") {
        warnings.push(`The plugin-owned kimi-code install is not used: ${owned.reason}. Run setup --install-kimi to repair it.`);
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
async function collectKimiVersionWarnings(env, warnings) {
    if (env.KIMI_PLUGIN_CC_SKIP_VERSION_PROBE === "1")
        return;
    // The same binary jobs select (override, plugin-owned, then PATH).
    const probe = await probeKimiVersion({
        kimiBin: selectKimiBinary(env).command,
        env,
    });
    if (probe.kind === "failed") {
        // Don't warn about probe failure here — if kimi is genuinely
        // missing/broken, the hook probe path will catch it with a much
        // clearer message. Avoid double-noise.
        return;
    }
    if (!probe.inTestedRange && !isNativeV2CertifiedVersion(probe.version)) {
        warnings.push(formatVersionOutOfRangeWarning(probe, KIMI_PLUGIN_CC_VERSION, NATIVE_V2_ANY_OPERATION_VERSIONS));
        return;
    }
    if (kimiReleaseHas(probe.version, "bounded-swarm")) {
        warnings.push(`NOTE: kimi-code ${probe.version} is certified for all operations. Swarm uses bounded waves with concurrency 2 or more, and one direct worker at concurrency 1. The finite job budget stops the whole run.`);
        return;
    }
    if (NATIVE_V2_NON_SWARM_VERSIONS.includes(probe.version)) {
        warnings.push(`NOTE: kimi-code ${probe.version} is certified for review, challenge, ask, rescue, review gate, and pursue only. Read-only swarm and write swarm refuse before model spawn on this exact release. Select exact kimi-code ${formatVersionChoice(kimiVersionsWith("bounded-swarm"))} for this plugin's certified bounded waves and single-worker path.`);
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
        "  read-only commands (/kimi:task, /kimi:review and the review gate) the",
        "  PreToolUse hook denies every tool that is not on its read-only list, so calls to these plugins' tools",
        "  are blocked — safe, but they can waste model turns. This is expected; no action needed.",
        "  (/kimi:task --write and /kimi:swarm apply their own allowlists.) To avoid the turn-waste, disable",
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
        ...(args.kimiBinary ? [`Kimi binary:      ${args.kimiBinary}`] : []),
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
    if (result.kimiInstall)
        return renderInstallKimiResult(result, result.kimiInstall);
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
function renderInstallKimiResult(result, report) {
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
