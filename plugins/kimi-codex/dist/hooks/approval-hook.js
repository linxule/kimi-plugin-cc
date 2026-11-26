#!/usr/bin/env node

// runtime/read-scope.ts
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
var READ_ROOTS_ENV = "KIMI_PLUGIN_CC_READ_ROOTS";
var NETWORK_ENV = "KIMI_PLUGIN_CC_NETWORK";
var READ_SCOPE_LABELS = new Set(["ask", "review", "challenge", "swarm"]);
var SCOPE_FLAGS_WRITE_MESSAGE = "--read-root and --network apply only to read-only operations (ask, review, challenge, read-only swarm). " + "Write-capable operations can read through allowlisted shell commands, so read confinement could not be honoured there.";
var FAIL_CLOSED = Object.freeze({ confined: true, roots: Object.freeze([]), network: false });
function parseScopeEnvironment(rawRoots, rawNetwork) {
  if (rawRoots === undefined && rawNetwork === undefined)
    return { confined: false, network: false };
  if (rawRoots === undefined)
    return FAIL_CLOSED;
  if (rawNetwork !== undefined && rawNetwork !== "1")
    return FAIL_CLOSED;
  let parsed;
  try {
    parsed = JSON.parse(rawRoots);
  } catch {
    return FAIL_CLOSED;
  }
  if (!Array.isArray(parsed) || parsed.length === 0)
    return FAIL_CLOSED;
  for (const entry of parsed) {
    if (typeof entry !== "string" || entry.includes("\x00") || entry.includes("\\") || !path.isAbsolute(entry) || path.resolve(entry) !== entry) {
      return FAIL_CLOSED;
    }
  }
  return Object.freeze({ confined: true, roots: Object.freeze([...parsed]), network: rawNetwork === "1" });
}
var SCOPED_READ_KEYS = {
  Read: new Set(["path", "line_offset", "column_offset", "n_lines", "max_chars"]),
  ReadMediaFile: new Set(["path", "region", "full_resolution"]),
  Glob: new Set(["pattern", "path", "head_limit", "offset", "include_ignored", "include_dirs"]),
  Grep: new Set([
    "pattern",
    "path",
    "glob",
    "type",
    "output_mode",
    "-i",
    "-n",
    "-A",
    "-B",
    "-C",
    "head_limit",
    "offset",
    "multiline",
    "include_ignored"
  ])
};
var SCOPED_READ_TOOLS = new Set(Object.keys(SCOPED_READ_KEYS));

class ScopeDenial extends Error {
}
async function evaluateScopedRead(toolName, toolInput, roots) {
  const deny = (why) => ({
    decision: "deny",
    reason: `kimi-plugin-cc safety hook: reads are confined to ${roots.length === 0 ? "no readable roots (the scope variables are malformed)" : roots.join(", ")}; tool "${toolName}" denied: ${why}`
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
    } else {
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
  } catch (error) {
    return deny(error instanceof ScopeDenial ? error.message : "its target could not be resolved.");
  }
  return { decision: "allow" };
}
function requirePath(value, key) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\x00")) {
    throw new ScopeDenial(`argument "${key}" is not a usable path.`);
  }
  if (value.startsWith("~"))
    throw new ScopeDenial(`"${value}" uses home-directory expansion.`);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value))
    throw new ScopeDenial(`"${value}" is not a filesystem path.`);
  denyAmbiguousSpelling(value, "path");
  return value;
}
function denyAmbiguousSpelling(value, noun) {
  if (value.includes("\\"))
    throw new ScopeDenial(`${noun} "${value}" contains a backslash.`);
  if (/^[A-Za-z]:/.test(value))
    throw new ScopeDenial(`${noun} "${value}" starts with a drive letter.`);
}
function patternAnchor(value, key) {
  if (typeof value !== "string" || value.includes("\x00")) {
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
    return;
  const literal = [];
  for (const segment of segments) {
    if (/[*?[\]{}!]/.test(segment))
      break;
    literal.push(segment);
  }
  return literal.join("/") || "/";
}
async function realTarget(absolute) {
  try {
    return await realpath(absolute);
  } catch (error) {
    const code = error.code;
    if (code !== "ENOENT" && code !== "ENOTDIR")
      throw error;
  }
  try {
    await lstat(absolute);
    throw new ScopeDenial(`"${absolute}" is a link whose target cannot be resolved.`);
  } catch (error) {
    if (error instanceof ScopeDenial)
      throw error;
  }
  let ancestor = path.dirname(absolute);
  while (true) {
    try {
      const real = await realpath(ancestor);
      return path.resolve(real, path.relative(ancestor, absolute));
    } catch (error) {
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
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
var NON_GLOBAL_IPV4 = [
  [0, 8],
  [167772160, 8],
  [1681915904, 10],
  [2130706432, 8],
  [2851995648, 16],
  [2886729728, 12],
  [3221225472, 24],
  [3221225984, 24],
  [3227017984, 24],
  [3232235520, 16],
  [3323068416, 15],
  [3325256704, 24],
  [3405803776, 24],
  [3758096384, 4],
  [4026531840, 4]
];
function isAllowedFetchUrl(url) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url))
    return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
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
    return;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255))
    return;
  return (octets[0] << 24 >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
}
function inRange(value, base, bits) {
  const mask = bits === 0 ? 0 : 4294967295 << 32 - bits >>> 0;
  return (value & mask) >>> 0 === base;
}
function ipv6Hextets(text) {
  const halves = text.split("::");
  if (halves.length > 2)
    return;
  const parse = (part) => {
    if (part === "")
      return [];
    const out = [];
    for (const piece of part.split(":")) {
      if (piece.includes(".")) {
        const v4 = ipv4Value(piece);
        if (v4 === undefined)
          return;
        out.push(v4 >>> 16, v4 & 65535);
      } else if (/^[0-9a-f]{1,4}$/i.test(piece)) {
        out.push(parseInt(piece, 16));
      } else {
        return;
      }
    }
    return out;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (head === undefined || tail === undefined)
    return;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 0 : fill !== 0)
    return;
  return [...head, ...new Array(halves.length === 2 ? fill : 0).fill(0), ...tail];
}
function isGlobalIpv4(value) {
  return !NON_GLOBAL_IPV4.some(([base, bits]) => inRange(value, base, bits));
}
function isGlobalIpv6(h) {
  if (h[0] === 100 && h[1] === 65435 && h.slice(2, 6).every((part) => part === 0)) {
    return isGlobalIpv4((h[6] << 16 >>> 0) + h[7]);
  }
  if ((h[0] & 57344) !== 8192)
    return false;
  if (h[0] === 8193 && h[1] < 512)
    return false;
  if (h[0] === 8193 && h[1] === 3512)
    return false;
  if (h[0] === 8194)
    return false;
  if (h[0] === 16383 && h[1] < 4096)
    return false;
  return true;
}

// runtime/kimi-releases.ts
var BASELINE = Object.freeze([
  "hook-schema",
  "web-preactivation",
  "print-cancels-plan",
  "local-environment",
  "agent-state",
  "modern-ws-control",
  "bounded-swarm",
  "web-json-ready"
]);
var KIMI_V2_RELEASES = Object.freeze([
  { version: "2.8.0", commit: "46d9085f", scope: "all", capabilities: BASELINE }
]);
var BORROWABLE_CAPABILITIES = new Set([
  "local-environment"
]);

