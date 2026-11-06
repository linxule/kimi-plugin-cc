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
      // 1.10.1: every plugin refusal states its setup-retryability explicitly.
      expect(re.details.retryable_after_setup).toBe(false);
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

  // Codex review P1.1: a reserved kimi flag in the prefix (JSON or plain-text
  // form, bare or `=`-joined) would smuggle a session/engine/plan change past
  // the plugin's own argv — e.g. `-r <session>` resumes a session the v2
  // preflight never scanned for plan taint. Refuse at resolution.
  test.each([
    JSON.stringify(["-r", "session_x"]),
    JSON.stringify(["--resume", "session_x"]),
    JSON.stringify(["--session=session_x"]),
    JSON.stringify(["--continue"]),
    JSON.stringify(["--plan"]),
    JSON.stringify(["-m", "some-model"]),
    "-r session_x",
    // Codex second-round F2: the HIDDEN `-C` alias of --continue resumes the
    // latest session for the cwd with no plugin-chosen id → no journal scan.
    JSON.stringify(["-C"]),
    "-C",
    JSON.stringify(["-y"]),
    JSON.stringify(["--yes"]),
    JSON.stringify(["--auto-approve"]),
    JSON.stringify(["--manual"]),
    JSON.stringify(["--environment", "ssh-target"]),
    JSON.stringify(["--environment-cwd=/remote/work"]),
    JSON.stringify(["-V"]),
  ])("rejects a reserved kimi flag in the prefix: %s", (raw) => {
    let threw: unknown;
    try {
      resolveKimiCliCommand({ KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS: raw });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(RuntimeError);
    expect((threw as RuntimeError).code).toBe("INVALID_ENV");
    expect((threw as RuntimeError).details.reserved_flag).toBeDefined();
    expect((threw as RuntimeError).details.retryable_after_setup).toBe(false);
  });
});
