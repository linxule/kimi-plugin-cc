import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildKimiCliEnvironment } from "../../runtime/cli-client.js";
import { createHookEscapeMonitor } from "../../runtime/hook-escape.js";
import { decideHookOutcome, decideHookOutcomePure, type PolicyContext } from "../../runtime/hooks/approval-policy.js";
import { parseScopeEnvironment } from "../../runtime/read-scope.js";
import { BOUNDED_SWARM_POLICY } from "../../runtime/swarm-policy.js";

let base: string;
let workspace: string;
let extra: string;
let outside: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "kimi-read-scope-")));
  workspace = path.join(base, "workspace");
  extra = path.join(base, "extra");
  outside = path.join(base, "outside");
  for (const dir of [workspace, extra, outside, path.join(workspace, "src"), path.join(outside, "dir")]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(path.join(workspace, "src", "a.ts"), "a");
  await writeFile(path.join(extra, "notes.md"), "n");
  await writeFile(path.join(outside, "secret.txt"), "s");
  await symlink(path.join(outside, "secret.txt"), path.join(workspace, "leak.txt"));
  await symlink(path.join(outside, "dir"), path.join(workspace, "leakdir"));
  await symlink(path.join(workspace, "src", "a.ts"), path.join(workspace, "inside-link.ts"));
  await symlink(path.join(outside, "missing"), path.join(workspace, "dangling"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const READ_ONLY_LABELS = ["ask", "review", "challenge", "swarm"] as const;
const confined = (roots: string[] = [workspace], network?: "1"): Partial<PolicyContext> => ({
  readRoots: JSON.stringify(roots),
  ...(network ? { network } : {}),
});
const decide = (label: string, tool_name: string, tool_input: unknown, scope: Partial<PolicyContext> = {}) =>
  decideHookOutcome({ tool_name, tool_input }, { commandLabel: label, ...scope });

describe("default scope (no scope variables)", () => {
  test.each(READ_ONLY_LABELS)("%s: reads stay unrestricted anywhere", async (label) => {
    for (const [tool, input] of [
      ["Read", { path: "/etc/passwd" }],
      ["Read", { path: path.join(workspace, "leak.txt") }],
      ["Grep", { pattern: "x", path: "/" }],
      ["Glob", { pattern: "/etc/*" }],
      ["ReadMediaFile", { path: "~/x.png" }],
      ["Read", { anything: 1 }],
    ] as const) {
      expect(await decide(label, tool, input)).toEqual({ decision: "allow" });
    }
  });

  test.each(READ_ONLY_LABELS)("%s: web tools are denied with a reason naming --network", async (label) => {
    for (const tool of ["WebSearch", "FetchURL"]) {
      const result = await decide(label, tool, { url: "https://example.com", query: "x" });
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("--network");
    }
  });

  test("write labels are untouched by scope variables", async () => {
    let evaluated = 0;
    const result = await decideHookOutcome({ tool_name: "Read", tool_input: { path: "/etc/passwd" } }, {
      commandLabel: "rescue", trustedWorkspaceRoot: workspace, ...confined(),
      rescueEvaluator: async () => { evaluated += 1; return { decision: "allow" }; },
    });
    expect(result).toEqual({ decision: "allow" });
    expect(evaluated).toBe(1);
    expect(await decideHookOutcome({ tool_name: "Read", tool_input: { path: "/etc/passwd" } },
      { commandLabel: "swarm-write", ...confined() })).toEqual({ decision: "allow" });
  });

  test("out-of-plugin use ignores even malformed scope variables", async () => {
    expect(await decideHookOutcome({ tool_name: "Read", tool_input: { path: "/etc/passwd" } },
      { readRoots: "not json", network: "yes" })).toEqual({ decision: "allow" });
  });
});

describe("confined reads", () => {
  test.each(READ_ONLY_LABELS)("%s: allows workspace and read-root targets", async (label) => {
    const scope = confined([workspace, extra]);
    for (const [tool, input] of [
      ["Read", { path: "src/a.ts" }],
      ["Read", { path: path.join(workspace, "src", "a.ts"), line_offset: 1, n_lines: 3 }],
      ["Read", { path: path.join(extra, "notes.md") }],
      ["Read", { path: "inside-link.ts" }],
      ["Read", { path: "src/../src/a.ts" }],
      ["Read", { path: "src/not-yet.ts" }],
      ["ReadMediaFile", { path: "src/a.png", region: { x: 0, y: 0, width: 1, height: 1 } }],
      ["Grep", { pattern: "secret" }],
      ["Grep", { pattern: "x", path: extra, glob: "*.md", "-i": true, output_mode: "content" }],
      ["Glob", { pattern: "**/*.ts" }],
      ["Glob", { pattern: `${workspace}/src/*.ts` }],
      ["Glob", { pattern: "*.md", path: extra }],
      ["TaskList", {}],
      ["TaskOutput", { task_id: "t" }],
      ["WaitFor", { timeout: 5 }],
    ] as const) {
      expect([tool, input, await decide(label, tool, input, scope)]).toEqual([tool, input, { decision: "allow" }]);
    }
  });

  test.each(READ_ONLY_LABELS)("%s: denies targets outside the roots", async (label) => {
    const scope = confined([workspace, extra]);
    for (const [tool, input] of [
      ["Read", { path: "/etc/passwd" }],
      ["Read", { path: path.join(outside, "secret.txt") }],
      ["Read", { path: "../outside/secret.txt" }],
      ["Read", { path: "leak.txt" }],
      ["Read", { path: path.join(workspace, "leakdir", "x") }],
      ["Read", { path: "dangling" }],
      ["Read", { path: "~/.ssh/id_rsa" }],
      ["Read", { path: "~" }],
      ["Read", { path: "kimi-file://abc" }],
      ["Read", { path: "" }],
      ["Read", { path: "a\0b" }],
      ["Read", {}],
      ["Read", { path: 7 }],
      ["Read", { path: "src/a.ts", file_path: "/etc/passwd" }],
      ["Read", "src/a.ts"],
      ["ReadMediaFile", { path: path.join(outside, "x.png") }],
      ["Grep", { pattern: "x", path: outside }],
      ["Grep", { pattern: "x", path: "leakdir" }],
      ["Grep", { pattern: "x", glob: "/etc/**" }],
      ["Grep", { pattern: "x", glob: "../**" }],
      ["Glob", { pattern: "/etc/*" }],
      ["Glob", { pattern: `${outside}/**` }],
      ["Glob", { pattern: "../outside/*" }],
      ["Glob", { pattern: "src/../../outside/*" }],
      ["Glob", { pattern: "~/*" }],
      ["Glob", { pattern: "*", path: "/" }],
      ["Glob", {}],
    ] as const) {
      const result = await decide(label, tool, input, scope);
      expect([tool, input, result.decision]).toEqual([tool, input, "deny"]);
    }
  });

  test("malformed scope variables confine reads to no roots and keep network off", async () => {
    for (const scope of [
      { readRoots: "not json" },
      { readRoots: "[]" },
      { readRoots: JSON.stringify(["relative/dir"]) },
      { readRoots: JSON.stringify([`${workspace}/`]) },
      { readRoots: JSON.stringify([`${workspace}/../workspace`]) },
      { readRoots: JSON.stringify({ root: workspace }) },
      { readRoots: JSON.stringify([workspace]), network: "true" },
      { network: "1" },
    ]) {
      expect(parseScopeEnvironment(scope.readRoots, scope.network)).toEqual({ confined: true, roots: [], network: false });
      expect((await decide("ask", "Read", { path: "src/a.ts" }, scope)).decision).toBe("deny");
      expect((await decide("ask", "WebSearch", { query: "x" }, scope)).decision).toBe("deny");
    }
  });
});

describe("network", () => {
  test.each(READ_ONLY_LABELS)("%s: --network allows WebSearch and http(s) FetchURL only", async (label) => {
    const scope = confined([workspace], "1");
    expect(await decide(label, "WebSearch", { query: "kimi" }, scope)).toEqual({ decision: "allow" });
    for (const url of ["https://example.com/a?b=c", "http://example.com", "HTTPS://EXAMPLE.COM"]) {
      expect(await decide(label, "FetchURL", { url }, scope)).toEqual({ decision: "allow" });
    }
    for (const input of [
      { url: "file:///etc/passwd" },
      { url: "https://user:pass@example.com" },
      { url: "https://user@example.com" },
      { url: "ftp://example.com" },
      { url: " https://example.com" },
      { url: "javascript:alert(1)" },
      { url: "https://" },
      {},
      { url: 1 },
    ]) {
      expect((await decide(label, "FetchURL", input, scope)).decision).toBe("deny");
    }
  });

  test("network on still confines reads", async () => {
    const scope = confined([workspace], "1");
    expect((await decide("ask", "Read", { path: "/etc/passwd" }, scope)).decision).toBe("deny");
    expect(await decide("ask", "Read", { path: "src/a.ts" }, scope)).toEqual({ decision: "allow" });
  });

  test("write labels never gain web tools", async () => {
    const scope = confined([workspace], "1");
    expect((await decide("swarm-write", "WebSearch", { query: "x" }, { ...scope, trustedWorkspaceRoot: workspace })).decision)
      .not.toBe("allow");
    expect((await decideHookOutcome({ tool_name: "FetchURL", tool_input: { url: "https://x" } },
      { commandLabel: "rescue", ...scope })).decision).toBe("deny");
  });
});

describe("swarm children", () => {
  test("bounded-swarm children share the coordinator's scope through the same hook", async () => {
    const ctx: PolicyContext = { commandLabel: "swarm", operationKind: "swarm", swarmPolicy: BOUNDED_SWARM_POLICY,
      swarmWaveSize: "2", trustedWorkspaceRoot: workspace, ...confined([workspace]) };
    expect((await decideHookOutcome({ tool_name: "Read", tool_input: { path: "/etc/passwd" } }, ctx)).decision).toBe("deny");
    expect(await decideHookOutcome({ tool_name: "Read", tool_input: { path: "src/a.ts" } }, ctx)).toEqual({ decision: "allow" });
    expect((await decideHookOutcome({ tool_name: "WebSearch", tool_input: { query: "x" } }, ctx)).decision).toBe("deny");
  });
});

describe("hook-escape monitor follows the same scope", () => {
  test("allowed web calls under --network are not escapes; confined reads are never replayed", () => {
    const scope = confined([workspace], "1");
    const monitor = createHookEscapeMonitor({ commandLabel: "ask", cwd: workspace, ...scope });
    monitor.observe({ role: "assistant", tool_calls: [
      { type: "function", id: "w", function: { name: "WebSearch", arguments: "{\"query\":\"x\"}" } },
      { type: "function", id: "r", function: { name: "Read", arguments: "{\"path\":\"/etc/passwd\"}" } },
    ] });
    expect(monitor.observe({ role: "tool", tool_call_id: "w", content: "results" })).toBeUndefined();
    expect(monitor.settle()).toEqual([]);
    expect("evaluator" in decideHookOutcomePure({ tool_name: "Read", tool_input: { path: "/x" } }, { commandLabel: "ask", ...scope }))
      .toBe(true);
  });

  test("without --network a WebSearch result that is not the hook's denial is still a mismatch", () => {
    for (const scope of [{}, confined([workspace])]) {
      const monitor = createHookEscapeMonitor({ commandLabel: "ask", cwd: workspace, ...scope });
      monitor.observe({ role: "assistant", tool_calls: [
        { type: "function", id: "w", function: { name: "WebSearch", arguments: "{\"query\":\"x\"}" } },
      ] });
      expect(monitor.observe({ role: "tool", tool_call_id: "w", content: "results" }))
        .toMatchObject({ tool_call_id: "w", tool_name: "WebSearch", kind: "mismatch" });
    }
  });
});

describe("child environment", () => {
  const plan = (operationKind: string) => ({
    schemaVersion: 1 as const, operationKind, intendedEngine: "native-v2" as const, command: "kimi", prefixArgs: [],
    kimiVersion: "2.8.0", certification: "certified" as const, resumedFromJobId: null, safetyProfile: "native-v2-no-plan/1" as const,
  });
  const ambient = { KIMI_CODE_HOME: "/isolated/kimi", KIMI_PLUGIN_CC_NETWORK: "1", KIMI_PLUGIN_CC_READ_ROOTS: "[\"/\"]" };

  test("ambient scope variables are deleted for the default scope", () => {
    const env = buildKimiCliEnvironment({ cwd: workspace, env: ambient, executionPlan: plan("ask") as never, commandLabel: "ask" });
    expect("KIMI_PLUGIN_CC_NETWORK" in env).toBe(false);
    expect("KIMI_PLUGIN_CC_READ_ROOTS" in env).toBe(false);
  });

  test("a scoped call exports the workspace realpath first, then its roots", () => {
    const env = buildKimiCliEnvironment({ cwd: path.join(workspace, "src", ".."), env: ambient, executionPlan: plan("ask") as never,
      commandLabel: "ask", readScope: { readRoots: [extra, workspace], network: false } });
    expect(JSON.parse(env.KIMI_PLUGIN_CC_READ_ROOTS!)).toEqual([workspace, extra]);
    expect("KIMI_PLUGIN_CC_NETWORK" in env).toBe(false);
    const networked = buildKimiCliEnvironment({ cwd: workspace, env: {}, executionPlan: plan("review") as never,
      commandLabel: "review", readScope: { readRoots: [], network: true } });
    expect(JSON.parse(networked.KIMI_PLUGIN_CC_READ_ROOTS!)).toEqual([workspace]);
    expect(networked.KIMI_PLUGIN_CC_NETWORK).toBe("1");
  });

  test("write labels refuse a non-default scope", () => {
    for (const commandLabel of ["rescue", "swarm-write", "pursue", undefined]) {
      expect(() => buildKimiCliEnvironment({ cwd: workspace, env: {}, executionPlan: plan("rescue") as never,
        commandLabel, readScope: { readRoots: [], network: true } })).toThrow(/read-only operations/);
    }
  });

  test("network is refused on an uncertified plan; read roots alone are accepted", () => {
    const uncertified = { ...plan("ask"), certification: "uncertified" as const };
    expect(() => buildKimiCliEnvironment({ cwd: workspace, env: {}, executionPlan: uncertified as never,
      commandLabel: "ask", readScope: { readRoots: [], network: true } })).toThrow(expect.objectContaining({ code: "READ_SCOPE_INVALID" }));
    const env = buildKimiCliEnvironment({ cwd: workspace, env: {}, executionPlan: uncertified as never,
      commandLabel: "ask", readScope: { readRoots: [extra], network: false } });
    expect(JSON.parse(env.KIMI_PLUGIN_CC_READ_ROOTS!)).toEqual([workspace, extra]);
  });
});

describe("S5 FetchURL targets under --network", () => {
  const scope = { readRoots: JSON.stringify(["/"]), network: "1" };
  const fetch = (url: string) => decide("ask", "FetchURL", { url }, scope);

  test("a public https URL is allowed", async () => {
    for (const url of ["https://example.com/docs?q=1", "http://93.184.216.34/", "https://[2606:4700::1111]/", "https://localhost.example.com/"]) {
      expect([url, await fetch(url)]).toEqual([url, { decision: "allow" }]);
    }
  });

  test.each([
    ["localhost name", "http://localhost:8080/"],
    ["localhost trailing dot", "http://LOCALHOST./x"],
    ["*.localhost", "https://api.localhost/"],
    ["*.local", "http://printer.local/"],
    ["*.internal", "http://metadata.google.internal/computeMetadata/v1/"],
    ["percent-encoded localhost", "http://%6c%6f%63alhost/"],
    ["0.0.0.0/8", "http://0.0.0.0/"],
    ["10/8", "http://10.1.2.3/"],
    ["100.64/10", "http://100.100.1.1/"],
    ["127/8", "http://127.0.0.1:631/"],
    ["169.254/16", "http://169.254.169.254/latest/meta-data/"],
    ["172.16/12", "http://172.31.255.255/"],
    ["192.168/16", "http://192.168.1.1/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["IPv6 unspecified", "http://[::]/"],
    ["IPv6 link-local", "http://[fe80::1]/"],
    ["IPv6 unique-local", "http://[fd12:3456::1]/"],
    ["IPv4-mapped loopback", "http://[::ffff:127.0.0.1]/"],
    ["IPv4-mapped private (hex form)", "http://[::ffff:a00:1]/"],
    ["bare integer host", "http://2130706433/"],
    ["hex octets", "http://0x7f.0.0.1/"],
    ["octal octets", "http://0177.0.0.1/"],
    ["short dotted form", "http://127.1/"],
    ["percent-encoded IPv4", "http://%31%32%37.0.0.1/"],
    ["public IPv4 written as an integer", "http://1572395042/"],
    ["credentials", "https://user:pass@example.com/"],
    ["file scheme", "file:///etc/passwd"],
    ["unparseable", "http://exa mple.com/"],
  ])("denies %s", async (_label, url) => {
    const result = await fetch(url);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("FetchURL");
  });
});

