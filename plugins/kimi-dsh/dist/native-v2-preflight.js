// Native-v2 pre-spawn safety preflight.
//
// Why this module exists:
//
//   kimi-code 0.42.0 removed the legacy-v1 engine. agent-core-v2's ONLY
//   chain-breaking `event.allow()` is the plan-file guard
//   (features/plan/planService.ts:110), and it fires only while plan mode is
//   ACTIVE. Plan mode can arm in a plugin-spawned `kimi -p` session in exactly
//   three ways:
//     A. `default_plan_mode = true` in <KIMI_CODE_HOME>/config.toml, read ONCE
//        inside sessions.create() (single user file; no env, argv or project
//        overlay; invalid values fall back to false upstream);
//     B. the EnterPlanMode tool (already hook-denied for every label);
//     C. resuming a session whose agent wire journal holds a durable
//        `plan_mode.enter` record (restore() folds ONLY agents/*/wire.jsonl).
//   This module closes A and C before any process is spawned, and refuses the
//   v2-only experimental features (tower, subagent fork) that this plugin does
//   not certify. B stays in runtime/hooks/approval-policy.ts.
//
// Contract:
//   - Pure inspection: never writes, never rewrites operator config, never
//     clears saved plan state. Refusals name the setting, never dump config.
//   - Fail-closed: unparseable/unreadable/oversized inputs refuse.
//   - Strictly more conservative than upstream (a non-boolean value that
//     upstream would ignore still refuses here).
//   - Refusals here are NOT /kimi:setup-recoverable and must never be
//     described as hook drift.
import { constants as fsConstants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { RuntimeError } from "./errors.js";
import { parse as parseToml } from "./vendor/smol-toml/parse.js";
/** `<kimiHome>/config.toml` is small hand-edited config, never a data file. */
const CONFIG_MAX_BYTES = 1 * 1024 * 1024;
/** A single agent's wire journal; generous but bounded so a runaway session
 * log can't turn a preflight check into an unbounded read. */
const JOURNAL_MAX_BYTES = 64 * 1024 * 1024;
/** Bounded directory enumeration so a pathological sessions/ tree refuses
 * instead of scanning forever. */
const DIR_ENUM_CAP = 4096;
const TRUTHY_STRINGS = new Set(["1", "true", "yes", "on"]);
function isTruthySelectorValue(value) {
    if (value === true)
        return true;
    if (typeof value === "string")
        return TRUTHY_STRINGS.has(value.trim().toLowerCase());
    return false;
}
/**
 * Read a small file with the same no-follow, size-capped posture as the
 * config lock reader in runtime/hooks/config-safety.ts. Never partial-reads:
 * an oversized file refuses rather than being silently truncated.
 */
async function readSmallFileSafe(filePath, maxBytes) {
    let handle;
    try {
        handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT")
            return { kind: "absent" };
        if (code === "ELOOP")
            return { kind: "unreadable", reason: "path is a symbolic link" };
        return { kind: "unreadable", reason: error.message };
    }
    try {
        const stats = await handle.stat({ bigint: true });
        if (!stats.isFile())
            return { kind: "unreadable", reason: "not a regular file" };
        if (stats.size > BigInt(maxBytes)) {
            return { kind: "unreadable", reason: `exceeds ${maxBytes} byte cap` };
        }
        const size = Number(stats.size);
        const buffer = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
            const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
            if (bytesRead === 0)
                break;
            offset += bytesRead;
        }
        return { kind: "ok", contents: buffer.subarray(0, offset).toString("utf8") };
    }
    finally {
        await handle.close().catch(() => undefined);
    }
}
/** Read+parse `<kimiHome>/config.toml`. `config: null` means the file is
 * absent (upstream default applies); any read/parse failure fails closed. */
async function readParsedConfig(kimiHome) {
    const configPath = path.join(kimiHome, "config.toml");
    const read = await readSmallFileSafe(configPath, CONFIG_MAX_BYTES);
    if (read.kind === "absent")
        return { kind: "ok", config: null };
    if (read.kind === "unreadable") {
        return { kind: "unreadable", reason: `${configPath} could not be read safely: ${read.reason}` };
    }
    try {
        return { kind: "ok", config: parseToml(read.contents) };
    }
    catch (error) {
        return {
            kind: "unreadable",
            reason: `${configPath} could not be parsed as TOML: ${error.message}`,
        };
    }
}
/**
 * Upstream's EXACT top-level key normalization
 * (`packages/agent-core-v2/src/app/config/toml.ts::snakeToCamel`, applied to
 * every top-level key by `transformTomlData` before the config registry sees
 * it). The plan section is registered under the camelCase domain
 * `defaultPlanMode`, so the operator can spell it `default_plan_mode`,
 * `defaultPlanMode`, `default_planMode`, … and upstream reads the same
 * setting. The plugin MUST inspect the same normalized view — a literal
 * `default_plan_mode` check lets `defaultPlanMode = true` arm plan mode.
 * Pinned by tests/audit/v2-tag-scan.test.ts (toml.ts hash + regex text).
 * NOTE: the `[experimental]` section registers its own `fromToml` that keeps
 * raw keys, and its flag ids are snake_case (`subagent_fork`), so that table
 * is deliberately NOT normalized here.
 */
