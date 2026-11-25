import { constants as fsConstants, existsSync } from "node:fs";
import { access, open, readFile } from "node:fs/promises";
import path from "node:path";
import { validateKimiHookSetForEnvironment } from "./config-safety.js";
import { countCleanEntriesInFile, effectiveHost, evaluateInstalled, findUnmanagedApprovalHookBlocks, parseManagedBlock, } from "./managed-block.js";
import { hostIdFromHookCommand, parseHookShellCommand, resolveHostId, tryBuildExpectedHookCommand, } from "./install-paths.js";
import { jobHostForHookScript } from "./job-host.js";
import { resolveKimiCodeConfigPath } from "../kimi-home.js";
export async function verifyHookInstalled(env, options = {}) {
    const configPath = resolveKimiCodeConfigPath(env);
    if (env.KIMI_PLUGIN_CC_SKIP_HOOK_CHECK === "1") {
        return { installed: true, configPath };
    }
    // Canonical expected shell command for the current env. If this
    // can't be resolved (KIMI_PLUGIN_CC_NODE_BIN not absolute,
    // install-paths module can't infer plugin root, etc.) treat the hook
    // as un-verifiable — installed=false with a structured reason. The
    // caller's stderr warning surfaces the underlying error code.
    const expected = tryBuildExpectedHookCommand(env);
    if ("error" in expected) {
        return {
            installed: false,
            reason: `unable to resolve canonical hook command for this companion: ${expected.error.message}`,
            configPath,
        };
    }
    let raw;
    try {
        raw = await readFile(configPath, "utf8");
    }
    catch (err) {
        const code = err.code;
        if (code === "ENOENT") {
            return {
                installed: false,
                reason: "kimi-code config file does not exist",
                configPath,
            };
        }
        return {
            installed: false,
            reason: `failed to read kimi-code config: ${err.message}`,
            configPath,
        };
    }
    const hookSet = await validateKimiHookSetForEnvironment(raw, env, options.kimiVersion);
    if (!hookSet.valid) {
        return {
            installed: false,
            reason: hookSet.reason ?? "configured hooks failed whole-array validation",
            configPath,
            hookSetInvalid: true,
        };
    }
    // Classify command mismatches into actionable drift reasons without changing
    // the installed=false decision. hostId isolates this host's block in the
    // shared config.
    const hostId = resolveHostId(env, expected.hookScriptPath);
    const check = evaluateInstalled(raw, expected.command, {
        hostId,
        nodeExists: (binPath) => existsSync(binPath),
    });
    // Markers are bookkeeping, not the security boundary. At job time a
    // duplicate or orphan marker is tolerated when the real parser finds a clean,
    // unconditional PreToolUse entry with the byte-exact command (the whole hook
    // set already validated above), and the job records the setup remedy. setup
    // and setup --check use evaluateInstalled directly and keep failing.
    const warnings = [];
    if (!check.installed &&
        (check.state.kind === "duplicate" || check.state.kind === "orphan") &&
        countCleanEntriesInFile(raw, expected.command) >= 1) {
        warnings.push(`The managed kimi-code PreToolUse hook is installed and enforcing, but its config markers need repair: ${check.reason}`);
    }
    else if (!check.installed) {
        return {
            installed: false,
            reason: check.reason,
            configPath,
            // Forwarded verbatim. Present only for a parseable path/binary mismatch;
            // the earlier short-circuits above (unresolvable command, unreadable
            // config, invalid hook set) return before this point and therefore never
            // carry drift — those are not re-pin-recoverable.
            ...(check.drift !== undefined ? { drift: check.drift } : {}),
        };
    }
    // A byte-exact command does not prove the hook can run. Confirm the script
    // remains readable and fail closed on every access error.
    try {
        await access(expected.hookScriptPath, fsConstants.R_OK);
    }
    catch {
        return {
            installed: false,
            reason: `hook script ${expected.hookScriptPath} is missing or unreadable — run /kimi:setup to reinstall`,
            configPath,
        };
    }
    // Confirm the pinned interpreter with a NARROW X_OK backstop. Interpreter
    // moves that change the recomputed command are already refused as drift; this
    // check covers only unchanged command bytes whose Node token fails X_OK now:
    //
    //   1. An absolute KIMI_PLUGIN_CC_NODE_BIN override names a dead interpreter
    //      other than the running process, so launch never proved it executable.
    //   2. The interpreter is chmodded after launch. realpathSync still resolves
    //      it, the preferred path and command bytes stay unchanged, but X_OK fails.
    //   3. The pathname is removed after launch. realpathSync throws, and the
    //      execPath fallback can retain the same spelling, so equality still passes
    //      while the pinned path is gone.
    //
    // Refusing these cases matters because a failed hook spawn is ALLOW upstream.
    // This per-spawn check also catches degradation since setup's last execution
    // probe. It proves only the exec bit, not a working Node, architecture, or
    // version; setup's shell probe executes the byte-identical command instead.
    //
    // Fail closed on EVERY access error. Do not harmonize this with spawning code
    // that ignores selected errnos: a security verifier cannot "try and see".
    //
    // This refusal carries no drift and therefore no retryable_after_setup field:
    // setup cannot repair a broken Node installation.
    try {
        await access(expected.nodeBin, fsConstants.X_OK);
    }
    catch {
        return {
            installed: false,
            reason: `hook interpreter ${expected.nodeBin} is missing or not executable, so the PreToolUse hook ` +
                `cannot spawn (kimi-code reads a failed hook as ALLOW). Repair the Node install, or set ` +
                `KIMI_PLUGIN_CC_NODE_BIN to a valid Node >=22.5 executable and run /kimi:setup.`,
            configPath,
            refusalKind: "node-bin-not-executable",
            nodeBin: expected.nodeBin,
        };
    }
    // Transition notice (channel W): other hosts' older hooks still veto.
    warnings.push(...await olderHostHookWarnings(raw, hostId, expected.command));
    return warnings.length > 0 ? { installed: true, configPath, warnings } : { installed: true, configPath };
}
/**
 * First plugin version whose hook abstains for jobs another host launched
 * (KIMI_PLUGIN_CC_JOB_HOST). Older hooks still apply their own rules to every
 * plugin job, and any deny wins.
 */
