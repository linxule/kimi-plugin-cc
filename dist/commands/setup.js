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
import { access, mkdir, readFile, rename, unlink, writeFile, } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPluginConfig, writePluginConfig } from "../config.js";
import { RuntimeError } from "../errors.js";
import { evaluateInstalled, parseManagedBlock, } from "../hooks/managed-block.js";
import { ensurePluginPaths, resolvePluginPaths } from "../paths.js";
import { KIMI_PLUGIN_CC_VERSION } from "../version.js";
const BEGIN_MARKER_PREFIX = "# === BEGIN kimi-plugin-cc-managed";
const END_MARKER = "# === END kimi-plugin-cc-managed ===";
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
    const warnings = [];
    switch (parsed.mode) {
        case "uninstall":
            return await runUninstall(configPath, hookScriptPath, reviewGateEnabled, warnings);
        case "check":
            return await runCheck(configPath, hookScriptPath, reviewGateEnabled, warnings, context);
        case "install":
            return await runInstall(configPath, hookScriptPath, reviewGateEnabled, warnings, context);
    }
}
function parseArgs(argv) {
    let mode = "install";
    let enableReviewGate = false;
    let disableReviewGate = false;
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
            case "--enable-review-gate":
                enableReviewGate = true;
                break;
            case "--disable-review-gate":
                disableReviewGate = true;
                break;
            default:
                throw new RuntimeError("INVALID_ARGS", `Unknown setup flag ${token}. Supported flags: --check, --uninstall, --enable-review-gate, --disable-review-gate.`, "setup.parse");
        }
    }
    if (enableReviewGate && disableReviewGate) {
        throw new RuntimeError("INVALID_ARGS", "setup accepts either --enable-review-gate or --disable-review-gate, not both.", "setup.parse");
    }
    return { mode, enableReviewGate, disableReviewGate };
}
async function runInstall(configPath, hookScriptPath, reviewGateEnabled, warnings, context) {
    await assertHookScriptExists(hookScriptPath);
    const existing = await readConfigSafe(configPath);
    const { state } = parseManagedBlock(existing);
    if (state.kind === "orphan") {
        throw new RuntimeError("SETUP_ORPHAN_MARKERS", [
            `kimi-code config at ${configPath} contains an orphaned ${state.detail} marker.`,
            "Run `/kimi:setup --uninstall` to clean up, then re-run `/kimi:setup`.",
        ].join(" "), "setup.install", { details: { configPath, orphan: state.detail } });
    }
    if (state.kind === "duplicate") {
        throw new RuntimeError("SETUP_DUPLICATE_BLOCKS", [
            `kimi-code config at ${configPath} contains ${state.beginLines.length} kimi-plugin-cc managed blocks (lines ${state.beginLines
                .map((line) => line + 1)
                .join(", ")}).`,
            "This usually means two /kimi:setup runs raced. Run `/kimi:setup --uninstall` to clear them, then `/kimi:setup` again.",
        ].join(" "), "setup.install", { details: { configPath, beginLines: state.beginLines } });
    }
    const lineEnding = detectLineEnding(existing);
    const block = buildManagedBlock(hookScriptPath, lineEnding);
    const next = state.kind === "found"
        ? spliceBlock(existing, state.beginLine, state.endLine, block, lineEnding)
        : appendBlock(existing, block, lineEnding);
    let blockWritten = next !== existing;
    if (blockWritten) {
        await writeConfigAtomic(configPath, next);
    }
    collectPermissionRuleWarnings(next, warnings);
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
            ? "Run /kimi:review, /kimi:challenge, /kimi:ask, or /kimi:rescue. Set KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1 to silence the per-call install warning."
            : "Re-run /kimi:setup after installing kimi-code and Node. If the probe keeps failing, run /kimi:setup --uninstall and inspect ~/.kimi-code/config.toml manually.",
        details: buildDetails({
            configPath,
            hookScriptPath,
            reviewGateEnabled,
            probe,
            warnings,
        }),
    };
}
async function runCheck(configPath, hookScriptPath, reviewGateEnabled, warnings, context) {
    const existing = await readConfigSafe(configPath);
    const installedCheck = evaluateInstalled(existing, hookScriptPath);
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
        nextStep: probe.ok
            ? "No action needed."
            : "Run /kimi:setup to repair the managed block, or /kimi:setup --uninstall if you want to remove the integration.",
        details: buildDetails({
            configPath,
            hookScriptPath,
            reviewGateEnabled,
            probe,
            warnings,
        }),
    };
}
async function runUninstall(configPath, hookScriptPath, reviewGateEnabled, warnings) {
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
    const { stripped, removedBlocks, orphansLeft } = stripManagedBlocks(existing);
    const changed = stripped !== existing;
    if (changed) {
        await writeConfigAtomic(configPath, stripped);
    }
    if (orphansLeft.length > 0) {
        warnings.push(`Detected ${orphansLeft.length} orphan marker line(s) at ${orphansLeft
            .map((line) => `line ${line + 1}`)
            .join(", ")}. Removed the marker line(s) but preserved surrounding user content — verify the config visually.`);
    }
    return {
        action: "uninstall",
        summary: changed
            ? `Removed ${removedBlocks} managed block(s) from ${configPath}.`
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
    // Two-phase write: write to a sibling temp file, then rename. Each
    // call uses a unique temp path so two concurrent installs/uninstalls
    // can race without clobbering each other's intermediate file (PR 4
    // reviewer finding — fixed-path tmp file was a race surface).
    await mkdir(path.dirname(configPath), { recursive: true });
    const suffix = randomBytes(8).toString("hex");
    const tmpPath = `${configPath}.kimi-plugin-cc.${process.pid}.${suffix}.tmp`;
    try {
        await writeFile(tmpPath, contents, "utf8");
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
 * Remove every BEGIN/END marker pair we find. Orphan marker lines are
 * removed individually (no destructive sweep of trailing content) so
 * `--uninstall` on a corrupted config doesn't take user data with it.
 */
function stripManagedBlocks(contents) {
    const lineEnding = detectLineEnding(contents);
    const lines = splitPreservingEnding(contents);
    const result = [];
    const orphansLeft = [];
    let removedBlocks = 0;
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();
        if (isBeginMarker(trimmed)) {
            // Look ahead for the matching END.
            let endIdx = -1;
            for (let j = i + 1; j < lines.length; j += 1) {
                const nextTrimmed = lines[j].trim();
                if (isBeginMarker(nextTrimmed)) {
                    // Two BEGINs in a row — the outer one is an orphan.
                    break;
                }
                if (isEndMarker(nextTrimmed)) {
                    endIdx = j;
                    break;
                }
            }
            if (endIdx === -1) {
                // Orphan BEGIN: drop only this line.
                orphansLeft.push(i);
                i += 1;
                continue;
            }
            // Found a complete pair — drop everything from BEGIN to END inclusive.
            removedBlocks += 1;
            i = endIdx + 1;
            continue;
        }
        if (isEndMarker(trimmed)) {
            // Orphan END with no preceding BEGIN: drop only this line.
            orphansLeft.push(i);
            i += 1;
            continue;
        }
        result.push(line);
        i += 1;
    }
    // Collapse runs of >= 3 blank lines created by removal back to 2.
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
function isBeginMarker(trimmedLine) {
    return /^#\s*===\s*BEGIN\s+kimi-plugin-cc-managed(?:\s+\([^)]+\))?\s*===\s*$/.test(trimmedLine);
}
function isEndMarker(trimmedLine) {
    return /^#\s*===\s*END\s+kimi-plugin-cc-managed\s*===\s*$/.test(trimmedLine);
}
// ----- Block content -----------------------------------------------------
/**
 * Resolved Node binary that kimi-code will spawn. We write an absolute
 * path into the managed block so the hook keeps firing when kimi-code
 * is launched from a GUI/LaunchAgent with a sanitized PATH (nvm /
 * asdf / mise users). PR 4 reviewers flagged bare `node` as a
 * fail-open class: kimi-code's `/bin/sh -c "node ..."` exits 127 on
 * missing-node, which the hook protocol treats as ALLOW.
 */
function resolveNodeBinary(env) {
    const override = env.KIMI_PLUGIN_CC_NODE_BIN;
    if (override !== undefined && override.length > 0) {
        return override;
    }
    return process.execPath;
}
function buildManagedBlock(hookScriptPath, lineEnding = "\n") {
    const nodeBin = resolveNodeBinary(process.env);
    const commandLine = `command = ${tomlBasicString(`${nodeBin} ${hookScriptPath}`)}`;
    return [
        `${BEGIN_MARKER_PREFIX} (v${KIMI_PLUGIN_CC_VERSION}) ===`,
        `# DO NOT EDIT — managed by /kimi:setup. Run /kimi:setup --uninstall to remove.`,
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
        END_MARKER,
    ].join(lineEnding);
}
/**
 * Encode a string for a TOML 1.0 basic string. Escapes the six required
 * escape sequences plus quotes/backslashes. Avoids the `\'` shell-quote
 * hazard that broke the v1.0-alpha.1 prototype: TOML basic strings
 * declare `\'` as a reserved escape, and a parser-compliant TOML
 * library (kimi-code uses smol-toml) raises an error on encounter.
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
    const home = env.KIMI_CODE_HOME ?? path.join(os.homedir(), ".kimi-code");
    return path.join(home, "config.toml");
}
/**
 * Resolve the absolute path to the compiled hook script.
 *
 * Resolution order:
 *
 *   1. `KIMI_PLUGIN_CC_HOOK_SCRIPT` override — tests / advanced users.
 *   2. Sibling resolution from this file's URL. setup.ts (or setup.js)
 *      lives at `<root>/{runtime,dist}/commands/`. The hook artifact
 *      lives at `<root>/dist/hooks/approval-hook.js`. We walk up to
 *      `<root>` and append `dist/hooks/approval-hook.js`.
 */
function resolveHookScriptPath(env) {
    if (env.KIMI_PLUGIN_CC_HOOK_SCRIPT && env.KIMI_PLUGIN_CC_HOOK_SCRIPT.length > 0) {
        return env.KIMI_PLUGIN_CC_HOOK_SCRIPT;
    }
    // `import.meta.url` resolves to either:
    //   - file://.../dist/commands/setup.js   (installed plugin)
    //   - file://.../runtime/commands/setup.ts (dev / bun test)
    const here = fileURLToPath(import.meta.url);
    const parts = here.split(path.sep);
    // Pin to the canonical suffix `{runtime|dist}/commands/setup.{ts,js}`
    // — anchoring to a specific tail keeps ancestor directories named
    // "runtime" or "dist" from confusing the lookup.
    if (parts.length < 3) {
        throw resolveHookFailure(here);
    }
    const tailParent = parts[parts.length - 2];
    const tailGrandparent = parts[parts.length - 3];
    if (tailParent !== "commands" || (tailGrandparent !== "runtime" && tailGrandparent !== "dist")) {
        throw resolveHookFailure(here);
    }
    const pluginRoot = parts.slice(0, parts.length - 3).join(path.sep) || path.sep;
    return path.join(pluginRoot, "dist", "hooks", "approval-hook.js");
}
function resolveHookFailure(here) {
    return new RuntimeError("SETUP_RESOLVE_HOOK_FAILED", `Could not infer plugin root from setup module path ${here}. Set KIMI_PLUGIN_CC_HOOK_SCRIPT to the absolute path of dist/hooks/approval-hook.js.`, "setup.resolve-hook", { details: { here } });
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
    const nodeBin = resolveNodeBinary(env);
    // Quote both arguments the same way the managed block would — the
    // managed block writes `"<nodeBin> <hookScript>"` into a TOML basic
    // string. We reproduce that via `/bin/sh -c`.
    const shellCommand = `${shellSingleQuote(nodeBin)} ${shellSingleQuote(hookScriptPath)}`;
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
function shellSingleQuote(value) {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
function truncate(value, max) {
    if (value.length <= max)
        return value;
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
    ].join("\n");
}
