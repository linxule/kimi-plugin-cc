import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { parse } from "./vendor/shell-quote/index.js";
import type { HookDecision } from "./hooks/approval-policy.js";

// v1.0 cutover note (PR 3):
//
//   The v0.4 entrypoint, `createRescueApprovalPolicy`, took
//   ApprovalRequestPayload values from the wire JSON-RPC channel and
//   returned approval policies for ApprovalDispatcher. Both of those
//   types lived in `runtime/wire/` which PR 4 deletes.
//
//   The v1.0 entrypoint, `evaluateRescueHookRequest`, takes the
//   PreToolUse hook shape (toolName + raw toolInput from kimi-code's
//   hook stdin) and returns a `HookDecision`. All the security helpers
//   below are unchanged from v0.4 — `checkApprovedPath`,
//   `validateShellCommand`, `validateShellStage`, `hasUnsafeShellSyntax`,
//   `hasMutatingFlag`, `validatePackageManagerCommand`, plus the
//   constant tables — kept verbatim so the bug-history reasoning that
//   went into them (e.g. git pre-subcommand flags, sed `-i.bak`,
//   shell-quote pipeline parsing) doesn't have to be re-derived. The
//   thin dispatcher at the top translates between the two surfaces.

// Flags that direct a command to write its output to a file. Audit
// report 28 (Codex M2) found that `git diff --output=secret.txt` slipped
// through the allowlist: the path argument bypasses rescue's
// workspace-bound file-edit check because the write happens via the
// tool's own --output semantics, not via shell redirection. Treating
// these as mutating closes that class (git diff, jq, dot, curl, openssl,
// many compilers — anything that advertises `--output=PATH`).
//
// `-o` short form is intentionally NOT blanket-banned: too many
// read-only commands use it for non-file purposes (rg -o, awk -o,
// grep --only-matching aliases). The space-separated `--output PATH`
// two-arg form is implicitly rejected because the scanner doesn't pair
// args — `--output` exact match below catches the flag itself.
const MUTATING_FLAGS_EXACT = new Set([
  "--fix",
  "--write",
  "-w",
  "--apply",
  "--in-place",
  "-i",
  "--output",
  "--output-file",
  "--output-directory",
  "--output-dir",
]);
const MUTATING_FLAG_PREFIXES = [
  "--fix=",
  "--write=",
  "--apply=",
  "--in-place=",
  "--output=",
  "--output-file=",
  "--output-directory=",
  "--output-dir=",
];
const PIPELINE_PLUMBING = new Set(["head", "tail", "wc", "sort", "uniq"]);
const GIT_READONLY_SUBCOMMANDS = new Set(["status", "diff", "show", "log", "grep", "blame"]);
const CARGO_SUBCOMMANDS = new Set(["check", "clippy", "test"]);
const GO_SUBCOMMANDS = new Set(["build", "vet", "test"]);
const BANNED_FIND_ACTIONS = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprintf",
  "-fprint0",
  "-fls",
]);

/**
 * Read-only tools that bypass the rescue allowlist entirely. Mirrors
 * the broader `READ_ONLY_TOOLS` in approval-policy.ts plus rescue's
 * historical "no harm done" defaults.
 */
const RESCUE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "ReadMediaFile",
  "TaskList",
  "TaskOutput",
]);

/**
 * Evaluate a PreToolUse hook request under the rescue policy.
 *
 * Replaces the v0.4 `createRescueApprovalPolicy` factory. The new entry
 * is a single async function so the hook script can call it directly
 * without juggling a factory + a closure.
 *
 * Inputs come from kimi-code's hook stdin:
 *   - `workspaceRoot`: the `cwd` field of the hook payload
 *   - `toolName`: e.g. `Bash`, `Write`, `Edit`, `MultiEdit`, etc.
 *   - `toolInput`: the raw arguments kimi will pass to the tool
 */
