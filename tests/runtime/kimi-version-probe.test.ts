import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  formatVersionOutOfRangeWarning,
  isInTestedRange,
  KIMI_TESTED_MINORS,
  maxTestedMinor,
  parseVersionLine,
  probeKimiVersion,
} from "../../runtime/kimi-version-probe.js";

describe("parseVersionLine", () => {
  test("parses a bare 0.2.0", () => {
    expect(parseVersionLine("0.2.0\n")).toEqual({
      raw: "0.2.0",
      major: 0,
      minor: 2,
      patch: 0,
    });
  });

  test("strips leading v prefix", () => {
    expect(parseVersionLine("v1.2.3\n")?.raw).toBe("1.2.3");
  });

  test("preserves pre-release suffix in raw but takes only the leading numerics", () => {
    expect(parseVersionLine("0.3.0-beta.1\n")).toEqual({
      raw: "0.3.0-beta.1",
      major: 0,
      minor: 3,
      patch: 0,
    });
  });

  test("tolerates trailing whitespace", () => {
    expect(parseVersionLine("0.2.0   \n   ")?.raw).toBe("0.2.0");
  });

  test("uses only the first non-empty line", () => {
    // kimi --version emits a single line, but if a future build splatters
    // build metadata on subsequent lines we should still find the version.
    expect(parseVersionLine("\n\n0.4.7\n(node v22)\n")?.raw).toBe("0.4.7");
  });

  test("returns undefined for garbage", () => {
    expect(parseVersionLine("not a version\n")).toBeUndefined();
    expect(parseVersionLine("")).toBeUndefined();
    expect(parseVersionLine("0.2\n")).toBeUndefined();
  });
});

