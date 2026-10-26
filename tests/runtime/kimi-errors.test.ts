import { describe, expect, test } from "bun:test";

import { RuntimeError } from "../../runtime/errors.js";
import { classifyManagedCommandFailure, classifySetupFailure, summarizeKimiAvailabilityWarning } from "../../runtime/kimi-errors.js";

describe("classifyManagedCommandFailure", () => {
  test("the added structured spawn message stays bounded", () => {
    const error = new RuntimeError("CLI_PROCESS_ERROR", "launch failed", "cli-client.spawn", {
      details: { spawn_code: "E2BIG", spawn_message: "x".repeat(20_000) + "tail" },
    });
    const result = classifyManagedCommandFailure(error, "review", "job") as RuntimeError;
    expect((result.details.spawn_message as string).length).toBeLessThanOrEqual(2001);
    expect(result.details.spawn_message).toEndWith("tail");
  });

  test("returns the original error when classification does not recognize it", () => {
    const original = new Error("something unrelated");
    const result = classifyManagedCommandFailure(original, "rescue", "job-xyz");
    expect(result).toBe(original);
  });

  test("leaves unrelated RuntimeErrors with spawn details unclassified", () => {
    const original = new RuntimeError("CLI_SPAWN_CALLBACK_FAILED", "spawn callback failed", "cli-client.spawn", {
      details: { spawn_code: "E2BIG" },
    });
    expect(classifySetupFailure(original)).toBeNull();
    expect(classifyManagedCommandFailure(original, "review", "job-xyz")).toBe(original);
  });

  test("collapses to `${commandType}.runtime` stage by default", () => {
    const inner = new RuntimeError(
      "TIMEOUT",
      "rescue.initialize timed out after 15000ms.",
      "rescue.initialize",
    );
    const result = classifyManagedCommandFailure(inner, "rescue", "job-xyz");
    expect(result).toBeInstanceOf(RuntimeError);
    expect((result as RuntimeError).code).toBe("RESCUE_KIMI_TIMEOUT");
    expect((result as RuntimeError).stage).toBe("rescue.runtime");
  });

  test("preserveStage keeps the deepest RuntimeError stage for rescue", () => {
    const inner = new RuntimeError(
      "TIMEOUT",
      "rescue.initialize timed out after 15000ms.",
      "rescue.initialize",
    );
    const result = classifyManagedCommandFailure(inner, "rescue", "job-xyz", {
      preserveStage: true,
    });
    expect(result).toBeInstanceOf(RuntimeError);
    expect((result as RuntimeError).code).toBe("RESCUE_KIMI_TIMEOUT");
    expect((result as RuntimeError).stage).toBe("rescue.initialize");
  });

  test("opaque CLI_SPAWN_FAILED retains binary-unavailable compatibility and its spawn stage", () => {
    const inner = new RuntimeError(
      "CLI_SPAWN_FAILED",
      "Failed to spawn kimi.",
      "cli-client.spawn",
    );
    const result = classifyManagedCommandFailure(inner, "rescue", "job-xyz", {
      preserveStage: true,
    });
    expect(result).toBeInstanceOf(RuntimeError);
    expect((result as RuntimeError).code).toBe("RESCUE_KIMI_BINARY_UNAVAILABLE");
    expect((result as RuntimeError).stage).toBe("cli-client.spawn");
  });

  for (const code of ["CLI_SPAWN_FAILED", "CLI_PROCESS_ERROR"]) {
    test.each(["E2BIG", "ENOMEM", "EMFILE"])(`${code} preserves non-executable failure %s`, (spawnCode) => {
      const inner = new RuntimeError(code, "process launch failed", "cli-client.spawn", {
        details: { spawn_code: spawnCode, spawn_errno: -7, spawn_message: "system launch failure" },
      });
      const classification = classifySetupFailure(inner)!;
      expect(classification.kind).toBe("startup_failed");
      expect(classification.nextStep).toBe("Check the underlying process error; shorten the prompt or environment if an argument-size limit was exceeded, then retry.");
      const result = classifyManagedCommandFailure(inner, "review", "job-xyz") as RuntimeError;
      expect(result.code).toBe("REVIEW_KIMI_STARTUP_FAILED");
      expect(result.details).toMatchObject(inner.details);
    });

    test.each(["ENOENT", "EACCES", "ENOEXEC"])(`${code} retains the install remedy for %s`, (spawnCode) => {
      const inner = new RuntimeError(code, "process launch failed", "cli-client.spawn", {
        details: { spawn_code: spawnCode },
      });
      expect(classifySetupFailure(inner)?.nextStep).toBe("Run `/kimi:setup` to verify the install, then expose `kimi` on PATH and retry.");
      const result = classifyManagedCommandFailure(inner, "review", "job-xyz") as RuntimeError;
      expect(result.code).toBe("REVIEW_KIMI_BINARY_UNAVAILABLE");
    });
  }

  test("legacy async ENOENT without structured cause retains the install remedy", () => {
    const inner = new RuntimeError("CLI_PROCESS_ERROR", "spawn kimi ENOENT", "cli-client.process");
    expect(classifySetupFailure(inner)?.nextStep).toBe("Run `/kimi:setup` to verify the install, then expose `kimi` on PATH and retry.");
    expect((classifyManagedCommandFailure(inner, "review", "job-xyz") as RuntimeError).code).toBe("REVIEW_KIMI_BINARY_UNAVAILABLE");
  });

  test("opaque async process errors retain health-check advice", () => {
    const inner = new RuntimeError("CLI_PROCESS_ERROR", "process error", "cli-client.process");
    expect(classifySetupFailure(inner)?.nextStep).toBe("Run `/kimi:setup` to verify local Kimi health, then retry.");
    expect((classifyManagedCommandFailure(inner, "review", "job-xyz") as RuntimeError).code).toBe("REVIEW_KIMI_STARTUP_FAILED");
  });

  test("preserveStage only kicks in when the inner error is a RuntimeError", () => {
    // Plain Errors no longer carry the kimi-startup classifier signal in
    // v1.0 (the "Failed to start kimi" message-substring branch was a
    // wire-transport artifact). Use a RuntimeError-shaped LLM-auth
    // failure so the classifier still recognizes it but is forced into
    // the default stage when the inner type isn't a RuntimeError.
    const inner = new Error("LLM is not set");
    const result = classifyManagedCommandFailure(inner, "rescue", "job-xyz", {
      preserveStage: true,
    });
    expect(result).toBeInstanceOf(RuntimeError);
    // Falls back to the default stage because inner is a plain Error, not a RuntimeError.
    expect((result as RuntimeError).stage).toBe("rescue.runtime");
  });

  test("distinguishes startup, initialize, and response timeouts per command type", () => {
    // v0.3.0 task #10: separate codes for "Kimi never started" vs "Kimi
    // started but never responded" so users can tell apart a dead binary
    // from a thinking-on finalization hang.
    const startup = classifyManagedCommandFailure(
      new RuntimeError("STARTUP_TIMEOUT", "review.start timed out after 10000ms.", "review.start"),
      "review",
      "job-xyz",
    ) as RuntimeError;
    expect(startup.code).toBe("REVIEW_KIMI_STARTUP_TIMEOUT");

    const init = classifyManagedCommandFailure(
      new RuntimeError(
        "INITIALIZE_TIMEOUT",
        "ask.initialize timed out after 15000ms.",
        "ask.initialize",
      ),
      "ask",
      "job-xyz",
    ) as RuntimeError;
    expect(init.code).toBe("ASK_KIMI_INITIALIZE_TIMEOUT");

    const response = classifyManagedCommandFailure(
      new RuntimeError(
        "RESPONSE_TIMEOUT",
        "review.prompt timed out after 600000ms.",
        "review.prompt",
      ),
      "review",
      "job-xyz",
    ) as RuntimeError;
    expect(response.code).toBe("REVIEW_KIMI_RESPONSE_TIMEOUT");
  });

  test("legacy `TIMEOUT` code still maps to `${COMMAND}_KIMI_TIMEOUT` for back-compat", () => {
    const legacy = classifyManagedCommandFailure(
      new RuntimeError("TIMEOUT", "ask.start timed out after 10000ms.", "ask.start"),
      "ask",
      "job-xyz",
    ) as RuntimeError;
    expect(legacy.code).toBe("ASK_KIMI_TIMEOUT");
  });

  test("plain Error with `timed out` substring falls through the legacy string-match branch", () => {
    const plain = classifyManagedCommandFailure(
      new Error("Kimi initialize timed out"),
      "review",
      "job-xyz",
    ) as RuntimeError;
    expect(plain.code).toBe("REVIEW_KIMI_TIMEOUT");
  });

  test("MAX_STEPS_REACHED is mapped to a command-prefixed code", () => {
    // Managed commands map MAX_STEPS_REACHED to a command-prefixed code
    // for parity with the timeout codes (which already prefix as
    // `${PREFIX}_KIMI_*_TIMEOUT`).
    const ask = classifyManagedCommandFailure(
      new RuntimeError(
        "MAX_STEPS_REACHED",
        "Kimi reached its step budget (50 steps) before finalizing this turn.",
        "wire.prompt",
      ),
      "ask",
      "job-xyz",
    ) as RuntimeError;
    expect(ask.code).toBe("ASK_KIMI_MAX_STEPS_REACHED");

    const review = classifyManagedCommandFailure(
      new RuntimeError("MAX_STEPS_REACHED", "Kimi reached step budget.", "wire.prompt"),
      "review",
      "job-xyz",
    ) as RuntimeError;
    expect(review.code).toBe("REVIEW_KIMI_MAX_STEPS_REACHED");
  });

  test("ask, review, challenge, and review_gate default behavior is unchanged (preserveStage opt-in)", () => {
    const inner = new RuntimeError(
      "TIMEOUT",
      "initialize timed out.",
      "some.inner.stage",
    );
    const askResult = classifyManagedCommandFailure(inner, "ask", "job-xyz");
    expect((askResult as RuntimeError).stage).toBe("ask.runtime");

    const reviewResult = classifyManagedCommandFailure(inner, "review", "job-xyz");
    expect((reviewResult as RuntimeError).stage).toBe("review.runtime");

    const challengeResult = classifyManagedCommandFailure(inner, "challenge", "job-xyz");
    expect((challengeResult as RuntimeError).stage).toBe("challenge.runtime");

    const gateResult = classifyManagedCommandFailure(inner, "review_gate", "job-xyz");
    expect((gateResult as RuntimeError).stage).toBe("review_gate.runtime");
  });

  test("auth.login_required in the stderr tail maps to AUTH_UNAVAILABLE with a kimi-login next step", () => {
    // The real 2026-08-08 incident shape: kimi 0.34.0 exits 1 before any
    // records, its stderr tail (embedded in the CLI_NONZERO_EXIT message by
    // assertCliResultSuccess) names the logged-out OAuth provider. The
    // classifier must recognize it BEFORE the generic CLI_NONZERO_EXIT
    // startup_failed branch, whose /kimi:setup advice cannot repair auth.
    const inner = new RuntimeError(
      "CLI_NONZERO_EXIT",
      'kimi subprocess exited with code 1:\nerror: failed to run prompt: auth.login_required: OAuth provider "managed:kimi-code" requires login before it can be used.',
      "ask.runtime",
    );
    const result = classifyManagedCommandFailure(inner, "ask", "job-xyz") as RuntimeError;
    expect(result.code).toBe("ASK_KIMI_AUTH_UNAVAILABLE");
    expect(result.message).toContain("kimi login");
    expect(result.message).not.toContain("startup");
  });

  test("wrapped errors carry availability, cause_code, and cause_message in details", () => {
    const inner = new RuntimeError(
      "CLI_NONZERO_EXIT",
      "kimi subprocess exited with code 1:\nsome stderr tail",
      "ask.runtime",
    );
    const result = classifyManagedCommandFailure(inner, "ask", "job-xyz") as RuntimeError;
    expect(result.details.availability).toBe("startup_failed");
    expect(result.details.cause_code).toBe("CLI_NONZERO_EXIT");
    expect(result.details.cause_message).toBe(
      "kimi subprocess exited with code 1:\nsome stderr tail",
    );
    expect(result.cause).toBe(inner);
  });

  test("plain Error causes carry cause_message but no cause_code", () => {
    const result = classifyManagedCommandFailure(
      new Error("LLM is not set"),
      "rescue",
      "job-xyz",
    ) as RuntimeError;
    expect(result.details.availability).toBe("auth_unavailable");
    expect(result.details.cause_code).toBeUndefined();
    expect(result.details.cause_message).toBe("LLM is not set");
  });

  test("oversized cause messages are tail-truncated for details", () => {
    // The informative lines of a crashed subprocess (kimi's own `error:`
    // output) are the TRAILING bytes of stderr, so truncation keeps the end.
    const filler = "x".repeat(5000);
    const inner = new RuntimeError(
      "CLI_NONZERO_EXIT",
      `${filler}\nerror: the part that matters`,
      "ask.runtime",
    );
    const result = classifyManagedCommandFailure(inner, "ask", "job-xyz") as RuntimeError;
    const causeMessage = result.details.cause_message as string;
    expect(causeMessage.startsWith("…")).toBe(true);
    expect(causeMessage.endsWith("error: the part that matters")).toBe(true);
    expect(causeMessage.length).toBeLessThanOrEqual(2001);
  });
});