export async function evaluateRescueHookRequest(
  workspaceRoot: string,
  toolName: string,
  toolInput: unknown,
): Promise<HookDecision> {
  if (RESCUE_READ_ONLY_TOOLS.has(toolName)) {
    return { decision: "allow" };
  }

  let root: string;
  try {
    root = await realpath(workspaceRoot);
  } catch (err) {
    return {
      decision: "deny",
      reason: `rescue cannot resolve workspace root: ${(err as Error).message}`,
    };
  }

  if (toolName === "Bash") {
    const command = extractBashCommand(toolInput);
    if (command === null) {
      return {
        decision: "deny",
        reason: "rescue cannot evaluate Bash input with no command field",
      };
    }
    const result = validateShellCommand(command);
    return result.response === "approve"
      ? { decision: "allow" }
      : { decision: "deny", reason: result.feedback ?? "rescue rejected the shell command" };
  }

  if (toolName === "Write" || toolName === "Edit") {
    const filePath = extractFilePath(toolInput);
    if (filePath === null) {
      return {
        decision: "deny",
        reason: `rescue cannot evaluate ${toolName} input with no file_path field`,
      };
    }
    return pathDecision(await checkApprovedPath(root, filePath), filePath);
  }

  if (toolName === "MultiEdit") {
    const filePath = extractFilePath(toolInput);
    if (filePath === null) {
      return {
        decision: "deny",
        reason: "rescue cannot evaluate MultiEdit input with no file_path field",
      };
    }
    return pathDecision(await checkApprovedPath(root, filePath), filePath);
  }

  return {
    decision: "deny",
    reason: `rescue does not allow tool "${toolName}" — only Bash, Write, Edit, MultiEdit (with allowlist checks) and read-only tools are permitted.`,
  };
}

function pathDecision(
  outcome: "allow" | "symlink" | "reject",
  filePath: string,
): HookDecision {
  if (outcome === "allow") return { decision: "allow" };
  if (outcome === "symlink") {
    return {
      decision: "deny",
      reason: `rescue does not overwrite symlinks: ${filePath}`,
    };
  }
  return {
    decision: "deny",
    reason: `rescue rejects file edits outside the workspace or inside .git: ${filePath}`,
  };
}

function extractBashCommand(toolInput: unknown): string | null {
  if (!isObject(toolInput)) return null;
  const command = toolInput.command;
  return typeof command === "string" && command.length > 0 ? command : null;
}

function extractFilePath(toolInput: unknown): string | null {
  if (!isObject(toolInput)) return null;
  const filePath = toolInput.file_path;
  return typeof filePath === "string" && filePath.length > 0 ? filePath : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------
// Internal helpers — verbatim from v0.4 rescue-approval.ts. The bug
// history that motivates each subtle check (e.g. git pre-subcommand
// flags, sed -i.bak suffix, shell-quote pipeline collapse, .git
// containment check) is documented inline and must NOT be removed.
// ---------------------------------------------------------------------

/**
 * TOCTOU note: this check runs at hook time, BEFORE kimi-code actually
 * writes the file. Between our allow decision and the write, an
 * attacker with workspace write access could swap the path with a
 * symlink that escapes the workspace. v0.4 had the same window (the
 * wire approval policy fired at the same point in time). Closing the
 * window would require either an open-by-fd dance under kimi-code's
 * Write tool (not available) or a recheck immediately before the
 * write (also unavailable to plugin code). The practical mitigation
 * is to trust the workspace's existing write controls — anything
 * able to swap a symlink can already mutate workspace files directly,
 * and rescue is intentionally write-capable.
 */
export async function checkApprovedPath(
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

export function validateShellCommand(
  command: string,
): { response: "approve" } | { response: "reject"; feedback: string } {
  // shell-quote collapses raw newline/carriage-return separators into adjacent tokens, which
  // hides a second command from per-stage validation (`git status\nrm -rf /` parses as
  // ['git','status','rm','-rf','/']). Reject any line-break characters up front so every
  // approved command maps to a single shell invocation.
  if (/[\r\n]/.test(command)) {
    return rejectShell(`Rescue rejects multi-line shell commands: ${JSON.stringify(command)}`);
  }

  if (hasUnsafeShellSyntax(command)) {
    return rejectShell(`Rescue rejects command substitution, process substitution, or backticks: ${command}`);
  }

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

    return rejectShell(`Rescue rejects shell syntax outside simple pipelines: ${command}`);
  }

  if (stages.some((stage) => stage.length === 0)) {
    return rejectShell(`Rescue rejects malformed shell pipelines: ${command}`);
  }

  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index]!;
    const allowed = validateShellStage(stage, index > 0 || stages.length > 1);
    if (!allowed.ok) {
      return rejectShell(allowed.reason);
    }
  }

  return { response: "approve" };
}