export function upstreamSnakeToCamel(key) {
    return key.replace(/_([a-z])/g, (_match, ch) => ch.toUpperCase());
}
const DEFAULT_PLAN_MODE_DOMAIN = "defaultPlanMode";
/**
 * Inspect `<kimiHome>/config.toml` for the upstream default-plan-mode setting
 * under EVERY spelling upstream normalizes to the `defaultPlanMode` domain.
 * ENOENT → ok:"absent" (upstream default is false; the missing hook is caught
 * separately). Any other read error, a symlinked file (open with O_NOFOLLOW),
 * an oversized file, or a TOML parse failure → refuse "v2-config-unreadable".
 * Every matching key holding literal boolean `false` → ok:"false". ANY matching
 * key with any other value (true, string, number, table, array) → refuse
 * "v2-plan-mode-configured", naming the raw key(s) found.
 */
export async function inspectPlanModeConfig(kimiHome) {
    const parsed = await readParsedConfig(kimiHome);
    if (parsed.kind === "unreadable") {
        return { kind: "refuse", refusalKind: "v2-config-unreadable", reason: parsed.reason };
    }
    if (parsed.config === null)
        return { kind: "ok", setting: "absent" };
    const matching = Object.entries(parsed.config).filter(([rawKey]) => upstreamSnakeToCamel(rawKey) === DEFAULT_PLAN_MODE_DOMAIN);
    if (matching.length === 0)
        return { kind: "ok", setting: "absent" };
    const offending = matching.filter(([, value]) => value !== false).map(([rawKey]) => rawKey);
    if (offending.length === 0)
        return { kind: "ok", setting: "false" };
    const configPath = path.join(kimiHome, "config.toml");
    return {
        kind: "refuse",
        refusalKind: "v2-plan-mode-configured",
        reason: `\`${offending.join("`, `")}\` (upstream setting \`default_plan_mode\`) is set in ${configPath} and is not \`false\`.`,
    };
}
/**
 * Refuse v2-only experimental features this plugin does not certify.
 * Sources (per-flag precedence upstream is env → [experimental] config →
 * master flag → default): the `[experimental]` table keys `tower` and
 * `subagent_fork` in `<kimiHome>/config.toml`, and the per-flag env vars
 * `KIMI_CODE_EXPERIMENTAL_TOWER` / `KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK`.
 * Truthy = boolean true, or a string in {"1","true","yes","on"} (trimmed,
 * case-insensitive). The master `KIMI_CODE_EXPERIMENTAL_FLAG` is handled by
 * kimi-engine.ts::assertNoUnsafeExperimentalSelector, not here.
 * Config read errors follow inspectPlanModeConfig's fail-closed rules.
 */
export async function inspectExperimentalSelectors(kimiHome, env) {
    const parsed = await readParsedConfig(kimiHome);
    if (parsed.kind === "unreadable") {
        return { kind: "refuse", selectors: [], reason: parsed.reason };
    }
    const selectors = [];
    const experimental = parsed.config?.["experimental"];
    if (experimental !== null && typeof experimental === "object" && !Array.isArray(experimental)) {
        const table = experimental;
        if (isTruthySelectorValue(table["tower"]))
            selectors.push("config:[experimental].tower");
        if (isTruthySelectorValue(table["subagent_fork"])) {
            selectors.push("config:[experimental].subagent_fork");
        }
    }
    if (isTruthySelectorValue(env.KIMI_CODE_EXPERIMENTAL_TOWER)) {
        selectors.push("env:KIMI_CODE_EXPERIMENTAL_TOWER");
    }
    if (isTruthySelectorValue(env.KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK)) {
        selectors.push("env:KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK");
    }
    if (selectors.length === 0)
        return { kind: "ok" };
    return {
        kind: "refuse",
        selectors,
        reason: `Refusing v2-only experimental feature(s) not certified by kimi-plugin-cc: ${selectors.join(", ")}.`,
    };
}
async function boundedReaddir(dirPath, cap) {
    let entries;
    try {
        entries = await readdir(dirPath, { withFileTypes: true });
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT" || code === "ENOTDIR")
            return { kind: "absent" };
        // Any other enumeration failure (EACCES, EIO, ELOOP, …) must land in the
        // classified `unavailable` refusal, not escape as an untyped fs error.
        return { kind: "unreadable", reason: `${dirPath}: ${error.message}` };
    }
    if (entries.length > cap)
        return { kind: "cap-exceeded" };
    return { kind: "ok", entries };
}
async function openJournalSafely(journalPath, maxBytes) {
    let handle;
    try {
        // O_NONBLOCK so a FIFO planted at the journal path (no writer) does not
        // block the open() indefinitely — the regular-file check below then
        // refuses it. O_NOFOLLOW refuses a symlinked final component.
        handle = await open(journalPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT")
            return { kind: "unavailable", reason: "journal not found" };
        if (code === "ELOOP")
            return { kind: "unavailable", reason: "journal path is a symbolic link" };
        return { kind: "unavailable", reason: error.message };
    }
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile()) {
        await handle.close().catch(() => undefined);
        return { kind: "unavailable", reason: "journal is not a regular file" };
    }
    if (stats.size > BigInt(maxBytes)) {
        await handle.close().catch(() => undefined);
        return { kind: "unavailable", reason: `journal exceeds ${maxBytes} byte cap` };
    }
    return { kind: "ok", handle };
}
/**
 * Scan one open journal's lines for a plan-mode control record. Returns the
 * record `type` string on a match, "<unparseable>" for a suspicious line
 * that fails to parse, or null when the journal is clean.
 */