// runtime/swarm-policy.ts
var SWARM_POLICY_ENV = "KIMI_PLUGIN_CC_SWARM_POLICY";
var SWARM_WAVE_SIZE_ENV = "KIMI_PLUGIN_CC_SWARM_WAVE_SIZE";
var BOUNDED_SWARM_POLICY = "bounded-waves/1";
function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function nonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
var SWARM_INPUT_KEYS = new Set([
  "description",
  "subagent_type",
  "prompt_template",
  "items",
  "fork",
  "resume_agent_ids",
  "model"
]);
function evaluateSwarmWaveInput(input, policy, waveSize) {
  const deny = (reason) => ({
    decision: "deny",
    reason: `kimi-plugin-cc safety hook: AgentSwarm denied: ${reason}`
  });
  if (policy !== BOUNDED_SWARM_POLICY)
    return deny("missing or unrecognized swarm policy.");
  const width = typeof waveSize === "string" && /^[1-9][0-9]*$/.test(waveSize) ? Number(waveSize) : NaN;
  if (!Number.isSafeInteger(width) || width < 1)
    return deny("missing or invalid trusted wave size.");
  if (width === 1) {
    return deny("concurrency 1 uses one worker directly; complete the task yourself without delegation.");
  }
  if (!plainObject(input))
    return deny("arguments must be an object.");
  if (Reflect.ownKeys(input).some((key) => typeof key !== "string" || !SWARM_INPUT_KEYS.has(key))) {
    return deny("unrecognized arguments.");
  }
  if (!nonemptyString(input.description))
    return deny("description must be a nonempty string.");
  for (const key of ["subagent_type", "prompt_template"]) {
    if (input[key] !== undefined && !nonemptyString(input[key]))
      return deny(`${key} must be a nonempty string.`);
  }
  if (input.model !== undefined && typeof input.model !== "string")
    return deny("model must be a string.");
  if (input.fork !== undefined && input.fork !== false)
    return deny("forked subagents are not supported.");
  if (input.items !== undefined && (!Array.isArray(input.items) || !input.items.every(nonemptyString))) {
    return deny("items must be an array of nonempty strings.");
  }
  if (input.resume_agent_ids !== undefined && (!plainObject(input.resume_agent_ids) || Reflect.ownKeys(input.resume_agent_ids).some((key) => typeof key !== "string" || !nonemptyString(key) || !nonemptyString(input.resume_agent_ids[key])))) {
    return deny("resume_agent_ids must map nonempty agent IDs to nonempty prompts.");
  }
  const fresh = Array.isArray(input.items) ? input.items.length : 0;
  const resumed = plainObject(input.resume_agent_ids) ? Object.keys(input.resume_agent_ids).length : 0;
  const total = fresh + resumed;
  if (total === 0)
    return deny("a wave must contain at least one new or resumed entry.");
  if (total > width) {
    return deny(`wave has ${total} new and resumed entries, exceeding the limit ${width}; split the work into sequential waves of at most ${width} entries and wait for each wave to finish.`);
  }
  if (fresh === 1 && resumed === 0) {
    return deny("fresh-only waves require at least two entries; regroup targets into disjoint entries within the wave limit, or resume an existing child for the remaining work.");
  }
  return { decision: "allow" };
}

