import { accessSync, constants as fsConstants, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { RuntimeError } from "./errors.js";
import { resolveKimiBinDir } from "./paths.js";

/**
 * Resolve the kimi binary command + prefix args for cli-client calls.
 * Binary order: KIMI_PLUGIN_CC_KIMI_BIN, then the plugin-owned
 * `<data root>/kimi-plugin-cc/kimi-bin/current` installed by `setup --install-kimi`, then
 * "kimi" on PATH. The engine's exact-version probe gates whichever is chosen.
 * Environment overrides support tests and non-default Node setups:
 *
 *   - KIMI_PLUGIN_CC_KIMI_BIN
 *       Override the binary path; wins over the plugin-owned install.
 *       Tests typically set this to the Node binary so they can spawn
 *       `node --import tsx mock-kimi-stream.ts`.
 *
 *   - KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS
 *       JSON array of extra argv prepended before `--output-format`.
 *       Used by tests to inject `["--import","tsx","/path/to/mock.ts"]`
 *       so the spawn line becomes
 *         node --import tsx /path/to/mock.ts --output-format stream-json -p "..."
 *       Plain-text values are space-split if JSON parsing fails.
 */
export interface ResolvedKimiCommand {
  command: string;
  prefixArgs: string[];
}

export type KimiBinarySource = "override" | "plugin-owned" | "path";

export interface PluginOwnedKimiState {
  /** `<data root>/kimi-plugin-cc/kimi-bin`, or null when the data root cannot be resolved. */
  binDir: string | null;
  status: "active" | "absent" | "rejected" | "unavailable";
  /** Realpath of the plugin-owned binary when active. */
  target?: string;
  /** Exact version directory the active target lives under. */
  version?: string;
  /** Why the plugin-owned install is not usable (rejected/unavailable). */
  reason?: string;
}

export interface KimiBinarySelection {
  command: string;
  source: KimiBinarySource;
  pluginOwned: PluginOwnedKimiState;
}

const EXACT_VERSION_DIR_RE = /^\d+\.\d+\.\d+$/;

/** Which binary jobs will use and why; setup reports this. */
export function selectKimiBinary(env: NodeJS.ProcessEnv): KimiBinarySelection {
  const pluginOwned = inspectPluginOwnedKimi(env);
  if (env.KIMI_PLUGIN_CC_KIMI_BIN) {
    return { command: env.KIMI_PLUGIN_CC_KIMI_BIN, source: "override", pluginOwned };
  }
  if (pluginOwned.status === "active") {
    return { command: pluginOwned.target!, source: "plugin-owned", pluginOwned };
  }
  return { command: "kimi", source: "path", pluginOwned };
}

/**
 * The plugin-owned binary is used only when `current` resolves to an
 * executable regular file inside `<data root>/kimi-plugin-cc/kimi-bin/<x.y.z>/`. The resolved
 * realpath is returned so the checked file is the one the plan records.
 * Anything else falls back to PATH, as before this install existed.
 */
export function inspectPluginOwnedKimi(env: NodeJS.ProcessEnv): PluginOwnedKimiState {
  let binDir: string;
  try {
    binDir = resolveKimiBinDir(env);
  } catch {
    return { binDir: null, status: "unavailable", reason: "plugin data root is not resolved" };
  }
  if (process.platform === "win32") {
    return { binDir, status: "unavailable", reason: "plugin-owned kimi-code is not supported on Windows" };
  }
  const currentPath = path.join(binDir, "current");
  try {
    lstatSync(currentPath);
  } catch {
    return { binDir, status: "absent" };
  }
  let realBinDir: string;
  let target: string;
  try {
    realBinDir = realpathSync(binDir);
    target = realpathSync(currentPath);
  } catch {
    return { binDir, status: "rejected", reason: `${currentPath} does not resolve to an existing file` };
  }
  const relative = path.relative(realBinDir, target);
  const versionDir = relative.split(path.sep)[0] ?? "";
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    !EXACT_VERSION_DIR_RE.test(versionDir) ||
    relative === versionDir
  ) {
    return {
      binDir,
      status: "rejected",
      reason: `${currentPath} resolves to ${target}, outside ${path.join(realBinDir, "<version>")}${path.sep}`,
    };
  }
  try {
    if (!statSync(target).isFile()) {
      return { binDir, status: "rejected", reason: `${target} is not a regular file` };
    }
    accessSync(target, fsConstants.X_OK);
  } catch {
    return { binDir, status: "rejected", reason: `${target} is not executable` };
  }
  return { binDir, status: "active", target, version: versionDir };
}

