// Probe the installed kimi-code CLI version and check it against the
// >= 2.8.0 rolling compatibility window.

import { spawn } from "node:child_process";

import { KIMI_V2_RELEASES, resolveKimiRelease } from "./kimi-releases.js";

const KIMI_VERSION_PROBE_TIMEOUT_MS = 5_000;

export const KIMI_MINIMUM_CERTIFIED_VERSION = KIMI_V2_RELEASES[0]!.version;

export interface KimiVersionProbeOk {
  readonly kind: "ok";
  /** Verbatim version string from `kimi --version` (e.g. `"2.8.0"`). */
  readonly version: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface KimiVersionProbeFailed {
  readonly kind: "failed";
  /** Why the probe didn't return a usable version. */
  readonly reason: string;
}

export type KimiVersionProbeResult = KimiVersionProbeOk | KimiVersionProbeFailed;

/**
 * Spawn `<kimi-bin> --version` and parse the output. Never throws;
 * failures resolve to `{kind: "failed", reason}`.
 */
export async function probeKimiVersion(options: {
  kimiBin?: string;
  prefixArgs?: readonly string[];
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
      });
    });
  });
}

/**
 * Parse `kimi --version` stdout into a structured version. Accepts bare semver
 * (`2.8.0`), `v`-prefixed (`v2.8.0`), and trailing pre-release/build metadata.
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
 * Format a user-facing warning line when the installed kimi-code version is
 * outside the certified rolling window (>= 2.8.0).
 */
export function formatVersionOutOfRangeWarning(
  probe: KimiVersionProbeOk,
  pluginVersion: string,
  nativeV2Certified: readonly string[] = [],
  env: Readonly<NodeJS.ProcessEnv> = {},
): string {
  const newestNative = [...nativeV2Certified].sort(compareVersions).at(-1) ?? KIMI_MINIMUM_CERTIFIED_VERSION;
  const probeRaw = `${probe.major}.${probe.minor}.${probe.patch}`;
  const aboveMax = compareVersions(probeRaw, newestNative) > 0;
  const belowFloor = compareVersions(probeRaw, KIMI_MINIMUM_CERTIFIED_VERSION) < 0;
  const certified = nativeV2Certified.length > 0
    ? nativeV2Certified.join(", ")
    : KIMI_MINIMUM_CERTIFIED_VERSION;
  const strict = env.KIMI_PLUGIN_CC_STRICT_VERSIONS === "1";
  const resolution = resolveKimiRelease(probe.version, { strict });
  const lines = [
    `WARNING: kimi-code version ${probe.version} is outside the rolling compatibility window kimi-plugin-cc ${pluginVersion} certifies (${certified}).`,
  ];
  if (aboveMax) {
    lines.push(
      `  This is NEWER than the newest certified version (${newestNative}) and is not yet certified for write/swarm execution.`,
    );
  } else if (belowFloor) {
    lines.push(
      `  This is OLDER than the supported floor (${KIMI_MINIMUM_CERTIFIED_VERSION}); legacy kimi-code releases are no longer supported.`,
    );
  }
  lines.push(
    resolution?.certified === false
      ? `  Read-only operations (ask, review, challenge) run on it with a warning; rescue, pursue and swarm refuse until this version is certified.`
      : `  Setup can complete, but model-spawning operations will refuse before Kimi starts until a certified >= ${KIMI_MINIMUM_CERTIFIED_VERSION} binary is selected.`,
    `  Run kimi_setup({ action: "install_kimi" }) or \`companion.sh setup --install-kimi\` to install the newest certified kimi-code, or update kimi-plugin-cc.`,
    `  KIMI_PLUGIN_CC_SKIP_VERSION_PROBE is a test/smoke seam, not a production compatibility override.`,
  );
  return lines.join("\n");
}
