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
export const READ_SCOPE_LABELS: ReadonlySet<string> = new Set(["ask", "review", "challenge", "swarm"]);

export interface ReadScope {
  /** Realpaths of the caller's --read-root directories, without the workspace. */
  readonly readRoots: readonly string[];
  readonly network: boolean;
}

export const SCOPE_FLAGS_WRITE_MESSAGE =
  "--read-root and --network apply only to read-only operations (ask, review, challenge, read-only swarm). " +
  "Write-capable operations can read through allowlisted shell commands, so read confinement could not be honoured there.";

/** Validate --read-root values and build the scope; undefined means the default scope. */
export async function resolveReadScope(
  readRoots: readonly string[] | undefined,
  network: boolean | undefined,
  stage: string,
): Promise<ReadScope | undefined> {
  const requested = readRoots ?? [];
  if (requested.length === 0 && network !== true) return undefined;
  const resolved: string[] = [];
  for (const root of requested) {
    if (!path.isAbsolute(root)) {
      throw new RuntimeError("INVALID_ARGS", `--read-root must be an absolute directory path; got "${root}".`, stage);
    }
    let real: string;
    try {
      real = await realpath(root);
      if (!(await stat(real)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new RuntimeError("INVALID_ARGS", `--read-root ${root} is not an existing directory.`, stage);
    }
    if (!resolved.includes(real)) resolved.push(real);
  }
  return Object.freeze({ readRoots: Object.freeze(resolved), network: network === true });
}

/**
 * Read confinement rests on tool schemas verified at certified releases only.
 * --read-root can only narrow, so it runs anywhere; --network is the
 * relaxation and is refused on an uncertified release.
 */
export function assertScopeSupported(
  scope: ReadScope | undefined,
  certification: string,
  code: "INVALID_ARGS" | "READ_SCOPE_INVALID",
  stage: string,
): void {
  if (scope?.network === true && certification === "uncertified") {
    throw new RuntimeError(
      code,
      "--network is refused on an uncertified kimi-code release: read confinement is verified only against certified releases. Run without --network, or install a certified kimi-code release.",
      stage,
    );
  }
}

/** Child-environment values for one spawn; both absent for the default scope. */
export function readScopeEnvironment(
  scope: ReadScope | undefined,
  cwd: string,
): { [READ_ROOTS_ENV]?: string; [NETWORK_ENV]?: "1" } {
  if (scope === undefined || (scope.readRoots.length === 0 && !scope.network)) return {};
  // Root 1 is the directory kimi runs in, so relative and defaulted tool
  // paths resolve inside it exactly as upstream resolves them.
  const roots = [realpathSync.native(cwd)];
  for (const root of scope.readRoots) if (!roots.includes(root)) roots.push(root);
  return {
    [READ_ROOTS_ENV]: JSON.stringify(roots),
    ...(scope.network ? { [NETWORK_ENV]: "1" as const } : {}),
  };
}

export type HookReadScope =
  | { readonly confined: false; readonly network: false }
  | { readonly confined: true; readonly roots: readonly string[]; readonly network: boolean };

const FAIL_CLOSED: HookReadScope = Object.freeze({ confined: true, roots: Object.freeze([]), network: false });

/**
 * Hook-side parse of the plugin-set variables. Both absent is the default
 * scope. Anything malformed (bad JSON, empty array, relative or unnormalized
 * entries, a network value other than "1", network without roots) confines
 * reads to NO roots with network off.
 */
export function parseScopeEnvironment(rawRoots: string | undefined, rawNetwork: string | undefined): HookReadScope {
  if (rawRoots === undefined && rawNetwork === undefined) return { confined: false, network: false };
  if (rawRoots === undefined) return FAIL_CLOSED;
  if (rawNetwork !== undefined && rawNetwork !== "1") return FAIL_CLOSED;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawRoots);
  } catch {
    return FAIL_CLOSED;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return FAIL_CLOSED;
  for (const entry of parsed) {
    if (typeof entry !== "string" || entry.includes("\0") || !path.isAbsolute(entry) || path.resolve(entry) !== entry) {
      return FAIL_CLOSED;
    }
  }
  return Object.freeze({ confined: true, roots: Object.freeze([...parsed as string[]]), network: rawNetwork === "1" });
}

/** Persisted job-row form; NULL for the default scope so old rows keep their shape. */
export function serializeReadScope(scope: ReadScope | undefined): string | null {
  if (scope === undefined || (scope.readRoots.length === 0 && !scope.network)) return null;
  return JSON.stringify({ read_roots: scope.readRoots, network: scope.network });
}

/** Inverse of serializeReadScope. A corrupt row refuses rather than run unconfined. */
export function parseJobReadScope(raw: string | null | undefined): ReadScope | undefined {
  if (raw === null || raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const record = parsed as { read_roots?: unknown; network?: unknown } | undefined;
  if (
    typeof record !== "object" || record === null ||
    !Array.isArray(record.read_roots) || typeof record.network !== "boolean" ||
    !record.read_roots.every((root) => typeof root === "string" && path.isAbsolute(root))
  ) {
    throw new RuntimeError("READ_SCOPE_INVALID", "The job's stored read scope is unreadable; refusing to run it unconfined.", "read-scope.load");
  }
  return Object.freeze({ readRoots: Object.freeze([...record.read_roots as string[]]), network: record.network });
}

/** Header line for a non-default scope; undefined for the default. */
export function describeReadScope(scope: ReadScope | undefined): string | undefined {
  if (scope === undefined || (scope.readRoots.length === 0 && !scope.network)) return undefined;
  const roots = scope.readRoots.length === 0
    ? "the workspace"
    : `the workspace and ${scope.readRoots.length} read root${scope.readRoots.length === 1 ? "" : "s"} (${scope.readRoots.join(", ")})`;
  return `Scope: reads confined to ${roots}; network ${scope.network ? "on" : "off"}`;
}

// ---------------------------------------------------------------------------
// Hook enforcement of confined reads.
//
// Input schemas are those of kimi-code 0.41.0 (legacy agent-core), 2.0.0 and
// 2.7.3 (agent-core-v2): Read/ReadMediaFile resolve `path`; Glob and Grep
// search `path` or, when omitted, the session cwd; Glob's `pattern` and Grep's
// `glob` are ripgrep --glob filters inside that search root. Upstream expands
// `~`, resolves relative paths against the cwd and normalizes `..` lexically
// before access. ripgrep runs without --follow, so links met while walking are
// skipped; links named directly are followed, hence realpath below.
// ---------------------------------------------------------------------------

const SCOPED_READ_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  Read: new Set(["path", "line_offset", "column_offset", "n_lines", "max_chars"]),
  ReadMediaFile: new Set(["path", "region", "full_resolution"]),
  Glob: new Set(["pattern", "path", "head_limit", "offset", "include_ignored", "include_dirs"]),
  Grep: new Set([
    "pattern", "path", "glob", "type", "output_mode", "-i", "-n", "-A", "-B", "-C",
    "head_limit", "offset", "multiline", "include_ignored",
  ]),
};

export const SCOPED_READ_TOOLS: ReadonlySet<string> = new Set(Object.keys(SCOPED_READ_KEYS));

export type ScopedReadDecision = { decision: "allow" } | { decision: "deny"; reason: string };

class ScopeDenial extends Error {}

export async function evaluateScopedRead(
  toolName: string,
  toolInput: unknown,
  roots: readonly string[],
): Promise<ScopedReadDecision> {
  const deny = (why: string): ScopedReadDecision => ({
    decision: "deny",
    reason: `kimi-plugin-cc safety hook: reads are confined to ${roots.length === 0 ? "no readable roots (the scope variables are malformed)" : roots.join(", ")}; tool "${toolName}" denied: ${why}`,
  });
  if (roots.length === 0) return deny("no path can be read.");
  const allowedKeys = SCOPED_READ_KEYS[toolName];
  if (allowedKeys === undefined) return deny("the tool has no confinement rule.");
  if (typeof toolInput !== "object" || toolInput === null || Array.isArray(toolInput)) {
    return deny("its arguments are not an object.");
  }
  const args = toolInput as Record<string, unknown>;
  for (const key of Object.keys(args)) {
    if (!allowedKeys.has(key)) return deny(`argument "${key}" cannot be checked.`);
  }
  try {
    const targets: string[] = [];
    if (toolName === "Read" || toolName === "ReadMediaFile") {
      targets.push(requirePath(args.path, "path"));
    } else {
      targets.push(args.path === undefined ? roots[0]! : requirePath(args.path, "path"));
      const patternKey = toolName === "Glob" ? "pattern" : "glob";
      const pattern = args[patternKey];
      if (toolName === "Glob" || pattern !== undefined) {
        const anchor = patternAnchor(pattern, patternKey);
        if (anchor !== undefined) targets.push(anchor);
      }
    }
    for (const target of targets) {
      const absolute = path.isAbsolute(target) ? path.resolve(target) : path.resolve(roots[0]!, target);
      const real = await realTarget(absolute);
      if (!roots.some((root) => isWithin(root, real))) {
        return deny(`"${target}" resolves outside the read roots.`);
      }
    }
  } catch (error) {
    return deny(error instanceof ScopeDenial ? error.message : "its target could not be resolved.");
  }
  return { decision: "allow" };
}

function requirePath(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new ScopeDenial(`argument "${key}" is not a usable path.`);
  }
  // Upstream expands ~ against the home directory and treats kimi-file://
  // as a session attachment; neither target is a workspace path.
  if (value.startsWith("~")) throw new ScopeDenial(`"${value}" uses home-directory expansion.`);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) throw new ScopeDenial(`"${value}" is not a filesystem path.`);
  denyAmbiguousSpelling(value, "path");
  return value;
}

