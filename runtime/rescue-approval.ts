import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { parse } from "shell-quote";

import type { ApprovalPolicy } from "./wire/approval-dispatcher.js";
import type { ApprovalRequestPayload } from "./wire/types.js";

const MUTATING_FLAGS = new Set(["--fix", "--write", "-w", "--apply", "--in-place", "-i"]);
const STOP_LIST = new Set([
  "start",
  "dev",
  "serve",
  "watch",
  "deploy",
  "publish",
  "release",
  "preview",
  "run",
  "install",
]);
const PIPELINE_PLUMBING = new Set(["head", "tail", "wc", "sort", "uniq", "awk", "sed"]);
const GIT_READONLY_SUBCOMMANDS = new Set(["status", "diff", "show", "log", "grep", "blame"]);
const CARGO_SUBCOMMANDS = new Set(["check", "clippy", "test"]);
const GO_SUBCOMMANDS = new Set(["build", "vet", "test"]);

export async function createRescueApprovalPolicy(workspaceRoot: string): Promise<ApprovalPolicy> {
  const root = await realpath(workspaceRoot);

  return async (request) => {
    if (isFileEditRequest(request)) {
      const decision = await evaluateFileEdit(root, request);
      return decision ?? reject("Only workspace-local file edits are allowed in rescue.");
    }

    if (isShellRequest(request)) {
      const command = extractShellCommand(request);
      if (!command) {
        return reject("Rescue could not determine the shell command to approve.");
      }

      return validateShellCommand(command);
    }

    return reject(`Rescue does not allow ${request.sender} approvals in v1.`);
  };
}

function isFileEditRequest(request: ApprovalRequestPayload): boolean {
  return request.sender === "WriteFile" || request.sender === "StrReplaceFile" || request.action === "edit file";
}

function isShellRequest(request: ApprovalRequestPayload): boolean {
  return request.sender === "Shell" || request.action.includes("command");
}

async function evaluateFileEdit(
  workspaceRoot: string,
  request: ApprovalRequestPayload,
): Promise<{ response: "approve" } | { response: "reject"; feedback: string } | null> {
  const targets = request.display
    .filter(isDiffDisplay)
    .map((entry) => entry.path)
    .filter((value): value is string => typeof value === "string");

  if (targets.length === 0) {
    return null;
  }

  for (const target of targets) {
    const allowed = await checkApprovedPath(workspaceRoot, target);
    if (allowed !== "allow") {
      if (allowed === "symlink") {
        return reject("Rescue does not overwrite symlinks.");
      }

      return reject(`Rescue rejects file edits outside the workspace or inside .git: ${target}`);
    }
  }

  return { response: "approve" };
}

async function checkApprovedPath(
  workspaceRoot: string,
  rawTargetPath: string,
): Promise<"allow" | "symlink" | "reject"> {
  const absoluteTarget = path.isAbsolute(rawTargetPath)
    ? path.resolve(rawTargetPath)
    : path.resolve(workspaceRoot, rawTargetPath);

  const targetStats = await statIfExists(absoluteTarget);
  if (targetStats?.isSymbolicLink()) {
    return "symlink";
  }

  const nearestExistingAncestor = await findNearestExistingAncestor(path.dirname(absoluteTarget));
  const ancestorRealPath = await realpath(nearestExistingAncestor);
  const candidatePath = path.resolve(
    ancestorRealPath,
    path.relative(nearestExistingAncestor, absoluteTarget),
  );
  const relativeToRoot = path.relative(workspaceRoot, candidatePath);

  return (
    isWithin(workspaceRoot, candidatePath) &&
    !relativeToRoot.split(path.sep).includes(".git")
  )
    ? "allow"
    : "reject";
}

async function statIfExists(targetPath: string) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function findNearestExistingAncestor(targetDirectory: string): Promise<string> {
  let candidate = targetDirectory;

  while (true) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        return candidate;
      }
      candidate = parent;
    }
  }
}