// runtime/hooks/approval-policy.ts
var READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "ReadMediaFile",
  "TaskList",
  "TaskOutput",
  "WaitFor"
]);
var WEB_TOOLS = new Set(["WebSearch", "FetchURL"]);
var AGENT_SWARM_TOOL = "AgentSwarm";
var PLAN_MODE_TOOLS = new Set(["EnterPlanMode", "ExitPlanMode"]);
var KNOWN_LABELS = new Set([
  "ask",
  "review",
  "challenge",
  "rescue",
  "swarm",
  "swarm-write"
]);
async function decideHookOutcome(input, ctx) {
  const result = decideHookOutcomePure(input, ctx);
  if (!("evaluator" in result))
    return result;
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  if (result.evaluator === "read-scope") {
    return await evaluateScopedRead(toolName, input.tool_input, result.roots);
  }
  if (ctx.rescueEvaluator !== undefined) {
    return await ctx.rescueEvaluator(result.workspaceRoot, toolName, input.tool_input);
  }
  if (READ_ONLY_TOOLS.has(toolName))
    return { decision: "allow" };
  return {
    decision: "deny",
    reason: `kimi-plugin-cc safety hook: ${ctx.commandLabel} evaluator not configured; tool "${toolName}" denied as a safety default.`
  };
}
function decideHookOutcomePure(input, ctx) {
  const label = typeof ctx.commandLabel === "string" ? ctx.commandLabel : undefined;
  if (label === undefined || label.length === 0) {
    return { decision: "allow" };
  }
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  if ((label === "swarm" || label === "swarm-write") && (ctx.swarmPolicy !== undefined || ctx.swarmWaveSize !== undefined)) {
    if (toolName === AGENT_SWARM_TOOL) {
      return evaluateSwarmWaveInput(input.tool_input, ctx.swarmPolicy, ctx.swarmWaveSize);
    }
    if (toolName === "Agent") {
      return {
        decision: "deny",
        reason: "kimi-plugin-cc safety hook: singular Agent delegation is denied for bounded swarm jobs."
      };
    }
    const args = input.tool_input;
    if (toolName === "Bash" && typeof args === "object" && args !== null && args.run_in_background === true) {
      return {
        decision: "deny",
        reason: "kimi-plugin-cc safety hook: run commands in the foreground; explicit background commands are disabled for bounded swarm execution."
      };
    }
  }
  if (PLAN_MODE_TOOLS.has(toolName)) {
    return {
      decision: "deny",
      reason: `kimi-plugin-cc safety hook: tool "${toolName}" is denied for plugin-managed sessions because agent-core-v2 plan-file writes can bypass later external hooks; native plan mode is never armed in plugin-managed sessions.`
    };
  }
  if (["GetGoal", "UpdateGoal", "CreateGoal", "SetGoalBudget"].includes(toolName)) {
    if (toolName === "SetGoalBudget" && label === "rescue" && ctx.operationKind === "pursue") {
      return {
        decision: "deny",
        reason: `kimi-plugin-cc safety hook: tool "SetGoalBudget" is denied. The outer plugin wall-clock budget already applies; continue the current goal without retrying SetGoalBudget or changing its budget.`
      };
    }
    const args = input.tool_input;
    const objectArgs = typeof args === "object" && args !== null && !Array.isArray(args) && (Object.getPrototypeOf(args) === Object.prototype || Object.getPrototypeOf(args) === null);
    const keys = objectArgs ? Reflect.ownKeys(args) : [];
    const validArgs = objectArgs && (toolName === "GetGoal" && keys.length === 0 || toolName === "UpdateGoal" && keys.length === 1 && keys[0] === "status" && (args.status === "complete" || args.status === "blocked"));
    if (label === "rescue" && ctx.operationKind === "pursue" && typeof ctx.trustedWorkspaceRoot === "string" && ctx.trustedWorkspaceRoot.trim().length > 0 && validArgs) {
      return { decision: "allow" };
    }
    return {
      decision: "deny",
      reason: `kimi-plugin-cc safety hook: tool "${toolName}" requires a pursue run with a trusted workspace root and exact terminal goal metadata arguments; goal creation, reactivation, and budget changes are denied.`
    };
  }
  switch (label) {
    case "ask":
    case "review":
    case "challenge":
      if (READ_ONLY_TOOLS.has(toolName)) {
        return readToolDecision(toolName, scopeOf(ctx));
      }
      if (WEB_TOOLS.has(toolName))
        return webToolDecision(label, toolName, input.tool_input, scopeOf(ctx));
      return {
        decision: "deny",
        reason: denyReadOnlyMessage(label, toolName)
      };
    case "swarm":
      if (toolName === AGENT_SWARM_TOOL)
        return { decision: "allow" };
      if (READ_ONLY_TOOLS.has(toolName))
        return readToolDecision(toolName, scopeOf(ctx));
      if (WEB_TOOLS.has(toolName))
        return webToolDecision(label, toolName, input.tool_input, scopeOf(ctx));
      return {
        decision: "deny",
        reason: denySwarmMessage(toolName, ctx.swarmPolicy === BOUNDED_SWARM_POLICY && ctx.swarmWaveSize === "1")
      };
    case "swarm-write": {
      const slashed = backslashRootDenial(ctx.trustedWorkspaceRoot, toolName);
      if (slashed !== undefined)
        return slashed;
      if (READ_ONLY_TOOLS.has(toolName) || toolName === AGENT_SWARM_TOOL) {
        return { decision: "allow" };
      }
      const workspaceRoot = typeof ctx.trustedWorkspaceRoot === "string" ? ctx.trustedWorkspaceRoot : "";
      if (workspaceRoot.length === 0) {
        return {
          decision: "deny",
          reason: `kimi-plugin-cc safety hook: swarm-write received no trusted workspace root; tool "${toolName}" denied. ` + "This is a plugin misconfiguration — writes are refused rather than risk the user's working tree."
        };
      }
      return { evaluator: "rescue", workspaceRoot };
    }
    case "rescue": {
      const slashed = backslashRootDenial(ctx.trustedWorkspaceRoot, toolName);
      if (slashed !== undefined)
        return slashed;
      const workspaceRoot = typeof ctx.trustedWorkspaceRoot === "string" ? ctx.trustedWorkspaceRoot : "";
      if (workspaceRoot.length === 0) {
        if (READ_ONLY_TOOLS.has(toolName))
          return { decision: "allow" };
        return {
          decision: "deny",
          reason: `kimi-plugin-cc safety hook: rescue received no trusted workspace root; tool "${toolName}" denied. ` + "This is a plugin misconfiguration — writes are refused rather than trusting hook payload cwd."
        };
      }
      return { evaluator: "rescue", workspaceRoot };
    }
    default:
      if (KNOWN_LABELS.has(label)) {
        return {
          decision: "deny",
          reason: `kimi-plugin-cc safety hook: command label "${label}" has no policy branch.`
        };
      }
      if (READ_ONLY_TOOLS.has(toolName)) {
        return readToolDecision(toolName, scopeOf(ctx));
      }
      return {
        decision: "deny",
        reason: `kimi-plugin-cc safety hook: unrecognized command label "${label}"; tool "${toolName}" denied as a safety default.`
      };
  }
}
function backslashRootDenial(root, toolName) {
  if (process.platform === "win32" || typeof root !== "string" || !root.includes("\\"))
    return;
  return {
    decision: "deny",
    reason: `kimi-plugin-cc safety hook: writes cannot be confined to ${root}: it contains a backslash, ` + `which kimi-code reads as a path separator; tool "${toolName}" denied.`
  };
}
function scopeOf(ctx) {
  return parseScopeEnvironment(ctx.readRoots, ctx.network);
}
function readToolDecision(toolName, scope) {
  if (scope.confined && SCOPED_READ_TOOLS.has(toolName))
    return { evaluator: "read-scope", roots: scope.roots };
  return { decision: "allow" };
}
function webToolDecision(label, toolName, toolInput, scope) {
  if (!scope.network) {
    return {
      decision: "deny",
      reason: `kimi-plugin-cc safety hook: ${label} has no network access; tool "${toolName}" is denied. ` + "The caller can allow WebSearch and FetchURL for one call with --network, which also confines reads to the workspace and any --read-root."
    };
  }
  if (toolName === "WebSearch")
    return { decision: "allow" };
  const url = typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput) ? toolInput.url : undefined;
  if (isAllowedFetchUrl(url))
    return { decision: "allow" };
  return {
    decision: "deny",
    reason: "kimi-plugin-cc safety hook: FetchURL accepts only http:// and https:// URLs without embedded credentials " + "whose host is a public name or a canonical global unicast IP address; localhost, .local and .internal names, " + "numerically encoded hosts, and private, loopback, link-local, documentation, multicast, reserved, 6to4 and Teredo addresses are denied."
  };
}
function denyReadOnlyMessage(label, toolName) {
  const tool = toolName.length > 0 ? toolName : "<unspecified>";
  return [
    `kimi-plugin-cc safety hook: ${label} is read-only.`,
    `Tool "${tool}" is denied — use Read, Grep, or Glob to inspect the workspace instead.`,
    "If you need to mutate state, the user must invoke /kimi:task --write (write-capable) rather than this command."
  ].join(" ");
}
function denySwarmMessage(toolName, singleWorker) {
  const tool = toolName.length > 0 ? toolName : "<unspecified>";
  if (singleWorker) {
    return [
      "kimi-plugin-cc safety hook: swarm with concurrency 1 is a read-only review.",
      `Tool "${tool}" is denied — use Read, Grep, or Glob to inspect the workspace.`,
      "Complete the review yourself; delegation is denied.",
      "Return your findings in a markdown report."
    ].join(" ");
  }
  return [
    "kimi-plugin-cc safety hook: swarm is a read-only parallel review.",
    `Tool "${tool}" is denied — every subagent may use Read, Grep, or Glob to inspect the workspace,`,
    "and the coordinator may use AgentSwarm to fan out, but no write, edit, or shell operations are permitted.",
    "Consolidate the subagents' findings into a markdown report instead."
  ].join(" ");
}

// runtime/hooks/hook-timing.ts
var HOOK_TIMEOUT_S = 15;
var HOOK_DECISION_DEADLINE_MS = HOOK_TIMEOUT_S * 1000 - 5000;
var HOOK_TEST_DELAY_ENV = "KIMI_PLUGIN_CC_HOOK_TEST_DELAY_MS";

// runtime/rescue-approval.ts
import { access, lstat as lstat2, readdir, realpath as realpath2 } from "node:fs/promises";
import path2 from "node:path";

