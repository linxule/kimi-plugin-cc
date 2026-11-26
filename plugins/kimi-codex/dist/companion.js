#!/usr/bin/env node
import { runCancel } from "./commands/cancel.js";
import { runModelInventory } from "./commands/models.js";
import { runRecoverSwarm } from "./commands/recover-swarm.js";
import { runRepairSessions } from "./commands/repair-sessions.js";
import { runReplay } from "./commands/replay.js";
import { runResult } from "./commands/result.js";
import { renderSetupResult, runSetup } from "./commands/setup.js";
import { runStatus } from "./commands/status.js";
import { runWorker } from "./commands/worker.js";
import { copyChildEnvironment } from "./cli-client.js";
import { formatError, RuntimeError } from "./errors.js";
import { resolveRepoIdentity } from "./git.js";
import { companionHelp as companionHelpHelper } from "./help.js";
import { sweepStaleJobs } from "./jobs.js";
import { withJobStore } from "./job-store.js";
import { resolveKimiHome } from "./kimi-home.js";
import { runMcpChild } from "./mcp/supervised-child.js";
import { runMcpServer } from "./mcp/server.js";
import { runModelCommand } from "./model-command.js";
import { ensurePluginPaths, resolvePluginPaths } from "./paths.js";
import { parseDurationMs } from "./parsing.js";
import { readArtifact, renderTerminalJobArtifact } from "./render.js";
import { routeSurfaceAliases } from "./surface-routing.js";
import { sleep } from "./util.js";
async function main(rawArgv) {
    const argv = routeSurfaceAliases(rawArgv);
    const help = companionHelpHelper(argv);
    if (help !== undefined) {
        process.stdout.write(`${help}\n`);
        return;
    }
    const [command, ...rest] = argv;
    const cwd = process.env.KIMI_PLUGIN_CC_WORKSPACE_CWD || process.cwd();
    const context = {
        cwd,
        // One environment for every guard, probe and child: on Windows a KIMI_*
        // name in another case is re-keyed here, before anything reads it by name.
        env: {
            ...copyChildEnvironment(process.env),
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
            if (rest.includes("--repair-sessions")) {
                const args = rest.filter((token) => token !== "--repair-sessions");
                context.stdout.write(await runRepairSessions(args, context));
                return;
            }
            const result = await runSetup(rest, context);
            context.stdout.write(`${renderSetupResult(result)}\n`);
            if (result.probe === "failed") {
                process.exitCode = 1;
            }
            return;
        }
        case "job": {
            const [subaction, ...subargs] = rest;
            context.stdout.write(await dispatchJobSubcommand(subaction, subargs, context));
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
            throw new RuntimeError("INVALID_COMMAND", `Unknown or missing companion subcommand: ${command ?? "<none>"}. Expected one of read, write, job, setup, mcp.`, "companion");
    }
}
async function dispatchJobSubcommand(subaction, args, context) {
    switch (subaction) {
        case "list":
            return await runJobList(args, context);
        case "status":
            return await runStatus(args, context);
        case "result":
            return await runResult(args, context);
        case "wait":
            return await runJobWait(args, context);
        case "cancel":
            return await runCancel(args, context);
        case "replay":
            return await runReplay(args, context);
        case "recover-swarm":
            return await runRecoverSwarm(args, context);
        default:
            throw new RuntimeError("INVALID_ARGS", `Unknown job action ${subaction ?? "<none>"}. Expected one of list, status, result, wait, cancel, replay, recover-swarm.`, "job.parse");
    }
}
async function runJobList(argv, context) {
    let statusFilter;
    let limit = 20;
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === "--status") {
            const value = argv[i + 1];
            if (value !== "running" && value !== "completed" && value !== "failed" && value !== "cancelled") {
                throw new RuntimeError("INVALID_ARGS", "--status requires running, completed, failed, or cancelled.", "job.list");
            }
            statusFilter = value;
            i += 1;
            continue;
        }
        if (token === "--limit") {
            const parsed = Number(argv[i + 1]);
            if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
                throw new RuntimeError("INVALID_ARGS", "--limit requires an integer between 1 and 100.", "job.list");
            }
            limit = parsed;
            i += 1;
            continue;
        }
        throw new RuntimeError("INVALID_ARGS", `Unknown job list argument ${token}. Supported: --status <status>, --limit <1..100>.`, "job.list");
    }
    const paths = resolvePluginPaths(context.env);
    await ensurePluginPaths(paths);
    const repo = await resolveRepoIdentity(context.cwd);
    return await withJobStore(paths, async (store) => {
        await sweepStaleJobs(store, paths);
        const jobs = store.listJobs({ repoId: repo.repoId, status: statusFilter, limit }).map((job) => ({
            job_id: job.job_id,
            operation_kind: job.operation_kind,
            command_type: job.command_type,
            status: job.status,
            phase: job.phase,
            summary: job.summary,
            created_at: job.created_at,
            updated_at: job.updated_at,
            kimi_session_id: job.kimi_session_id,
        }));
        return `${JSON.stringify({ workspace: context.cwd, count: jobs.length, jobs }, null, 2)}\n`;
    });
}
async function runJobWait(argv, context) {
    let jobId;
    let timeoutMs = 300_000;
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === "--timeout") {
            timeoutMs = parseDurationMs(argv[i + 1], "--timeout", "job.wait", "response");
            i += 1;
            continue;
        }
        if (token.startsWith("-")) {
            throw new RuntimeError("INVALID_ARGS", `Unknown job wait flag ${token}. Supported: [job-id] --timeout <duration>.`, "job.wait");
        }
        if (jobId) {
            throw new RuntimeError("INVALID_ARGS", "job wait accepts at most one job-id.", "job.wait");
        }
        jobId = token;
    }
    const paths = resolvePluginPaths(context.env);
    await ensurePluginPaths(paths);
    const repo = await resolveRepoIdentity(context.cwd);
    const deadline = Date.now() + timeoutMs;
    let delayMs = 50;
    for (;;) {
        const terminalBody = await withJobStore(paths, async (store) => {
            await sweepStaleJobs(store, paths);
            const job = jobId
                ? store.getJob(jobId)
                : store.findLatestJob({ repoId: repo.repoId });
            if (!job || job.repo_id !== repo.repoId) {
                throw new RuntimeError("JOB_NOT_FOUND", "No matching job was found to wait on.", "job.wait");
            }
            jobId ??= job.job_id;
            if (job.status === "running")
                return null;
            return job.final_output_path
                ? await readArtifact(job.final_output_path)
                : `${renderTerminalJobArtifact(job)}\n`;
        });
        if (terminalBody !== null)
            return terminalBody;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw new RuntimeError("JOB_WAIT_TIMEOUT", `Timed out waiting after ${timeoutMs}ms; job is still running.`, "job.wait");
        }
        await sleep(Math.min(delayMs, remaining));
        delayMs = Math.min(250, delayMs * 2);
    }
}
main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
});
