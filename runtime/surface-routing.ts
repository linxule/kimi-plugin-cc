import { RuntimeError } from "./errors.js";
import { hasHelpFlag, looksLikeFlag, withoutLeadingFlag } from "./parsing.js";

const VALUE_TAKING_FLAGS = new Set([
  "-m",
  "--model",
  "--thinking",
  "--budget",
  "--base",
  "--resume",
  "--read-root",
  "--reference-session",
  "--cap",
  "--max-concurrency",
  "--turns",
  "--mode",
]);

/**
 * Extract `--mode <val>` or `--mode=<val>` ONLY from the leading flag region
 * (stopping at `--` or the first non-flag token, matching `looksLikeFlag`).
 */
function extractLeadingMode(args: readonly string[]): { mode?: string; remaining: string[] } {
  const remaining: string[] = [];
  let mode: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === "--" || !looksLikeFlag(token)) {
      remaining.push(...args.slice(i));
      break;
    }
    if (token === "--mode") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        throw new RuntimeError("INVALID_ARGS", "--mode requires a mode value.", "args.parse");
      }
      mode = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--mode=")) {
      const value = token.slice("--mode=".length);
      if (!value) {
        throw new RuntimeError("INVALID_ARGS", "--mode requires a mode value.", "args.parse");
      }
      mode = value;
      continue;
    }
    remaining.push(token);
    if (VALUE_TAKING_FLAGS.has(token) && i + 1 < args.length) {
      i += 1;
      remaining.push(args[i]!);
    }
  }

  return { mode, remaining };
}

/**
 * Route primary CLI wrappers (`read`, `write`) and legacy aliases (`ask --write`,
 * `review --challenge`) to internal command targets from leading flags only.
 */
export function routeSurfaceAliases(argv: readonly string[]): string[] {
  const [command, ...rest] = argv;
  if (command === "read") {
    if (hasHelpFlag(rest)) return ["read", ...rest];
    const { mode = "ask", remaining } = extractLeadingMode(rest);
    if (withoutLeadingFlag(remaining, "--write") !== undefined) {
      throw new RuntimeError(
        "INVALID_ARGS",
        "--write is not allowed with `read`. Use `write` (e.g. `write --mode rescue` or `write --mode swarm-patch`) for write operations.",
        "read.parse",
      );
    }
    switch (mode) {
      case "ask":
        return ["ask", ...remaining];
      case "review":
        return ["review", ...remaining];
      case "challenge":
        return ["task", "challenge", ...remaining];
      case "swarm":
        return ["task", "swarm", ...remaining];
      default:
        throw new RuntimeError(
          "INVALID_ARGS",
          `Unknown read mode ${JSON.stringify(mode)}. Expected ask, review, challenge, or swarm.`,
          "read.parse",
        );
    }
  }
  if (command === "write") {
    if (hasHelpFlag(rest)) return ["write", ...rest];
    const { mode = "rescue", remaining } = extractLeadingMode(rest);
    switch (mode) {
      case "rescue":
        return ["task", "rescue", ...remaining];
      case "pursue":
        return ["task", "pursue", ...remaining];
      case "swarm-patch":
      case "swarm_patch":
        return ["task", "swarm", "--write", ...remaining];
      default:
        throw new RuntimeError(
          "INVALID_ARGS",
          `Unknown write mode ${JSON.stringify(mode)}. Expected rescue, pursue, or swarm-patch.`,
          "write.parse",
        );
    }
  }
  if (command === "ask") {
    const remaining = withoutLeadingFlag(rest, "--write");
    if (remaining !== undefined) return ["task", "rescue", ...remaining];
  }
  if (command === "review") {
    const remaining = withoutLeadingFlag(rest, "--challenge");
    if (remaining !== undefined) return ["task", "challenge", ...remaining];
  }
  return [...argv];
}
