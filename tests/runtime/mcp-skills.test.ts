import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { SKILL_AGENT_URI, SKILL_URI } from "../../runtime/mcp/skills.js";
import { createMcpFixture, McpClient, modernMeta } from "../helpers/mcp.js";

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function expectClientRpcError(
  request: Promise<unknown>,
  code: number,
  message?: string,
): Promise<Record<string, unknown>> {
  let thrown: unknown;
  try {
    await request;
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  const rpcError = JSON.parse((thrown as Error).message) as Record<string, unknown>;
  expect(rpcError.code).toBe(code);
  if (message !== undefined) expect(rpcError.message).toContain(message);
  return rpcError;
}

describe("MCP SEP-2640 skills and resources", () => {
  test("modern MCP exposes skills/list, skills/get, resources/list, and resources/read with digests and cache metadata", async () => {
    const fixture = await createMcpFixture("mcp-skills-modern");
    const skillBytes = await readFile(path.join(process.cwd(), "skills/kimi/SKILL.md"));
    const agentBytes = await readFile(path.join(process.cwd(), "skills/kimi/agents/openai.yaml"));
    const expectedSkillText = skillBytes.toString("utf8");
    const expectedAgentText = agentBytes.toString("utf8");
    const expectedResources = [
      { uri: SKILL_URI, digest: sha256(skillBytes), size: skillBytes.byteLength },
      { uri: SKILL_AGENT_URI, digest: sha256(agentBytes), size: agentBytes.byteLength },
    ];
    let client: McpClient | undefined;
    try {
      client = await McpClient.modern(fixture);

      const skills = await client.request("skills/list", { _meta: modernMeta() });
      expect(skills.resultType).toBe("complete");
      expect(skills.ttlMs).toBe(0);
      expect(skills.cacheScope).toBe("private");
      expect(skills.skills).toHaveLength(1);
      expect(skills.skills[0]).toMatchObject({
        uri: SKILL_URI,
        frontmatter: { name: "kimi" },
        resources: expectedResources,
      });
      const description = skills.skills[0].frontmatter.description as string;
      expect(typeof description).toBe("string");
      expect(description.trim().length).toBeGreaterThan(0);

      const fetched = await client.request("skills/get", { uri: SKILL_URI, _meta: modernMeta() });
      expect(fetched).toEqual({
        resultType: "complete",
        ttlMs: 0,
        cacheScope: "private",
        skill: skills.skills[0],
      });
      await expectClientRpcError(
        client.request("skills/get", { uri: "skill://kimi/UNKNOWN.md", _meta: modernMeta() }),
        -32_602,
        "Unknown skill URI: skill://kimi/UNKNOWN.md",
      );
      await expectClientRpcError(
        client.request("skills/get", { uri: "", _meta: modernMeta() }),
        -32_602,
        "skills/get requires a non-empty string uri",
      );

      const resources = await client.request("resources/list", { _meta: modernMeta() });
      expect(resources).toEqual({
        resultType: "complete",
        ttlMs: 0,
        cacheScope: "private",
        resources: [
          {
            uri: SKILL_URI,
            name: "kimi",
            title: "Kimi Collaboration Skill",
            description,
            mimeType: "text/markdown",
          },
          {
            uri: SKILL_AGENT_URI,
            name: "kimi/agents/openai.yaml",
            title: "Kimi Agent Interface Metadata",
            description: "Agent UI metadata for the kimi skill.",
            mimeType: "application/yaml",
          },
        ],
      });

      const readSkill = await client.request("resources/read", {
        uri: SKILL_URI,
        _meta: modernMeta(),
      });
      expect(readSkill).toEqual({
        resultType: "complete",
        ttlMs: 0,
        cacheScope: "private",
        contents: [
          {
            uri: SKILL_URI,
            mimeType: "text/markdown",
            text: expectedSkillText,
          },
        ],
      });

      const readAgent = await client.request("resources/read", {
        uri: SKILL_AGENT_URI,
        _meta: modernMeta(),
      });
      expect(readAgent).toEqual({
        resultType: "complete",
        ttlMs: 0,
        cacheScope: "private",
        contents: [
          {
            uri: SKILL_AGENT_URI,
            mimeType: "application/yaml",
            text: expectedAgentText,
          },
        ],
      });

      await expectClientRpcError(
        client.request("resources/read", { uri: "skill://kimi/UNKNOWN.md", _meta: modernMeta() }),
        -32_602,
        "Unknown resource URI: skill://kimi/UNKNOWN.md",
      );
      await expectClientRpcError(
        client.request("resources/read", { uri: "file:///etc/passwd", _meta: modernMeta() }),
        -32_602,
        "Unknown resource URI: file:///etc/passwd",
      );
      await expectClientRpcError(
        client.request("resources/read", { uri: "", _meta: modernMeta() }),
        -32_602,
        "resources/read requires a non-empty string uri",
      );
      await expectClientRpcError(
        client.request("resources/read", { _meta: modernMeta() }),
        -32_602,
        "resources/read requires a non-empty string uri",
      );
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 30_000);

  test("legacy MCP exposes full SEP-2640 skills/list, skills/get, resources/list, and resources/read without modern wrapper fields", async () => {
    const fixture = await createMcpFixture("mcp-skills-legacy");
    const skillBytes = await readFile(path.join(process.cwd(), "skills/kimi/SKILL.md"));
    const agentBytes = await readFile(path.join(process.cwd(), "skills/kimi/agents/openai.yaml"));
    let client: McpClient | undefined;
    try {
      client = await McpClient.legacy(fixture);

      const skills = await client.request("skills/list", {});
      expect(skills.resultType).toBeUndefined();
      expect(skills.ttlMs).toBeUndefined();
      expect(skills.cacheScope).toBeUndefined();
      expect(skills.skills).toHaveLength(1);
      expect(skills.skills[0]).toMatchObject({
        uri: SKILL_URI,
        frontmatter: { name: "kimi" },
        resources: [
          { uri: SKILL_URI, digest: sha256(skillBytes), size: skillBytes.byteLength },
          { uri: SKILL_AGENT_URI, digest: sha256(agentBytes), size: agentBytes.byteLength },
        ],
      });

      const fetched = await client.request("skills/get", { uri: SKILL_URI });
      expect(fetched.resultType).toBeUndefined();
      expect(fetched).toEqual({ skill: skills.skills[0] });

      const resources = await client.request("resources/list", {});
      expect(resources.resultType).toBeUndefined();
      expect(resources.resources).toHaveLength(2);
      expect(resources.resources[0]).toMatchObject({
        uri: SKILL_URI,
        name: "kimi",
        title: "Kimi Collaboration Skill",
        mimeType: "text/markdown",
      });
      expect(resources.resources[1]).toMatchObject({
        uri: SKILL_AGENT_URI,
        name: "kimi/agents/openai.yaml",
        mimeType: "application/yaml",
      });

      const read = await client.request("resources/read", { uri: SKILL_URI });
      expect(read).toEqual({
        contents: [
          {
            uri: SKILL_URI,
            mimeType: "text/markdown",
            text: skillBytes.toString("utf8"),
          },
        ],
      });

      const readAgent = await client.request("resources/read", { uri: SKILL_AGENT_URI });
      expect(readAgent).toEqual({
        contents: [
          {
            uri: SKILL_AGENT_URI,
            mimeType: "application/yaml",
            text: agentBytes.toString("utf8"),
          },
        ],
      });

      await expectClientRpcError(
        client.request("resources/read", { uri: "skill://other/SKILL.md" }),
        -32_602,
        "Unknown resource URI: skill://other/SKILL.md",
      );
    } finally {
      if (client) await client.close();
      await fixture.cleanup();
    }
  }, 30_000);
});
