// Codex review P2.4: a detached worker (or a forged queued row) reloads a
// persisted plan and hands kimi_session_id to the spawn. assertPersistedResumeLineage
// re-establishes the resume binding and engine lineage from the store before spawn,
// so the dispatch-time check cannot be skipped by going straight to the worker path.
import { describe, expect, test } from "bun:test";

import {
  assertPersistedResumeLineage,
  executionPlanFromPersisted,
  type KimiExecutionPlan,
} from "../../runtime/kimi-engine.js";
import { JobStore, type CreateJobInput } from "../../runtime/job-store.js";
import { ensurePluginPaths, resolvePluginPaths } from "../../runtime/paths.js";
import { RuntimeError } from "../../runtime/errors.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

function jobInput(over: Partial<CreateJobInput> & Pick<CreateJobInput, "job_id">): CreateJobInput {
  return {
    repo_id: "repo",
    command_type: "ask",
    cwd: "/tmp",
    model: null,
    thinking: null,
    background: false,
    pid: null,
    kimi_pid: null,
    status: "completed",
    kimi_session_id: null,
    operation_kind: "ask",
    intended_engine: "native-v2",
    observed_engine: "native-v2",
    kimi_version: "2.8.0",
    kimi_command: "/usr/bin/kimi",
    kimi_prefix_args: "[]",
    plan_certification: "certified",
    safety_profile: "native-v2-no-plan/1",
    agent_profile: "read-only",
    prompt_digest: "d",
    summary: "s",
    final_output_path: null,
    stream_log_path: "/tmp/log.jsonl",
    error: null,
    ...over,
  };
}

async function withStore(run: (store: JobStore) => Promise<void>): Promise<void> {
  const root = await createTestPluginDataRoot("persisted-resume-lineage");
  try {
    const paths = resolvePluginPaths({ ...process.env, KIMI_PLUGIN_CC_DATA: root });
    await ensurePluginPaths(paths);
    const store = new JobStore(paths);
    try {
      await run(store);
    } finally {
      store.close();
    }
  } finally {
    await cleanupTestPath(root);
  }
}

function planFrom(job: ReturnType<JobStore["getJob"]>): KimiExecutionPlan {
  return executionPlanFromPersisted(job!);
}

describe("assertPersistedResumeLineage", () => {
  test("passes for a legitimate same-engine v2 resume", async () => {
    await withStore(async (store) => {
      store.createJob(jobInput({ job_id: "src", kimi_session_id: "sess-1", observed_engine: "native-v2" }));
      const resuming = store.createJob(
        jobInput({ job_id: "run", status: "running", kimi_session_id: "sess-1", resumed_from_job_id: "src" }),
      );
      await assertPersistedResumeLineage(store, planFrom(store.getJob("run")), resuming.kimi_session_id!, "ask");
    });
  });

  // Codex second-round F4: a row that carries a session id but records no
  // source job has no plugin lineage and can never be a managed resume. (A
  // genuinely fresh session has no session id yet, so callers never reach this
  // check for it.)
  test("refuses a session id with no recorded source job", async () => {
    await withStore(async (store) => {
      store.createJob(jobInput({ job_id: "orphan", status: "running", kimi_session_id: "sess-x" }));
      await expect(
        assertPersistedResumeLineage(store, planFrom(store.getJob("orphan")), "sess-x", "ask"),
      ).rejects.toMatchObject({
        code: "KIMI_SESSION_LINEAGE_UNKNOWN",
        details: { refusal_kind: "session-lineage-unknown", source_job_id: null },
      });
    });
  });

  test("refuses when the recorded source job is missing", async () => {
    await withStore(async (store) => {
      store.createJob(
        jobInput({ job_id: "run", status: "running", kimi_session_id: "sess-1", resumed_from_job_id: "ghost" }),
      );
      await expect(
        assertPersistedResumeLineage(store, planFrom(store.getJob("run")), "sess-1", "ask"),
      ).rejects.toMatchObject({ code: "KIMI_SESSION_LINEAGE_UNKNOWN" });
    });
  });

  test("refuses a forged binding: source owns a different session", async () => {
    await withStore(async (store) => {
      store.createJob(jobInput({ job_id: "src", kimi_session_id: "sess-REAL", observed_engine: "native-v2" }));
      store.createJob(
        jobInput({ job_id: "run", status: "running", kimi_session_id: "sess-TAINTED", resumed_from_job_id: "src" }),
      );
      await expect(
        assertPersistedResumeLineage(store, planFrom(store.getJob("run")), "sess-TAINTED", "ask"),
      ).rejects.toMatchObject({ code: "KIMI_SESSION_LINEAGE_UNKNOWN" });
    });
  });

  test("refuses a cross-engine resume (v1 source, v2 plan)", async () => {
    await withStore(async (store) => {
      store.createJob(jobInput({ job_id: "src", kimi_session_id: "sess-1", observed_engine: "legacy-v1" }));
      store.createJob(
        jobInput({ job_id: "run", status: "running", kimi_session_id: "sess-1", resumed_from_job_id: "src" }),
      );
      await expect(
        assertPersistedResumeLineage(store, planFrom(store.getJob("run")), "sess-1", "ask"),
      ).rejects.toMatchObject({ code: "KIMI_SESSION_ENGINE_MISMATCH" });
    });
  });
});
