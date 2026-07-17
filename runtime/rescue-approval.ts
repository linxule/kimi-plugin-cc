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
// Flags whose VALUE is executed as a command or external tool (RCE class).
// Whole-repo audit 2026-05-28 (report 43) found that allowlisted commands
// were trusted with arbitrary flags. No allowlisted read-only command uses
// these legitimately, so they are rejected for EVERY tool:
//   - `git grep --open-files-in-pager=touch /tmp/x needle` → git runs `touch`
//     (F1, CRITICAL — same pager-smuggling class as the pre-subcommand
//     `git -c core.pager=` defense, but via a subcommand flag)
//   - `go vet -vettool=<bin>`, `go test -exec <bin>` / `-toolexec <bin>` → runs <bin>
// The git `-O` short form of --open-files-in-pager is handled in the git
// branch (it collides with `find -O<level>`, so it can't be banned globally).
const EXEC_DELEGATING_FLAGS_EXACT = new Set([
  "--open-files-in-pager",
  "-vettool",
  "--vettool",
  "-toolexec",
  "--toolexec",
  "-exec",
  "-execdir",
  // `rg --pre <CMD>` runs CMD as a per-file preprocessor (RCE); `rg --hostname-bin
  // <CMD>` runs CMD to resolve the hostname; `sort --compress-program <CMD>` execs
  // CMD to (de)compress spill files (RCE on GNU sort). Verified 2026-07-17.
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
// Pytest/python -m pytest report flags write to arbitrary paths. Test
// runners execute repo code by design (documented trust boundary, report 43
// F4); this only stops them writing OUTSIDE the workspace. pytest parses argv
// with argparse (allow_abbrev), so match these as abbreviation-aware prefixes.
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
// mode (verified 2026-07-17). Each takes a path value (space- or =-separated);
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
// against lowercased arg names (Opus review 2026-07-17).
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
// alongside the direct write flags (Fable review 2026-07-17).
const RUFF_WRITE_FLAGS = new Set(["--add-noqa", "--fix-only", "--cache-dir", "--output-file", "--config"]);
const ESLINT_WRITE_FLAGS = new Set(["--cache-location", "--output-file"]);
// eslint LOADS AND EXECUTES the module these point at (a custom parser, a rules
// directory, or the plugin-resolution root) — an arbitrary path is a code-exec
// escape from the "linters run repo code" boundary. A reviewer uses the
// project's eslintrc, not these CLI flags (Fable review 2026-07-17).
const ESLINT_CODELOAD_FLAGS = new Set(["--parser", "--rulesdir", "--resolve-plugins-relative-to"]);

// mypy runs no repo code, but writes reports/cache to arbitrary paths and can
// pip-install. mypy uses argparse (allow_abbrev), so ANY unambiguous prefix of
// these resolves (`--jun`→--junit-xml, `--html-rep`→--html-report,
// `--cache-di`→--cache-dir); matched abbreviation-aware, not exact.
const MYPY_WRITE_FLAGS_ABBREV = [
  "--junit-xml",
  "--cache-dir",
  "--install-types",
  // A mypy config file can set `plugins = /path/to/plugin.py`, which mypy
  // IMPORTS (executes) — an arbitrary `--config-file` is a code-exec escape
  // (Fable review 2026-07-17). A reviewer uses the workspace mypy.ini.
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
function hasFlagFromSet(args: string[], flags: ReadonlySet<string>): boolean {
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
function matchesAbbreviatedFlag(args: string[], flags: readonly string[]): boolean {
  return args.some((arg) => {
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (name.length < 3) return false;
    return flags.some((flag) => flag.startsWith(name) || name.startsWith(flag));
  });
}

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
  // kimi-code's Write/Edit tools name the path field `path`
  // (packages/agent-core/src/tools/builtin/file/{write,edit}.ts:
  // z.object({ path: ... })) — NOT `file_path` (the Anthropic/Claude Code
  // convention). The original `file_path`-only read meant EVERY real Write/Edit
  // was denied with "no path field" (fail-closed but broken) for rescue/pursue/
  // swarm-write — invisible to the unit tests, which all mock `file_path`, and
  // only caught once the write-swarm real-binary smoke landed (v1.4.1). Prefer
  // the kimi-code key; accept `file_path` too for forward/backward compat.
  const candidate = toolInput.path ?? toolInput.file_path;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
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
    // `git grep -O[<cmd>]` / `--open-files-in-pager[=<cmd>]` runs <cmd> as the
    // pager (report 43 F1, CRITICAL RCE). The long form is caught by the
    // global exec-delegating check above; the `-O` short form collides with
    // `find -O<level>` so it is rejected here, git-locally.
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
    // same write flag as `--outDir` (Opus review 2026-07-17).
    const tscLowerNames = args.map((arg) => {
      const eq = arg.indexOf("=");
      return (eq === -1 ? arg : arg.slice(0, eq)).toLowerCase();
    });
    if (!tscLowerNames.includes("--noemit")) {
      return { ok: false, reason: "Rescue allows tsc only with --noEmit." };
    }
    // --noEmit suppresses JS emit but NOT the profile/trace/buildinfo/declaration
    // writers, which write to arbitrary paths (verified 2026-07-17).
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
    // biome check applies fixes with any --apply/--write/--fix variant, incl. the
    // -unsafe/-only suffixes that dodge the global exact/prefix mutating-flag set
    // (--apply is caught globally, --apply-unsafe is not). Verified 2026-07-17.
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
    // path outside the workspace (verified 2026-07-17).
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
    // `go build -o PATH` / `go test -c -o PATH` write a binary to an
    // arbitrary path (report 43 F3). -vettool / -exec / -toolexec are caught
    // by the global exec-delegating check above.
    if (hasWriteShortFlag(args)) {
      return {
        ok: false,
        reason: `Rescue rejects go -o (writes a binary to an arbitrary path): ${tokens.join(" ")}.`,
      };
    }
    // Profile/trace/output-dir flags on `go test`/`go build` write to arbitrary
    // paths without `-o` (verified 2026-07-17).
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
    // ESLint's `-o` short form is `--output-file` — writes the lint
    // report to an arbitrary path. The long form `--output-file=` is
    // already caught by MUTATING_FLAG_PREFIXES; the short form needs an
    // eslint-specific check because `-o` is a legitimate read flag in
    // other tools (e.g. `rg -o` = --only-matching). Audit re-review
    // (report 34 Codex HIGH) found this gap. `--fix` is also already
    // in MUTATING_FLAGS_EXACT, so the eslint command surface is now
    // read-only by construction.
    // Match `-o` and the joined `-o<path>` spelling (eslint accepts both).
    if (args.some((arg) => arg === "-o" || /^-o./.test(arg))) {
      return {
        ok: false,
        reason: `Rescue rejects eslint -o (writes report to a file): ${tokens.join(" ")}. Drop the flag or use a path-checked Write tool call.`,
      };
    }
    // --output-file (long form) is caught globally; --cache-location writes the
    // cache tree to an arbitrary path (verified 2026-07-17).
    if (hasFlagFromSet(args, ESLINT_WRITE_FLAGS)) {
      return {
        ok: false,
        reason: `Rescue rejects eslint --cache-location/--output-file (writes to an arbitrary path): ${tokens.join(" ")}.`,
      };
    }
    // --parser/--rulesdir/--resolve-plugins-relative-to LOAD AND EXECUTE a module
    // from the given path (Fable review 2026-07-17) — a code-exec escape.
    if (hasFlagFromSet(args, ESLINT_CODELOAD_FLAGS)) {
      return {
        ok: false,
        reason: `Rescue rejects eslint --parser/--rulesdir/--resolve-plugins-relative-to (loads and executes a module from the given path): ${tokens.join(" ")}.`,
      };
    }
    return { ok: true };
  }

  if (command === "mypy") {
    // mypy runs no repo code, but writes reports/cache to arbitrary paths and can
    // pip-install. Matched abbreviation-aware because argparse allow_abbrev lets
    // `--jun`→--junit-xml, `--html-rep`→--html-report, `--cache-di`→--cache-dir
    // (verified 2026-07-17).
    if (matchesAbbreviatedFlag(args, MYPY_WRITE_FLAGS_ABBREV)) {
      return {
        ok: false,
        reason: `Rescue rejects mypy report/cache/install flags (--junit-xml, --*-report, --cache-dir, --install-types — incl. argparse abbreviations — write outside the workspace or run pip): ${tokens.join(" ")}.`,
      };
    }
    return { ok: true };
  }

  if (command === "pytest") {
    // pytest executes repo code by design (documented trust boundary, report
    // 43 F4); block only its file-writing report flags so it can't write
    // outside the workspace.
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
    // `sort -o FILE` writes anywhere (report 43 F2); `uniq IN OUT` writes its
    // second positional. Piped plumbing reads stdin → it needs neither.
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
    if (
      command === "sort" &&
      (args.some((arg) => sortShortClusterWrites(arg)) ||
        args.includes("--temporary-directory") ||
        args.some((arg) => arg.startsWith("--temporary-directory=")))
    ) {
      return {
        ok: false,
        reason: `Rescue rejects sort -o/-T (incl. bundled short clusters like -rT) and --temporary-directory (write to an arbitrary path): ${tokens.join(" ")}.`,
      };
    }
    // `uniq IN OUT` writes OUT; `-` (stdin) counts as an operand, so
    // `uniq - /tmp/out` is a write. Two+ operands ⇒ an output file is present.
    if (
      command === "uniq" &&
      args.filter((arg) => arg === "-" || !arg.startsWith("-")).length >= 2
    ) {
      return {
        ok: false,
        reason: `Rescue rejects uniq with an output-file argument (uniq IN OUT writes OUT): ${tokens.join(" ")}.`,
      };
    }
    return { ok: true };
  }

  return { ok: false, reason: `Rescue rejects shell command: ${tokens.join(" ")}` };
}

/** Thrown by `throwingExpansionEnv` when the parser resolves a real variable. */
class ShellExpansionError extends Error {}

/**
 * Env callback for `parse(command, env)`. shell-quote invokes it ONLY for a
 * `$VAR`/`${…}` expansion that bash would actually perform — i.e. OUTSIDE single
 * quotes (single-quoted `$` is literal). Throwing on any non-empty key rejects
 * every real reference — including `$IFS`, `$HOME`, and double-quoted `"$PAT"` —
 * quote-aware and for free. An EMPTY key is a trailing/literal `$` (`grep 'end$'`,
 * `awk '{print $}'`), which bash does not expand, so it returns a literal `$`.
 */
function throwingExpansionEnv(key: string): string {
  if (key !== "") throw new ShellExpansionError(key);
  return "$";
}

/**
 * True if the command performs any `$VAR`/`${…}` parameter expansion. Uses the
 * vendored parser's own quote tracking (via the throwing env), so it is immune
 * to the two ways the default empty-env parse DIVERGES from bash and hides a
 * smuggled flag from every per-flag check:
 *   - `${VAR:-flag}` collapsed to an empty token (no `:-`-default modelling), and
 *   - `$IFS`-gluing (`rg x$IFS--pre$IFS'sh'` → one token here, but bash splits it
 *     into `rg x --pre sh` — an RCE). The word-boundary regex this replaced
 *     missed the glued form because `$` was preceded by a letter, not whitespace.
 * A malformed substitution (`${}`, unterminated) throws a plain parser Error;
 * that is itself unsafe to pass through, so any throw ⇒ unsafe (fail closed).
 */
function hasShellExpansion(command: string): boolean {
  try {
    parse(command, throwingExpansionEnv);
    return false;
  } catch {
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
function isBraceExpansion(s: string, open: number): boolean {
  if (open > 0 && s[open - 1] === "$") return false;
  let depth = 0;
  let sawSeparator = false;
  for (let j = open; j < s.length; j += 1) {
    const ch = s[j]!;
    if (ch === "\\") {
      j += 1;
      continue;
    }
    if (ch === "'" || ch === '"') return false;
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return sawSeparator;
    } else if (depth === 1 && (ch === "," || (ch === "." && s[j + 1] === "."))) {
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
function scanUnsafeUnquoted(command: string): boolean {
  const n = command.length;
  let i = 0;
  while (i < n) {
    const c = command[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return true; // unterminated quote → unsafe
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
        if (command[i] === "`") return true; // backtick cmd-sub (active in "…")
        if (command[i] === "$" && command[i + 1] === "(") return true; // $(…) cmd-sub (active in "…")
        i += 1;
      }
      if (i >= n) return true; // unterminated quote → unsafe
      i += 1;
      continue;
    }
    if (c === "`") return true; // backtick command substitution
    if (c === "$" && (command[i + 1] === "'" || command[i + 1] === '"')) return true; // $'…' / $"…"
    if (c === "$" && command[i + 1] === "(") return true; // $(…) command substitution
    if ((c === "<" || c === ">") && command[i + 1] === "(") return true; // <(…) / >(…)
    if (c === "{" && isBraceExpansion(command, i)) return true;
    i += 1;
  }
  return false;
}

/**
 * Keystone syntax gate — runs BEFORE the per-flag allowlist in
 * `validateShellCommand`. Rejects any shell construct that bash would expand,
 * substitute, or split in a way the vendored shell-quote parser does NOT model,
 * because such a divergence smuggles a flag/command past every downstream check.
 * Two complementary, quote-aware passes: `scanUnsafeUnquoted` (backticks,
 * command/process substitution, `$'…'`/`$"…"` openers, brace expansion) and
 * `hasShellExpansion` (`$VAR`/`${…}` parameter expansion, incl. `$IFS`-gluing and
 * `${VAR:-flag}`). Verified against a bypass + false-positive battery 2026-07-17.
 */
export function hasUnsafeShellSyntax(command: string): boolean {
  return scanUnsafeUnquoted(command) || hasShellExpansion(command);
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

/**
 * True if any arg is a flag whose value is executed as a command/tool.
 * Rejected for every command (report 43 F1/F3).
 */
export function hasExecDelegatingFlag(args: string[]): boolean {
  return args.some(
    (arg) =>
      EXEC_DELEGATING_FLAGS_EXACT.has(arg) ||
      EXEC_DELEGATING_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix)),
  );
}

/**
 * True if any arg is the bare `-o` short form (`-o`, `-ofile`, `-o=file`),
 * the "write output to file" flag for go / sort / ruff. NOT banned globally:
 * `rg -o` / `grep -o` (--only-matching) are read-only, so this is applied
 * per-tool where `-o` writes a file (report 43 F2/F3/F5). The long
 * `--output*` forms are already covered by MUTATING_FLAG_PREFIXES.
 */
export function hasWriteShortFlag(args: string[]): boolean {
  return args.some((arg) => arg === "-o" || /^-o./.test(arg));
}

/**
 * True if a GNU `sort` short-flag token writes a file — including a BUNDLED
 * cluster (`-rT DIR`, `-ro FILE`) the plain `-o` check misses. getopt consumes a
 * cluster left to right; the first argument-taking option grabs the rest as its
 * value, so an `o`/`T` AFTER a `-t`/`-k`/`-S` (sort's other arg-taking options)
 * is that option's value, not a write flag. (Opus review 2026-07-17.)
 */
function sortShortClusterWrites(token: string): boolean {
  if (token.length < 2 || token[0] !== "-" || token[1] === "-") return false;
  for (let i = 1; i < token.length; i += 1) {
    const ch = token[i]!;
    if (ch === "o" || ch === "T") return true; // -o output / -T temp dir → write
    if (ch === "t" || ch === "k" || ch === "S") return false; // arg-taking: rest is its value
  }
  return false;
}

function hasPytestReportFlag(args: string[]): boolean {
  return matchesAbbreviatedFlag(args, PYTEST_REPORT_FLAGS);
}

export function validatePackageManagerCommand(
  command: string,
  args: string[],
): { ok: true } | { ok: false; reason: string } {
  // Direct `<pm> test` is the test-runner shorthand. Like `pytest`/`go test`/
  // `cargo test`, it EXECUTES repo code by design (the package.json "test"
  // script) — the SAME documented trust boundary (docs/safety.md): a test runner
  // in a write-capable rescue/pursue run can already run arbitrary repo code, so
  // rejecting `test` would only cripple the expected surface without adding
  // safety. `run <arbitrary-script>` below is different: it is a fully general
  // script executor (dev/deploy/publish), not a test entry point, so it stays
  // rejected. (Fable review 2026-07-17 flagged the `test`/`run` asymmetry — this
  // is the deliberate resolution, not an oversight.)
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
