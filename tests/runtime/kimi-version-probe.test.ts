import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  formatVersionOutOfRangeWarning,
  KIMI_MINIMUM_CERTIFIED_VERSION,
  parseVersionLine,
  probeKimiVersion,
} from "../../runtime/kimi-version-probe.js";

describe("parseVersionLine", () => {
  test("parses a bare 2.8.0", () => {
    expect(parseVersionLine("2.8.0\n")).toEqual({
      raw: "2.8.0",
      major: 2,
      minor: 8,
      patch: 0,
    });
  });

  test("strips leading v prefix", () => {
    expect(parseVersionLine("v2.8.0\n")?.raw).toBe("2.8.0");
  });

  test("preserves pre-release suffix in raw but takes only the leading numerics", () => {
    expect(parseVersionLine("2.9.0-beta.1\n")).toEqual({
      raw: "2.9.0-beta.1",
      major: 2,
      minor: 9,
      patch: 0,
    });
  });

  test("tolerates trailing whitespace", () => {
    expect(parseVersionLine("2.8.0   \n   ")?.raw).toBe("2.8.0");
  });

  test("uses only the first non-empty line", () => {
    expect(parseVersionLine("\n\n2.8.1\n(node v22)\n")?.raw).toBe("2.8.1");
  });

  test("returns undefined for garbage", () => {
    expect(parseVersionLine("not a version\n")).toBeUndefined();
    expect(parseVersionLine("")).toBeUndefined();
    expect(parseVersionLine("2.8\n")).toBeUndefined();
  });
});

describe("KIMI_MINIMUM_CERTIFIED_VERSION", () => {
  test("pins the >= 2.8.0 rolling compatibility floor", () => {
    expect(KIMI_MINIMUM_CERTIFIED_VERSION).toBe("2.8.0");
  });
});

describe("formatVersionOutOfRangeWarning", () => {
  test("flags a version below the 2.8.0 floor as legacy/unsupported", () => {
    const text = formatVersionOutOfRangeWarning(
      {
        kind: "ok",
        version: "2.7.3",
        major: 2,
        minor: 7,
        patch: 3,
      },
      "3.1.0-test",
      ["2.8.0"],
    );
    expect(text).toContain("2.7.3");
    expect(text).toContain("3.1.0-test");
    expect(text).toContain("OLDER than the supported floor (2.8.0)");
    expect(text).toContain("model-spawning operations will refuse");
    expect(text).toContain("setup --install-kimi");
    expect(text).toContain("not a production compatibility override");
    expect(text).not.toContain("NEWER than the newest certified version");
  });

  test("an uncertified 2.x strictly above 2.8.0 says read-only operations run and names setup --install-kimi", () => {
    const text = formatVersionOutOfRangeWarning(
      { kind: "ok", version: "2.99.0", major: 2, minor: 99, patch: 0 },
      "3.1.0-test",
      ["2.8.0"],
    );
    expect(text).toContain("NEWER than the newest certified version (2.8.0)");
    expect(text).toContain("Read-only operations (ask, review, challenge) run on it with a warning");
    expect(text).toContain("rescue, pursue and swarm refuse");
    expect(text).toContain("setup --install-kimi");
    expect(text).not.toContain("model-spawning operations will refuse");
  });

  test("a pre-2.8 version refuses every model-spawning operation", () => {
    const text = formatVersionOutOfRangeWarning(
      { kind: "ok", version: "0.39.0", major: 0, minor: 39, patch: 0 },
      "3.1.0-test",
      ["2.8.0"],
    );
    expect(text).toContain("OLDER than the supported floor (2.8.0)");
    expect(text).toContain("model-spawning operations will refuse");
    expect(text).toContain("setup --install-kimi");
  });

  test("a major-3 version outside the 2.x rolling window refuses every model-spawning operation", () => {
    const text = formatVersionOutOfRangeWarning(
      { kind: "ok", version: "3.0.0", major: 3, minor: 0, patch: 0 },
      "3.1.0-test",
      ["2.8.0"],
    );
    expect(text).toContain("NEWER than the newest certified version (2.8.0)");
    expect(text).toContain("model-spawning operations will refuse");
  });

  test("an uncertified gap between certified rows gets no NEWER note", () => {
    const probe = { kind: "ok" as const, version: "2.8.5", major: 2, minor: 8, patch: 5 };
    const text = formatVersionOutOfRangeWarning(probe, "9.9.9-test", ["2.8.0", "2.9.0"]);
    expect(text).not.toContain("NEWER than");
    expect(text).not.toContain("OLDER than");
    expect(text).toContain("Read-only operations (ask, review, challenge) run on it with a warning");
  });
});

describe("probeKimiVersion", () => {
  test("captures and parses a version emitted by a real subprocess", async () => {
    const result = await probeKimiVersion({
      kimiBin: "bun",
      env: process.env,
      timeoutMs: 5_000,
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(typeof result.major).toBe("number");
      expect(typeof result.minor).toBe("number");
      expect(typeof result.patch).toBe("number");
    }
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
