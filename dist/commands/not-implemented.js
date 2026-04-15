import { RuntimeError } from "../errors.js";
export function notImplementedCompanionCommand(command) {
    throw new RuntimeError("NOT_IMPLEMENTED", `Companion subcommand ${command} is not implemented.`, command);
}