export const FIRST_ABSTAINING_HOOK_VERSION = "3.0.0";
const MANIFEST_WALK_LEVELS = 4;
const MANIFEST_MAX_BYTES = 64 * 1024;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/**
 * One launch warning per other host's hook that predates abstaining (or whose
 * version cannot be read). Covers other hosts' managed blocks and their
 * marker-less tables left by a config rewrite. Reads manifests only; never
 * executes anything and never refuses.
 */
export async function olderHostHookWarnings(contents, ownHostId, ownCommand) {
    const ownScript = parseHookShellCommand(ownCommand)?.hookScript;
    const ownIds = new Set([ownHostId, ...(ownScript !== undefined ? [jobHostForHookScript(ownScript)] : [])]);
    const others = new Map();
    for (const block of parseManagedBlock(contents, ownHostId).blocks) {
        const host = effectiveHost(block, ownHostId);
        if (ownIds.has(host) || block.commandPath.length === 0 || block.commandPath === ownCommand)
            continue;
        if (!others.has(block.commandPath))
            others.set(block.commandPath, host);
    }
    for (const table of findUnmanagedApprovalHookBlocks(contents)) {
        const host = hostIdFromHookCommand(table.command);
        if (host === null || ownIds.has(host) || table.command === ownCommand)
            continue;
        if (!others.has(table.command))
            others.set(table.command, host);
    }
    const warnings = [];
    for (const [command, host] of others) {
        const version = await hookPluginVersion(command);
        if (version !== undefined && !predatesAbstainingHook(version))
            continue;
        warnings.push(`The ${host} host's kimi-plugin-cc hook (${version === undefined ? "an unknown version" : `version ${version}`}) ` +
            `also checks this job with its older rules; it can deny web access and rm, mv, cp and mkdir that this ` +
            `version allows. Update the plugin in ${host} and run its setup.`);
    }
    return warnings;
}
/**
 * The plugin version behind a canonical hook command: walk up a few levels
 * from the hook script to the nearest named `package.json` (it must be
 * `kimi-plugin-cc`) or a Codex install's `.codex-plugin/plugin.json` (name
 * `kimi`; that root has no package.json). Nameless `{"type":"module"}`
 * markers under dist/ are skipped. Undefined when nothing trustworthy is found.
 */
