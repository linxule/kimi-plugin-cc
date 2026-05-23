import { describe, expect, test } from "bun:test";

import { formatError, RuntimeError } from "../../runtime/errors.js";

describe("runtime error formatting", () => {
  test("formatError includes RuntimeError code and stage", () => {
    const error = new RuntimeError("INVALID_ARGS", "bad arguments", "args.parse", {
      details: { received: "--bad" },
    });

    expect(formatError(error)).toBe("[INVALID_ARGS] [args.parse] bad arguments");
    expect(error.details).toEqual({ received: "--bad" });
  });

  test("formatError preserves plain Error messages", () => {
    expect(formatError(new Error("plain failure"))).toBe("plain failure");
  });

  test("RuntimeError exposes empty details by default", () => {
    const error = new RuntimeError("INVALID_ARGS", "bad arguments", "args.parse");

    expect(error.details).toEqual({});
  });
});
