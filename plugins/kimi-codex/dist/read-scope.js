import { realpathSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { RuntimeError } from "./errors.js";
/**
 * Per-call scope for the read-only operations (ask, review, challenge,
 * read-only swarm). kimi-code approves Read, Grep, Glob, ReadMediaFile,
 * WebSearch and FetchURL itself, so the PreToolUse hook is the only place
 * these can be scoped. Web access is coupled to read confinement: a job that
 * can send data out may read only the workspace and the caller's read roots.
 *
 * The plugin sets or deletes both variables on every spawn; the hook reads
 * only these, never the hook payload's cwd.
 */
export const READ_ROOTS_ENV = "KIMI_PLUGIN_CC_READ_ROOTS";
export const NETWORK_ENV = "KIMI_PLUGIN_CC_NETWORK";
/** Hook labels that may carry a non-default scope. */
export const READ_SCOPE_LABELS = new Set(["ask", "review", "challenge", "swarm"]);
export const SCOPE_FLAGS_WRITE_MESSAGE = "--read-root and --network apply only to read-only operations (ask, review, challenge, read-only swarm). " +
    "Write-capable operations can read through allowlisted shell commands, so read confinement could not be honoured there.";
/** Validate --read-root values and build the scope; undefined means the default scope. */
export async function resolveReadScope(readRoots, network, stage) {
    const requested = readRoots ?? [];
    if (requested.length === 0 && network !== true)
        return undefined;
    const resolved = [];
    for (const root of requested) {
        if (!path.isAbsolute(root)) {
            throw new RuntimeError("INVALID_ARGS", `--read-root must be an absolute directory path; got "${root}".`, stage);
        }
        let real;
        if (root.includes("\\")) {
            throw new RuntimeError("INVALID_ARGS", `--read-root ${root} contains a backslash, which kimi-code reads as a path separator.`, stage);
        }
        try {
            real = await realpath(root);
            if (!(await stat(real)).isDirectory())
                throw new Error("not a directory");
        }
        catch {
            throw new RuntimeError("INVALID_ARGS", `--read-root ${root} is not an existing directory.`, stage);
        }
        if (real.includes("\\")) {
            throw new RuntimeError("INVALID_ARGS", `--read-root ${root} contains a backslash, which kimi-code reads as a path separator.`, stage);
        }
        if (!resolved.includes(real))
            resolved.push(real);
    }
    return Object.freeze({ readRoots: Object.freeze(resolved), network: network === true });
}
/**
 * Read confinement rests on tool schemas verified at certified releases only.
 * --read-root can only narrow, so it runs anywhere; --network is the
 * relaxation and is refused on an uncertified release.
 */
export function assertScopeSupported(scope, certification, code, stage) {
    if (scope?.network === true && certification === "uncertified") {
        throw new RuntimeError(code, "--network is refused on an uncertified kimi-code release: read confinement is verified only against certified releases. Run without --network, or install a certified kimi-code release.", stage);
    }
}
/** The roots the hook confines reads to: the run directory first, then the read roots. */
export function effectiveReadRoots(scope, cwd) {
    // Root 1 is the directory kimi runs in, so relative and defaulted tool
    // paths resolve inside it exactly as upstream resolves them.
    if (cwd.includes("\\")) {
        throw new RuntimeError("READ_SCOPE_INVALID", `Read confinement cannot use ${cwd}: it contains a backslash, which kimi-code reads as a path separator.`, "read-scope.roots");
    }
    const roots = [realpathSync.native(cwd)];
    for (const root of scope.readRoots)
        if (!roots.includes(root))
            roots.push(root);
    // kimi-code resolves with pathe, which reads "\\" as a separator, so such a
    // root would name a different directory to kimi than to the hook.
    const slashed = roots.find((root) => root.includes("\\"));
    if (slashed !== undefined) {
        throw new RuntimeError("READ_SCOPE_INVALID", `Read confinement cannot use ${slashed}: it contains a backslash, which kimi-code reads as a path separator.`, "read-scope.roots");
    }
    return roots;
}
/** True when every root in `inner` lies within some root in `outer`. */
export function rootsWithin(inner, outer) {
    return inner.every((root) => outer.some((candidate) => isWithin(candidate, root)));
}
/** Child-environment values for one spawn; both absent for the default scope. */
export function readScopeEnvironment(scope, cwd) {
    if (scope === undefined || (scope.readRoots.length === 0 && !scope.network))
        return {};
    return {
        [READ_ROOTS_ENV]: JSON.stringify(effectiveReadRoots(scope, cwd)),
        ...(scope.network ? { [NETWORK_ENV]: "1" } : {}),
    };
}
const FAIL_CLOSED = Object.freeze({ confined: true, roots: Object.freeze([]), network: false });
/**
 * Hook-side parse of the plugin-set variables. Both absent is the default
 * scope. Anything malformed (bad JSON, empty array, relative or unnormalized
 * entries, a network value other than "1", network without roots) confines
 * reads to NO roots with network off.
 */
export function parseScopeEnvironment(rawRoots, rawNetwork) {
    if (rawRoots === undefined && rawNetwork === undefined)
        return { confined: false, network: false };
    if (rawRoots === undefined)
        return FAIL_CLOSED;
    if (rawNetwork !== undefined && rawNetwork !== "1")
        return FAIL_CLOSED;
    let parsed;
    try {
        parsed = JSON.parse(rawRoots);
    }
    catch {
        return FAIL_CLOSED;
    }
    if (!Array.isArray(parsed) || parsed.length === 0)
        return FAIL_CLOSED;
    for (const entry of parsed) {
        if (typeof entry !== "string" || entry.includes("\0") || entry.includes("\\") || !path.isAbsolute(entry) || path.resolve(entry) !== entry) {
            return FAIL_CLOSED;
        }
    }
    return Object.freeze({ confined: true, roots: Object.freeze([...parsed]), network: rawNetwork === "1" });
}
/** Persisted job-row form; NULL for the default scope so old rows keep their shape. */
export function serializeReadScope(scope) {
    if (scope === undefined || (scope.readRoots.length === 0 && !scope.network))
        return null;
    return JSON.stringify({ read_roots: scope.readRoots, network: scope.network });
}
/** Inverse of serializeReadScope. A corrupt row refuses rather than run unconfined. */
export function parseJobReadScope(raw) {
    if (raw === null || raw === undefined)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        parsed = undefined;
    }
    const record = parsed;
    if (typeof record !== "object" || record === null ||
        !Array.isArray(record.read_roots) || typeof record.network !== "boolean" ||
        !record.read_roots.every((root) => typeof root === "string" && path.isAbsolute(root))) {
        throw new RuntimeError("READ_SCOPE_INVALID", "The job's stored read scope is unreadable; refusing to run it unconfined.", "read-scope.load");
    }
    return Object.freeze({ readRoots: Object.freeze([...record.read_roots]), network: record.network });
}
/** Header line for a non-default scope; undefined for the default. */
export function describeReadScope(scope) {
    if (scope === undefined || (scope.readRoots.length === 0 && !scope.network))
        return undefined;
    const roots = scope.readRoots.length === 0
        ? "the workspace"
        : `the workspace and ${scope.readRoots.length} read root${scope.readRoots.length === 1 ? "" : "s"} (${scope.readRoots.join(", ")})`;
    return `Scope: reads confined to ${roots}; network ${scope.network ? "on" : "off"}`;
}
// ---------------------------------------------------------------------------
// Hook enforcement of confined reads.
//
// Input schemas are those of kimi-code 0.41.0 (legacy agent-core), 2.0.0,
// 2.7.3 and 2.8.0 (agent-core-v2): Read/ReadMediaFile resolve `path`; Glob and Grep
// search `path` or, when omitted, the session cwd; Glob's `pattern` and Grep's
// `glob` are ripgrep --glob filters inside that search root. Upstream expands
// `~`, resolves relative paths against the cwd and normalizes `..` lexically
// before access. ripgrep runs without --follow, so links met while walking are
// skipped; links named directly are followed, hence realpath below.
// ---------------------------------------------------------------------------
const SCOPED_READ_KEYS = {
    Read: new Set(["path", "line_offset", "column_offset", "n_lines", "max_chars"]),
    ReadMediaFile: new Set(["path", "region", "full_resolution"]),
    Glob: new Set(["pattern", "path", "head_limit", "offset", "include_ignored", "include_dirs"]),
    Grep: new Set([
        "pattern", "path", "glob", "type", "output_mode", "-i", "-n", "-A", "-B", "-C",
        "head_limit", "offset", "multiline", "include_ignored",
    ]),
};
export const SCOPED_READ_TOOLS = new Set(Object.keys(SCOPED_READ_KEYS));
class ScopeDenial extends Error {
}
export async function evaluateScopedRead(toolName, toolInput, roots) {
    const deny = (why) => ({
        decision: "deny",
        reason: `kimi-plugin-cc safety hook: reads are confined to ${roots.length === 0 ? "no readable roots (the scope variables are malformed)" : roots.join(", ")}; tool "${toolName}" denied: ${why}`,
    });
    if (roots.length === 0)
        return deny("no path can be read.");
    const allowedKeys = SCOPED_READ_KEYS[toolName];
    if (allowedKeys === undefined)
        return deny("the tool has no confinement rule.");
    if (typeof toolInput !== "object" || toolInput === null || Array.isArray(toolInput)) {
        return deny("its arguments are not an object.");
    }
    const args = toolInput;
    for (const key of Object.keys(args)) {
        if (!allowedKeys.has(key))
            return deny(`argument "${key}" cannot be checked.`);
    }
    try {
        const targets = [];
        if (toolName === "Read" || toolName === "ReadMediaFile") {
            targets.push(requirePath(args.path, "path"));
        }
        else {
            targets.push(args.path === undefined ? roots[0] : requirePath(args.path, "path"));
            const patternKey = toolName === "Glob" ? "pattern" : "glob";
            const pattern = args[patternKey];
            if (toolName === "Glob" || pattern !== undefined) {
                const anchor = patternAnchor(pattern, patternKey);
                if (anchor !== undefined)
                    targets.push(anchor);
            }
        }
        for (const target of targets) {
            const absolute = path.isAbsolute(target) ? path.resolve(target) : path.resolve(roots[0], target);
            const real = await realTarget(absolute);
            if (!roots.some((root) => isWithin(root, real))) {
                return deny(`"${target}" resolves outside the read roots.`);
            }
        }
    }
    catch (error) {
        return deny(error instanceof ScopeDenial ? error.message : "its target could not be resolved.");
    }
    return { decision: "allow" };
}
function requirePath(value, key) {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
        throw new ScopeDenial(`argument "${key}" is not a usable path.`);
    }
    // Upstream expands ~ against the home directory and treats kimi-file://
    // as a session attachment; neither target is a workspace path.
    if (value.startsWith("~"))
        throw new ScopeDenial(`"${value}" uses home-directory expansion.`);
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value))
        throw new ScopeDenial(`"${value}" is not a filesystem path.`);
    denyAmbiguousSpelling(value, "path");
    return value;
}
// Upstream resolves with pathe, which reads "\\" as a separator and a drive
// prefix as absolute; node:path on POSIX reads neither. Deny those spellings
// instead of imitating pathe.
function denyAmbiguousSpelling(value, noun) {
    if (value.includes("\\"))
        throw new ScopeDenial(`${noun} "${value}" contains a backslash.`);
    if (/^[A-Za-z]:/.test(value))
        throw new ScopeDenial(`${noun} "${value}" starts with a drive letter.`);
}
/** Literal directory an absolute glob names; undefined for a relative glob. */
function patternAnchor(value, key) {
    if (typeof value !== "string" || value.includes("\0")) {
        throw new ScopeDenial(`argument "${key}" is not a usable glob.`);
    }
    const body = value.startsWith("!") ? value.slice(1) : value;
    if (body.startsWith("~"))
        throw new ScopeDenial(`glob "${value}" uses home-directory expansion.`);
    denyAmbiguousSpelling(body, "glob");
    const segments = body.split("/");
    if (segments.includes(".."))
        throw new ScopeDenial(`glob "${value}" climbs with "..".`);
    if (!path.isAbsolute(body))
        return undefined;
    const literal = [];
    for (const segment of segments) {
        if (/[*?[\]{}!]/.test(segment))
            break;
        literal.push(segment);
    }
    return literal.join("/") || "/";
}
/** Physical location of `absolute`: realpath when it exists, else the nearest existing ancestor's. */
async function realTarget(absolute) {
    try {
        return await realpath(absolute);
    }
    catch (error) {
        const code = error.code;
        if (code !== "ENOENT" && code !== "ENOTDIR")
            throw error;
    }
    // A dangling link may later point anywhere; only a truly absent path falls back.
    try {
        await lstat(absolute);
        throw new ScopeDenial(`"${absolute}" is a link whose target cannot be resolved.`);
    }
    catch (error) {
        if (error instanceof ScopeDenial)
            throw error;
    }
    let ancestor = path.dirname(absolute);
    while (true) {
        try {
            const real = await realpath(ancestor);
            return path.resolve(real, path.relative(ancestor, absolute));
        }
        catch (error) {
            const code = error.code;
            if (code !== "ENOENT" && code !== "ENOTDIR")
                throw error;
            const parent = path.dirname(ancestor);
            if (parent === ancestor)
                throw error;
            ancestor = parent;
        }
    }
}
function isWithin(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
// ---------------------------------------------------------------------------
// FetchURL targets under --network: http(s) without credentials, and never a
// local name or an IP literal that is not global unicast. The WHATWG parser
// canonicalizes the hostname; the raw authority is compared so that integer,
// hex, octal or percent-encoded IPv4 spellings are refused rather than decoded.
// ---------------------------------------------------------------------------
const NON_GLOBAL_IPV4 = [
    [0x00000000, 8], // this network
    [0x0a000000, 8], // private
    [0x64400000, 10], // shared address space
    [0x7f000000, 8], // loopback
    [0xa9fe0000, 16], // link-local
    [0xac100000, 12], // private
    [0xc0000000, 24], // IETF protocol assignments
    [0xc0000200, 24], // documentation
    [0xc0586300, 24], // deprecated 6to4 relay anycast
    [0xc0a80000, 16], // private
    [0xc6120000, 15], // benchmarking
    [0xc6336400, 24], // documentation
    [0xcb007100, 24], // documentation
    [0xe0000000, 4], // multicast
    [0xf0000000, 4], // reserved, including broadcast
];
/** True when `url` is an allowed FetchURL target. */
export function isAllowedFetchUrl(url) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url))
        return false;
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        return false;
    if (parsed.username !== "" || parsed.password !== "")
        return false;
    const host = parsed.hostname;
    if (host.startsWith("[")) {
        const hextets = ipv6Hextets(host.slice(1, -1));
        return hextets !== undefined && isGlobalIpv6(hextets);
    }
    const ipv4 = ipv4Value(host);
    if (ipv4 !== undefined) {
        // The parser accepts many IPv4 spellings; only the canonical one is allowed.
        if (rawHost(url) !== host)
            return false;
        return isGlobalIpv4(ipv4);
    }
    const name = host.replace(/\.+$/, "");
    if (name.length === 0 || /^[0-9]+$/.test(name))
        return false;
    return !(name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".internal"));
}
function rawHost(url) {
    const authority = url.replace(/^https?:\/\//i, "").split(/[/\\?#]/, 1)[0];
    const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
    return hostPort.replace(/:[0-9]*$/, "").toLowerCase();
}
function ipv4Value(host) {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!match)
        return undefined;
    const octets = match.slice(1).map(Number);
    if (octets.some((octet) => octet > 255))
        return undefined;
    return ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
}
function inRange(value, base, bits) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === base;
}
function ipv6Hextets(text) {
    const halves = text.split("::");
    if (halves.length > 2)
        return undefined;
    const parse = (part) => {
        if (part === "")
            return [];
        const out = [];
        for (const piece of part.split(":")) {
            if (piece.includes(".")) {
                const v4 = ipv4Value(piece);
                if (v4 === undefined)
                    return undefined;
                out.push(v4 >>> 16, v4 & 0xffff);
            }
            else if (/^[0-9a-f]{1,4}$/i.test(piece)) {
                out.push(parseInt(piece, 16));
            }
            else {
                return undefined;
            }
        }
        return out;
    };
    const head = parse(halves[0]);
    const tail = halves.length === 2 ? parse(halves[1]) : [];
    if (head === undefined || tail === undefined)
        return undefined;
    const fill = 8 - head.length - tail.length;
    if (halves.length === 2 ? fill < 0 : fill !== 0)
        return undefined;
    return [...head, ...new Array(halves.length === 2 ? fill : 0).fill(0), ...tail];
}
function isGlobalIpv4(value) {
    return !NON_GLOBAL_IPV4.some(([base, bits]) => inRange(value, base, bits));
}
/** Only global unicast 2000::/3, less its special-purpose blocks; NAT64 by its IPv4. */
function isGlobalIpv6(h) {
    if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((part) => part === 0)) {
        return isGlobalIpv4(((h[6] << 16) >>> 0) + h[7]);
    }
    if ((h[0] & 0xe000) !== 0x2000)
        return false;
    if (h[0] === 0x2001 && h[1] < 0x0200)
        return false; // 2001::/23 IETF assignments, Teredo 2001::/32
    if (h[0] === 0x2001 && h[1] === 0x0db8)
        return false; // documentation
    if (h[0] === 0x2002)
        return false; // 6to4 embeds an IPv4 address
    if (h[0] === 0x3fff && h[1] < 0x1000)
        return false; // documentation 3fff::/20
    return true;
}
