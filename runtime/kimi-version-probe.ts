// Probe the installed kimi-code CLI version and check it against the
// range kimi-plugin-cc has been tested against.
//
// Setup probes the installed command and warns outside the tested range;
// model jobs probe the exact command + prefix tuple to build a fail-closed
// execution plan before spawn. The latter is the durable engine-provenance
// gate: an operation outside its certified engine/version range is refused
// rather than guessed.
//
// What this module is NOT:
//
//   - Not, by itself, the policy decision. setup still warns; the execution-
//     plan layer (`kimi-engine.ts`) decides whether an exact result is certified.
//   - Not a license to infer historical versions. Old job rows remain unknown
//     unless their saved logs contain positive evidence.

import { spawn } from "node:child_process";

const KIMI_VERSION_PROBE_TIMEOUT_MS = 5_000;

/**
 * Legacy-v1 kimi-code minors tested for plugin use. Membership is by
 * `{major, minor}`; every patch within a listed minor is accepted.
 *
 * This table intentionally never gains 0.42, which removed legacy v1.
 * Exact per-operation native-v2 certification lives in `kimi-engine.ts`.
 */
export const KIMI_TESTED_MINORS: ReadonlyArray<{ major: number; minor: number }> = [
  { major: 0, minor: 1 },
  { major: 0, minor: 2 },
  { major: 0, minor: 3 },
  { major: 0, minor: 4 },
  { major: 0, minor: 5 },
  { major: 0, minor: 6 },
  { major: 0, minor: 7 },
  { major: 0, minor: 8 },
  { major: 0, minor: 9 },
  { major: 0, minor: 10 },
  { major: 0, minor: 11 },
  { major: 0, minor: 12 },
  { major: 0, minor: 13 },
  { major: 0, minor: 14 },
  { major: 0, minor: 15 },
  { major: 0, minor: 16 },
  { major: 0, minor: 17 },
  { major: 0, minor: 18 },
  { major: 0, minor: 19 },
  { major: 0, minor: 20 },
  { major: 0, minor: 21 },
  { major: 0, minor: 22 },
  { major: 0, minor: 23 },
  { major: 0, minor: 24 },
  { major: 0, minor: 25 },
  { major: 0, minor: 26 },
  { major: 0, minor: 27 },
  { major: 0, minor: 28 },
  { major: 0, minor: 29 },
  { major: 0, minor: 30 },
  { major: 0, minor: 31 },
  { major: 0, minor: 32 },
  { major: 0, minor: 33 },
  { major: 0, minor: 34 },
  { major: 0, minor: 35 },
  { major: 0, minor: 36 },
  { major: 0, minor: 37 },
  { major: 0, minor: 38 },
  { major: 0, minor: 39 },
  { major: 0, minor: 40 },
  { major: 0, minor: 41 },
];

export interface KimiVersionProbeOk {
  readonly kind: "ok";
  /** Verbatim version string from `kimi --version` (e.g. `"0.2.0"`). */
  readonly version: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** True when {major, minor} appears in KIMI_TESTED_MINORS. */
  readonly inTestedRange: boolean;
}

export interface KimiVersionProbeFailed {
  readonly kind: "failed";
  /** Why the probe didn't return a usable version. */
  readonly reason: string;
}

export type KimiVersionProbeResult = KimiVersionProbeOk | KimiVersionProbeFailed;

/**
 * Spawn `<kimi-bin> --version` and parse the output. Never throws;
 * failures resolve to `{kind: "failed", reason}` so callers can decide
 * the policy. The kimi binary path defaults to bare `kimi` (PATH
 * lookup); callers that need an explicit absolute path should pass it.
 */