function extractShellCommand(request: ApprovalRequestPayload): string | null {
  const shellEntry = request.display.find(isShellDisplay);
  if (shellEntry) {
    return shellEntry.command;
  }

  const match = request.description.match(/`([^`]+)`/);
  return match?.[1] ?? null;
}

function validateShellCommand(command: string): { response: "approve" | "reject"; feedback?: string } {
  const parsed = parse(command);
  const stages: string[][] = [[]];

  for (const token of parsed) {
    if (typeof token === "string") {
      stages.at(-1)!.push(token);
      continue;
    }

    if ("op" in token && token.op === "|") {
      stages.push([]);
      continue;
    }

    return reject(`Rescue rejects shell syntax outside simple pipelines: ${command}`);
  }

  if (stages.some((stage) => stage.length === 0)) {
    return reject(`Rescue rejects malformed shell pipelines: ${command}`);
  }

  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index]!;
    const allowed = validateShellStage(stage, index > 0 || stages.length > 1);
    if (!allowed.ok) {
      return reject(allowed.reason);
    }
  }

  return { response: "approve" };
}

function validateShellStage(tokens: string[], pipelineMode: boolean): { ok: true } | { ok: false; reason: string } {
  const [command, ...args] = tokens;

  if (!command || path.isAbsolute(command) || command.includes(path.sep)) {
    return { ok: false, reason: `Rescue rejects non-standard shell entrypoints: ${tokens.join(" ")}` };
  }

  if (args.some((arg) => MUTATING_FLAGS.has(arg))) {
    return { ok: false, reason: `Rescue rejects mutating shell flags: ${tokens.join(" ")}` };
  }

  if (command === "git") {
    return GIT_READONLY_SUBCOMMANDS.has(args[0] ?? "")
      ? { ok: true }
      : { ok: false, reason: `Rescue rejects git mutation commands: ${tokens.join(" ")}` };
  }

  if (command === "find") {
    return args.some((arg) => arg === "-exec" || arg === "-execdir" || arg === "-delete")
      ? { ok: false, reason: `Rescue rejects find with -exec/-execdir/-delete: ${tokens.join(" ")}` }
      : { ok: true };
  }

  if (command === "tsc") {
    return args.includes("--noEmit")
      ? { ok: true }
      : { ok: false, reason: "Rescue allows tsc only with --noEmit." };
  }

  if (command === "biome") {
    return args[0] === "check"
      ? { ok: true }
      : { ok: false, reason: "Rescue allows biome only in check mode." };
  }

  if (command === "cargo") {
    if (args[0] === "fmt") {
      return args.includes("--check")
        ? { ok: true }
        : { ok: false, reason: "Rescue allows cargo fmt only with --check." };
    }

    return CARGO_SUBCOMMANDS.has(args[0] ?? "")
      ? { ok: true }
      : { ok: false, reason: `Rescue rejects cargo subcommand: ${tokens.join(" ")}` };
  }

  if (command === "go") {
    return GO_SUBCOMMANDS.has(args[0] ?? "")
      ? { ok: true }
      : { ok: false, reason: `Rescue rejects go subcommand: ${tokens.join(" ")}` };
  }

  if (command === "python" || command === "python3") {
    return args[0] === "-m" && args[1] === "pytest"
      ? { ok: true }
      : { ok: false, reason: `Rescue rejects ${command} shell command: ${tokens.join(" ")}` };
  }

  if (command === "uv") {
    return validateRunCommand(command, args);
  }

  if (command === "npm" || command === "pnpm" || command === "yarn" || command === "bun") {
    return validatePackageManagerCommand(command, args);
  }

  if (["rg", "grep", "ls", "cat", "pwd", "pyright", "mypy", "ruff", "eslint", "pytest"].includes(command)) {
    return { ok: true };
  }

  if (pipelineMode && PIPELINE_PLUMBING.has(command)) {
    if (command === "sed" && args.includes("-i")) {
      return { ok: false, reason: "Rescue rejects sed -i in shell pipelines." };
    }
    return { ok: true };
  }

  return { ok: false, reason: `Rescue rejects shell command: ${tokens.join(" ")}` };
}

function validatePackageManagerCommand(
  command: string,
  args: string[],
): { ok: true } | { ok: false; reason: string } {
  if (args[0] === "test") {
    return { ok: true };
  }

  if (args[0] !== "run" || !args[1]) {
    return { ok: false, reason: `Rescue rejects ${command} command: ${[command, ...args].join(" ")}` };
  }

  return STOP_LIST.has(args[1])
    ? { ok: false, reason: `Rescue rejects ${command} run ${args[1]} via stop list.` }
    : { ok: true };
}

function validateRunCommand(command: string, args: string[]): { ok: true } | { ok: false; reason: string } {
  if (args[0] !== "run" || !args[1]) {
    return { ok: false, reason: `Rescue rejects ${command} command: ${[command, ...args].join(" ")}` };
  }

  return STOP_LIST.has(args[1])
    ? { ok: false, reason: `Rescue rejects ${command} run ${args[1]} via stop list.` }
    : { ok: true };
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function reject(feedback: string): { response: "reject"; feedback: string } {
  return {
    response: "reject",
    feedback,
  };
}

function isDiffDisplay(value: unknown): value is { type: "diff"; path: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type?: string }).type === "diff" &&
    "path" in value &&
    typeof (value as { path?: unknown }).path === "string"
  );
}

function isShellDisplay(value: unknown): value is { type: "shell"; command: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type?: string }).type === "shell" &&
    "command" in value &&
    typeof (value as { command?: unknown }).command === "string"
  );
}