// Upstream resolves with pathe, which reads "\\" as a separator and a drive
// prefix as absolute; node:path on POSIX reads neither. Deny those spellings
// instead of imitating pathe.
function denyAmbiguousSpelling(value: string, noun: "path" | "glob"): void {
  if (value.includes("\\")) throw new ScopeDenial(`${noun} "${value}" contains a backslash.`);
  if (/^[A-Za-z]:/.test(value)) throw new ScopeDenial(`${noun} "${value}" starts with a drive letter.`);
}

/** Literal directory an absolute glob names; undefined for a relative glob. */
function patternAnchor(value: unknown, key: string): string | undefined {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new ScopeDenial(`argument "${key}" is not a usable glob.`);
  }
  const body = value.startsWith("!") ? value.slice(1) : value;
  if (body.startsWith("~")) throw new ScopeDenial(`glob "${value}" uses home-directory expansion.`);
  denyAmbiguousSpelling(body, "glob");
  const segments = body.split("/");
  if (segments.includes("..")) throw new ScopeDenial(`glob "${value}" climbs with "..".`);
  if (!path.isAbsolute(body)) return undefined;
  const literal: string[] = [];
  for (const segment of segments) {
    if (/[*?[\]{}!]/.test(segment)) break;
    literal.push(segment);
  }
  return literal.join("/") || "/";
}

