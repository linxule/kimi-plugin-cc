import { runAsk } from "./commands/ask.js";
import { runCancel } from "./commands/cancel.js";
import { notImplementedCompanionCommand } from "./commands/not-implemented.js";
import { runReplay } from "./commands/replay.js";
import { runResult } from "./commands/result.js";
import { runReview } from "./commands/review.js";
import { runRescue } from "./commands/rescue.js";
import { runPursue } from "./commands/pursue.js";
import { runSwarm } from "./commands/swarm.js";
import { renderSetupResult, runSetup } from "./commands/setup.js";
import { runStatus } from "./commands/status.js";
import { runWorker } from "./commands/worker.js";
import { formatError, RuntimeError } from "./errors.js";
import type { CommandContext } from "./types.js";

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv as [string | undefined, ...string[]];
  const context: CommandContext = {
    cwd: process.env.KIMI_PLUGIN_CC_WORKSPACE_CWD || process.cwd(),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  };

  switch (command) {
    case "setup": {
      const result = await runSetup(rest, context);
      context.stdout.write(`${renderSetupResult(result)}\n`);
      return;
    }
    case "review": {
      const result = await runReview(rest, context, "review");
      context.stdout.write(`${result}\n`);
      return;
    }
    case "task": {
      const [taskType, ...taskArgs] = rest;
      if (taskType === "rescue") {
        const result = await runRescue(taskArgs, context);
        context.stdout.write(result);
        return;
      }

      if (taskType === "challenge") {
        const result = await runReview(taskArgs, context, "challenge");
        context.stdout.write(`${result}\n`);
        return;
      }

      if (taskType === "pursue") {
        const result = await runPursue(taskArgs, context);
        context.stdout.write(result);
        return;
      }

      if (taskType === "swarm") {
        const result = await runSwarm(taskArgs, context);
        context.stdout.write(result);
        return;
      }

      notImplementedCompanionCommand(taskType ? `task ${taskType}` : "task");
      return;
    }
    case "ask": {
      const result = await runAsk(rest, context);
      context.stdout.write(`${result}\n`);
      return;
    }
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
    case "worker":
      await runWorker(rest, context);
      return;
    default:
      throw new RuntimeError(
        "INVALID_COMMAND",
        `Unknown or missing companion subcommand: ${command ?? "<none>"}. Expected one of setup, review, task, ask, status, result, cancel, replay.`,
        "companion",
      );
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${formatError(error)}\n`);
  process.exitCode = 1;
});