export function resolveKimiCliCommand(env: NodeJS.ProcessEnv): ResolvedKimiCommand {
  const command = env.KIMI_PLUGIN_CC_KIMI_BIN || selectKimiBinary(env).command;
  const raw = env.KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS;
  if (!raw) {
    return { command, prefixArgs: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Plain-text values are space-split for launcher-style overrides.
    const plainArgs = raw.split(" ").filter(Boolean);
    assertPrefixArgsSafe(plainArgs, raw);
    return { command, prefixArgs: plainArgs };
  }

  if (!Array.isArray(parsed)) {
    throw new RuntimeError(
      "INVALID_ENV",
      "KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS must be a JSON array of strings.",
      "kimi-command.env",
      { details: { env_var: "KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS", value: raw, retryable_after_setup: false } },
    );
  }
  for (const entry of parsed) {
    if (typeof entry !== "string") {
      throw new RuntimeError(
        "INVALID_ENV",
        "KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS entries must be strings.",
        "kimi-command.env",
        { details: { env_var: "KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS", value: raw, retryable_after_setup: false } },
      );
    }
  }
  const prefixArgs = parsed as string[];
  assertPrefixArgsSafe(prefixArgs, raw);
  return { command, prefixArgs };
}

/**
 * Flags the plugin owns on the `kimi -p` argv. The prefix is only a launcher
 * shim (e.g. `["run", "<companion-dist>"]`); it must never carry a kimi flag
 * that changes the session, engine, plan, prompt, or output format. In
 * particular a smuggled `-r <session>` would resume a session the plugin never
 * scanned for plan-mode taint (the journal scan keys only on the plugin-chosen
 * resumeSessionId), so it is refused here — the single resolution point reached
 * by both foreground and detached-worker spawns.
 */
const RESERVED_PREFIX_FLAGS = new Set([
  // Session selection — incl. the HIDDEN `-C` alias of `--continue`
  // (apps/kimi-code/src/cli/commands.ts), which resumes the latest session for
  // the cwd without any plugin-chosen resumeSessionId, so no journal scan runs.
  "-r", "--resume", "-S", "--session", "-c", "-C", "--continue",
  // Prompt / output.
  "-p", "--prompt", "--output-format",
  // Permission / plan mode.
  "--plan", "--auto", "-y", "--yolo", "--yes", "--auto-approve", "--manual",
  // Model / profile / roots.
  "-m", "--model", "--skills-dir", "--agent", "--agent-file", "--add-dir",
  "--environment", "--environment-cwd",
  // Terminal informational flags (would replace the run with a banner).
  "-V", "--version", "-h", "--help",
]);

export function assertPrefixArgsSafe(prefixArgs: readonly string[], raw?: string): void {
  for (const token of prefixArgs) {
    // Compare the flag name only, so `--session=x` is caught as well as `-S x`.
    const flag = token.startsWith("-") ? token.split("=", 1)[0] : token;
    if (RESERVED_PREFIX_FLAGS.has(flag)) {
      throw new RuntimeError(
        "INVALID_ENV",
        `KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS must not contain the reserved kimi flag "${flag}". ` +
          "The prefix is a launcher shim only; session, engine, plan, prompt, model, and " +
          "output-format flags are owned by the plugin and would bypass its safety checks.",
        "kimi-command.env",
        {
          details: {
            env_var: "KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS",
            reserved_flag: flag,
            value: raw,
            retryable_after_setup: false,
          },
        },
      );
    }
  }
}
