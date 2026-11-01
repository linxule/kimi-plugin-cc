import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeError } from "./errors.js";
// Use the loaded module, not the shared PLUGIN_ROOT/CLAUDE_PLUGIN_ROOT variables.
// Both source and compiled modules live one directory below the package root.
const loadedPackageRoot = fileURLToPath(new URL("../", import.meta.url));
/** Resolve state without silently trusting a different plugin's shared env. */
export function resolvePluginDataRoot(env, packageRoot = loadedPackageRoot) {
    const explicit = env.KIMI_PLUGIN_CC_DATA;
    if (explicit !== undefined) {
        if (!path.isAbsolute(explicit)) {
            throw new RuntimeError("INVALID_PLUGIN_DATA", "KIMI_PLUGIN_CC_DATA must be an absolute directory path, not an empty or relative value.", "paths");
        }
        return path.normalize(explicit);
    }
    const expected = installedDataRoot(packageRoot);
    const shared = [env.CLAUDE_PLUGIN_DATA, env.PLUGIN_DATA].filter((value) => Boolean(value));
    if (expected) {
        if (shared.some((value) => !path.isAbsolute(value) || !sameDataRoot(value, expected))) {
            throw new RuntimeError("PLUGIN_DATA_CONFLICT", "Shared plugin data variables do not match this installation. Remove the conflicting variables or set KIMI_PLUGIN_CC_DATA to the intended Kimi data directory. No data was moved.", "paths", { details: { expected_data_root: expected, override_variable: "KIMI_PLUGIN_CC_DATA" } });
        }
        return expected;
    }
    // Checkout/custom launch compatibility: we cannot infer ownership from an
    // arbitrary directory or from a marker that may not exist on first setup.
    // Preserve the old location when unambiguous; require an explicit choice otherwise.
    if (shared.length === 2 && !sameDataRoot(shared[0], shared[1])) {
        throw new RuntimeError("PLUGIN_DATA_CONFLICT", "CLAUDE_PLUGIN_DATA and PLUGIN_DATA disagree. Set KIMI_PLUGIN_CC_DATA to the intended Kimi data directory before retrying. No data was moved.", "paths");
    }
    if (shared[0])
        return shared[0];
    if (env.KIMI_PLUGIN_CC_SHELL_LAUNCH === "1" && (env.CODEX_HOME || env.HOME)) {
        const dataRoot = env.CODEX_HOME
            ? path.join(env.CODEX_HOME, "plugins", "data")
            : path.join(env.HOME, ".codex", "plugins", "data");
        return path.join(dataRoot, "kimi-marketplace-kimi");
    }
    throw new RuntimeError("MISSING_PLUGIN_DATA", "Set KIMI_PLUGIN_CC_DATA to an absolute writable data directory. Custom launches may also use an unambiguous CLAUDE_PLUGIN_DATA or PLUGIN_DATA value.", "paths");
}
function installedDataRoot(packageRoot) {
    const root = path.resolve(packageRoot);
    const pluginDir = path.dirname(root);
    const marketplaceDir = path.dirname(pluginDir);
    const cacheDir = path.dirname(marketplaceDir);
    const pluginsDir = path.dirname(cacheDir);
    if (path.basename(pluginDir) !== "kimi" || path.basename(cacheDir) !== "cache" || path.basename(pluginsDir) !== "plugins") {
        return undefined;
    }
    const marketplace = path.basename(marketplaceDir);
    if (existsSync(path.join(root, ".codex-plugin", "plugin.json"))) {
        return path.join(pluginsDir, "data", `${marketplace}-kimi`);
    }
    if (existsSync(path.join(root, ".claude-plugin", "plugin.json"))) {
        // Claude documents plugin-id sanitization for persistent data directories.
        const id = `kimi@${marketplace}`.replace(/[^a-zA-Z0-9_-]/g, "-");
        return path.join(pluginsDir, "data", id);
    }
    return undefined;
}
function sameDataRoot(left, right) {
    if (path.resolve(left) === path.resolve(right))
        return true;
    const canonicalLeft = canonicalDataRoot(left);
    return canonicalLeft !== undefined && canonicalLeft === canonicalDataRoot(right);
}
/** Resolve existing ancestors without creating a first-run data directory. */
function canonicalDataRoot(value) {
    let cursor = path.resolve(value);
    const missing = [];
    for (;;) {
        try {
            const resolved = realpathSync(cursor);
            if (missing.length > 0 && !statSync(cursor).isDirectory())
                return undefined;
            return path.join(resolved, ...missing);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                return undefined;
            // ENOENT can also mean a dangling symlink. Do not treat an existing
            // link as a missing directory and accidentally bypass its destination.
            try {
                lstatSync(cursor);
                return undefined;
            }
            catch (statError) {
                if (statError.code !== "ENOENT")
                    return undefined;
            }
            const parent = path.dirname(cursor);
            if (parent === cursor)
                return undefined;
            missing.unshift(path.basename(cursor));
            cursor = parent;
        }
    }
}
