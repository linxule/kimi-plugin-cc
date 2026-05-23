import { RuntimeError, formatError } from "./errors.js";
import type { ManagedCommandType, RuntimeCommandType } from "./types.js";

type AvailabilityKind =
  | "auth_unavailable"
  | "binary_unavailable"
  | "startup_failed"
  | "startup_timeout"
  | "initialize_timeout"
  | "response_timeout"
  | "timeout"
  | "max_steps_reached"
  | null;

interface AvailabilityClassification {
  kind: Exclude<AvailabilityKind, null>;
  summary: string;
  nextStep: string;
  runtimeProbe: "ok" | "failed";
  authProbe: "ok" | "failed";
}

export function classifyManagedCommandFailure(
  error: unknown,
  commandType: ManagedCommandType | "review_gate",
  jobId: string,
  options?: { preserveStage?: boolean },
): Error {
  const classification = classifyKimiAvailability(error);
  if (!classification) {
    return error instanceof Error ? error : new Error(String(error));
  }

  const label = formatCommandLabel(commandType);
  const stage =
    options?.preserveStage && error instanceof RuntimeError
      ? error.stage
      : `${commandType}.runtime`;
  return new RuntimeError(
    mapAvailabilityCode(classification.kind, commandType),
    `${label} could not run because ${classification.summary} ${classification.nextStep} Job ${jobId} was persisted as failed.`,
    stage,
    error instanceof Error ? { cause: error } : undefined,
  );
}

export function summarizeKimiAvailabilityWarning(
  error: unknown,
  commandType: RuntimeCommandType,
): string | null {
  const classification = classifyKimiAvailability(error);
  if (!classification) {
    return null;
  }

  if (classification.kind === "auth_unavailable") {
    return `Kimi ${formatCommandLabel(commandType).toLowerCase()} is not configured for model access; allowing stop.`;
  }

  if (classification.kind === "binary_unavailable") {
    return `Kimi ${formatCommandLabel(commandType).toLowerCase()} could not find the Kimi CLI; allowing stop.`;
  }

  if (classification.kind === "startup_failed") {
    return `Kimi ${formatCommandLabel(commandType).toLowerCase()} could not start a usable Wire session; allowing stop.`;
  }

  switch (classification.kind) {
    case "startup_timeout":
      return `Kimi ${formatCommandLabel(commandType).toLowerCase()} did not respond during startup; allowing stop.`;
    case "initialize_timeout":
      return `Kimi ${formatCommandLabel(commandType).toLowerCase()} did not complete Wire initialization; allowing stop.`;
    case "response_timeout":
      return `Kimi ${formatCommandLabel(commandType).toLowerCase()} did not return a final response; allowing stop.`;
    case "max_steps_reached":
      return `Kimi ${formatCommandLabel(commandType).toLowerCase()} exhausted its step budget; allowing stop.`;
    case "timeout":
      return `Kimi ${formatCommandLabel(commandType).toLowerCase()} timed out; allowing stop.`;
  }
}

export function classifySetupFailure(error: unknown): AvailabilityClassification | null {
  return classifyKimiAvailability(error);
}

