import { fileURLToPath } from "node:url";
import path from "node:path";

import type { ApprovalPolicy } from "./wire/approval-dispatcher.js";
import { ApprovalDispatcher } from "./wire/approval-dispatcher.js";
import { WireClient } from "./wire/client.js";

export interface KimiLaunchOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  sessionId: string;
  agentFile: string;
  model?: string;
  thinking?: boolean;
  logPath: string;
  approvalPolicy: ApprovalPolicy;
}

export function buildWireClient(options: KimiLaunchOptions): WireClient {
  const { command, prefixArgs } = resolveKimiWireCommand(options.env);
  const args = [
    ...prefixArgs,
    "--wire",
    "--session",
    options.sessionId,
    "--agent-file",
    options.agentFile,
    ...(options.model ? ["--model", options.model] : []),
    ...(options.thinking === undefined ? [] : [options.thinking ? "--thinking" : "--no-thinking"]),
  ];

  return new WireClient({
    cwd: options.cwd,
    env: options.env,
    command,
    args,
    logPath: options.logPath,
    approvalDispatcher: new ApprovalDispatcher(options.approvalPolicy),
  });
}

const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function resolveAgentFile(relativePath: string): string {
  return path.join(runtimeRoot, relativePath);
}

function resolveKimiWireCommand(env: NodeJS.ProcessEnv): { command: string; prefixArgs: string[] } {
  const command = env.KIMI_PLUGIN_CC_KIMI_BIN || "kimi";
  const rawPrefixArgs = env.KIMI_PLUGIN_CC_KIMI_PREFIX_ARGS;

  if (!rawPrefixArgs) {
    return { command, prefixArgs: [] };
  }

  try {
    const parsed = JSON.parse(rawPrefixArgs);
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
      return { command, prefixArgs: parsed };
    }
  } catch {
    return { command, prefixArgs: rawPrefixArgs.split(" ").filter(Boolean) };
  }

  return { command, prefixArgs: [] };
}
