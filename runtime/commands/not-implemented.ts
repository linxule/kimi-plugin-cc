import { RuntimeError } from "../errors.js";

export function notImplementedCompanionCommand(command: string): never {
  throw new RuntimeError(
    "NOT_IMPLEMENTED",
    `Companion subcommand ${command} is not implemented.`,
    command,
  );
}