// runtime/vendor/shell-quote/parse.ts
var CONTROL = "(?:" + [
  "\\|\\|",
  "\\&\\&",
  ";;",
  "\\|\\&",
  "\\<\\(",
  "\\<\\<\\<",
  ">>",
  ">\\&",
  "<\\&",
  "[&;()|<>]"
].join("|") + ")";
var controlRE = new RegExp("^" + CONTROL + "$");
var META = "|&;()<> \\t";
var SINGLE_QUOTE = '"((\\\\"|[^"])*?)"';
var DOUBLE_QUOTE = "'((\\\\'|[^'])*?)'";
var hash = /^#$/;
var SQ = "'";
var DQ = '"';
var DS = "$";
var TOKEN = "";
var mult = 4294967296;
for (i = 0;i < 4; i++) {
  TOKEN += (mult * Math.random()).toString(16);
}
var i;
var startsWithToken = new RegExp("^" + TOKEN);
function matchAll(s, r) {
  var origIndex = r.lastIndex;
  var matches = [];
  var matchObj;
  while (matchObj = r.exec(s)) {
    matches.push(matchObj);
    if (r.lastIndex === matchObj.index) {
      r.lastIndex += 1;
    }
  }
  r.lastIndex = origIndex;
  return matches;
}
function getVar(env, pre, key) {
  var r = typeof env === "function" ? env(key) : env[key];
  if (typeof r === "undefined" && key != "") {
    r = "";
  } else if (typeof r === "undefined") {
    r = "$";
  }
  if (typeof r === "object") {
    return pre + TOKEN + JSON.stringify(r) + TOKEN;
  }
  return pre + r;
}
function parseInternal(string, env, opts) {
  if (!opts) {
    opts = {};
  }
  var BS = opts.escape || "\\";
  var BAREWORD = "(\\" + BS + `['"` + META + `]|[^\\s'"` + META + "])+";
  var chunker = new RegExp([
    "(" + CONTROL + ")",
    "(" + BAREWORD + "|" + SINGLE_QUOTE + "|" + DOUBLE_QUOTE + ")+"
  ].join("|"), "g");
  var matches = matchAll(string, chunker);
  if (matches.length === 0) {
    return [];
  }
  if (!env) {
    env = {};
  }
  var commented = false;
  return matches.map(function(match) {
    var s = match[0];
    if (!s || commented) {
      return;
    }
    if (controlRE.test(s)) {
      return { op: s };
    }
    var quote = false;
    var esc = false;
    var out = "";
    var isGlob = false;
    var i;
    function parseEnvVar() {
      i += 1;
      var varend;
      var varname;
      var char = s.charAt(i);
      if (char === "{") {
        i += 1;
        if (s.charAt(i) === "}") {
          throw new Error("Bad substitution: " + s.slice(i - 2, i + 1));
        }
        varend = s.indexOf("}", i);
        if (varend < 0) {
          throw new Error("Bad substitution: " + s.slice(i));
        }
        varname = s.slice(i, varend);
        i = varend;
      } else if (/[*@#?$!_-]/.test(char)) {
        varname = char;
        i += 1;
      } else {
        var slicedFromI = s.slice(i);
        varend = slicedFromI.match(/[^\w\d_]/);
        if (!varend) {
          varname = slicedFromI;
          i = s.length;
        } else {
          varname = slicedFromI.slice(0, varend.index);
          i += varend.index - 1;
        }
      }
      return getVar(env, "", varname);
    }
    for (i = 0;i < s.length; i++) {
      var c = s.charAt(i);
      isGlob = isGlob || !quote && (c === "*" || c === "?");
      if (esc) {
        out += c;
        esc = false;
      } else if (quote) {
        if (c === quote) {
          quote = false;
        } else if (quote == SQ) {
          out += c;
        } else {
          if (c === BS) {
            i += 1;
            c = s.charAt(i);
            if (c === DQ || c === BS || c === DS) {
              out += c;
            } else {
              out += BS + c;
            }
          } else if (c === DS) {
            out += parseEnvVar();
          } else {
            out += c;
          }
        }
      } else if (c === DQ || c === SQ) {
        quote = c;
      } else if (controlRE.test(c)) {
        return { op: s };
      } else if (hash.test(c)) {
        commented = true;
        var commentObj = { comment: string.slice(match.index + i + 1) };
        if (out.length) {
          return [out, commentObj];
        }
        return [commentObj];
      } else if (c === BS) {
        esc = true;
      } else if (c === DS) {
        out += parseEnvVar();
      } else {
        out += c;
      }
    }
    if (isGlob) {
      return { op: "glob", pattern: out };
    }
    return out;
  }).reduce(function(prev, arg) {
    if (typeof arg === "undefined") {
      return prev;
    }
    [].concat(arg).forEach(function(entry) {
      prev[prev.length] = entry;
    });
    return prev;
  }, []);
}
function parse(s, env, opts) {
  var mapped = parseInternal(s, env, opts);
  if (typeof env !== "function") {
    return mapped;
  }
  return mapped.reduce(function(acc, value) {
    if (typeof value === "object") {
      acc[acc.length] = value;
      return acc;
    }
    var xs = value.split(RegExp("(" + TOKEN + ".*?" + TOKEN + ")", "g"));
    if (xs.length === 1) {
      acc[acc.length] = xs[0];
      return acc;
    }
    xs.filter(Boolean).forEach(function(x) {
      acc[acc.length] = startsWithToken.test(x) ? JSON.parse(x.split(TOKEN)[1]) : x;
    });
    return acc;
  }, []);
}
// runtime/rescue-approval.ts
var MUTATING_FLAGS_EXACT = new Set([
  "--fix",
  "--write",
  "-w",
  "--apply",
  "--in-place",
  "-i",
  "--output",
  "--output-file",
  "--output-directory",
  "--output-dir"
]);
var MUTATING_FLAG_PREFIXES = [...MUTATING_FLAGS_EXACT].filter((flag) => flag.startsWith("--")).map((flag) => `${flag}=`);
var EXEC_DELEGATING_FLAGS_EXACT = new Set([
  "--open-files-in-pager",
  "-vettool",
  "--vettool",
  "-toolexec",
  "--toolexec",
  "-exec",
  "-execdir",
  "--pre",
  "--hostname-bin",
  "--compress-program"
]);
var EXEC_DELEGATING_FLAG_PREFIXES = [...EXEC_DELEGATING_FLAGS_EXACT].filter((flag) => flag !== "-exec" && flag !== "-execdir").map((flag) => `${flag}=`);
var PYTEST_REPORT_FLAGS = [
  "--junitxml",
  "--junit-xml",
  "--result-log",
  "--report-log"
];
var PIPELINE_PLUMBING = new Set(["head", "tail", "wc", "sort", "uniq"]);
var GIT_READONLY_SUBCOMMANDS = new Set(["status", "diff", "show", "log", "grep", "blame"]);
var CARGO_SUBCOMMANDS = new Set(["check", "clippy", "test"]);
var GO_SUBCOMMANDS = new Set(["build", "vet", "test"]);
var BANNED_FIND_ACTIONS = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprintf",
  "-fprint0",
  "-fls"
]);
var GO_WRITE_FLAGS = new Set([
  "-coverprofile",
  "-cpuprofile",
  "-memprofile",
  "-blockprofile",
  "-mutexprofile",
  "-trace",
  "-outputdir"
]);
var CARGO_WRITE_FLAGS = new Set(["--target-dir", "--out-dir"]);
var TSC_WRITE_FLAGS_LC = new Set([
  "--generatecpuprofile",
  "--generatetrace",
  "--tsbuildinfofile",
  "--outfile",
  "--outdir",
  "--out",
  "--declarationdir"
]);
var RUFF_WRITE_FLAGS = new Set(["--add-noqa", "--fix-only", "--cache-dir", "--output-file", "--config"]);
var ESLINT_WRITE_FLAGS = new Set(["--cache-location", "--output-file"]);
var ESLINT_CODELOAD_FLAGS = new Set(["--parser", "--rulesdir", "--resolve-plugins-relative-to"]);
var MYPY_WRITE_FLAGS_ABBREV = [
  "--junit-xml",
  "--cache-dir",
  "--install-types",
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
  "--xslt-txt-report"
];
function hasFlagFromSet(args, flags) {
  return args.some((arg) => flags.has(flagName(arg)));
}
function flagName(arg) {
  const eq = arg.indexOf("=");
  return eq === -1 ? arg : arg.slice(0, eq);
}
function matchesAbbreviatedFlag(args, flags) {
  return args.some((arg) => {
    const name = flagName(arg);
    if (name.length < 3)
      return false;
    return flags.some((flag) => flag.startsWith(name) || name.startsWith(flag));
  });
}
async function evaluateRescueHookRequest(workspaceRoot, toolName, toolInput) {
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { decision: "allow" };
  }
  const posix = process.platform !== "win32";
  if (posix && workspaceRoot.includes("\\")) {
    return { decision: "deny", reason: backslashRootReason(workspaceRoot, toolName) };
  }
  let root;
  try {
    root = await realpath2(workspaceRoot);
  } catch (err) {
    return {
      decision: "deny",
      reason: `rescue cannot resolve workspace root: ${err.message}`
    };
  }
  if (posix && root.includes("\\")) {
    return { decision: "deny", reason: backslashRootReason(root, toolName) };
  }
  if (toolName === "Bash") {
    const command = extractBashCommand(toolInput);
    if (command === null) {
      return {
        decision: "deny",
        reason: "rescue cannot evaluate Bash input with no command field"
      };
    }
    const cwd = isObject(toolInput) ? toolInput.cwd : undefined;
    if (cwd !== undefined) {
      if (typeof cwd !== "string" || cwd.length === 0) {
        return { decision: "deny", reason: "rescue requires Bash cwd to be a non-empty string" };
      }
      if (hasAmbiguousPathSpelling(cwd))
        return ambiguousPathDenial(cwd, root);
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
      } catch (err) {
        return { decision: "deny", reason: `rescue cannot inspect Bash cwd ${cwd}: ${err.message}` };
      }
    }
    const result = await validateWorkspaceShellCommand(command, root);
    return result.response === "approve" ? { decision: "allow" } : { decision: "deny", reason: result.feedback ?? "rescue rejected the shell command" };
  }
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    for (const key of ["path", "file_path"]) {
      const candidate = isObject(toolInput) ? toolInput[key] : undefined;
      if (typeof candidate === "string" && hasAmbiguousPathSpelling(candidate)) {
        return ambiguousPathDenial(candidate, root);
      }
    }
    const filePath = extractFilePath(toolInput);
    if (filePath === null) {
      return {
        decision: "deny",
        reason: `rescue cannot evaluate ${toolName} input with no path field`
      };
    }
    try {
      return pathDecision(await checkApprovedPath(root, filePath), filePath);
    } catch (err) {
      return {
        decision: "deny",
        reason: `rescue cannot inspect ${filePath} (outside the workspace, inside .git or unreadable): ${err.message}`
      };
    }
  }
  return {
    decision: "deny",
    reason: `rescue does not allow tool "${toolName}" — only Bash, Write, Edit, MultiEdit (with allowlist checks) and read-only tools are permitted.`
  };
}
function backslashRootReason(root, toolName) {
  return `kimi-plugin-cc safety hook: writes cannot be confined to ${root}: it contains a backslash, ` + `which kimi-code reads as a path separator; tool "${toolName}" denied.`;
}
function hasAmbiguousPathSpelling(candidate) {
  return candidate.includes("\\") || candidate.includes("\x00") || candidate.startsWith("~") || /^[A-Za-z]:/.test(candidate) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(candidate);
}
function ambiguousPathDenial(candidate, root) {
  return {
    decision: "deny",
    reason: `rescue rejects the path ${JSON.stringify(candidate)}: a backslash, leading ~, drive letter, NUL or URL ` + `scheme can resolve differently in kimi-code; use a plain POSIX path under ${root}`
  };
}
function pathDecision(outcome, filePath) {
  if (outcome === "allow")
    return { decision: "allow" };
  if (outcome === "hardlink")
    return { decision: "deny", reason: `${HARD_LINK_REASON}: ${filePath}` };
  if (outcome === "symlink") {
    return {
      decision: "deny",
      reason: `rescue does not overwrite symlinks: ${filePath}`
    };
  }
  return {
    decision: "deny",
    reason: `rescue rejects file edits outside the workspace or inside .git: ${filePath}`
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
  const candidate = toolInput.path ?? toolInput.file_path;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function checkApprovedPath(workspaceRoot, rawTargetPath) {
  const absoluteTarget = path2.isAbsolute(rawTargetPath) ? path2.resolve(rawTargetPath) : path2.resolve(workspaceRoot, rawTargetPath);
  const targetStats = await statIfExists(absoluteTarget);
  if (targetStats?.isSymbolicLink()) {
    return "symlink";
  }
  let candidatePath;
  if (targetStats !== null) {
    candidatePath = await realpath2(absoluteTarget);
  } else {
    const nearestExistingAncestor = await findNearestExistingAncestor(path2.dirname(absoluteTarget));
    const ancestorRealPath = await realpath2(nearestExistingAncestor);
    candidatePath = path2.resolve(ancestorRealPath, path2.relative(nearestExistingAncestor, absoluteTarget));
  }
  if (!isWithinWorkspaceOutsideAnyGit(workspaceRoot, candidatePath))
    return "reject";
  return isHardLinkedFile(targetStats) ? "hardlink" : "allow";
}
function isHardLinkedFile(stats) {
  return stats !== null && stats.isFile() && stats.nlink > 1;
}
var HARD_LINK_REASON = "rescue does not write through hard links";
async function checkApprovedDirectory(workspaceRoot, rawCwd) {
  const candidate = path2.resolve(workspaceRoot, rawCwd);
  const stats = await statIfExists(candidate);
  if (stats?.isSymbolicLink())
    return "symlink";
  if (!stats?.isDirectory())
    return "missing";
  const resolved = await realpath2(candidate);
  return isWithinWorkspaceOutsideAnyGit(workspaceRoot, resolved) ? "allow" : "reject";
}
async function statIfExists(targetPath) {
  try {
    return await lstat2(targetPath);
  } catch (error) {
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
    } catch {
      const parent = path2.dirname(candidate);
      if (parent === candidate) {
        return candidate;
      }
      candidate = parent;
    }
  }
}
async function validateWorkspaceShellCommand(command, workspaceRoot) {
  const parsed = parseShellPipeline(command);
  if ("response" in parsed)
    return parsed;
  if (parsed.stages.filter((stage) => FILE_OPERATION_FLAGS.has(stage[0])).length > 1) {
    return rejectShell(`Rescue allows only one rm, mv, cp or mkdir per command: ${command}`);
  }
  for (let index = 0;index < parsed.stages.length; index += 1) {
    const stage = parsed.stages[index];
    const allowed = FILE_OPERATION_FLAGS.has(stage[0]) ? await validateFileOperationStage(stage, workspaceRoot) : validateShellStage(stage, parsed.stages.length > 1);
    if (!allowed.ok) {
      return rejectShell(allowed.reason);
    }
  }
  return { response: "approve" };
}
var MAX_SHELL_COMMAND_LENGTH = 16384;
function parseShellPipeline(command) {
  if (command.length > MAX_SHELL_COMMAND_LENGTH) {
    return rejectShell(`Rescue rejects shell commands longer than ${MAX_SHELL_COMMAND_LENGTH} characters (this one has ${command.length}); split the work into shorter commands.`);
  }
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
  return { stages };
}
var FILE_OPERATION_FLAGS = new Map([
  ["rm", new Set(["-f", "-r", "-R", "-rf", "-fr"])],
  ["mkdir", new Set(["-p"])],
  ["mv", new Set(["-f", "-n"])],
  ["cp", new Set(["-R", "-r", "-p", "-f", "-n"])]
]);
var FILE_OPERAND = /^[\p{L}\p{N}._+@%,:/ -]+$/u;
async function validateFileOperationStage(tokens, workspaceRoot) {
  const [command, ...args] = tokens;
  const allowedFlags = FILE_OPERATION_FLAGS.get(command);
  const shown = tokens.join(" ");
  if (process.platform === "win32") {
    return { ok: false, reason: `Rescue does not allow ${command} on Windows: ${shown}` };
  }
  const flags = new Set;
  const operands = [];
  let endOfFlags = false;
  for (const arg of args) {
    if (!endOfFlags && arg === "--") {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && arg.startsWith("-")) {
      if (!allowedFlags.has(arg)) {
        return {
          ok: false,
          reason: `Rescue allows ${command} only with ${[...allowedFlags].join(", ")} and --: ${shown}`
        };
      }
      flags.add(arg);
      continue;
    }
    endOfFlags = true;
    if (!FILE_OPERAND.test(arg)) {
      return {
        ok: false,
        reason: `Rescue rejects ${command} operands with glob, expansion or other special characters: ${shown}`
      };
    }
    if (!path2.isAbsolute(arg)) {
      return {
        ok: false,
        reason: `Rescue requires absolute paths for ${command}; use paths under ${workspaceRoot}: ${shown}`
      };
    }
    if (arg.split("/").includes("..")) {
      return { ok: false, reason: `Rescue rejects ${command} operands containing "..": ${shown}` };
    }
    operands.push(arg);
  }
  const minimum = command === "mv" || command === "cp" ? 2 : 1;
  if (operands.length < minimum) {
    return { ok: false, reason: `Rescue requires ${command} to name at least ${minimum} path operand(s): ${shown}` };
  }
  try {
    const resolved = [];
    for (const operand of operands) {
      const outcome = await resolveFileOperand(workspaceRoot, operand);
      if (outcome === "symlink") {
        return { ok: false, reason: `Rescue rejects ${command} on a symlink operand: ${operand}` };
      }
      if (outcome === "reject") {
        return {
          ok: false,
          reason: `Rescue rejects ${command} operands outside the workspace or inside .git: ${operand}`
        };
      }
      resolved.push(outcome);
    }
    const sources = command === "mv" || command === "cp" ? resolved.slice(0, -1) : resolved;
    if (command !== "mkdir" && sources.some((operand) => operand.path === workspaceRoot)) {
      return { ok: false, reason: `Rescue rejects ${command} on the workspace root itself: ${shown}` };
    }
    if (command === "mv" || command === "cp") {
      const missing = sources.find((source) => source.stats === null);
      if (missing !== undefined) {
        return { ok: false, reason: `Rescue requires every ${command} source to exist: ${missing.path}` };
      }
      const destination = resolved.at(-1);
      const landing = sources.map((source) => destination.stats?.isDirectory() ? path2.join(destination.path, path2.basename(source.path)) : destination.path);
      for (const [index, source] of sources.entries()) {
        if (landing.some((target, other) => other !== index && isWithin2(target, source.path))) {
          return { ok: false, reason: `Rescue rejects ${command} where a source lies under another source's destination: ${shown}` };
        }
        const inside = (target) => target !== source.path && isWithin2(source.path, target);
        if (inside(destination.path) || inside(landing[index])) {
          return { ok: false, reason: `Rescue rejects ${command} whose destination lies under one of its sources: ${shown}` };
        }
      }
    }
    const recursive = flags.has("-r") || flags.has("-R") || flags.has("-rf") || flags.has("-fr");
    const treeOperation = command === "rm" && recursive ? { label: "rm -r", remedy: "delete" } : command === "mv" ? { label: "mv", remedy: "move" } : command === "cp" && recursive ? { label: "cp -R", remedy: "copy" } : null;
    if (treeOperation !== null) {
      const scan = await scanTreesForGit(sources.filter((operand) => operand.stats?.isDirectory()).map((operand) => operand.path));
      if (scan === "git") {
        return {
          ok: false,
          reason: `Rescue rejects ${treeOperation.label} of a tree that holds a .git entry at any depth: ${shown}`
        };
      }
      if (scan !== "clean") {
        return {
          ok: false,
          reason: `Rescue could not prove ${treeOperation.label} leaves every .git intact (${scan}); ` + `${treeOperation.remedy} in smaller pieces: ${shown}`
        };
      }
    }
    if (command === "mv" || command === "cp") {
      const destination = resolved.at(-1);
      if (command === "cp" && recursive && destination.stats !== null && sources.some((source) => source.stats?.isDirectory())) {
        return {
          ok: false,
          reason: `Rescue allows cp -R of a directory only to a destination that does not exist yet: ${shown}`
        };
      }
      if (command === "cp" && isHardLinkedFile(destination.stats)) {
        return { ok: false, reason: `${HARD_LINK_REASON}: ${destination.path}` };
      }
      if (destination.stats?.isDirectory()) {
        for (const source of sources) {
          const target = path2.join(destination.path, path2.basename(source.path));
          const targetStats = await statIfExists(target);
          if (targetStats?.isSymbolicLink()) {
            return { ok: false, reason: `Rescue rejects ${command} onto a symlink: ${target}` };
          }
          if (command === "cp" && isHardLinkedFile(targetStats)) {
            return { ok: false, reason: `${HARD_LINK_REASON}: ${target}` };
          }
          if (!isWithinWorkspaceOutsideAnyGit(workspaceRoot, target)) {
            return { ok: false, reason: `Rescue rejects ${command} into .git: ${target}` };
          }
        }
      }
    }
  } catch (err) {
    return { ok: false, reason: `Rescue cannot inspect ${command} operands: ${err.message}` };
  }
  return { ok: true };
}
async function resolveFileOperand(workspaceRoot, operand) {
  const absolute = path2.resolve(operand);
  const stats = await statIfExists(absolute);
  if (stats?.isSymbolicLink())
    return "symlink";
  let candidate;
  if (stats !== null) {
    candidate = await realpath2(absolute);
  } else {
    let ancestor = path2.dirname(absolute);
    let ancestorReal = null;
    while (ancestorReal === null) {
      try {
        ancestorReal = await realpath2(ancestor);
      } catch (err) {
        if (err.code !== "ENOENT")
          throw err;
        if (await statIfExists(ancestor) !== null)
          return "reject";
        const parent = path2.dirname(ancestor);
        if (parent === ancestor)
          return "reject";
        ancestor = parent;
      }
    }
    candidate = path2.join(ancestorReal, path2.relative(ancestor, absolute));
  }
  return isWithinWorkspaceOutsideAnyGit(workspaceRoot, candidate) ? { path: candidate, stats } : "reject";
}
function validateShellStage(tokens, pipelineMode) {
  const [command, ...args] = tokens;
  if (!command || path2.isAbsolute(command) || command.includes(path2.sep)) {
    return { ok: false, reason: `Rescue rejects non-standard shell entrypoints: ${tokens.join(" ")}` };
  }
  if (hasMutatingFlag(command === "grep" ? args.filter((arg) => arg !== "-i") : args)) {
    return { ok: false, reason: `Rescue rejects mutating shell flags: ${tokens.join(" ")}` };
  }
  if (hasExecDelegatingFlag(args)) {
    return {
      ok: false,
      reason: `Rescue rejects flags that execute an external command/tool (e.g. --open-files-in-pager, -vettool, -exec, -toolexec): ${tokens.join(" ")}`
    };
  }
  if (command === "git") {
    const gitArgs = args[0] === "--no-pager" ? args.slice(1) : args;
    const firstArg = gitArgs[0] ?? "";
    if (firstArg.startsWith("-")) {
      return {
        ok: false,
        reason: `Rescue rejects git pre-subcommand flags (e.g. -c/-C/-p/--exec-path): ${tokens.join(" ")}. Put the read-only subcommand immediately after \`git\` or \`git --no-pager\`.`
      };
    }
    if (args.some((arg) => arg === "-O" || /^-O./.test(arg))) {
      return {
        ok: false,
        reason: `Rescue rejects git -O/--open-files-in-pager (executes the pager value as a command): ${tokens.join(" ")}.`
      };
    }
    return GIT_READONLY_SUBCOMMANDS.has(firstArg) ? { ok: true } : { ok: false, reason: `Rescue rejects git mutation commands: ${tokens.join(" ")}` };
  }
  if (command === "find") {
    return args.some((arg) => BANNED_FIND_ACTIONS.has(arg)) ? {
      ok: false,
      reason: `Rescue rejects find actions that execute or write files: ${tokens.join(" ")}`
    } : { ok: true };
  }
  if (command === "tsc") {
    const tscLowerNames = args.map((arg) => flagName(arg).toLowerCase());
    if (!tscLowerNames.includes("--noemit")) {
      return { ok: false, reason: "Rescue allows tsc only with --noEmit." };
    }
    if (tscLowerNames.some((name) => TSC_WRITE_FLAGS_LC.has(name))) {
      return {
        ok: false,
        reason: `Rescue rejects tsc write flags (--generateCpuProfile, --generateTrace, --tsBuildInfoFile, --outFile, --outDir, --out, --declarationDir — case-insensitive): ${tokens.join(" ")}.`
      };
    }
    return { ok: true };
  }
  if (command === "biome") {
    if (args[0] !== "check") {
      return { ok: false, reason: "Rescue allows biome only in check mode." };
    }
    if (args.some((arg) => /^--(apply|write|fix)/.test(arg))) {
      return {
        ok: false,
        reason: `Rescue rejects biome check write flags (--apply, --apply-unsafe, --write, --fix, and -unsafe/-only variants): ${tokens.join(" ")}.`
      };
    }
    return { ok: true };
  }
  if (command === "ruff") {
    if (args[0] === "check") {
      if (hasWriteShortFlag(args)) {
        return {
          ok: false,
          reason: `Rescue rejects ruff -o (writes the report to a file): ${tokens.join(" ")}.`
        };
      }
      if (hasFlagFromSet(args, RUFF_WRITE_FLAGS)) {
        return {
          ok: false,
          reason: `Rescue rejects ruff write flags (--add-noqa, --fix-only, --cache-dir, --output-file): ${tokens.join(" ")}.`
        };
      }
      return { ok: true };
    }
    if (args[0] === "format") {
      return args.some((arg) => arg === "--check" || arg === "--diff") ? { ok: true } : { ok: false, reason: "Rescue allows ruff format only with --check or --diff." };
    }
    return { ok: false, reason: `Rescue rejects ruff subcommand: ${tokens.join(" ")}` };
  }
  if (command === "cargo") {
    if (args[0] === "fmt") {
      return args.includes("--check") ? { ok: true } : { ok: false, reason: "Rescue allows cargo fmt only with --check." };
    }
    if (!CARGO_SUBCOMMANDS.has(args[0] ?? "")) {
      return { ok: false, reason: `Rescue rejects cargo subcommand: ${tokens.join(" ")}` };
    }
    if (hasFlagFromSet(args, CARGO_WRITE_FLAGS)) {
      return {
        ok: false,
        reason: `Rescue rejects cargo --target-dir/--out-dir (writes artifacts to an arbitrary path): ${tokens.join(" ")}.`
      };
    }
    return { ok: true };
  }
  if (command === "go") {
    if (!GO_SUBCOMMANDS.has(args[0] ?? "")) {
      return { ok: false, reason: `Rescue rejects go subcommand: ${tokens.join(" ")}` };
    }
    if (hasWriteShortFlag(args)) {
      return {
        ok: false,
        reason: `Rescue rejects go -o (writes a binary to an arbitrary path): ${tokens.join(" ")}.`
      };
    }
    if (hasFlagFromSet(args, GO_WRITE_FLAGS)) {
      return {
        ok: false,
        reason: `Rescue rejects go profile/output flags (-coverprofile, -cpuprofile, -memprofile, -blockprofile, -mutexprofile, -trace, -outputdir write to arbitrary paths): ${tokens.join(" ")}.`
      };
    }
    return { ok: true };
  }
  if (command === "python" || command === "python3") {
    if (args[0] !== "-m" || args[1] !== "pytest") {
      return { ok: false, reason: `Rescue rejects ${command} shell command: ${tokens.join(" ")}` };
    }
    if (hasPytestReportFlag(args.slice(2))) {
      return pytestReportFlagRejection(tokens);
    }
    return { ok: true };
  }
  if (command === "npm" || command === "pnpm" || command === "yarn" || command === "bun" || command === "uv") {
    return validatePackageManagerCommand(command, args);
  }
  if (command === "eslint") {
    if (hasWriteShortFlag(args)) {
      return {
        ok: false,
        reason: `Rescue rejects eslint -o (writes report to a file): ${tokens.join(" ")}. Drop the flag or use a path-checked Write tool call.`
      };
    }
    if (hasFlagFromSet(args, ESLINT_WRITE_FLAGS)) {
      return {
        ok: false,
        reason: `Rescue rejects eslint --cache-location/--output-file (writes to an arbitrary path): ${tokens.join(" ")}.`
      };
    }
    if (hasFlagFromSet(args, ESLINT_CODELOAD_FLAGS)) {
      return {
        ok: false,
        reason: `Rescue rejects eslint --parser/--rulesdir/--resolve-plugins-relative-to (loads and executes a module from the given path): ${tokens.join(" ")}.`
      };
    }
    return { ok: true };
  }
  if (command === "mypy") {
    if (matchesAbbreviatedFlag(args, MYPY_WRITE_FLAGS_ABBREV)) {
      return {
        ok: false,
        reason: `Rescue rejects mypy report/cache/install flags (--junit-xml, --*-report, --cache-dir, --install-types — incl. argparse abbreviations — write outside the workspace or run pip): ${tokens.join(" ")}.`
      };
    }
    return { ok: true };
  }
  if (command === "pytest") {
    if (hasPytestReportFlag(args)) {
      return pytestReportFlagRejection(tokens);
    }
    return { ok: true };
  }
  if (["rg", "grep", "ls", "cat", "pwd", "pyright"].includes(command)) {
    return { ok: true };
  }
  if (pipelineMode && PIPELINE_PLUMBING.has(command)) {
    if (hasWriteShortFlag(args) || args.includes("--output")) {
      return {
        ok: false,
        reason: `Rescue rejects ${command} -o/--output (writes to an arbitrary file): ${tokens.join(" ")}.`
      };
    }
    if (command === "sort" && (args.some((arg) => sortShortClusterWrites(arg)) || args.includes("--temporary-directory") || args.some((arg) => arg.startsWith("--temporary-directory=")))) {
      return {
        ok: false,
        reason: `Rescue rejects sort -o/-T (incl. bundled short clusters like -rT) and --temporary-directory (write to an arbitrary path): ${tokens.join(" ")}.`
      };
    }
    if (command === "uniq" && args.filter((arg) => arg === "-" || !arg.startsWith("-")).length >= 2) {
      return {
        ok: false,
        reason: `Rescue rejects uniq with an output-file argument (uniq IN OUT writes OUT): ${tokens.join(" ")}.`
      };
    }
    return { ok: true };
  }
  return { ok: false, reason: `Rescue rejects shell command: ${tokens.join(" ")}` };
}

class ShellExpansionError extends Error {
}
function throwingExpansionEnv(key) {
  if (key !== "")
    throw new ShellExpansionError(key);
  return "$";
}
function hasShellExpansion(command) {
  try {
    parse(command, throwingExpansionEnv);
    return false;
  } catch {
    return true;
  }
}
function isBraceExpansion(s, open) {
  if (open > 0 && s[open - 1] === "$")
    return false;
  let depth = 0;
  let sawSeparator = false;
  for (let j = open;j < s.length; j += 1) {
    const ch = s[j];
    if (ch === "\\") {
      j += 1;
      continue;
    }
    if (ch === "'" || ch === '"')
      return false;
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0)
        return sawSeparator;
    } else if (depth === 1 && (ch === "," || ch === "." && s[j + 1] === ".")) {
      sawSeparator = true;
    }
  }
  return false;
}
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
        return true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < n && command[i] !== '"') {
        if (command[i] === "\\") {
          i += 2;
          continue;
        }
        if (command[i] === "`")
          return true;
        if (command[i] === "$" && command[i + 1] === "(")
          return true;
        i += 1;
      }
      if (i >= n)
        return true;
      i += 1;
      continue;
    }
    if (c === "`")
      return true;
    if (c === "$" && (command[i + 1] === "'" || command[i + 1] === '"'))
      return true;
    if (c === "$" && command[i + 1] === "(")
      return true;
    if ((c === "<" || c === ">") && command[i + 1] === "(")
      return true;
    if (c === "{" && isBraceExpansion(command, i))
      return true;
    i += 1;
  }
  return false;
}
function hasUnsafeShellSyntax(command) {
  return scanUnsafeUnquoted(command) || hasShellExpansion(command);
}
function hasMutatingFlag(args) {
  for (const arg of args) {
    if (MUTATING_FLAGS_EXACT.has(arg)) {
      return true;
    }
    if (MUTATING_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
      return true;
    }
    if (/^-i[.=]/.test(arg)) {
      return true;
    }
  }
  return false;
}
function hasExecDelegatingFlag(args) {
  return args.some((arg) => EXEC_DELEGATING_FLAGS_EXACT.has(arg) || EXEC_DELEGATING_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix)));
}
function hasWriteShortFlag(args) {
  return args.some((arg) => arg === "-o" || /^-o./.test(arg));
}
function sortShortClusterWrites(token) {
  if (token.length < 2 || token[0] !== "-" || token[1] === "-")
    return false;
  for (let i = 1;i < token.length; i += 1) {
    const ch = token[i];
    if (ch === "o" || ch === "T")
      return true;
    if (ch === "t" || ch === "k" || ch === "S")
      return false;
  }
  return false;
}
function hasPytestReportFlag(args) {
  return matchesAbbreviatedFlag(args, PYTEST_REPORT_FLAGS);
}
function pytestReportFlagRejection(tokens) {
  return {
    ok: false,
    reason: `Rescue rejects pytest report-writing flags (--junitxml, --result-log, --report-log): ${tokens.join(" ")}.`
  };
}
function validatePackageManagerCommand(command, args) {
  if (args[0] === "test") {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `Rescue rejects ${command} ${args.join(" ")}. Use direct tools (tsc --noEmit, pyright, mypy, ruff check, eslint, pytest) instead of package.json scripts.`
  };
}
function isWithin2(root, target) {
  return target === root || target.startsWith(`${root}${path2.sep}`);
}
function isGitName(segment) {
  return segment.replace(/[. ]+$/, "").toLowerCase() === ".git";
}
function isWithinWorkspaceOutsideAnyGit(root, target) {
  return isWithin2(root, target) && !path2.relative(root, target).split(path2.sep).some(isGitName);
}
var RM_RECURSIVE_SCAN_ENTRY_CAP = 20000;
var GIT_SCAN_DEADLINE_MS = 3000;
async function scanTreesForGit(roots, { cap = RM_RECURSIVE_SCAN_ENTRY_CAP, deadlineMs = GIT_SCAN_DEADLINE_MS } = {}) {
  const deadline = Date.now() + deadlineMs;
  const late = () => Date.now() >= deadline;
  const pending = [];
  for (const root of roots) {
    pending.push({ directory: root, device: (await lstat2(root)).dev });
  }
  let seen = 0;
  while (pending.length > 0) {
    if (late())
      return `took longer than ${deadlineMs} ms`;
    const { directory, device } = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (err) {
      return `cannot read ${directory}: ${err.code ?? err.message}`;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > cap)
        return `more than ${cap} entries`;
      if (isGitName(entry.name))
        return "git";
      if (!entry.isDirectory())
        continue;
      const child = path2.join(directory, entry.name);
      let childDevice;
      try {
        childDevice = (await lstat2(child)).dev;
      } catch (err) {
        return `cannot read ${child}: ${err.code ?? err.message}`;
      }
      if (childDevice !== device)
        return `crosses a filesystem boundary at ${child}`;
      if (late())
        return `took longer than ${deadlineMs} ms`;
      pending.push({ directory: child, device });
    }
  }
  return "clean";
}
function rejectShell(feedback) {
  return { response: "reject", feedback };
}

