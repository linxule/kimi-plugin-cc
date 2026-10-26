import { runRecoverSwarm } from "./commands/recover-swarm.js";
import { companionHelp } from "./help.js";
import { runModelInventory } from "./commands/models.js";
import { runCancel } from "./commands/cancel.js";
import { runReplay } from "./commands/replay.js";
import { runRepairSessions } from "./commands/repair-sessions.js";
import { runResult } from "./commands/result.js";
import { renderSetupResult, runSetup } from "./commands/setup.js";
import { runStatus } from "./commands/status.js";
import { runWorker } from "./commands/worker.js";
import { formatError, RuntimeError } from "./errors.js";
import { resolveKimiHome } from "./kimi-home.js";
import { runModelCommand } from "./model-command.js";
import { runMcpChild } from "./mcp/supervised-child.js";
import { runMcpServer } from "./mcp/server.js";
async function main(argv) {
    const help = companionHelp(argv);
    if (help !== undefined) {
        process.stdout.write(`${help}\n`);
        return;
    }
    const [command, ...rest] = argv;
    const cwd = process.env.KIMI_PLUGIN_CC_WORKSPACE_CWD || process.cwd();
    const context = {
        cwd,
        env: {
            ...process.env,
            KIMI_CODE_HOME: command === "mcp" ? process.env.KIMI_CODE_HOME : resolveKimiHome(process.env, cwd),
        },
        stdout: process.stdout,
        stderr: process.stderr,
    };
    const modelResult = await runModelCommand(argv, context);
    if (modelResult !== undefined) {
        context.stdout.write(modelResult);
        return;
    }
    switch (command) {
        case "setup": {
            if (rest.includes("--models")) {
                const args = [...rest];
                args.splice(args.indexOf("--models"), 1);
                context.stdout.write(`${await runModelInventory(args, context)}\n`);
                return;
            }
            const result = await runSetup(rest, context);
            context.stdout.write(`${renderSetupResult(result)}\n`);
            // A failed probe means the hook did not actually deny when exercised —
            // enforcement is NOT in place, whichever action produced it. This must be
            // nonzero for `install` too, not just `check`: since v1.9.0 an agent may
            // run setup and then RETRY the refused command, and it keys that decision
            // on the exit code. Exiting 0 after a failed probe would walk it straight
            // past a proven-dead hook (a byte-exact command + a readable-but-broken
            // script passes `verifyHookInstalled`, since only the probe can tell that
            // the script cannot deny — e.g. a truncated `approval-hook.js`, which has
            // happened here via iCloud sync, or a half-extracted plugin cache).
            // `probe: "skipped"` (uninstall) is deliberately untouched.
            if (result.probe === "failed") {
                process.exitCode = 1;
            }
            return;
        }
        case "mcp":
            await runMcpServer(context);
            return;
        case "mcp-child":
            context.stdout.write(await runMcpChild(rest, context));
            return;
        case "status":
            context.stdout.write(await runStatus(rest, context));
            return;
        case "result":
            context.stdout.write(await runResult(rest, context));
            return;
        case "cancel":
            context.stdout.write(await runCancel(rest, context));
            return;
        case "replay":
            context.stdout.write(await runReplay(rest, context));
            return;
        case "recover-swarm":
            context.stdout.write(await runRecoverSwarm(rest, context));
            return;
        case "repair-sessions":
            context.stdout.write(await runRepairSessions(rest, context));
            return;
        case "worker":
            await runWorker(rest, context);
            return;
        default:
            throw new RuntimeError("INVALID_COMMAND", `Unknown or missing companion subcommand: ${command ?? "<none>"}. Expected one of setup, review, task, ask, status, result, cancel, replay, repair-sessions, recover-swarm.`, "companion");
    }
}
main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
});
