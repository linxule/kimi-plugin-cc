import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import type { JobRecord } from "../../runtime/job-store.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";
import { renderManagedJobOutput, writeArtifact } from "../../runtime/render.js";
import type { ManagedCommandType } from "../../runtime/types.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

function makeJob(commandType: ManagedCommandType): JobRecord {
  return {
    job_id: `job-${commandType}`,
    repo_id: "repo",
    command_type: commandType,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    cwd: process.cwd(),
    model: null,
    thinking: false,
    background: false,
    pid: null,
    kimi_pid: null,
    status: "running",
    kimi_session_id: "session",
    agent_profile: `runtime/agents/${commandType}.yaml`,
    prompt_digest: "digest",
    summary: "running",
    phase: null,
    final_output_path: null,
    stream_log_path: "stream.jsonl",
    error: null,
  };
}

describe("command output mode enforcement", () => {
  test("parsed review_gate output throws before artifact rendering when JSON is malformed", () => {
    expect(() => renderManagedJobOutput(makeJob("review_gate"), "not-json")).toThrow(
      /review_gate is configured for parsed output but returned malformed JSON/,
    );
  });

  test("passthrough command writes JSON-shaped output without structural errors", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("output-mode-passthrough");
    const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot });

    try {
      await ensurePluginPaths(paths);
      const job = makeJob("ask");
      const finalText = '{"decision":"BLOCK","confidence":"high","summary":"plain text","issues":[]}';
      const rendered = renderManagedJobOutput(job, finalText);
      const artifactPath = await writeArtifact(paths, job, rendered.rendered);

      expect(await readFile(artifactPath, "utf8")).toBe(`${finalText}\n`);
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });

  test("parsed review_gate output renders and writes when JSON is valid", async () => {
    const pluginDataRoot = await createTestPluginDataRoot("output-mode-parsed");
    const paths = resolvePluginPaths({ ...process.env, CLAUDE_PLUGIN_DATA: pluginDataRoot });

    try {
      await ensurePluginPaths(paths);
      const job = makeJob("review_gate");
      const rendered = renderManagedJobOutput(
        job,
        JSON.stringify({
          decision: "ALLOW",
          confidence: "high",
          summary: "No blocking issues.",
          issues: [],
        }),
      );
      const artifactPath = await writeArtifact(paths, job, rendered.rendered);

      expect(await readFile(artifactPath, "utf8")).toBe(rendered.rendered);
      expect(rendered.summary).toBe("No blocking issues.");
    } finally {
      await cleanupTestPath(pluginDataRoot);
    }
  });
});