describe("summarizeKimiAvailabilityWarning", () => {
  test.each([
    {
      error: new Error("LLM is not set"),
      expected: "Kimi review gate is not configured for model access; allowing stop.",
    },
    {
      error: new RuntimeError(
        "CLI_NONZERO_EXIT",
        'kimi subprocess exited with code 1:\nerror: failed to run prompt: auth.login_required: OAuth provider "managed:kimi-code" requires login before it can be used.',
        "review_gate.runtime",
      ),
      expected: "Kimi review gate is not configured for model access; allowing stop.",
    },
    {
      error: new RuntimeError("CLI_SPAWN_FAILED", "Failed to spawn kimi.", "cli-client.spawn"),
      expected: "Kimi review gate could not find the Kimi CLI; allowing stop.",
    },
    {
      error: new RuntimeError("CLI_NONZERO_EXIT", "exited", "cli-client.process"),
      expected: "Kimi review gate could not start a usable Kimi subprocess; allowing stop.",
    },
    {
      error: new RuntimeError("STARTUP_TIMEOUT", "startup timed out", "cli-client.spawn"),
      expected: "Kimi review gate did not respond during startup; allowing stop.",
    },
    {
      error: new RuntimeError("INITIALIZE_TIMEOUT", "initialize timed out", "cli-client.initialize"),
      expected: "Kimi review gate did not complete session initialization; allowing stop.",
    },
    {
      error: new RuntimeError("RESPONSE_TIMEOUT", "prompt timed out", "wire.prompt"),
      expected: "Kimi review gate did not return a final response; allowing stop.",
    },
    {
      error: new RuntimeError("MAX_STEPS_REACHED", "max steps", "wire.prompt"),
      expected: "Kimi review gate exhausted its step budget; allowing stop.",
    },
    {
      error: new Error("operation timed out"),
      expected: "Kimi review gate timed out; allowing stop.",
    },
  ])("returns an explicit warning for $expected", ({ error, expected }) => {
    expect(summarizeKimiAvailabilityWarning(error, "review_gate")).toBe(expected);
  });
});