async function scanJournalLines(handle) {
    const rl = createInterface({ input: handle.createReadStream() });
    try {
        for await (const rawLine of rl) {
            const line = rawLine.trim();
            if (line.length === 0)
                continue;
            // Parse EVERY record and check its DECODED `type`. A raw-substring filter
            // is unsafe on its own: a JSON-escaped type such as
            // {"type":"plan_mode.enter"} contains no literal "plan_mode." yet
            // upstream JSON.parse decodes it to "plan_mode.enter" and restores active
            // plan mode. So parse first (this catches the escape). If a line FAILS to
            // parse, upstream cannot fold it into a plan event either — but be
            // conservative: a malformed line that still LOOKS plan-related is treated
            // as tainted rather than skipped, so a hand-corrupted journal cannot hide
            // a plan record behind a parse error.
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                if (line.includes('"plan_mode.') || line.includes('"plan.')) {
                    return "<unparseable>";
                }
                continue;
            }
            const type = parsed?.["type"];
            if (typeof type === "string" && (type.startsWith("plan_mode.") || type.startsWith("plan."))) {
                return type;
            }
        }
        return null;
    }
    finally {
        rl.close();
    }
}
/**
 * Scan every agent wire journal of a saved session for plan-mode records.
 * Layout at 0.42.0: `<kimiHome>/sessions/<workspaceId>/<sessionId>/agents/<agentId>/wire.jsonl`
 * (workspaceId is unknown to the plugin → enumerate `sessions/*` with bounded
 * readdir). Raw-line scan of EVERY agent journal: a JSON line whose `type`
 * starts with `plan_mode.` or `plan.` → tainted (fail-closed on a line that
 * looks suspicious but does not parse). No session dir, no journal, unreadable,
 * or any single journal above the size cap → unavailable. Never modifies files.
 */
