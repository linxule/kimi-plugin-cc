import { hasHelpFlag, ASK_SUPPORTED_FLAGS, RESCUE_SUPPORTED_FLAGS, REVIEW_SUPPORTED_FLAGS, PURSUE_SUPPORTED_FLAGS, SWARM_SUPPORTED_FLAGS, JOB_LOOKUP_SUPPORTED_FLAGS, SETUP_SUPPORTED_FLAGS, REPAIR_SESSIONS_SUPPORTED_FLAGS, REPLAY_SUPPORTED_FLAGS, RECOVER_SWARM_SUPPORTED_FLAGS, } from "./parsing.js";
const SUBCOMMANDS = "setup, review, task, ask, status, result, cancel, replay, repair-sessions, recover-swarm";
const TASK_KINDS = "rescue, challenge, pursue, swarm";
/** Help is a dispatch-only, side-effect-free exception to normal argument parsing. */
export function companionHelp(argv) {
    const [command, kind] = argv;
    // Scan only the argument region: the subcommand (and a task kind) are
    // positional names, not prose, so they must not end the flag region.
    const argumentStart = command === "--help" || command === "-h" ? 0
        : command === "task" && kind !== undefined && !kind.startsWith("-") ? 2
            : 1;
    if (!hasHelpFlag(argv.slice(argumentStart)))
        return undefined;
    const suffix = " Thinking effort is a per-run request, not a guarantee. Use --help or -h among the leading flags (before any prompt text or --) to show this usage.";
    const usage = (name, positionals, flags, description) => `Usage: companion.sh ${name}${positionals ? ` ${positionals}` : ""}. ${description} Supported flags: ${flags}.${suffix}`;
    switch (command) {
        case "--help":
        case "-h":
            return `Usage: companion.sh <subcommand> [arguments]. Subcommands: ${SUBCOMMANDS}. Use <subcommand> --help for usage.`;
        case "task":
            switch (kind) {
                case "rescue": return usage("task rescue", "[options] [--] <task>", RESCUE_SUPPORTED_FLAGS, "Write-capable task; default budget 45m. Backgrounding does not extend the budget.");
                case "challenge": return usage("task challenge", "[options] [--] [focus]", REVIEW_SUPPORTED_FLAGS, "Read-only challenge; default budget 30m. Foreground-only (no --background/--wait).");
                case "pursue": return usage("task pursue", "[options] [--] <objective>", PURSUE_SUPPORTED_FLAGS, "Autonomous goal; default budget 45m. Runtime foreground-only.");
                case "swarm": return usage("task swarm", "[options] [--] <objective>", SWARM_SUPPORTED_FLAGS, "Parallel task; default budget 30m. Runtime foreground-only; --write produces a patch.");
                default: return `Usage: companion.sh task <kind> [arguments]. Task kinds: ${TASK_KINDS}. Use task <kind> --help for usage.`;
            }
        case "ask": return usage(command, "[options] [--] [prompt]", ASK_SUPPORTED_FLAGS, "Read-only question; default budget 30m. Backgrounding does not extend the budget.");
        case "review": return usage(command, "[options] [--] [focus]", REVIEW_SUPPORTED_FLAGS, "Read-only review; default budget 30m. Foreground-only (no --background/--wait).");
        case "setup": return usage(command, "[options]", SETUP_SUPPORTED_FLAGS, "Install, check, or remove this host's managed hook, or list configured models.");
        case "status":
        case "result":
        case "cancel":
            return usage(command, "[job-id] [options]", JOB_LOOKUP_SUPPORTED_FLAGS, command === "status" ? "Show job state as JSON." : command === "result" ? "Read a terminal artifact, optionally in a JSON envelope." : "Cancel a running job; without an id, target the repository's latest running job.");
        case "replay": return usage(command, "<job-id>", REPLAY_SUPPORTED_FLAGS, "Replay a completed job's persisted stream log.");
        case "recover-swarm": return `Usage: companion.sh recover-swarm <job-id> [${RECOVER_SWARM_SUPPORTED_FLAGS}]. Preview durable swarm recovery; --apply stops verified orphans, disables the recorded session and captures a patch. Never resumes prompts or changes terminal job outcomes.`;
        case "repair-sessions": return usage(command, "[options]", REPAIR_SESSIONS_SUPPORTED_FLAGS, "Preview session metadata repair; --apply writes, --all selects all host-owned repositories.");
        case "worker": return "Usage: companion.sh worker <ask|rescue> <job-id>. Internal detached-worker entry point; launched by ask/rescue, not manually.";
        case "mcp": return "Usage: companion.sh mcp. Run the Kimi MCP stdio server; normally launched by Claude Code or Codex plugin configuration.";
        case "mcp-child": return "Usage: companion.sh mcp-child <job-uuid> <model-operation> [arguments]. Internal supervised MCP child; launched by the MCP server, not manually.";
        default: return undefined;
    }
}
