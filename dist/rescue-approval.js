import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { parse } from "./vendor/shell-quote/index.js";
const MUTATING_FLAGS_EXACT = new Set(["--fix", "--write", "-w", "--apply", "--in-place", "-i"]);
const MUTATING_FLAG_PREFIXES = ["--fix=", "--write=", "--apply=", "--in-place="];
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
export async function createRescueApprovalPolicy(workspaceRoot) {
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
function isFileEditRequest(request) {
    return request.sender === "WriteFile" || request.sender === "StrReplaceFile" || request.action === "edit file";
}
function isShellRequest(request) {
    return request.sender === "Shell" || request.action.includes("command");
}
async function evaluateFileEdit(workspaceRoot, request) {
    const targets = request.display
        .filter(isDiffDisplay)
        .map((entry) => entry.path)
        .filter((value) => typeof value === "string");
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
async function checkApprovedPath(workspaceRoot, rawTargetPath) {
    const absoluteTarget = path.isAbsolute(rawTargetPath)
        ? path.resolve(rawTargetPath)
        : path.resolve(workspaceRoot, rawTargetPath);
    const targetStats = await statIfExists(absoluteTarget);
    if (targetStats?.isSymbolicLink()) {
        return "symlink";
    }
    const nearestExistingAncestor = await findNearestExistingAncestor(path.dirname(absoluteTarget));
    const ancestorRealPath = await realpath(nearestExistingAncestor);
    const candidatePath = path.resolve(ancestorRealPath, path.relative(nearestExistingAncestor, absoluteTarget));
    const relativeToRoot = path.relative(workspaceRoot, candidatePath);
    return (isWithin(workspaceRoot, candidatePath) &&
        !relativeToRoot.split(path.sep).includes(".git"))
        ? "allow"
        : "reject";
}
async function statIfExists(targetPath) {
    try {
        return await lstat(targetPath);
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}
async function findNearestExistingAncestor(targetDirectory) {
    let candidate = targetDirectory;
    while (true) {
        try {
            await access(candidate);
            return candidate;
        }
        catch {
            const parent = path.dirname(candidate);
            if (parent === candidate) {
                return candidate;
            }
            candidate = parent;
        }
    }
}
function extractShellCommand(request) {
    const shellEntry = request.display.find(isShellDisplay);
    if (shellEntry) {
        return shellEntry.command;
    }
    const match = request.description.match(/`([^`]+)`/);
    return match?.[1] ?? null;
}
function validateShellCommand(command) {
    // shell-quote collapses raw newline/carriage-return separators into adjacent tokens, which
    // hides a second command from per-stage validation (`git status\nrm -rf /` parses as
    // ['git','status','rm','-rf','/']). Reject any line-break characters up front so every
    // approved command maps to a single shell invocation.
    if (/[\r\n]/.test(command)) {
        return reject(`Rescue rejects multi-line shell commands: ${JSON.stringify(command)}`);
    }
    if (hasUnsafeShellSyntax(command)) {
        return reject(`Rescue rejects command substitution, process substitution, or backticks: ${command}`);
    }
    const parsed = parse(command);
    const stages = [[]];
    for (const token of parsed) {
        if (typeof token === "string") {
            stages.at(-1).push(token);
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
        const stage = stages[index];
        const allowed = validateShellStage(stage, index > 0 || stages.length > 1);
        if (!allowed.ok) {
            return reject(allowed.reason);
        }
    }
    return { response: "approve" };
}
function validateShellStage(tokens, pipelineMode) {
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
    if (["rg", "grep", "ls", "cat", "pwd", "pyright", "mypy", "eslint", "pytest"].includes(command)) {
        return { ok: true };
    }
    if (pipelineMode && PIPELINE_PLUMBING.has(command)) {
        return { ok: true };
    }
    return { ok: false, reason: `Rescue rejects shell command: ${tokens.join(" ")}` };
}
function hasUnsafeShellSyntax(command) {
    return /[`]/.test(command) || /\$\(/.test(command) || /<\(/.test(command) || />\(/.test(command);
}
function hasMutatingFlag(args) {
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
function validatePackageManagerCommand(command, args) {
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
function isWithin(root, target) {
    return target === root || target.startsWith(`${root}${path.sep}`);
}
function reject(feedback) {
    return {
        response: "reject",
        feedback,
    };
}
function isDiffDisplay(value) {
    return (typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "diff" &&
        "path" in value &&
        typeof value.path === "string");
}
function isShellDisplay(value) {
    return (typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "shell" &&
        "command" in value &&
        typeof value.command === "string");
}