export async function scanSessionJournalsForPlan(kimiHome, sessionId) {
    const sessionsDir = path.join(kimiHome, "sessions");
    const workspaceEntries = await boundedReaddir(sessionsDir, DIR_ENUM_CAP);
    if (workspaceEntries.kind === "absent") {
        return { kind: "unavailable", reason: `no sessions directory at ${sessionsDir}` };
    }
    if (workspaceEntries.kind === "cap-exceeded") {
        return { kind: "unavailable", reason: `too many entries under ${sessionsDir} to scan safely` };
    }
    if (workspaceEntries.kind === "unreadable") {
        return { kind: "unavailable", reason: `could not enumerate the session tree: ${workspaceEntries.reason}` };
    }
    const journalPaths = [];
    for (const workspaceEntry of workspaceEntries.entries) {
        // A symlinked entry in the session tree is refused, not skipped: a
        // symlinked agent (or workspace) directory has isDirectory() === false, so
        // skipping it would drop its journal from the scan and let an active-plan
        // journal hide behind the symlink while a sibling reads clean. Fail closed.
        if (workspaceEntry.isSymbolicLink()) {
            return {
                kind: "unavailable",
                reason: `symlinked entry in the session tree: ${path.join(sessionsDir, workspaceEntry.name)}`,
            };
        }
        if (!workspaceEntry.isDirectory())
            continue;
        const agentsDir = path.join(sessionsDir, workspaceEntry.name, sessionId, "agents");
        const agentEntries = await boundedReaddir(agentsDir, DIR_ENUM_CAP);
        if (agentEntries.kind === "absent")
            continue;
        if (agentEntries.kind === "cap-exceeded") {
            return { kind: "unavailable", reason: `too many agent entries under ${agentsDir} to scan safely` };
        }
        if (agentEntries.kind === "unreadable") {
            return { kind: "unavailable", reason: `could not enumerate agent journals: ${agentEntries.reason}` };
        }
        for (const agentEntry of agentEntries.entries) {
            if (agentEntry.isSymbolicLink()) {
                return {
                    kind: "unavailable",
                    reason: `symlinked agent entry in the session tree: ${path.join(agentsDir, agentEntry.name)}`,
                };
            }
            if (!agentEntry.isDirectory())
                continue;
            journalPaths.push(path.join(agentsDir, agentEntry.name, "wire.jsonl"));
        }
    }
    if (journalPaths.length === 0) {
        return { kind: "unavailable", reason: `no agent wire journals found for session ${sessionId}` };
    }
    for (const journalPath of journalPaths) {
        const opened = await openJournalSafely(journalPath, JOURNAL_MAX_BYTES);
        if (opened.kind === "unavailable") {
            return { kind: "unavailable", reason: `${journalPath}: ${opened.reason}` };
        }
        try {
            const taintedType = await scanJournalLines(opened.handle);
            if (taintedType !== null) {
                return { kind: "tainted", journal: journalPath, recordType: taintedType };
            }
        }
        finally {
            await opened.handle.close().catch(() => undefined);
        }
    }
    return { kind: "clean", journals: journalPaths };
}
/**
 * Run every inspection and throw a RuntimeError on the first refusal:
 *   CLI_V2_PLAN_MODE_CONFIGURED   details.refusal_kind = "v2-plan-mode-configured"
 *   CLI_V2_CONFIG_UNREADABLE      details.refusal_kind = "v2-config-unreadable"
 *   CLI_V2_EXPERIMENTAL_UNSAFE    details.refusal_kind = "v2-experimental-unsafe", details.selectors
 *   KIMI_SESSION_PLAN_TAINTED     details.refusal_kind = "session-plan-tainted", details.record_type
 *   KIMI_SESSION_JOURNAL_UNAVAILABLE details.refusal_kind = "session-journal-unavailable"
 * Every message carries a truthful remedy (edit the named setting / start a
 * fresh session) and MUST NOT mention /kimi:setup or hook drift.
 * Every details object also carries `retryable_after_setup: false`.
 */
export async function assertNativeV2Preflight(options) {
    const stage = options.stage ?? "native-v2.preflight";
    const configPath = path.join(options.kimiHome, "config.toml");
    const planMode = await inspectPlanModeConfig(options.kimiHome);
    if (planMode.kind === "refuse") {
        const code = planMode.refusalKind === "v2-plan-mode-configured"
            ? "CLI_V2_PLAN_MODE_CONFIGURED"
            : "CLI_V2_CONFIG_UNREADABLE";
        const remedy = planMode.refusalKind === "v2-plan-mode-configured"
            ? `Set \`default_plan_mode = false\` (or remove it) in ${configPath}.`
            : `Fix or remove the unreadable file at ${configPath} so plan mode can be verified off.`;
        throw new RuntimeError(code, `${planMode.reason} ${remedy}`, stage, {
            details: { refusal_kind: planMode.refusalKind, retryable_after_setup: false },
        });
    }
    const experimental = await inspectExperimentalSelectors(options.kimiHome, options.env);
    if (experimental.kind === "refuse") {
        throw new RuntimeError("CLI_V2_EXPERIMENTAL_UNSAFE", `${experimental.reason} Unset the listed selector(s) before retrying.`, stage, {
            details: {
                refusal_kind: "v2-experimental-unsafe",
                selectors: experimental.selectors,
                retryable_after_setup: false,
            },
        });
    }
    if (options.resumeSessionId !== undefined) {
        const journalScan = await scanSessionJournalsForPlan(options.kimiHome, options.resumeSessionId);
        if (journalScan.kind === "tainted") {
            throw new RuntimeError("KIMI_SESSION_PLAN_TAINTED", `Saved session ${options.resumeSessionId} previously entered plan mode (record type "${journalScan.recordType}" in ${journalScan.journal}). Start a fresh session; saved session state was not modified.`, stage, {
                details: {
                    refusal_kind: "session-plan-tainted",
                    record_type: journalScan.recordType,
                    retryable_after_setup: false,
                },
            });
        }
        if (journalScan.kind === "unavailable") {
            throw new RuntimeError("KIMI_SESSION_JOURNAL_UNAVAILABLE", `Could not verify saved session ${options.resumeSessionId} is free of plan-mode state (${journalScan.reason}). Start a fresh session; saved session state was not modified.`, stage, {
                details: {
                    refusal_kind: "session-journal-unavailable",
                    retryable_after_setup: false,
                },
            });
        }
    }
}
