import { randomUUID } from "node:crypto";

import { brandString } from "@deepseek-ai/dsh-brand";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { SessionId } from "@deepseek-ai/dsh-session";
import {
  assertUsableCwd,
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
} from "@deepseek-ai/dsh-subagent";
import type { SubprocessHandle, SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";

export const DSH_COMPANION_OPERATIONS = [
  "ask",
  "review",
  "challenge",
  "rescue",
  "pursue",
  "swarm",
  "swarm-write",
] as const;
export type DshCompanionOperation = typeof DSH_COMPANION_OPERATIONS[number];
export type DshSpawn = (spec: SubprocessSpawnSpec) => SubprocessHandle;

export interface DshCompanionSpec {
  companionPath: string;
  dataRoot: string;
  env: Record<string, string>;
  disposeGraceMs: number;
  maxOutputBytes: number;
  model?: string;
  thinkingEffort?: string;
  budget?: string;
  reviewBase?: string;
  spawn: DshSpawn;
}

export interface DshCompanionCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export function companionTextTask(prompt: readonly ContentBlock[]): string {
  if (prompt.length === 0 || prompt.some((block) => block.type !== "text")) {
    throw new Error("kimi-plugin-cc: a delegation must contain only text blocks");
  }
  const text = prompt.map((block) => block.type === "text" ? block.text : "").join("\n\n");
  if (text.trim().length === 0) {
    throw new Error("kimi-plugin-cc: a delegation must not be empty");
  }
  return text;
}

export function companionArgv(
  operation: DshCompanionOperation,
  prompt: string,
  companionPath: string,
  nodeBin = process.execPath,
  options: Pick<DshCompanionSpec, "model" | "thinkingEffort" | "budget" | "reviewBase"> = {},
): string[] {
  const command = operation === "ask" || operation === "review"
    ? [operation]
    : operation === "swarm-write"
      ? ["task", "swarm", "--write"]
      : ["task", operation];
  return [
    nodeBin,
    companionPath,
    ...command,
    ...(operation === "ask" || operation === "rescue" ? ["--fresh"] : []),
    ...(options.model === undefined ? [] : ["-m", options.model]),
    ...(options.thinkingEffort === undefined ? [] : ["--thinking", options.thinkingEffort]),
    ...(options.budget === undefined ? [] : ["--budget", options.budget]),
    ...((operation === "review" || operation === "challenge") && options.reviewBase !== undefined
      ? ["--base", options.reviewBase]
      : []),
    "--",
    prompt,
  ];
}

export function companionEnvironment(
  dataRoot: string,
  cwd: string,
  env: Record<string, string>,
  nodeBin = process.execPath,
): NodeJS.ProcessEnv {
  return {
    ...env,
    KIMI_PLUGIN_CC_DATA: dataRoot,
    KIMI_PLUGIN_CC_HOST_ID: "dsh",
    KIMI_PLUGIN_CC_NODE_BIN: nodeBin,
    KIMI_PLUGIN_CC_WORKSPACE_CWD: cwd,
    CLAUDE_PLUGIN_DATA: undefined,
    PLUGIN_DATA: undefined,
    CLAUDE_PLUGIN_ROOT: undefined,
    PLUGIN_ROOT: undefined,
    KIMI_PLUGIN_CC_SHELL_LAUNCH: undefined,
    KIMI_PLUGIN_CC_MCP_WORKSPACE: undefined,
    KIMI_PLUGIN_CC_WORKSPACE_ROOT: undefined,
    KIMI_PLUGIN_CC_HOOK_SCRIPT: undefined,
    KIMI_PLUGIN_CC_SKIP_HOOK_CHECK: undefined,
    KIMI_PLUGIN_CC_SKIP_VERSION_PROBE: undefined,
    KIMI_CODE_TRUST_WORKSPACE: undefined,
  };
}

export async function startCompanionRun(
  request: SubagentStartRequest,
  operation: DshCompanionOperation,
  spec: DshCompanionSpec,
): Promise<SubagentRun> {
  const prompt = companionTextTask(request.prompt);
  if (request.signal.aborted) {
    throw new Error("kimi-plugin-cc: delegation was aborted before companion startup");
  }
  const cwd = assertUsableCwd("kimi-plugin-cc", "child cwd", request.cwd ?? process.cwd());
  const termination = new AbortController();
  let cancelled = false;
  const requestCancel = (): void => {
    cancelled = true;
    if (!termination.signal.aborted) {
      termination.abort(new Error("kimi-plugin-cc: delegation cancelled"));
    }
  };
  const onAbort = (): void => requestCancel();
  request.signal.addEventListener("abort", onAbort, { once: true });

  let child: SubprocessHandle;
  try {
    child = spec.spawn({
      argv: companionArgv(operation, prompt, spec.companionPath, process.execPath, spec),
      cwd,
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: spec.maxOutputBytes },
        stderr: "inherit",
      },
      graceMs: spec.disposeGraceMs,
      signal: termination.signal,
      env: companionEnvironment(spec.dataRoot, cwd, spec.env),
    });
  } catch (error) {
    request.signal.removeEventListener("abort", onAbort);
    throw error;
  }

  let diagnostic: string | undefined;
  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async () => {
      let outcome;
      try {
        outcome = await child.done;
      } catch (error) {
        diagnostic = `Kimi ${operation} companion failed before producing a terminal exit`;
        throw error;
      }
      const collected = child.collected.stdout?.readFrom(0);
      const text = collected?.text.trimEnd() ?? "";
      if (!cancelled && outcome.exitCode === 0 && collected && !collected.lossy && text.trim().length > 0) {
        return { output: [{ type: "text", text }], stopReason: "completed" };
      }
      const facts = [
        `exit code: ${outcome.exitCode ?? "none"}`,
        `signal: ${outcome.signal ?? "none"}`,
        ...(collected?.lossy ? ["stdout truncated"] : []),
        ...(text.trim().length === 0 ? ["stdout empty"] : []),
      ];
      diagnostic = `Kimi ${operation} companion failed (${facts.join("; ")})`;
      return { output: [], diagnostic, stopReason: cancelled ? "aborted" : "error" };
    },
    collectOutput: () => [],
    collectDiagnostic: () => diagnostic,
    cancelled: () => cancelled,
    signal: request.signal,
    onAbort,
  });

  return subprocessRunHandle({
    id: brandString<SessionId>(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: async () => {
      child.terminate();
      await child.waitForExit();
      await child.done.catch(() => {});
    },
  });
}

export async function runCompanionCommand(
  argv: readonly string[],
  cwd: string,
  spec: DshCompanionSpec,
  signal?: AbortSignal,
): Promise<DshCompanionCommandResult> {
  const child = spec.spawn({
    argv: [process.execPath, spec.companionPath, ...argv],
    cwd,
    stdio: {
      stdin: "ignore",
      stdout: { maxBytes: spec.maxOutputBytes },
      stderr: { maxBytes: spec.maxOutputBytes },
    },
    graceMs: spec.disposeGraceMs,
    signal,
    env: companionEnvironment(spec.dataRoot, cwd, spec.env),
  });
  try {
    const outcome = await child.done;
    await child.waitForExit();
    const stdout = child.collected.stdout?.readFrom(0);
    const stderr = child.collected.stderr?.readFrom(0);
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: stdout?.text ?? "",
      stderr: stderr?.text ?? "",
      truncated: Boolean(stdout?.lossy || stderr?.lossy),
    };
  } catch (error) {
    child.terminate();
    await child.waitForExit().catch(() => false);
    throw error;
  }
}
