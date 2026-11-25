import { withoutLeadingFlag } from "./parsing.js";
/**
 * Host wrappers pass user arguments through to `ask` and `review`; a leading
 * `--write` or `--challenge` selects the existing operation. Only the CLI entry
 * point applies this: MCP children run canonical spellings whose operation is
 * already recorded from the tool name.
 */
export function routeSurfaceAliases(argv) {
    const [command, ...rest] = argv;
    if (command === "ask") {
        const remaining = withoutLeadingFlag(rest, "--write");
        if (remaining !== undefined)
            return ["task", "rescue", ...remaining];
    }
    if (command === "review") {
        const remaining = withoutLeadingFlag(rest, "--challenge");
        if (remaining !== undefined)
            return ["task", "challenge", ...remaining];
    }
    return [...argv];
}