export function validateShellStage(
  tokens: string[],
  pipelineMode: boolean,
): { ok: true } | { ok: false; reason: string } {
  const [command, ...args] = tokens;

  if (!command || path.isAbsolute(command) || command.includes(path.sep)) {
    return { ok: false, reason: `Rescue rejects non-standard shell entrypoints: ${tokens.join(" ")}` };
  }

  if (hasMutatingFlag(args)) {
    return { ok: false, reason: `Rescue rejects mutating shell flags: ${tokens.join(" ")}` };
  }

  if (command === "git") {
    const firstArg = args[0] ?? "";
    // Pre-subcommand git flags shift where the subcommand lives in argv. The `-c` form in
    // particular can smuggle pager overrides: `git -c core.pager=bash show HEAD:exfil.sh`
    // makes git pipe blob contents through bash without any shell metacharacters. Any
    // legitimate "find first non-flag arg then check allowlist" refactor would accidentally
    // admit that class of attack, so we preemptively reject every pre-subcommand flag here
    // with an unambiguous error.
    if (firstArg.startsWith("-")) {
      return {
        ok: false,
        reason: `Rescue rejects git pre-subcommand flags (e.g. -c/-C/-p/--no-pager/--exec-path): ${tokens.join(" ")}. Put the read-only subcommand immediately after \`git\`.`,
      };
    }
    return GIT_READONLY_SUBCOMMANDS.has(firstArg)
      ? { ok: true }
      : { ok: false, reason: `Rescue rejects git mutation commands: ${tokens.join(" ")}` };
  }

  if (command === "find") {
    return args.some((arg) => BANNED_FIND_ACTIONS.has(arg))
      ? {
          ok: false,
          reason: `Rescue rejects find actions that execute or write files: ${tokens.join(" ")}`,
        }
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

  if (command === "ruff") {
    if (args[0] === "check") {
      return { ok: true };
    }
    if (args[0] === "format") {
      return args.some((arg) => arg === "--check" || arg === "--diff")
        ? { ok: true }
        : { ok: false, reason: "Rescue allows ruff format only with --check or --diff." };
    }
    return { ok: false, reason: `Rescue rejects ruff subcommand: ${tokens.join(" ")}` };
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

  if (command === "npm" || command === "pnpm" || command === "yarn" || command === "bun" || command === "uv") {
    return validatePackageManagerCommand(command, args);
  }

  if (command === "eslint") {
    // ESLint's `-o` short form is `--output-file` — writes the lint
    // report to an arbitrary path. The long form `--output-file=` is
    // already caught by MUTATING_FLAG_PREFIXES; the short form needs an
    // eslint-specific check because `-o` is a legitimate read flag in
    // other tools (e.g. `rg -o` = --only-matching). Audit re-review
    // (report 34 Codex HIGH) found this gap. `--fix` is also already
    // in MUTATING_FLAGS_EXACT, so the eslint command surface is now
    // read-only by construction.
    if (args.includes("-o")) {
      return {
        ok: false,
        reason: `Rescue rejects eslint -o (writes report to a file): ${tokens.join(" ")}. Drop the flag or use a path-checked Write tool call.`,
      };
    }
    return { ok: true };
  }

  if (["rg", "grep", "ls", "cat", "pwd", "pyright", "mypy", "pytest"].includes(command)) {
    return { ok: true };
  }

  if (pipelineMode && PIPELINE_PLUMBING.has(command)) {
    return { ok: true };
  }

  return { ok: false, reason: `Rescue rejects shell command: ${tokens.join(" ")}` };
}

export function hasUnsafeShellSyntax(command: string): boolean {
  return /[`]/.test(command) || /\$\(/.test(command) || /<\(/.test(command) || />\(/.test(command);
}

export function hasMutatingFlag(args: string[]): boolean {
  for (const arg of args) {
    if (MUTATING_FLAGS_EXACT.has(arg)) {
      return true;
    }
    if (MUTATING_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
      return true;
    }
    // sed's -i accepts an optional suffix like -i.bak or --in-place=.bak. Match only the
    // punctuation-suffix shapes so we don't collide with read-only short-flag clusters
    // such as `find -iname`, `grep -il`, or `rg -iw`.
    if (/^-i[.=]/.test(arg)) {
      return true;
    }
  }
  return false;
}

export function validatePackageManagerCommand(
  command: string,
  args: string[],
): { ok: true } | { ok: false; reason: string } {
  // Direct `<pm> test` is the test-runner shorthand.
  if (args[0] === "test") {
    return { ok: true };
  }

  // `<pm> run <script>` is opaque: a malicious package.json can redefine any script to do anything.
  // Rescue requires users to invoke direct check/build tools (tsc, pyright, mypy, eslint, etc.).
  return {
    ok: false,
    reason: `Rescue rejects ${command} ${args.join(" ")}. Use direct tools (tsc --noEmit, pyright, mypy, ruff check, eslint, pytest) instead of package.json scripts.`,
  };
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function rejectShell(feedback: string): { response: "reject"; feedback: string } {
  return { response: "reject", feedback };
}
