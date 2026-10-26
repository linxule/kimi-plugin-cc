import { RuntimeError } from "./errors.js";

// Node/libuv's default CreateProcess argument quoting (UTF-16 code units).
export function windowsCommandLineLength(command: string, args: readonly string[]): number {
  const quotedLength = (value: string): number => {
    if (value.length > 0 && !/[\s"]/u.test(value)) return value.length;
    return 2 + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1').length;
  };
  return [command, ...args].reduce((size, value) => size + quotedLength(value) + 1, 0);
}

export function assertPromptFitsCommandLine(command: string, args: readonly string[], platform = process.platform): void {
  if (platform !== "win32") return;
  const size = windowsCommandLineLength(command, args);
  if (size <= 32_767) return;
  throw new RuntimeError(
    "CLI_COMMAND_LINE_TOO_LONG",
    "The Kimi prompt exceeds the Windows command-line limit; the CLI was not started. Narrow the review or split it into smaller scopes. A short ask prompt can reference a saved diff inside the workspace. Reinstalling Kimi or running setup will not fix this. The current print transport does not support stdin prompts.",
    "cli-client.pre-spawn",
    { details: { command_line_utf16_units: size, limit_utf16_units: 32_767, platform } },
  );
}
