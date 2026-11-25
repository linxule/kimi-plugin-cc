import { describe, expect, test } from "bun:test";

import { validateKimiHookSet } from "../../runtime/hooks/config-safety.js";
import { tomlErrorLocation } from "../../runtime/util.js";
import { parse as parseToml } from "../../runtime/vendor/smol-toml/parse.js";

const SECRET = "sk-FAKE-NOT-A-REAL-KEY-12345";
const BROKEN = `[providers.demo]\napi_key = "${SECRET}"\nbase_url = oops not quoted\n`;

describe("TOML parse failures never quote config lines", () => {
  test("the parser's own message does quote them, which is why it is not forwarded", () => {
    let message = "";
    try {
      parseToml(BROKEN);
    } catch (error) {
      message = (error as Error).message;
      expect(tomlErrorLocation(error)).toBe("syntax error at line 3, column 12");
    }
    expect(message).toContain(SECRET);
  });

  test("hook-set validation reports only the location", () => {
    const result = validateKimiHookSet(BROKEN);
    expect(result.valid).toBe(false);
    expect(result.line).toBe(3);
    expect(result.reason).toContain("TOML parse failed: syntax error at line 3, column 12.");
    expect(result.reason).not.toContain(SECRET);
    expect(result.reason).not.toContain("api_key");
  });

  test("a non-parser error has no location to report", () => {
    expect(tomlErrorLocation(new Error(`boom ${SECRET}`))).toBe("syntax error");
    expect(tomlErrorLocation(undefined)).toBe("syntax error");
  });
});
