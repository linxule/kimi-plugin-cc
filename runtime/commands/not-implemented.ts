import { RuntimeError } from "../errors.js";

export function notImplementedInPhase1a(command: string): never {
  throw new RuntimeError(
    "NOT_IMPLEMENTED",
    `${command} is not yet implemented in phase 1a.`,
    command,
  );
}