export async function probeKimiVersion(options: {
  kimiBin?: string;
  /** Prefix argv that identifies the same wrapped CLI used for the real spawn. */
  prefixArgs?: readonly string[];
  /** Working directory used by the real spawn; relevant for relative wrappers. */
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<KimiVersionProbeResult> {
  const bin = options.kimiBin ?? "kimi";
  const args = [...(options.prefixArgs ?? []), "--version"];
  const timeoutMs = options.timeoutMs ?? KIMI_VERSION_PROBE_TIMEOUT_MS;
  return await new Promise<KimiVersionProbeResult>((resolve) => {
    let settled = false;
    const settle = (result: KimiVersionProbeResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      settle({
        kind: "failed",
        reason: `spawn failed: ${(err as Error).message}`,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
      }
      settle({
        kind: "failed",
        reason: `\`${[bin, ...args].join(" ")}\` timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      settle({
        kind: "failed",
        reason: `spawn error: ${err.message}`,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.trim() !== "" ? stderr.trim() : `exit ${code}`;
        settle({
          kind: "failed",
          reason: `\`${[bin, ...args].join(" ")}\` failed: ${detail}`,
        });
        return;
      }
      const parsed = parseVersionLine(stdout);
      if (parsed === undefined) {
        settle({
          kind: "failed",
          reason: `could not parse \`${[bin, ...args].join(" ")}\` output: ${JSON.stringify(stdout.slice(0, 80))}`,
        });
        return;
      }
      settle({
        kind: "ok",
        version: parsed.raw,
        major: parsed.major,
        minor: parsed.minor,
        patch: parsed.patch,
        inTestedRange: isInTestedRange(parsed.major, parsed.minor),
      });
    });
  });
}

/**
 * Parse a `kimi --version` stdout into a structured version. Accepts
 * bare semver (`0.2.0`), `v`-prefixed (`v0.2.0`), and trailing
 * pre-release / build metadata (`0.2.0-beta.1`, `0.2.0+sha.abc`). The
 * major/minor/patch numbers are the leading three components only —
 * pre-release / build metadata is preserved in `raw` but doesn't
 * affect the tested-range check.
 *
 * Returns undefined when the first nonempty line doesn't look like a version.
 */
export function parseVersionLine(stdout: string): {
  raw: string;
  major: number;
  minor: number;
  patch: number;
} | undefined {
  const firstLine = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (firstLine === undefined) return undefined;
  const trimmed = firstLine.trim().replace(/^v/, "");
  const match = trimmed.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  if (match === null) return undefined;
  return {
    raw: trimmed,
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
    patch: Number.parseInt(match[3]!, 10),
  };
}

export function isInTestedRange(major: number, minor: number): boolean {
  return KIMI_TESTED_MINORS.some((entry) => entry.major === major && entry.minor === minor);
}

/**
 * The newest `{major, minor}` in the legacy-v1 tested set. Native-v2-certified
 * versions lie outside this table. Set membership already warns for anything
 * outside the legacy range; this upper bound lets the warning distinguish a
 * newer, unverified legacy release from a below/gap version.
 */
export function maxTestedMinor(): { major: number; minor: number } {
  return KIMI_TESTED_MINORS.reduce((max, entry) =>
    entry.major > max.major || (entry.major === max.major && entry.minor > max.minor)
      ? entry
      : max,
  );
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10));
  const pb = b.split(".").map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Format a user-facing warning line for an out-of-range version probe.
 * Setup itself may complete, but the execution-plan gate will refuse model
 * spawns until the operator selects a certified binary or updates the plugin.
 * `nativeV2Certified` is the exact native-v2 table; both engines are named so
 * the newest certified version is not misreported as the legacy-v1 bound.
 */
export function formatVersionOutOfRangeWarning(
  probe: KimiVersionProbeOk,
  pluginVersion: string,
  nativeV2Certified: readonly string[] = [],
): string {
  const tested = KIMI_TESTED_MINORS.map((entry) => `${entry.major}.${entry.minor}.x`).join(", ");
  const max = maxTestedMinor();
  const newestNative = [...nativeV2Certified].sort(compareVersions).at(-1);
  const probeRaw = `${probe.major}.${probe.minor}.${probe.patch}`;
  const aboveMax = newestNative !== undefined
    ? compareVersions(probeRaw, newestNative) > 0
    : probe.major > max.major || (probe.major === max.major && probe.minor > max.minor);
  const certified = nativeV2Certified.length > 0
    ? `legacy-v1 ${tested}; native-v2 exact ${nativeV2Certified.join(", ")}`
    : tested;
  const lines = [
    `WARNING: kimi-code version ${probe.version} is outside the versions kimi-plugin-cc ${pluginVersion} certifies (${certified}).`,
  ];
  if (aboveMax) {
    // Commonly out-of-band auto-upgrade drift past the last certification.
    lines.push(
      `  This is NEWER than the newest certified version (${newestNative ?? `${max.major}.${max.minor}.x`}) and is not yet certified for model execution.`,
    );
  }
  lines.push(
    `  Setup can complete, but model-spawning commands will refuse before Kimi starts rather than run an unreviewed engine/version route.`,
    `  Update kimi-plugin-cc to a release that certifies this version, or point KIMI_PLUGIN_CC_KIMI_BIN at a certified kimi-code binary and retry setup.`,
    `  KIMI_PLUGIN_CC_SKIP_VERSION_PROBE is a test/smoke seam, not a production compatibility override.`,
  );
  return lines.join("\n");
}