function classifyKimiAvailability(error: unknown): AvailabilityClassification | null {
  const message = formatError(error);

  if (message.includes("LLM is not set") || message.includes("LLM service error")) {
    return {
      kind: "auth_unavailable",
      summary: "local Kimi authentication or model configuration is not usable.",
      nextStep: "Run `/kimi:setup`, then `kimi login` or fix the local Kimi model configuration and retry.",
      runtimeProbe: "ok",
      authProbe: "failed",
    };
  }

  if (
    error instanceof RuntimeError &&
    error.code === "WIRE_SPAWN_FAILED"
  ) {
    return {
      kind: "binary_unavailable",
      summary: "the Kimi CLI is missing from PATH or not executable in this environment.",
      nextStep: "Run `/kimi:setup` to verify the install, then expose `kimi` on PATH and retry.",
      runtimeProbe: "failed",
      authProbe: "failed",
    };
  }

  if (message.includes("Failed to start kimi")) {
    return {
      kind: "startup_failed",
      summary: "the Kimi CLI reported a startup failure before the Wire session was ready.",
      nextStep: "Run `/kimi:setup` to inspect the local Kimi installation and retry.",
      runtimeProbe: "failed",
      authProbe: "failed",
    };
  }

  if (
    error instanceof RuntimeError &&
    error.code === "WIRE_PROCESS_EXITED"
  ) {
    return {
      kind: "startup_failed",
      summary: "the Kimi Wire process exited before the session initialized.",
      nextStep: "Run `/kimi:setup` to verify local Kimi health, then retry.",
      runtimeProbe: "failed",
      authProbe: "failed",
    };
  }

  if (error instanceof RuntimeError && error.code === "MAX_STEPS_REACHED") {
    return {
      kind: "max_steps_reached",
      summary: "Kimi exhausted its step budget before finalizing the turn.",
      nextStep: "Retry with a more focused prompt or a higher step budget, or rerun with --no-thinking.",
      runtimeProbe: "ok",
      authProbe: "ok",
    };
  }

  if (error instanceof RuntimeError) {
    if (error.code === "STARTUP_TIMEOUT") {
      return {
        kind: "startup_timeout",
        summary: "the Kimi CLI did not respond to the wire handshake within the startup budget.",
        nextStep: "Run `/kimi:setup` to verify local Kimi health, then retry.",
        runtimeProbe: "failed",
        authProbe: "failed",
      };
    }

    if (error.code === "INITIALIZE_TIMEOUT") {
      return {
        kind: "initialize_timeout",
        summary: "the Kimi wire session started but did not complete `initialize` in time.",
        nextStep: "Run `/kimi:setup` to verify local Kimi auth and protocol-version compatibility, then retry.",
        runtimeProbe: "failed",
        authProbe: "failed",
      };
    }

    if (error.code === "RESPONSE_TIMEOUT") {
      return {
        kind: "response_timeout",
        summary: "Kimi started and accepted the prompt but never returned a final response.",
        nextStep: "Retry with `--no-thinking`; if the response still hangs, check local Kimi version and report upstream.",
        runtimeProbe: "ok",
        authProbe: "ok",
      };
    }
  }

  if (message.includes("timed out")) {
    return {
      kind: "timeout",
      summary: "the Kimi runtime did not become ready within the expected time budget.",
      nextStep: "Run `/kimi:setup` to check local Kimi auth and network health, then retry.",
      runtimeProbe: "failed",
      authProbe: "failed",
    };
  }

  return null;
}

function mapAvailabilityCode(
  kind: Exclude<AvailabilityKind, null>,
  commandType: ManagedCommandType | "review_gate",
): string {
  const prefix = commandType.toUpperCase();
  switch (kind) {
    case "auth_unavailable":
      return `${prefix}_KIMI_AUTH_UNAVAILABLE`;
    case "binary_unavailable":
      return `${prefix}_KIMI_BINARY_UNAVAILABLE`;
    case "startup_failed":
      return `${prefix}_KIMI_STARTUP_FAILED`;
    case "startup_timeout":
      return `${prefix}_KIMI_STARTUP_TIMEOUT`;
    case "initialize_timeout":
      return `${prefix}_KIMI_INITIALIZE_TIMEOUT`;
    case "response_timeout":
      return `${prefix}_KIMI_RESPONSE_TIMEOUT`;
    case "timeout":
      return `${prefix}_KIMI_TIMEOUT`;
    case "max_steps_reached":
      return `${prefix}_KIMI_MAX_STEPS_REACHED`;
  }
}

function formatCommandLabel(commandType: ManagedCommandType | RuntimeCommandType): string {
  switch (commandType) {
    case "challenge":
      return "challenge";
    case "review_gate":
      return "review gate";
    default:
      return commandType.replaceAll("_", " ");
  }
}