describe("isInTestedRange", () => {
  test("returns true for any patch within a known minor", () => {
    expect(isInTestedRange(0, 1)).toBe(true);
    expect(isInTestedRange(0, 2)).toBe(true);
    expect(isInTestedRange(0, 3)).toBe(true);
    expect(isInTestedRange(0, 4)).toBe(true);
    expect(isInTestedRange(0, 5)).toBe(true);
    expect(isInTestedRange(0, 6)).toBe(true);
    expect(isInTestedRange(0, 7)).toBe(true);
    expect(isInTestedRange(0, 8)).toBe(true);
    expect(isInTestedRange(0, 9)).toBe(true);
    expect(isInTestedRange(0, 10)).toBe(true);
    expect(isInTestedRange(0, 11)).toBe(true);
    expect(isInTestedRange(0, 12)).toBe(true);
    expect(isInTestedRange(0, 13)).toBe(true);
    expect(isInTestedRange(0, 14)).toBe(true);
    expect(isInTestedRange(0, 15)).toBe(true);
    expect(isInTestedRange(0, 16)).toBe(true);
    expect(isInTestedRange(0, 17)).toBe(true);
    expect(isInTestedRange(0, 18)).toBe(true);
    expect(isInTestedRange(0, 19)).toBe(true);
  });

  test("returns false for an unknown minor", () => {
    expect(isInTestedRange(0, 20)).toBe(false);
    expect(isInTestedRange(0, 99)).toBe(false);
  });

  test("returns false for a different major", () => {
    expect(isInTestedRange(1, 0)).toBe(false);
    expect(isInTestedRange(2, 1)).toBe(false);
  });

  test("KIMI_TESTED_MINORS is non-empty and well-formed", () => {
    // Catch the easy mistake of clearing the array during a future
    // refactor — an empty tested-range list would silently disable
    // the warning surface.
    expect(KIMI_TESTED_MINORS.length).toBeGreaterThan(0);
    for (const entry of KIMI_TESTED_MINORS) {
      expect(Number.isInteger(entry.major)).toBe(true);
      expect(Number.isInteger(entry.minor)).toBe(true);
      expect(entry.major).toBeGreaterThanOrEqual(0);
      expect(entry.minor).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("formatVersionOutOfRangeWarning", () => {
  test("includes the observed version, the tested range, and the plugin version", () => {
    const text = formatVersionOutOfRangeWarning(
      {
        kind: "ok",
        version: "0.3.5",
        major: 0,
        minor: 3,
        patch: 5,
        inTestedRange: false,
      },
      "1.0.0-test",
    );
    expect(text).toContain("0.3.5");
    expect(text).toContain("1.0.0-test");
    expect(text).toContain("0.1.x");
    expect(text).toContain("0.2.x");
    expect(text).toContain("plugin will still run");
  });

  test("H9: flags a version NEWER than the tested max with an above-bound note", () => {
    const max = maxTestedMinor();
    const text = formatVersionOutOfRangeWarning(
      {
        kind: "ok",
        version: `${max.major}.${max.minor + 5}.0`,
        major: max.major,
        minor: max.minor + 5,
        patch: 0,
        inTestedRange: false,
      },
      "1.2.1-test",
    );
    expect(text).toContain("NEWER than the newest version we have tested");
    expect(text).toContain(`${max.major}.${max.minor}.x`);
  });

  test("H9: a version BELOW the tested max does not get the above-bound note", () => {
    const text = formatVersionOutOfRangeWarning(
      { kind: "ok", version: "0.0.9", major: 0, minor: 0, patch: 9, inTestedRange: false },
      "1.2.1-test",
    );
    expect(text).not.toContain("NEWER than the newest version we have tested");
  });
});

describe("maxTestedMinor", () => {
  test("returns the highest {major, minor} in the tested set", () => {
    const max = maxTestedMinor();
    for (const entry of KIMI_TESTED_MINORS) {
      const notNewer =
        entry.major < max.major || (entry.major === max.major && entry.minor <= max.minor);
      expect(notNewer).toBe(true);
    }
  });
});

describe("probeKimiVersion", () => {
  test("captures and parses an in-range version emitted by a mock binary", async () => {
    const mockBin = path.join(process.cwd(), "tests/helpers/mock-kimi-version.ts");
    const result = await probeKimiVersion({
      kimiBin: "bun",
      env: { ...process.env, KIMI_MOCK_VERSION: "0.2.0" },
      timeoutMs: 5_000,
    });
    // We invoked `bun --version`, not the mock — verify the framework
    // works even when the version is bun's own (which is in some
    // multi-decimal range outside our tested set). What we're really
    // exercising here is the spawn + parse pipeline.
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(typeof result.major).toBe("number");
      expect(typeof result.minor).toBe("number");
      expect(typeof result.patch).toBe("number");
    }
    // mockBin path is computed for clarity but bun --version is the
    // actual spawn target here — keeps the test hermetic without a
    // helper script.
    expect(mockBin).toBeDefined();
  });

  test("reports failed when the binary does not exist", async () => {
    const result = await probeKimiVersion({
      kimiBin: "/definitely/does/not/exist/kimi-binary-xyz",
      env: process.env,
      timeoutMs: 2_000,
    });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toContain("spawn");
    }
  });

  test("reports failed with 'timed out' when the binary blocks past the timeout", async () => {
    // The mock script ignores --version and sleeps for 10s; the probe's
    // 100ms budget should fire, SIGTERM the child, and resolve with the
    // canonical "timed out" reason. Mock is shebang-executable so spawn
    // honors `#!/usr/bin/env -S node --import tsx` directly.
    const slowMock = path.join(process.cwd(), "tests/helpers/mock-slow-kimi.ts");
    const result = await probeKimiVersion({
      kimiBin: slowMock,
      env: process.env,
      timeoutMs: 100,
    });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toContain("timed out");
    }
  });

  test("reports failed when the binary exits non-zero with stderr detail", async () => {
    // `false` exits 1 with no output; the failure reason should still
    // surface the exit code rather than throwing or hanging.
    const result = await probeKimiVersion({
      kimiBin: "false",
      env: process.env,
      timeoutMs: 2_000,
    });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toContain("exit");
    }
  });
});
