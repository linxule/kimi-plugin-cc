// Probe the installed kimi-code CLI version and check it against the
// range kimi-plugin-cc has been tested against.
//
// Why this exists (H6, Codex post-hotfix audit Area 8):
//
//   kimi-code 0.2.0 introduced wire protocol 1.1 and a new "warn-and-
//   replay" code path for sessions from newer protocol versions. A
//   future 0.3.0 could replay an older session with an invisible warning
//   and produce flattened output that silently differs from what our
//   plugin captured originally — see PR #49 (cf2227e) and PR #22
//   (2004aed) in the 0.2.0 changeset. The alpha.5 hotfix exists because
//   *this exact failure mode already happened once* (kimi-code 0.2.0
//   moved the session resume hint from stderr to a stream-json meta
//   record, and our plugin captured nothing until we noticed).
//
//   The defensible posture: probe kimi-code's version at setup time,
//   compare against the range we've actively tested, and emit a stderr
//   warning when the user is outside it. We do NOT block — kimi-code is
//   the user's tool of choice, our plugin sits beside it — but we
//   loud-warn so a silent version drift can't sneak by.
//
//   This is belt-and-suspenders for the alpha.4 `warnIfSessionIdMissing`
//   surface: that warning fires when capture demonstrably fails on a
//   completed job; this one fires before any job runs, on the theory
//   that "you're running a kimi-code we haven't tested" is worth knowing
//   even if the first job happens to work.
//
// What this module is NOT:
//
//   - Not a hard gate. We never refuse to run on version mismatch.
//   - Not a substitute for upstream compatibility testing. The right
//     long-term answer is for kimi-code to advertise wire-protocol
//     compatibility via a stable feature flag or version field in its
//     stream-json output. Until upstream lands that, this is the best
//     signal we can give users.
//   - Not invoked on every spawn. Setup-time check is sufficient — a
//     per-spawn probe would slow every command for no real benefit.

import { spawn } from "node:child_process";

/** Maximum time to wait for `kimi --version` to print and exit. */
const KIMI_VERSION_PROBE_TIMEOUT_MS = 5_000;

/**
 * The range of kimi-code package versions kimi-plugin-cc has been
 * actively tested against. Bump these when a new kimi-code release is
 * verified to work end-to-end (production smoke + full test suite).
 *
 * Versions are matched as `<major>.<minor>` pairs — patch versions are
 * always accepted within a known minor. A version of `0.2.5` is
 * considered tested if `{0, 2}` is in this set.
 *
 * Why store as `{major, minor}` and not a semver range string: avoids a
 * semver parser dependency for a one-off comparison, and the range
 * shape is naturally tied to kimi-code's own release cadence (0.x
 * pre-1.0, minor bumps for behavioral change).
 */
export const KIMI_TESTED_MINORS: ReadonlyArray<{ major: number; minor: number }> = [
  { major: 0, minor: 1 },
  { major: 0, minor: 2 },
  // 0.3 and 0.4 added in v1.0.1 (2026-05-27) after the 4-reviewer audit
  // verified compat through @moonshot-ai/kimi-code@0.4.0. See
  // docs/upstream-compat-audit.md for the playbook and
  // .claude/kimi-code-research/reports/31-35-* for the audit reports.
  // Tag: compat-verified-kimi-code-0.4.0 on commit b67263c.
  { major: 0, minor: 3 },
  { major: 0, minor: 4 },
  // 0.5 added in v1.0.2 (2026-05-28) after a same-day 4-reviewer audit
  // verified compat through @moonshot-ai/kimi-code@0.5.0. The hook
  // engine moved path (agent/hooks/ → session/hooks/) but is
  // byte-identical; run-prompt.ts and rpc/events.ts are byte-identical;
  // the new --auto CLI flag is rejected when combined with -p. See
  // .claude/kimi-code-research/reports/36-40-* for the audit reports.
  // Tag: compat-verified-kimi-code-0.5.0.
  { major: 0, minor: 5 },
  // 0.6 added in v1.0.4 (2026-05-31) after a 4-reviewer audit verified
  // compat through @moonshot-ai/kimi-code@0.6.0, backed by a GREEN
  // real-binary smoke (`bun run smoke:real`) against the installed 0.6.0
  // binary — "tested" is earned end-to-end, not source-reading-only. The
  // hook engine (session/hooks/), policy queue order (policies/index.ts),
  // and CLI argv (options.ts/commands.ts) are byte-identical; the
  // stream-json resume-hint writer is byte-identical. The +17-line
  // run-prompt.ts change is a resume-session workDir guard that runs
  // before permission forcing and cannot fire for the plugin (we always
  // resume from the originating cwd). The permission/index.ts
  // `rpc?.requestApproval` refactor is dead code in -p mode (shadowed by
  // auto-mode-approve at index 4; the hook policy is index 0;
  // requestApproval is always present). See
  // .claude/kimi-code-research/reports/47-51-* for the
  // audit reports. Tag: compat-verified-kimi-code-0.6.0.
  { major: 0, minor: 6 },
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
 *
 * Output contract: kimi-code 0.1.x and 0.2.x both write a single line
 * like `0.2.0` (sometimes with leading "v") to stdout and exit 0. We
 * tolerate either form and any trailing whitespace.
 */
export async function probeKimiVersion(options: {
  kimiBin?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<KimiVersionProbeResult> {
  const bin = options.kimiBin ?? "kimi";
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
      child = spawn(bin, ["--version"], {
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
        // best effort
      }
      settle({ kind: "failed", reason: `\`${bin} --version\` timed out after ${timeoutMs}ms` });
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
          reason: `\`${bin} --version\` failed: ${detail}`,
        });
        return;
      }
      const parsed = parseVersionLine(stdout);
      if (parsed === undefined) {
        settle({
          kind: "failed",
          reason: `could not parse \`${bin} --version\` output: ${JSON.stringify(stdout.slice(0, 80))}`,
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
 * Returns undefined when the leading line doesn't look like a version.
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
 * Format a user-facing warning line for an out-of-range version probe.
 * Includes the canonical "not a block, just a heads up" framing so the
 * caller agent doesn't misinterpret this as fatal.
 */
export function formatVersionOutOfRangeWarning(probe: KimiVersionProbeOk, pluginVersion: string): string {
  const tested = KIMI_TESTED_MINORS.map((entry) => `${entry.major}.${entry.minor}.x`).join(", ");
  return [
    `WARNING: kimi-code version ${probe.version} is outside the range kimi-plugin-cc ${pluginVersion} was tested against (${tested}).`,
    `  The plugin will still run, but a silent breakage may exist for behaviors that changed in your version.`,
    `  If something looks off (missing session ids, malformed records, hook bypasses), check the kimi-code changelog`,
    `  for changes since the last tested range and report mismatches via the plugin issue tracker.`,
  ].join("\n");
}
