import { runAsk } from "./commands/ask.js";
import { notImplementedCompanionCommand } from "./commands/not-implemented.js";
import { runPursue } from "./commands/pursue.js";
import { runRescue } from "./commands/rescue.js";
import { runReview } from "./commands/review.js";
import { runSwarm } from "./commands/swarm.js";
export async function runModelCommand(argv, context) {
    const [command, ...rest] = argv;
    switch (command) {
        case "review":
            return `${await runReview(rest, context, "review")}\n`;
        case "ask":
            return `${await runAsk(rest, context)}\n`;
        case "task": {
            const [taskType, ...taskArgs] = rest;
            switch (taskType) {
                case "rescue":
                    return runRescue(taskArgs, context);
                case "challenge":
                    return `${await runReview(taskArgs, context, "challenge")}\n`;
                case "pursue":
                    return runPursue(taskArgs, context);
                case "swarm":
                    return runSwarm(taskArgs, context);
                default:
                    notImplementedCompanionCommand(taskType ? `task ${taskType}` : "task");
            }
        }
        default:
            return undefined;
    }
}
