import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CommandDefinitionId } from "@deepseek-ai/dsh-commands/brand";
import z from "@deepseek-ai/schemastery";
import { NO_START_CAPABILITIES, } from "@deepseek-ai/dsh-subagent";
import { DSH_COMPANION_OPERATIONS, runCompanionCommand, startCompanionRun, } from "./companion.js";
import { parseDurationMs } from "../parsing.js";
export const name = "kimi-plugin-cc";
export const inject = ["subagents", "subprocess"];
export const DSH_TOOL_GUIDANCE = [
    "Kimi delegation tools have different write boundaries:",
    "kimi_ask, kimi_review, and kimi_challenge are read-only; kimi_swarm is a read-only parallel review.",
    "kimi_rescue and kimi_pursue can edit the selected workspace; kimi_pursue continues toward a bounded goal.",
    "kimi_swarm_write edits a temporary worktree and returns a patch without applying it.",
].join(" ");
const DEFAULT_DISPOSE_GRACE_MS = 6_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const COMPANION_PATH = fileURLToPath(new URL("../../dist/companion.js", import.meta.url));
export const Config = z.object({
    dataRoot: z.string().min(1),
    env: z.dict(z.string()).default({}),
    disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
    maxOutputBytes: z.number().default(DEFAULT_MAX_OUTPUT_BYTES),
    model: z.string().min(1),
    thinkingEffort: z.string().min(1),
    budget: z.string().min(1),
    reviewBase: z.string().min(1),
});
export function defaultDshDataRoot(env = process.env) {
    const explicit = env.KIMI_PLUGIN_CC_DATA;
    if (explicit !== undefined) {
        if (!path.isAbsolute(explicit)) {
            throw new Error("kimi-plugin-cc: KIMI_PLUGIN_CC_DATA must be absolute");
        }
        return path.normalize(explicit);
    }
    const dshHome = env.DSH_HOME ?? path.join(env.HOME || homedir(), ".dsh");
    if (!path.isAbsolute(dshHome)) {
        throw new Error("kimi-plugin-cc: DSH_HOME must be absolute");
    }
    return path.join(dshHome, "plugin-data", "kimi-plugin-cc");
}
function resolveConfig(config) {
    const resolved = {
        dataRoot: config.dataRoot ?? defaultDshDataRoot(),
        env: config.env ?? {},
        disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
        maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        model: config.model,
        thinkingEffort: config.thinkingEffort,
        budget: config.budget,
        reviewBase: config.reviewBase,
    };
    if (!path.isAbsolute(resolved.dataRoot)) {
        throw new Error("kimi-plugin-cc: dataRoot must be absolute");
    }
    if (!Number.isFinite(resolved.disposeGraceMs) || resolved.disposeGraceMs < DEFAULT_DISPOSE_GRACE_MS || resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
        throw new Error(`kimi-plugin-cc: disposeGraceMs must be at least ${DEFAULT_DISPOSE_GRACE_MS} and no greater than ${MAX_TIMER_DELAY_MS}`);
    }
    if (!Number.isSafeInteger(resolved.maxOutputBytes) || resolved.maxOutputBytes <= 0) {
        throw new Error("kimi-plugin-cc: maxOutputBytes must be a positive safe integer");
    }
    for (const [field, value] of [["model", resolved.model], ["thinkingEffort", resolved.thinkingEffort], ["reviewBase", resolved.reviewBase]]) {
        if (value?.startsWith("-"))
            throw new Error(`kimi-plugin-cc: ${field} must not start with '-'`);
    }
    if (resolved.budget !== undefined)
        parseDurationMs(resolved.budget, "--budget", "dsh.config", "safety");
    return resolved;
}
class KimiCompanionProvider {
    name;
    operation;
    spec;
    capabilities = NO_START_CAPABILITIES;
    inheritsParentContext = false;
    constructor(name, operation, spec) {
        this.name = name;
        this.operation = operation;
        this.spec = spec;
    }
    start(request) {
        return startCompanionRun(request, this.operation, this.spec);
    }
}
function commandArguments(rawInput) {
    const trimmed = rawInput.trim();
    return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
}
function commandText(result) {
    return [result.stdout.trimEnd(), result.stderr.trimEnd()]
        .filter((text) => text.length > 0)
        .join("\n");
}
export function apply(ctx, config) {
    const resolved = resolveConfig(config);
    const spec = {
        companionPath: COMPANION_PATH,
        dataRoot: resolved.dataRoot,
        env: resolved.env,
        disposeGraceMs: resolved.disposeGraceMs,
        maxOutputBytes: resolved.maxOutputBytes,
        model: resolved.model,
        thinkingEffort: resolved.thinkingEffort,
        budget: resolved.budget,
        reviewBase: resolved.reviewBase,
        spawn: (spawnSpec) => ctx.subprocess.spawn(spawnSpec),
    };
    for (const operation of DSH_COMPANION_OPERATIONS) {
        ctx.subagents.registerProvider(new KimiCompanionProvider(`kimi-${operation}`, operation, spec));
    }
    ctx.inject(["systemPrompt"], (promptCtx) => {
        promptCtx.systemPrompt.section({
            name: "kimi-plugin-cc:tool-boundaries",
            order: promptCtx.systemPrompt.getSectionOrder("TOOL_SUBAGENT"),
            text: () => DSH_TOOL_GUIDANCE,
        });
    });
    ctx.inject(["commands"], (commandCtx) => {
        const execute = async (invocation, argv) => {
            const directories = commandCtx.get("workingDirectory");
            if (directories === undefined) {
                return { kind: "error", text: "Kimi commands require the DSH working-directory service." };
            }
            const cwd = await directories.ensure(invocation.agent, invocation.signal);
            const result = await runCompanionCommand(argv, cwd, spec, invocation.signal);
            const text = commandText(result);
            if (result.truncated) {
                return { kind: "error", text: `${text}\nKimi command output exceeded the configured byte limit.`.trim() };
            }
            if (result.exitCode !== 0) {
                return {
                    kind: "error",
                    text: `${text}\nKimi command failed (exit code: ${result.exitCode ?? "none"}; signal: ${result.signal ?? "none"}).`.trim(),
                };
            }
            return { kind: "success", text: text.length > 0 ? text : "Kimi command completed." };
        };
        commandCtx.commands.register({
            definitionId: CommandDefinitionId("kimi-plugin-cc/dsh/setup"),
            name: "kimi-setup",
            description: "Install, check, or remove the DSH-owned Kimi PreToolUse hook; list configured models",
            input: { hint: "[--check|--uninstall|--models [--json]]" },
            recordInput: false,
            handler: (invocation) => {
                const args = commandArguments(invocation.rawInput);
                const valid = args.length === 0
                    || (args.length === 1 && ["--check", "--uninstall", "--models"].includes(args[0]))
                    || (args.length === 2 && args[0] === "--models" && args[1] === "--json");
                if (!valid) {
                    return { kind: "error", text: "Usage: /kimi-setup [--check|--uninstall|--models [--json]]" };
                }
                return execute(invocation, ["setup", ...args]);
            },
        });
        for (const command of ["status", "result", "cancel"]) {
            commandCtx.commands.register({
                definitionId: CommandDefinitionId(`kimi-plugin-cc/dsh/${command}`),
                name: `kimi-${command}`,
                description: `${command === "cancel" ? "Cancel" : command === "status" ? "Inspect" : "Return"} a companion Kimi job`,
                input: { hint: "[job-id]" },
                recordInput: false,
                handler: (invocation) => execute(invocation, [command, ...commandArguments(invocation.rawInput)]),
            });
        }
    });
}
