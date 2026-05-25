import { describe, expect, test } from "bun:test";

import { resolveKimiCliCommand } from "../../runtime/kimi-command.js";
import { RuntimeError } from "../../runtime/errors.js";

describe("resolveKimiCliCommand", () => {
  test("returns 'kimi' with no prefix args when env is empty", () => {
    expect(resolveKimiCliCommand({})).toEqual({ command: "kimi", prefixArgs: [] });
  });

  test("honors KIMI_PLUGIN_CC_KIMI_BIN", () => {
    const resolved = resolveKimiCliCommand({ KIMI_PLUGIN_CC_KIMI_BIN: "/usr/local/bin/kimi" });
    expect(resolved.command).toBe("/usr/local/bin/kimi");
    expect(resolved.prefixArgs).toEqual([]);
  });

  test("parses JSON array prefix args", () => {
    const resolved = resolveKimiCliCommand({
      KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["--import", "tsx", "/path/mock.ts"]),
    });
    expect(resolved.prefixArgs).toEqual(["--import", "tsx", "/path/mock.ts"]);
  });

  test("falls back to space-split when env is not JSON", () => {
    const resolved = resolveKimiCliCommand({
      KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: "--import tsx /path/mock.ts",
    });
    expect(resolved.prefixArgs).toEqual(["--import", "tsx", "/path/mock.ts"]);
  });

  test("space-split skips empty tokens", () => {
    const resolved = resolveKimiCliCommand({
      KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: "  --import   tsx  ",
    });
    expect(resolved.prefixArgs).toEqual(["--import", "tsx"]);
  });

  test("throws INVALID_ENV when JSON is not an array", () => {
    expect(() =>
      resolveKimiCliCommand({
        KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify({ foo: "bar" }),
      }),
    ).toThrow(RuntimeError);
  });

  test("throws INVALID_ENV when array contains non-strings", () => {
    expect(() =>
      resolveKimiCliCommand({
        KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["--import", 42]),
      }),
    ).toThrow(RuntimeError);
  });

  test("INVALID_ENV error carries env_var details", () => {
    try {
      resolveKimiCliCommand({
        KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify({ foo: "bar" }),
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeError);
      const re = err as RuntimeError;
      expect(re.code).toBe("INVALID_ENV");
      expect(re.details.env_var).toBe("KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS");
    }
  });

  test("combines bin and prefix args", () => {
    const resolved = resolveKimiCliCommand({
      KIMI_PLUGIN_CC_KIMI_BIN: "/usr/bin/node",
      KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: JSON.stringify(["--import", "tsx", "/m.ts"]),
    });
    expect(resolved).toEqual({
      command: "/usr/bin/node",
      prefixArgs: ["--import", "tsx", "/m.ts"],
    });
  });
});