/** Physical location of `absolute`: realpath when it exists, else the nearest existing ancestor's. */
async function realTarget(absolute: string): Promise<string> {
  try {
    return await realpath(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  // A dangling link may later point anywhere; only a truly absent path falls back.
  try {
    await lstat(absolute);
    throw new ScopeDenial(`"${absolute}" is a link whose target cannot be resolved.`);
  } catch (error) {
    if (error instanceof ScopeDenial) throw error;
  }
  let ancestor = path.dirname(absolute);
  while (true) {
    try {
      const real = await realpath(ancestor);
      return path.resolve(real, path.relative(ancestor, absolute));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// ---------------------------------------------------------------------------
// FetchURL targets under --network: http(s) without credentials, and never a
// local, private or numerically encoded host. The WHATWG parser canonicalizes
// the hostname; the raw authority is compared so that integer, hex, octal or
// percent-encoded IPv4 spellings are refused rather than decoded.
// ---------------------------------------------------------------------------

const PRIVATE_IPV4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
  [0xa9fe0000, 16], [0xac100000, 12], [0xc0a80000, 16],
];

/** True when `url` is an allowed FetchURL target. */
export function isAllowedFetchUrl(url: unknown): boolean {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  const host = parsed.hostname;
  if (host.startsWith("[")) {
    const hextets = ipv6Hextets(host.slice(1, -1));
    return hextets !== undefined && !isPrivateIpv6(hextets);
  }
  const ipv4 = ipv4Value(host);
  if (ipv4 !== undefined) {
    // The parser accepts many IPv4 spellings; only the canonical one is allowed.
    if (rawHost(url) !== host) return false;
    return !PRIVATE_IPV4.some(([base, bits]) => inRange(ipv4, base, bits));
  }
  const name = host.replace(/\.+$/, "");
  if (name.length === 0 || /^[0-9]+$/.test(name)) return false;
  return !(name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".internal"));
}

function rawHost(url: string): string {
  const authority = url.replace(/^https?:\/\//i, "").split(/[/\\?#]/, 1)[0]!;
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  return hostPort.replace(/:[0-9]*$/, "").toLowerCase();
}

function ipv4Value(host: string): number | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return undefined;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return undefined;
  return ((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!;
}

function inRange(value: number, base: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((value & mask) >>> 0) === base;
}

function ipv6Hextets(text: string): number[] | undefined {
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    for (const piece of part.split(":")) {
      if (piece.includes(".")) {
        const v4 = ipv4Value(piece);
        if (v4 === undefined) return undefined;
        out.push(v4 >>> 16, v4 & 0xffff);
      } else if (/^[0-9a-f]{1,4}$/i.test(piece)) {
        out.push(parseInt(piece, 16));
      } else {
        return undefined;
      }
    }
    return out;
  };
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if (head === undefined || tail === undefined) return undefined;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 0 : fill !== 0) return undefined;
  return [...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...tail];
}

function isPrivateIpv6(h: readonly number[]): boolean {
  if (h.every((part) => part === 0)) return true; // unspecified
  if (h.slice(0, 7).every((part) => part === 0) && h[7] === 1) return true; // loopback
  if ((h[0]! & 0xffc0) === 0xfe80) return true; // link-local
  if ((h[0]! & 0xfe00) === 0xfc00) return true; // unique-local
  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible form.
  if (h.slice(0, 5).every((part) => part === 0) && (h[5] === 0xffff || h[5] === 0)) {
    const v4 = ((h[6]! << 16) >>> 0) + h[7]!;
    return PRIVATE_IPV4.some(([base, bits]) => inRange(v4, base, bits));
  }
  return false;
}
