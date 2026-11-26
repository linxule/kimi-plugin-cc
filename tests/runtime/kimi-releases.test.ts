import { describe, expect, test } from "bun:test";

import {
  KIMI_V2_RELEASES,
  formatVersionChoice,
  kimiCertifiedReleaseHas,
  kimiReleaseHas,
  resolveKimiRelease,
  kimiVersionsInScope,
  kimiVersionsWith,
  type KimiReleaseCapability,
} from "../../runtime/kimi-releases.js";
import { MCP_TOOL_DEFINITIONS } from "../../runtime/mcp/operations.js";

// The deliberate second spelling. The table is the single source for the
// runtime; these literals pin what each capability means under the >= 2.8.0
// rolling compatibility floor.
const EXPECTED: Record<KimiReleaseCapability, string[]> = {
  "hook-schema": ["2.8.0"],
  "web-preactivation": ["2.8.0"],
  "local-environment": ["2.8.0"],
  "agent-state": ["2.8.0"],
  "modern-ws-control": ["2.8.0"],
  "bounded-swarm": ["2.8.0"],
  "web-json-ready": ["2.8.0"],
  "print-cancels-plan": ["2.8.0"],
};

describe("kimi-releases table (>= 2.8.0 floor)", () => {
  test("each capability covers exactly its pinned releases, ascending", () => {
    for (const [capability, versions] of Object.entries(EXPECTED)) {
      expect(kimiVersionsWith(capability as KimiReleaseCapability)).toEqual(versions);
    }
  });

  test("the per-version predicate agrees with the pinned lists for every release", () => {
    for (const [capability, versions] of Object.entries(EXPECTED)) {
      for (const release of KIMI_V2_RELEASES) {
        expect([release.version, capability, kimiReleaseHas(release.version, capability as KimiReleaseCapability)])
          .toEqual([release.version, capability, versions.includes(release.version)]);
      }
    }
  });

  test("rows and their shared capability arrays cannot be mutated", () => {
    expect(Object.isFrozen(KIMI_V2_RELEASES)).toBe(true);
    for (const release of KIMI_V2_RELEASES) expect(Object.isFrozen(release.capabilities)).toBe(true);
  });

  test("all certified >= 2.8.0 releases are full-scope", () => {
    expect(kimiVersionsInScope("non-swarm")).toEqual([]);
    expect(kimiVersionsInScope("all")).toEqual(["2.8.0"]);
    expect(kimiVersionsInScope("all")).toHaveLength(KIMI_V2_RELEASES.length);
  });

  test("rows are unique, ascending and carry a commit", () => {
    const versions = KIMI_V2_RELEASES.map((release) => release.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((left, right) => left.localeCompare(right, "en", { numeric: true }))).toEqual(versions);
    for (const release of KIMI_V2_RELEASES) expect(release.commit).toMatch(/^[0-9a-f]{8}$/);
  });

  test("malformed, suffixed, other-major and pre-2.8.0 versions resolve to nothing", () => {
    for (const version of [
      null,
      undefined,
      "",
      "2.8",
      "3.0.0",
      "1.9.9",
      "0.39.0",
      "0.41.0",
      "0.42.0",
      "2.0.0",
      "2.6.0",
      "2.7.2",
      "2.7.3",
      "2.7.4",
      "2.8.0-rc.1",
      "2.8.0+build",
      "v2.8.0",
      " 2.8.0",
    ]) {
      expect(resolveKimiRelease(version)).toBeNull();
      for (const capability of Object.keys(EXPECTED) as KimiReleaseCapability[]) {
        expect(kimiReleaseHas(version, capability)).toBe(false);
        expect(kimiCertifiedReleaseHas(version, capability)).toBe(false);
      }
    }
  });

  test("an unlisted plain 2.x strictly above 2.8.0 borrows only local-environment", () => {
    expect(resolveKimiRelease("2.8.0")).toMatchObject({ certified: true, release: { version: "2.8.0" } });
    expect(resolveKimiRelease("2.8.1")).toMatchObject({ certified: false, release: { version: "2.8.0" } });
    expect(resolveKimiRelease("2.10.0")).toMatchObject({ certified: false, release: { version: "2.8.0" } });
    expect(resolveKimiRelease("2.8.1", { strict: true })).toBeNull();
    expect(resolveKimiRelease("2.8.0", { strict: true })).toMatchObject({ certified: true });

    for (const capability of Object.keys(EXPECTED) as KimiReleaseCapability[]) {
      const borrowable = capability === "local-environment";
      expect([capability, kimiReleaseHas("2.8.1", capability)]).toEqual([capability, borrowable]);
      expect([capability, kimiCertifiedReleaseHas("2.8.1", capability)]).toEqual([capability, false]);
      expect([capability, kimiCertifiedReleaseHas("2.8.0", capability)]).toEqual([capability, true]);
    }
    expect(kimiReleaseHas("2.8.1", "hook-schema")).toBe(false);
    expect(kimiReleaseHas("2.8.1", "bounded-swarm")).toBe(false);
  });

  test("formatVersionChoice matches the refusal wording", () => {
    expect(formatVersionChoice([])).toBe("");
    expect(formatVersionChoice(["2.8.0"])).toBe("2.8.0");
    expect(formatVersionChoice(["2.8.0", "2.8.1"])).toBe("2.8.0 or 2.8.1");
    expect(formatVersionChoice(["2.8.0", "2.8.1", "2.9.0"])).toBe("2.8.0, 2.8.1 or 2.9.0");
    expect(formatVersionChoice(kimiVersionsWith("bounded-swarm"))).toBe("2.8.0");
  });
});

describe("MCP schema names the certified bounded-swarm release floor", () => {
  test("kimi_read max_concurrency description names the bounded-swarm release list", () => {
    const bounded = kimiVersionsWith("bounded-swarm").join("/");
    const readDef = MCP_TOOL_DEFINITIONS.find((tool) => tool.name === "kimi_read");
    const maxConcurrency = (readDef?.inputSchema.properties as Record<string, { description?: string }> | undefined)?.max_concurrency;
    expect(maxConcurrency?.description).toContain(bounded);
  });
});