for (const command of ["ask", "rescue", "review", "challenge"] as const) {
  for (const background of [false, true]) {
    test(`${command} timeout advice reflects background=${background}`, () => {
      const inner = new RuntimeError("RESPONSE_TIMEOUT", "budget elapsed", "prompt", {
        details: { budget_ms: 60_000, record_count: 3, partial_output_chars: 42, aborted: true },
      });
      const error = classifyManagedCommandFailure(inner, command, "timeout-job", { background, budgetMs: 60_000 }) as RuntimeError;
      expect(error.code).toBe(`${command.toUpperCase()}_KIMI_RESPONSE_TIMEOUT`);
      expect(error.message).toContain("--budget 2m");
      expect(error.message).toContain("result timeout-job");
      expect(error.message.includes("--background")).toBe(!background && (command === "ask" || command === "rescue"));
      expect(error.details).toMatchObject(inner.details);
      expect(error.cause).toBe(inner);
    });
  }
}

test("source timeout advice is correct for consumers without managed-command context", () => {
  const error = new RuntimeError("RESPONSE_TIMEOUT", "budget exhausted", "prompt", { details: { settled_post_abort: true } });
  const source = classifySetupFailure(error)!;
  expect(source.nextStep).toContain("--budget <dur>");
  expect(source.nextStep).toContain("result <jobId>");
  expect(source.nextStep).not.toContain("--background");
  for (const command of ["ask", "rescue", "review", "challenge", "review_gate"] as const) {
    const classified = classifyManagedCommandFailure(error, command, "job") as RuntimeError;
    expect(classified.message).not.toContain("retry with --background");
    expect(classified.details.settled_post_abort).toBe(true);
  }
});