export async function hookPluginVersion(command) {
    const parsed = parseHookShellCommand(command);
    if (parsed === null || !path.isAbsolute(parsed.hookScript))
        return undefined;
    let dir = path.dirname(path.resolve(parsed.hookScript));
    for (let level = 0; level <= MANIFEST_WALK_LEVELS; level += 1) {
        const pkg = await readSmallJsonObject(path.join(dir, "package.json"));
        if (pkg !== undefined && typeof pkg.name === "string") {
            return pkg.name === "kimi-plugin-cc" ? semverOrUndefined(pkg.version) : undefined;
        }
        const codex = await readSmallJsonObject(path.join(dir, ".codex-plugin", "plugin.json"));
        if (codex !== undefined && typeof codex.name === "string") {
            return codex.name === "kimi" ? semverOrUndefined(codex.version) : undefined;
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return undefined;
}
/** True for a version below FIRST_ABSTAINING_HOOK_VERSION, its prereleases, or an unparseable one. */
export function predatesAbstainingHook(version) {
    const have = SEMVER_RE.exec(version);
    const want = SEMVER_RE.exec(FIRST_ABSTAINING_HOOK_VERSION);
    if (have === null)
        return true;
    for (let i = 1; i <= 3; i += 1) {
        const diff = Number(have[i]) - Number(want[i]);
        if (diff !== 0)
            return diff < 0;
    }
    return have[4] !== undefined;
}
function semverOrUndefined(value) {
    return typeof value === "string" && SEMVER_RE.test(value) ? value : undefined;
}
async function readSmallJsonObject(file) {
    let handle;
    try {
        handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MANIFEST_MAX_BYTES)
            return undefined;
        const value = JSON.parse(await handle.readFile("utf8"));
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? value
            : undefined;
    }
    catch {
        return undefined;
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
}
/**
 * Caller-facing repair protocol shared by every hook-refusal surface. Re-pin
 * through the resolved plugin root, retry ONCE only when
 * `retryable_after_setup` is literally true and setup exits zero, and never use
 * the skip-check environment variable as a repair.
 */
export function hookRefusalRetryProtocol(env) {
    const root = env.CLAUDE_PLUGIN_ROOT ?? env.PLUGIN_ROOT ?? "${CLAUDE_PLUGIN_ROOT}";
    return (`If details shows retryable_after_setup:true (routine after a plugin update — the ` +
        `version-stamped hook path moved), run \`${root}/scripts/companion.sh setup\` and, only ` +
        `if it exits 0, retry the refused command once. Anything else — or a second refusal — ` +
        `surface the refusal instead of retrying.`);
}
/**
 * Structured details for a hook-refusal RuntimeError. `retryable_after_setup`
 * is present only for drift and is literally true only when setup can re-pin
 * every differing token: hook-script drift, or node-bin/both drift whose Node
 * tokens name the same file. A different interpreter is not automatically
 * repairable. Callers must also require a zero setup exit before one retry.
 */
export function hookRefusalDetails(status) {
    return {
        config_path: status.configPath,
        // Routes the caller to "tell the human to repair Node" instead of the
        // default "run /kimi:setup and retry" reflex. Never co-occurs with `drift`:
        // drift requires the equality check to FAIL, this requires it to PASS.
        ...(status.refusalKind !== undefined
            ? { refusal_kind: status.refusalKind, node_bin: status.nodeBin }
            : {}),
        ...(status.drift !== undefined
            ? {
                drift_axis: status.drift.axis,
                drift_installed_command: status.drift.installedCommand,
                drift_expected_command: status.drift.expectedCommand,
                retryable_after_setup: status.drift.axis === "hook-script" || status.drift.nodeInterpreterUnchanged === true,
            }
            : {}),
    };
}
export function formatHookMissingWarning(status, commandLabel) {
    return [
        "",
        "WARNING: kimi-plugin-cc safety hook is NOT installed (or is invalid).",
        `  Command: ${commandLabel}`,
        `  Config:  ${status.configPath}`,
        `  Reason:  ${status.reason ?? "unknown"}`,
        "",
        "  Without a valid PreToolUse hook, kimi-code's `-p` mode auto-approves",
        "  every tool call — including Bash, Write, Edit — even from commands",
        "  documented as read-only.",
        "",
        "  This command will not start a Kimi model run until enforcement is",
        "  repaired (the review gate skips instead of blocking stop).",
        "",
        "  Fix: run Claude Code `/kimi:setup` or Codex `$kimi-setup` to install",
        "  or repair this host's managed block in",
        "  ~/.kimi-code/config.toml. If you use nvm, asdf, mise, or fnm, you",
        "  must re-run `/kimi:setup` after any Node version switch — the",
        "  verifier pins the absolute Node binary path and a switch invalidates",
        "  the previously-installed block by design. See docs/safety.md.",
        "",
        "  KIMI_PLUGIN_CC_SKIP_HOOK_CHECK=1 explicitly bypasses hook-verification",
        "  refusals and restores un-enforced `permission: auto` execution. It does",
        "  NOT bypass the experimental-v2 safety refusal. Reserve it for tests or",
        "  diagnostics where the hook risk is intentional.",
        "",
    ].join("\n");
}
/** Once-per-process latch for missing-hook warnings. */
let warnedThisProcess = false;
/**
 * Emit the warning to stderr at most once per process. Stderr is for humans;
 * stdout remains reserved for load-bearing command output.
 */
export function maybeWarnHookMissing(status, commandLabel, stderr = process.stderr) {
    if (status.installed)
        return;
    if (warnedThisProcess)
        return;
    warnedThisProcess = true;
    stderr.write(formatHookMissingWarning(status, commandLabel));
}
/** Test hook — resets the once-per-process latch. */
export function __resetHookMissingWarning() {
    warnedThisProcess = false;
}
