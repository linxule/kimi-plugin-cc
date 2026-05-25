import { RuntimeError } from "./errors.js";

/**
 * Resolve the kimi binary command + prefix args for cli-client calls.
 *
 * v1.0 uses `kimi -p --output-format stream-json` rather than v0.4's
 * `kimi --wire ...`. The env-var contract is preserved so tests and
 * users with non-default Node setups keep working:
 *
 *   - KIMI_PLUGIN_CC_KIMI_BIN
 *       Override the binary path. Defaults to "kimi" (resolved via PATH).
 *       Tests typically set this to the Node binary so they can spawn
 *       `node --import tsx mock-kimi-stream.ts`.
 *
 *   - KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS
 *       JSON array of extra argv prepended before `--output-format`.
 *       Used by tests to inject `["--import","tsx","/path/to/mock.ts"]`
 *       so the spawn line becomes
 *         node --import tsx /path/to/mock.ts --output-format stream-json -p "..."
 *       (Plain-text fallback: space-split if JSON parsing fails. Same
 *       contract as v0.4's `resolveKimiWireCommand`.)
 *
 * Distinct from `resolveKimiWireCommand` because:
 *
 *   - The v0.4 helper lives in kimi-launch.ts which PR 4 deletes.
 *   - The v1.0 prefix-args contract is identical but the call site is
 *     different (cli-client takes `command` + `prefixArgs` explicitly).
 *   - Keeping a tiny dedicated module makes the PR 4 deletion of
 *     kimi-launch.ts mechanical with no cli-client-side knock-on edits.
 */
export interface ResolvedKimiCommand {
  command: string;
  prefixArgs: string[];
}

export function resolveKimiCliCommand(env: NodeJS.ProcessEnv): ResolvedKimiCommand {
  const command = env.KIMI_PLUGIN_CC_KIMI_BIN || "kimi";
  const raw = env.KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS;
  if (!raw) {
    return { command, prefixArgs: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Plain-text fallback. Mirrors v0.4's permissive shape so users with
    // an existing `KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS="--import tsx ..."`
    // export don't have to migrate to JSON for v1.0.
    return { command, prefixArgs: raw.split(" ").filter(Boolean) };
  }

  if (!Array.isArray(parsed)) {
    throw new RuntimeError(
      "INVALID_ENV",
      "KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS must be a JSON array of strings.",
      "kimi-command.env",
      { details: { env_var: "KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS", value: raw } },
    );
  }
  for (const entry of parsed) {
    if (typeof entry !== "string") {
      throw new RuntimeError(
        "INVALID_ENV",
        "KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS entries must be strings.",
        "kimi-command.env",
        { details: { env_var: "KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS", value: raw } },
      );
    }
  }
  return { command, prefixArgs: parsed as string[] };
}
