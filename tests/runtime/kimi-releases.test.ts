import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

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

// The deliberate second spelling. The table is the single source for the
// runtime; these literals pin what each capability means, so an edited preset
// or a mis-copied row fails here instead of silently widening a gate.
const EXPECTED: Record<KimiReleaseCapability, string[]> = {
  "hook-schema": [
    "2.0.0", "2.0.1", "2.0.2", "2.1.0", "2.1.1", "2.2.0", "2.3.0", "2.3.1", "2.3.2", "2.3.3", "2.4.0",
    "2.4.1", "2.5.0", "2.5.1", "2.5.2", "2.5.3", "2.6.0", "2.6.2", "2.6.3", "2.7.2", "2.7.3",
  ],
  "web-preactivation": [
    "2.3.2", "2.3.3", "2.4.0", "2.4.1", "2.5.0", "2.5.1", "2.5.2", "2.5.3", "2.6.0", "2.6.2", "2.6.3", "2.7.2", "2.7.3",
  ],
  "local-environment": ["2.5.0", "2.5.1", "2.5.2", "2.5.3", "2.6.0", "2.6.2", "2.6.3", "2.7.2", "2.7.3"],
  "agent-state": ["2.5.0", "2.5.1", "2.5.2", "2.5.3", "2.6.0", "2.6.2", "2.6.3", "2.7.2", "2.7.3"],
  "modern-ws-control": ["2.6.0", "2.6.2", "2.6.3", "2.7.2", "2.7.3"],
  "bounded-swarm": ["2.6.2", "2.6.3", "2.7.2", "2.7.3"],
  "web-json-ready": ["2.7.2", "2.7.3"],
};

describe("kimi-releases table", () => {
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

  test("scopes keep 2.6.0 out of the all-operation set", () => {
    expect(kimiVersionsInScope("non-swarm")).toEqual(["2.6.0"]);
    expect(kimiVersionsInScope("all")).not.toContain("2.6.0");
    expect(kimiVersionsInScope("all")).toHaveLength(KIMI_V2_RELEASES.length - 1);
    expect(kimiReleaseHas("2.6.0", "bounded-swarm")).toBe(false);
  });

  test("rows are unique, ascending and carry a commit", () => {
    const versions = KIMI_V2_RELEASES.map((release) => release.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((left, right) => left.localeCompare(right, "en", { numeric: true }))).toEqual(versions);
    for (const release of KIMI_V2_RELEASES) expect(release.commit).toMatch(/^[0-9a-f]{8}$/);
  });

  test("malformed, suffixed, other-major and old versions resolve to nothing", () => {
    for (const version of [null, undefined, "", "2.7", "3.0.0", "1.9.9", "2.0.0-rc.1", "v2.7.3", " 2.7.3", "2.7.3-rc.1", "2.8.0+build", "0.44.0"]) {
      expect(resolveKimiRelease(version)).toBeNull();
      for (const capability of Object.keys(EXPECTED) as KimiReleaseCapability[]) {
        expect(kimiReleaseHas(version, capability)).toBe(false);
        expect(kimiCertifiedReleaseHas(version, capability)).toBe(false);
      }
    }
  });

  test("an unlisted plain 2.x borrows only the argv mechanics of the row below it", () => {
    expect(resolveKimiRelease("2.7.3")).toMatchObject({ certified: true, release: { version: "2.7.3" } });
    expect(resolveKimiRelease("2.8.0")).toMatchObject({ certified: false, release: { version: "2.7.3" } });
    expect(resolveKimiRelease("2.7.4")).toMatchObject({ certified: false, release: { version: "2.7.3" } });
    expect(resolveKimiRelease("2.6.1")).toMatchObject({ certified: false, release: { version: "2.6.0" } });
    expect(resolveKimiRelease("2.0.3")).toMatchObject({ certified: false, release: { version: "2.0.2" } });
    expect(resolveKimiRelease("2.10.0")).toMatchObject({ certified: false, release: { version: "2.7.3" } });
    expect(resolveKimiRelease("2.8.0", { strict: true })).toBeNull();
    expect(resolveKimiRelease("2.7.3", { strict: true })).toMatchObject({ certified: true });

    for (const capability of Object.keys(EXPECTED) as KimiReleaseCapability[]) {
      const borrowable = capability === "local-environment";
      expect([capability, kimiReleaseHas("2.8.0", capability)]).toEqual([capability, borrowable]);
      expect([capability, kimiCertifiedReleaseHas("2.8.0", capability)]).toEqual([capability, false]);
      expect([capability, kimiCertifiedReleaseHas("2.7.3", capability)]).toEqual([capability, true]);
    }
    // A borrowed row never lends a capability it does not itself have.
    expect(kimiReleaseHas("2.4.2", "local-environment")).toBe(false);
    expect(kimiReleaseHas("2.5.4", "local-environment")).toBe(true);
    expect(kimiReleaseHas("2.8.0", "hook-schema")).toBe(false);
  });

  test("formatVersionChoice matches the refusal wording", () => {
    expect(formatVersionChoice([])).toBe("");
    expect(formatVersionChoice(["2.6.2"])).toBe("2.6.2");
    expect(formatVersionChoice(["2.6.2", "2.6.3"])).toBe("2.6.2 or 2.6.3");
    expect(formatVersionChoice(kimiVersionsWith("bounded-swarm"))).toBe("2.6.2, 2.6.3, 2.7.2 or 2.7.3");
  });
});

describe("surfaces that name the bounded-swarm releases", () => {
  const bounded = kimiVersionsWith("bounded-swarm").join("/");
  // Hash-pinned Claude surfaces are hand-written, so a certification has to
  // edit them; generated Codex skills derive the list. Either kind going stale
  // fails here.
  const surfaces = [
    "commands/swarm.md",
    "agents/kimi-swarm.md",
    "agents/kimi-swarm-write.md",
    "plugins/kimi-codex/skills/kimi-swarm/SKILL.md",
    "plugins/kimi-codex/skills/kimi-swarm-write/SKILL.md",
  ];
  for (const surface of surfaces) {
    test(`${surface} names every bounded-swarm release wherever it lists them`, () => {
      const text = readFileSync(path.join(process.cwd(), surface), "utf8");
      const lists = text.match(/\b2\.6\.2(?:\/\d+\.\d+\.\d+)+/g) ?? [];
      expect(lists.length).toBeGreaterThan(0);
      for (const list of lists) expect(list).toBe(bounded);
    });
  }
});
