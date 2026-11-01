import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { parse } from "./vendor/shell-quote/index.js";
// Tool-owned output flags write without shell redirection and therefore bypass
// path checks unless treated as mutating. The `-o` short form is not banned
// globally because tools such as rg and grep use it for read-only behavior;
// per-tool checks handle it. Exact `--output` also rejects the two-argument
// form because this scanner intentionally does not pair arguments.
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
// Flags whose VALUE is executed as a command or external tool are rejected for
// every tool: Git pager overrides and Go -vettool/-exec/-toolexec are direct
// command-execution escapes. Git's -O short form is handled in its own branch
// because it collides with find's read-only -O<level> syntax.
const EXEC_DELEGATING_FLAGS_EXACT = new Set([
    "--open-files-in-pager",
    "-vettool",
    "--vettool",
    "-toolexec",
    "--toolexec",
    "-exec",
    "-execdir",
    // rg --pre/--hostname-bin and GNU sort --compress-program also execute their
    // values as commands.
    "--pre",
    "--hostname-bin",
    "--compress-program",
]);
const EXEC_DELEGATING_FLAG_PREFIXES = [
    "--open-files-in-pager=",
    "-vettool=",
    "--vettool=",
    "-toolexec=",
    "--toolexec=",
    "--pre=",
    "--hostname-bin=",
    "--compress-program=",
];
// Pytest report flags write to arbitrary paths. Test runners execute repo code
// by design, so these checks block known runner-owned report outputs rather
// than every possible write. Match argparse allow_abbrev prefixes as well.
const PYTEST_REPORT_FLAGS = [
    "--junitxml",
    "--junit-xml",
    "--result-log",
    "--report-log",
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
// Per-tool flags that write to an arbitrary path even in the tool's read/check
// mode. Each takes a path value (space- or =-separated);
// `hasFlagFromSet` matches both spellings.
const GO_WRITE_FLAGS = new Set([
    "-coverprofile",
    "-cpuprofile",
    "-memprofile",
    "-blockprofile",
    "-mutexprofile",
    "-trace",
    "-outputdir",
]);
const CARGO_WRITE_FLAGS = new Set(["--target-dir", "--out-dir"]);
// tsc matches option names case-INSENSITIVELY (the compiler lowercases them via
// optionsNameMap), so `--outdir` == `--outDir`. Stored lowercase; matched
// against lowercased arg names.
const TSC_WRITE_FLAGS_LC = new Set([
    "--generatecpuprofile",
    "--generatetrace",
    "--tsbuildinfofile",
    "--outfile",
    "--outdir",
    "--out",
    "--declarationdir",
]);
// ruff --config accepts an inline `key=value` override (`--config 'fix=true'`
// flips ruff into file-rewriting mode) or an arbitrary config path — reject it
// alongside the direct write flags.
const RUFF_WRITE_FLAGS = new Set(["--add-noqa", "--fix-only", "--cache-dir", "--output-file", "--config"]);
const ESLINT_WRITE_FLAGS = new Set(["--cache-location", "--output-file"]);
// ESLint loads and executes the module named by these flags, so an arbitrary
// parser/rules/plugin path is a code-execution escape. Normal linting uses the
// project's own config instead of these overrides.
const ESLINT_CODELOAD_FLAGS = new Set(["--parser", "--rulesdir", "--resolve-plugins-relative-to"]);
// By default mypy does not execute repo code, but config plugins are imported
// (the --config-file exception denied below). Reports/cache can target arbitrary
// paths and --install-types runs pip. Match argparse allow_abbrev prefixes.
const MYPY_WRITE_FLAGS_ABBREV = [
    "--junit-xml",
    "--cache-dir",
    "--install-types",
    // A mypy config file can import plugins, so an arbitrary --config-file is a
    // code-execution escape; normal checks use the workspace mypy.ini.
    "--config-file",
    "--any-exprs-report",
    "--cobertura-xml-report",
    "--html-report",
    "--linecount-report",
    "--linecoverage-report",
    "--lineprecision-report",
    "--memory-xml-report",
    "--txt-report",
    "--xml-report",
    "--xslt-html-report",
    "--xslt-txt-report",
];
/**
 * True if any arg is exactly a flag in `flags` or its `--flag=value` form.
 * Handles both `--flag value` (arg === "--flag") and `--flag=value`.
 */
function hasFlagFromSet(args, flags) {
    return args.some((arg) => {
        const eq = arg.indexOf("=");
        const name = eq === -1 ? arg : arg.slice(0, eq);
        return flags.has(name);
    });
}
/**
 * True if `arg` matches any flag in `flags` accounting for argparse-style prefix
 * ABBREVIATION (`allow_abbrev`, the default for mypy/pytest): argparse accepts
 * any unambiguous prefix of a registered option, so `--jun` resolves to
 * `--junit-xml`. Matches when the arg name (before any `=`) is a prefix of a
 * dangerous flag (abbreviation) OR a dangerous flag is a prefix of the name
 * (exact + trailing). This is a SUPERSET of the argparse-acceptable forms —
 * genuinely ambiguous prefixes that argparse would reject are harmlessly denied
 * too. Min length 3 (`--` + 1 char) avoids matching a bare `--`.
 */
function matchesAbbreviatedFlag(args, flags) {
    return args.some((arg) => {
        const eq = arg.indexOf("=");
        const name = eq === -1 ? arg : arg.slice(0, eq);
        if (name.length < 3)
            return false;
        return flags.some((flag) => flag.startsWith(name) || name.startsWith(flag));
    });
}
/**
 * Direct-read bypass for rescue. Keep this set identical to READ_ONLY_TOOLS in
 * approval-policy.ts; the deliberate duplication must be updated in both places.
 */
const RESCUE_READ_ONLY_TOOLS = new Set([
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
 * `workspaceRoot` is the plugin-owned KIMI_PLUGIN_CC_WORKSPACE_ROOT passed by
 * the hook entry, never the payload cwd; the model cannot forge that per-spawn
 * environment value. `toolName` and `toolInput` are the raw upstream tool call.
 */
export async function evaluateRescueHookRequest(workspaceRoot, toolName, toolInput) {
    if (RESCUE_READ_ONLY_TOOLS.has(toolName)) {
        return { decision: "allow" };
    }
    let root;
    try {
        root = await realpath(workspaceRoot);
    }
    catch (err) {
        return {
            decision: "deny",
            reason: `rescue cannot resolve workspace root: ${err.message}`,
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
        const cwd = isObject(toolInput) ? toolInput.cwd : undefined;
        if (cwd !== undefined) {
            if (typeof cwd !== "string" || cwd.length === 0) {
                return { decision: "deny", reason: "rescue requires Bash cwd to be a non-empty string" };
            }
            try {
                const outcome = await checkApprovedDirectory(root, cwd);
                if (outcome === "symlink") {
                    return { decision: "deny", reason: `rescue rejects Bash cwd symlinks: ${cwd}` };
                }
                if (outcome === "missing") {
                    return { decision: "deny", reason: `rescue rejects Bash cwd that is missing or not a directory: ${cwd}` };
                }
                if (outcome === "reject") {
                    return { decision: "deny", reason: `rescue rejects Bash cwd outside the workspace or inside .git: ${cwd}` };
                }
            }
            catch (err) {
                return { decision: "deny", reason: `rescue cannot inspect Bash cwd ${cwd}: ${err.message}` };
            }
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
                reason: `rescue cannot evaluate ${toolName} input with no path field`,
            };
        }
        return pathDecision(await checkApprovedPath(root, filePath), filePath);
    }
    if (toolName === "MultiEdit") {
        const filePath = extractFilePath(toolInput);
        if (filePath === null) {
            return {
                decision: "deny",
                reason: "rescue cannot evaluate MultiEdit input with no path field",
            };
        }
        return pathDecision(await checkApprovedPath(root, filePath), filePath);
    }
    return {
        decision: "deny",
        reason: `rescue does not allow tool "${toolName}" — only Bash, Write, Edit, MultiEdit (with allowlist checks) and read-only tools are permitted.`,
    };
}
function pathDecision(outcome, filePath) {
    if (outcome === "allow")
        return { decision: "allow" };
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
function extractBashCommand(toolInput) {
    if (!isObject(toolInput))
        return null;
    const command = toolInput.command;
    return typeof command === "string" && command.length > 0 ? command : null;
}
function extractFilePath(toolInput) {
    if (!isObject(toolInput))
        return null;
    // kimi-code Write/Edit/MultiEdit call this field `path`, not Claude Code's
    // `file_path`. Prefer the native key and accept the alias for compatibility.
    const candidate = toolInput.path ?? toolInput.file_path;
    return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * TOCTOU residual: this check runs before kimi-code writes. An attacker with
 * workspace write access could replace the approved path with an escaping
 * symlink before that write. The plugin cannot open-by-fd or recheck inside the
 * Write tool, so the explicit trust boundary is the workspace's existing write
 * controls: such an attacker can already mutate workspace files directly, and
 * rescue is intentionally write-capable.
 */
export async function checkApprovedPath(workspaceRoot, rawTargetPath) {
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
async function checkApprovedDirectory(workspaceRoot, rawCwd) {
    const candidate = path.resolve(workspaceRoot, rawCwd);
    const stats = await statIfExists(candidate);
    if (stats?.isSymbolicLink())
        return "symlink";
    if (!stats?.isDirectory())
        return "missing";
    const resolved = await realpath(candidate);
    return isWithin(workspaceRoot, resolved) &&
        !path.relative(workspaceRoot, resolved).split(path.sep).includes(".git")
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
export function validateShellCommand(command) {
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
        return rejectShell(`Rescue rejects shell syntax outside simple pipelines: ${command}`);
    }
    if (stages.some((stage) => stage.length === 0)) {
        return rejectShell(`Rescue rejects malformed shell pipelines: ${command}`);
    }
    for (let index = 0; index < stages.length; index += 1) {
        const stage = stages[index];
        const allowed = validateShellStage(stage, index > 0 || stages.length > 1);
        if (!allowed.ok) {
            return rejectShell(allowed.reason);
        }
    }
    return { response: "approve" };
}
export function validateShellStage(tokens, pipelineMode) {
    const [command, ...args] = tokens;
    if (!command || path.isAbsolute(command) || command.includes(path.sep)) {
        return { ok: false, reason: `Rescue rejects non-standard shell entrypoints: ${tokens.join(" ")}` };
    }
    if (hasMutatingFlag(args)) {
        return { ok: false, reason: `Rescue rejects mutating shell flags: ${tokens.join(" ")}` };
    }
    if (hasExecDelegatingFlag(args)) {
        return {
            ok: false,
            reason: `Rescue rejects flags that execute an external command/tool (e.g. --open-files-in-pager, -vettool, -exec, -toolexec): ${tokens.join(" ")}`,
        };
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
        // git grep -O/--open-files-in-pager executes its pager value. The long form
        // is caught globally; reject -O here because find uses that spelling for a
        // read-only optimization level.
        if (args.some((arg) => arg === "-O" || /^-O./.test(arg))) {
            return {
                ok: false,
                reason: `Rescue rejects git -O/--open-files-in-pager (executes the pager value as a command): ${tokens.join(" ")}.`,
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
        // tsc option names are case-INSENSITIVE (compiler lowercases them), so match
        // lowercased. `--noemit`/`--noEmit` both suppress JS emit; `--outdir` is the
        // same write flag as `--outDir`.
        const tscLowerNames = args.map((arg) => {
            const eq = arg.indexOf("=");
            return (eq === -1 ? arg : arg.slice(0, eq)).toLowerCase();
        });
        if (!tscLowerNames.includes("--noemit")) {
            return { ok: false, reason: "Rescue allows tsc only with --noEmit." };
        }
        // --noEmit suppresses JS emit but NOT the profile/trace/buildinfo/declaration
        // writers, which write to arbitrary paths.
        if (tscLowerNames.some((name) => TSC_WRITE_FLAGS_LC.has(name))) {
            return {
                ok: false,
                reason: `Rescue rejects tsc write flags (--generateCpuProfile, --generateTrace, --tsBuildInfoFile, --outFile, --outDir, --out, --declarationDir — case-insensitive): ${tokens.join(" ")}.`,
            };
        }
        return { ok: true };
    }
    if (command === "biome") {
        if (args[0] !== "check") {
            return { ok: false, reason: "Rescue allows biome only in check mode." };
        }
        // biome check applies fixes for every --apply/--write/--fix variant,
        // including -unsafe/-only suffixes missed by the global mutating-flag set.
        if (args.some((arg) => /^--(apply|write|fix)/.test(arg))) {
            return {
                ok: false,
                reason: `Rescue rejects biome check write flags (--apply, --apply-unsafe, --write, --fix, and -unsafe/-only variants): ${tokens.join(" ")}.`,
            };
        }
        return { ok: true };
    }
    if (command === "ruff") {
        if (args[0] === "check") {
            if (hasWriteShortFlag(args)) {
                return {
                    ok: false,
                    reason: `Rescue rejects ruff -o (writes the report to a file): ${tokens.join(" ")}.`,
                };
            }
            // --add-noqa/--fix-only rewrite source; --cache-dir/--output-file write
            // outside the workspace (--fix-only dodges the global --fix check).
            if (hasFlagFromSet(args, RUFF_WRITE_FLAGS)) {
                return {
                    ok: false,
                    reason: `Rescue rejects ruff write flags (--add-noqa, --fix-only, --cache-dir, --output-file): ${tokens.join(" ")}.`,
                };
            }
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
        if (!CARGO_SUBCOMMANDS.has(args[0] ?? "")) {
            return { ok: false, reason: `Rescue rejects cargo subcommand: ${tokens.join(" ")}` };
        }
        // --target-dir/--out-dir redirect the whole artifact tree to an arbitrary
        // path outside the workspace.
        if (hasFlagFromSet(args, CARGO_WRITE_FLAGS)) {
            return {
                ok: false,
                reason: `Rescue rejects cargo --target-dir/--out-dir (writes artifacts to an arbitrary path): ${tokens.join(" ")}.`,
            };
        }
        return { ok: true };
    }
    if (command === "go") {
        if (!GO_SUBCOMMANDS.has(args[0] ?? "")) {
            return { ok: false, reason: `Rescue rejects go subcommand: ${tokens.join(" ")}` };
        }
        // go build/test -o writes a binary to an arbitrary path. Exec-delegating
        // -vettool/-exec/-toolexec values are already rejected globally.
        if (hasWriteShortFlag(args)) {
            return {
                ok: false,
                reason: `Rescue rejects go -o (writes a binary to an arbitrary path): ${tokens.join(" ")}.`,
            };
        }
        // Profile/trace/output-dir flags on `go test`/`go build` write to arbitrary
        // paths without `-o`.
        if (hasFlagFromSet(args, GO_WRITE_FLAGS)) {
            return {
                ok: false,
                reason: `Rescue rejects go profile/output flags (-coverprofile, -cpuprofile, -memprofile, -blockprofile, -mutexprofile, -trace, -outputdir write to arbitrary paths): ${tokens.join(" ")}.`,
            };
        }
        return { ok: true };
    }
    if (command === "python" || command === "python3") {
        if (args[0] !== "-m" || args[1] !== "pytest") {
            return { ok: false, reason: `Rescue rejects ${command} shell command: ${tokens.join(" ")}` };
        }
        if (hasPytestReportFlag(args.slice(2))) {
            return {
                ok: false,
                reason: `Rescue rejects pytest report-writing flags (--junitxml, --result-log, --report-log): ${tokens.join(" ")}.`,
            };
        }
        return { ok: true };
    }
    if (command === "npm" || command === "pnpm" || command === "yarn" || command === "bun" || command === "uv") {
        return validatePackageManagerCommand(command, args);
    }
    if (command === "eslint") {
        // Block ESLint's runner-owned report/cache paths. `-o` and joined
        // `-o<path>` need a tool-specific check because rg/grep use `-o` read-only;
        // the long --output-file form is already caught globally. These checks do
        // not make linting read-only: project config and linter code still execute
        // within rescue's repository trust boundary.
        if (args.some((arg) => arg === "-o" || /^-o./.test(arg))) {
            return {
                ok: false,
                reason: `Rescue rejects eslint -o (writes report to a file): ${tokens.join(" ")}. Drop the flag or use a path-checked Write tool call.`,
            };
        }
        // --output-file (long form) is caught globally; --cache-location writes the
        // cache tree to an arbitrary path.
        if (hasFlagFromSet(args, ESLINT_WRITE_FLAGS)) {
            return {
                ok: false,
                reason: `Rescue rejects eslint --cache-location/--output-file (writes to an arbitrary path): ${tokens.join(" ")}.`,
            };
        }
        // --parser/--rulesdir/--resolve-plugins-relative-to LOAD AND EXECUTE a module
        // from the given path — a code-exec escape.
        if (hasFlagFromSet(args, ESLINT_CODELOAD_FLAGS)) {
            return {
                ok: false,
                reason: `Rescue rejects eslint --parser/--rulesdir/--resolve-plugins-relative-to (loads and executes a module from the given path): ${tokens.join(" ")}.`,
            };
        }
        return { ok: true };
    }
    if (command === "mypy") {
        // By default mypy does not execute repo code, but --config-file can import
        // plugins and is denied below. Block report/cache/install outputs and their
        // argparse allow_abbrev prefixes.
        if (matchesAbbreviatedFlag(args, MYPY_WRITE_FLAGS_ABBREV)) {
            return {
                ok: false,
                reason: `Rescue rejects mypy report/cache/install flags (--junit-xml, --*-report, --cache-dir, --install-types — incl. argparse abbreviations — write outside the workspace or run pip): ${tokens.join(" ")}.`,
            };
        }
        return { ok: true };
    }
    if (command === "pytest") {
        // pytest executes repo code by design. Block its known runner-owned report
        // flags, not every write that test code itself can perform.
        if (hasPytestReportFlag(args)) {
            return {
                ok: false,
                reason: `Rescue rejects pytest report-writing flags (--junitxml, --result-log, --report-log): ${tokens.join(" ")}.`,
            };
        }
        return { ok: true };
    }
    if (["rg", "grep", "ls", "cat", "pwd", "pyright"].includes(command)) {
        return { ok: true };
    }
    if (pipelineMode && PIPELINE_PLUMBING.has(command)) {
        // sort -o and uniq's second positional are output writes, unnecessary for
        // pipeline stages that read stdin.
        if (hasWriteShortFlag(args) || args.includes("--output")) {
            return {
                ok: false,
                reason: `Rescue rejects ${command} -o/--output (writes to an arbitrary file): ${tokens.join(" ")}.`,
            };
        }
        // `sort -o FILE` / `-T DIR` write to an arbitrary path — including BUNDLED
        // short-flag clusters (`sort -rT /tmp`, `-ro file`) that the generic `-o`
        // check above misses because the cluster starts with `-r` (Opus review
        // 2026-07-17). `sortShortClusterWrites` scans the cluster with getopt
        // semantics; the long `--temporary-directory` form is matched separately.
        if (command === "sort" &&
            (args.some((arg) => sortShortClusterWrites(arg)) ||
                args.includes("--temporary-directory") ||
                args.some((arg) => arg.startsWith("--temporary-directory=")))) {
            return {
                ok: false,
                reason: `Rescue rejects sort -o/-T (incl. bundled short clusters like -rT) and --temporary-directory (write to an arbitrary path): ${tokens.join(" ")}.`,
            };
        }
        // `uniq IN OUT` writes OUT; `-` (stdin) counts as an operand, so
        // `uniq - /tmp/out` is a write. Two+ operands ⇒ an output file is present.
        if (command === "uniq" &&
            args.filter((arg) => arg === "-" || !arg.startsWith("-")).length >= 2) {
            return {
                ok: false,
                reason: `Rescue rejects uniq with an output-file argument (uniq IN OUT writes OUT): ${tokens.join(" ")}.`,
            };
        }
        return { ok: true };
    }
    return { ok: false, reason: `Rescue rejects shell command: ${tokens.join(" ")}` };
}
class ShellExpansionError extends Error {
}
/**
 * Env callback for `parse(command, env)`. shell-quote invokes it ONLY for a
 * `$VAR`/`${…}` expansion that bash would actually perform — i.e. OUTSIDE single
 * quotes (single-quoted `$` is literal). Throwing on any non-empty key rejects
 * every real reference — including `$IFS`, `$HOME`, and double-quoted `"$PAT"` —
 * quote-aware and for free. An EMPTY key is a trailing/literal `$` (`grep 'end$'`,
 * `awk '{print $}'`), which bash does not expand, so it returns a literal `$`.
 */
function throwingExpansionEnv(key) {
    if (key !== "")
        throw new ShellExpansionError(key);
    return "$";
}
/**
 * True if the command performs any `$VAR`/`${…}` parameter expansion. Uses the
 * vendored parser's own quote tracking (via the throwing env), so it is immune
 * to the two ways the default empty-env parse DIVERGES from bash and hides a
 * smuggled flag from every per-flag check:
 *   - `${VAR:-flag}` collapsed to an empty token (no `:-`-default modelling), and
 *   - `$IFS`-gluing (`rg x$IFS--pre$IFS'sh'` → one token here, but bash splits it
 *     into `rg x --pre sh` — an RCE).
 * A malformed substitution (`${}`, unterminated) throws a plain parser Error;
 * that is itself unsafe to pass through, so any throw ⇒ unsafe (fail closed).
 */
function hasShellExpansion(command) {
    try {
        parse(command, throwingExpansionEnv);
        return false;
    }
    catch {
        return true;
    }
}
/**
 * True if `s[open]` opens a bash BRACE EXPANSION (`{a,b}` / `{a..b}`): a matching
 * `}` with a top-level `,` or `..` between. bash expands it into multiple words
 * BEFORE the allowlist sees them (`find . {-delete,}` → `find . -delete`), while
 * shell-quote keeps it as one literal token — so a smuggled flag/action hides in
 * the group. `${…}` (param expansion, handled by `hasShellExpansion`) and a
 * quoted group are not brace expansion.
 */
function isBraceExpansion(s, open) {
    if (open > 0 && s[open - 1] === "$")
        return false;
    let depth = 0;
    let sawSeparator = false;
    for (let j = open; j < s.length; j += 1) {
        const ch = s[j];
        if (ch === "\\") {
            j += 1;
            continue;
        }
        if (ch === "'" || ch === '"')
            return false;
        if (ch === "{") {
            depth += 1;
        }
        else if (ch === "}") {
            depth -= 1;
            if (depth === 0)
                return sawSeparator;
        }
        else if (depth === 1 && (ch === "," || (ch === "." && s[j + 1] === "."))) {
            sawSeparator = true;
        }
    }
    return false;
}
/**
 * Quote-aware scan for dangerous constructs the vendored parser does NOT surface
 * as a `$VAR` expansion (so `hasShellExpansion` can't see them): backticks,
 * command/process substitution, the `$'…'`/`$"…"` quoting openers (bash decodes
 * `\xNN` etc. into bytes that can form a flag — shell-quote does not), and brace
 * expansion. SINGLE-quoted spans are fully inert (bash suppresses everything), so
 * a `` ` ``/`$`/`{` inside them is never flagged — that removes the blind-regex
 * false positives (`grep 'foo $'`, `grep '$(x)'`, `find -name '*.{a,b}'`). DOUBLE
 * quotes are NOT inert: `$(…)` and backticks stay ACTIVE inside them (only `$VAR`
 * detection is delegated to `hasShellExpansion`), so the double-quote span is
 * scanned for those two. A backslash escapes the next char in either context.
 */
function scanUnsafeUnquoted(command) {
    const n = command.length;
    let i = 0;
    while (i < n) {
        const c = command[i];
        if (c === "\\") {
            i += 2;
            continue;
        }
        if (c === "'") {
            const end = command.indexOf("'", i + 1);
            if (end === -1)
                return true; // unterminated quote → unsafe
            i = end + 1;
            continue;
        }
        if (c === '"') {
            // Double quotes keep command substitution active (`"$(id)"` runs `id`;
            // `` "`id`" `` too), so scan the span for them. `"\$(x)"` / `` "\`x`" `` are
            // escaped → literal → allowed. `$VAR`/`${…}` are caught by hasShellExpansion.
            i += 1;
            while (i < n && command[i] !== '"') {
                if (command[i] === "\\") {
                    i += 2;
                    continue;
                }
                if (command[i] === "`")
                    return true; // backtick cmd-sub (active in "…")
                if (command[i] === "$" && command[i + 1] === "(")
                    return true; // $(…) cmd-sub (active in "…")
                i += 1;
            }
            if (i >= n)
                return true; // unterminated quote → unsafe
            i += 1;
            continue;
        }
        if (c === "`")
            return true; // backtick command substitution
        if (c === "$" && (command[i + 1] === "'" || command[i + 1] === '"'))
            return true; // $'…' / $"…"
        if (c === "$" && command[i + 1] === "(")
            return true; // $(…) command substitution
        if ((c === "<" || c === ">") && command[i + 1] === "(")
            return true; // <(…) / >(…)
        if (c === "{" && isBraceExpansion(command, i))
            return true;
        i += 1;
    }
    return false;
}
/**
 * Syntax gate before the per-flag allowlist. Reject the expansion/substitution
 * classes shell-quote does not model: backticks, command/process substitution,
 * `$'…'`/`$"…"` openers, brace expansion, and `$VAR`/`${…}` parameter expansion
 * including `$IFS` gluing and default-value forms. Two complementary quote-aware
 * passes prevent these forms from smuggling flags or commands downstream.
 */
export function hasUnsafeShellSyntax(command) {
    return scanUnsafeUnquoted(command) || hasShellExpansion(command);
}
export function hasMutatingFlag(args) {
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
/** True if any argument delegates execution to a command or external tool. */
export function hasExecDelegatingFlag(args) {
    return args.some((arg) => EXEC_DELEGATING_FLAGS_EXACT.has(arg) ||
        EXEC_DELEGATING_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix)));
}
/**
 * Per-tool check for `-o`, joined `-ofile`, and `-o=file` where that flag writes
 * output (go, sort, ruff, and ESLint). It is not global because rg/grep use `-o`
 * for read-only matching. Long --output forms are covered by the mutating set.
 */
export function hasWriteShortFlag(args) {
    return args.some((arg) => arg === "-o" || /^-o./.test(arg));
}
/**
 * True if a GNU `sort` short-flag token writes a file — including a BUNDLED
 * cluster (`-rT DIR`, `-ro FILE`) the plain `-o` check misses. getopt consumes a
 * cluster left to right; the first argument-taking option grabs the rest as its
 * value, so an `o`/`T` AFTER a `-t`/`-k`/`-S` (sort's other arg-taking options)
 * is that option's value, not a write flag.
 */
function sortShortClusterWrites(token) {
    if (token.length < 2 || token[0] !== "-" || token[1] === "-")
        return false;
    for (let i = 1; i < token.length; i += 1) {
        const ch = token[i];
        if (ch === "o" || ch === "T")
            return true; // -o output / -T temp dir → write
        if (ch === "t" || ch === "k" || ch === "S")
            return false; // arg-taking: rest is its value
    }
    return false;
}
function hasPytestReportFlag(args) {
    return matchesAbbreviatedFlag(args, PYTEST_REPORT_FLAGS);
}
export function validatePackageManagerCommand(command, args) {
    // Direct <pm> test executes the repository's test script by design, like
    // pytest/go test/cargo test, and remains inside the documented test-runner
    // trust boundary. `run <arbitrary-script>` is instead a general script
    // executor (dev/deploy/publish), so this deliberate test/run asymmetry stays.
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
function rejectShell(feedback) {
    return { response: "reject", feedback };
}