// runtime/hooks/approval-hook.ts
var STDIN_TIMEOUT_MS = 5000;
async function main() {
  armDecisionDeadline();
  const stdinText = await readStdinWithTimeout(STDIN_TIMEOUT_MS);
  let input;
  try {
    const parsed = JSON.parse(stdinText);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("hook payload must be a JSON object");
    }
    input = parsed;
  } catch (err) {
    failClosed(`stdin was not a JSON object: ${formatErr(err)}`);
    return;
  }
  await testOnlyDelay(process.env[HOOK_TEST_DELAY_ENV]);
  const decision = await decideHookOutcome(input, {
    commandLabel: process.env.KIMI_PLUGIN_CC_CMD,
    operationKind: process.env.KIMI_PLUGIN_CC_OPERATION,
    swarmPolicy: process.env[SWARM_POLICY_ENV],
    swarmWaveSize: process.env[SWARM_WAVE_SIZE_ENV],
    rescueEvaluator: evaluateRescueHookRequest,
    trustedWorkspaceRoot: process.env.KIMI_PLUGIN_CC_WORKSPACE_ROOT,
    readRoots: process.env[READ_ROOTS_ENV],
    network: process.env[NETWORK_ENV]
  });
  if (decision.decision === "deny") {
    process.stderr.write(`${decision.reason ?? "denied"}
`);
    process.exit(2);
    return;
  }
  process.exit(0);
}
function armDecisionDeadline() {
  const label = process.env.KIMI_PLUGIN_CC_CMD;
  if (label === undefined || label.length === 0)
    return;
  const reason = `kimi-plugin-cc safety hook: no decision within ${HOOK_DECISION_DEADLINE_MS / 1000}s; ` + "the tool call is denied because a hook that times out would be read as allow.";
  setTimeout(() => {
    process.stderr.write(`${reason}
`);
    process.exit(2);
  }, HOOK_DECISION_DEADLINE_MS).unref();
  process.once("beforeExit", () => {
    process.stderr.write(`${reason}
`);
    process.exit(2);
  });
}
async function testOnlyDelay(value) {
  if (value === undefined || value.length === 0)
    return;
  if (value === "hang") {
    await new Promise(() => {});
    return;
  }
  const ms = Number(value);
  if (Number.isSafeInteger(ms) && ms > 0)
    await new Promise((resolve) => setTimeout(resolve, ms));
}
function failClosed(reason) {
  process.stderr.write(`kimi-plugin-cc safety hook misconfigured: ${reason}
`);
  process.exit(2);
}
function formatErr(err) {
  return err instanceof Error ? err.message : String(err);
}
function readStdinWithTimeout(timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const finish = (value) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      if (value instanceof Error)
        reject(value);
      else
        resolve(value);
    };
    const timer = setTimeout(() => {
      finish(new Error(`stdin did not close within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    try {
      process.stdin.setEncoding("utf8");
    } catch {}
    process.stdin.on("data", (chunk) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    process.stdin.on("end", () => finish(buf));
    process.stdin.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
  });
}
main().catch((err) => {
  failClosed(`uncaught error: ${formatErr(err)}`);
});
