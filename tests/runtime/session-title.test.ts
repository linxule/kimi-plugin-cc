import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  KIMI_SESSION_TITLE_MAX_LENGTH,
  buildKimiSessionTitle,
  normalizeTitleFragment,
  shortenForTitle,
  syncKimiSessionTitle,
} from "../../runtime/session-title.js";
import { resolveKimiHome } from "../../runtime/kimi-home.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

describe("buildKimiSessionTitle", () => {
  test("prefixes titles by user-facing command", () => {
    expect(buildKimiSessionTitle("ask", "explain the session storage flow")).toBe(
      "Kimi Ask: explain the session storage flow",
    );
    expect(buildKimiSessionTitle("review", "pending changes")).toBe("Kimi Review: pending changes");
    expect(buildKimiSessionTitle("challenge", "rescue allowlist")).toBe(
      "Kimi Challenge: rescue allowlist",
    );
    expect(buildKimiSessionTitle("rescue", "fix flaky test")).toBe("Kimi Rescue: fix flaky test");
    expect(buildKimiSessionTitle("pursue", "finish the report")).toBe("Kimi Pursue: finish the report");
    expect(buildKimiSessionTitle("swarm", "audit generated surfaces")).toBe(
      "Kimi Swarm: audit generated surfaces",
    );
    expect(buildKimiSessionTitle("swarm-write", "split parser cleanup")).toBe(
      "Kimi Swarm Write: split parser cleanup",
    );
  });

  test("normalizes control characters and whitespace", () => {
    expect(buildKimiSessionTitle("ask", "  line one\nline two\t\u0000line three  ")).toBe(
      "Kimi Ask: line one line two line three",
    );
    expect(normalizeTitleFragment("a\n\nb\tc")).toBe("a b c");
  });

  test("falls back to the command prefix for empty summaries", () => {
    expect(buildKimiSessionTitle("ask", "")).toBe("Kimi Ask");
    expect(buildKimiSessionTitle("rescue", "   \n")).toBe("Kimi Rescue");
    expect(buildKimiSessionTitle("swarm-write", undefined)).toBe("Kimi Swarm Write");
  });

  test("falls back defensively for invalid runtime command keys", () => {
    expect(buildKimiSessionTitle("bogus" as unknown as "ask", "unexpected")).toBe(
      "Kimi Session: unexpected",
    );
  });

  test("bounds final title length to 120 chars", () => {
    const title = buildKimiSessionTitle("rescue", "x".repeat(500));
    expect(title.length).toBeLessThanOrEqual(KIMI_SESSION_TITLE_MAX_LENGTH);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("shortenForTitle", () => {
  test("collapses internal whitespace and truncates with ellipsis", () => {
    expect(shortenForTitle("  hello   world\n\ttest  ", 50)).toBe("hello world test");
    expect(shortenForTitle("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcdefghi…");
  });
});

describe("syncKimiSessionTitle", () => {
  test("updates title and marks the Kimi session custom", async () => {
    const kimiHome = await createTestPluginDataRoot("kimi-title-home");
    const sessionId = "session_11111111-1111-4111-8111-111111111111";

    try {
      const statePath = await seedKimiSession(kimiHome, sessionId, {
        title: "New Session",
        isCustomTitle: false,
        updatedAt: "2026-07-01T00:00:00.000Z",
      });

      const result = await syncKimiSessionTitle({
        env: { ...process.env, KIMI_CODE_HOME: kimiHome },
        sessionId,
        title: "Kimi Ask: explain storage",
      });
      const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;

      expect(result).toBe("updated");
      expect(state.title).toBe("Kimi Ask: explain storage");
      expect(state.isCustomTitle).toBe(true);
      expect(state.updatedAt).toBe("2026-07-01T00:00:00.000Z");
    } finally {
      await cleanupTestPath(kimiHome);
    }
  });

  test("preserves state.json permissions during atomic replacement", async () => {
    const kimiHome = await createTestPluginDataRoot("kimi-title-mode");
    const sessionId = "session_00000000-0000-4000-8000-000000000000";

    try {
      const statePath = await seedKimiSession(kimiHome, sessionId, {
        title: "New Session",
        isCustomTitle: false,
      });
      await chmod(statePath, 0o600);

      expect(
        await syncKimiSessionTitle({
          env: { ...process.env, KIMI_CODE_HOME: kimiHome },
          sessionId,
          title: "Kimi Ask: preserve mode",
        }),
      ).toBe("updated");

      expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    } finally {
      await cleanupTestPath(kimiHome);
    }
  });

  test("preserves an existing custom title", async () => {
    const kimiHome = await createTestPluginDataRoot("kimi-title-custom");
    const sessionId = "session_22222222-2222-4222-8222-222222222222";

    try {
      const statePath = await seedKimiSession(kimiHome, sessionId, {
        title: "Manual title",
        isCustomTitle: true,
      });

      const result = await syncKimiSessionTitle({
        env: { ...process.env, KIMI_CODE_HOME: kimiHome },
        sessionId,
        title: "Kimi Ask: should not overwrite",
      });
      const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;

      expect(result).toBe("custom-title");
      expect(state.title).toBe("Manual title");
    } finally {
      await cleanupTestPath(kimiHome);
    }
  });

  test("handles missing and malformed state without throwing", async () => {
    const missingHome = await createTestPluginDataRoot("kimi-title-missing");
    const malformedHome = await createTestPluginDataRoot("kimi-title-malformed");
    const missingId = "session_33333333-3333-4333-8333-333333333333";
    const malformedId = "session_44444444-4444-4444-8444-444444444444";

    try {
      expect(
        await syncKimiSessionTitle({
          env: { ...process.env, KIMI_CODE_HOME: missingHome },
          sessionId: missingId,
          title: "Kimi Ask: missing",
        }),
      ).toBe("missing-index");

      const malformedStatePath = await seedKimiSession(malformedHome, malformedId, {
        title: "New Session",
      });
      await writeFile(malformedStatePath, "{not-json", "utf8");

      expect(
        await syncKimiSessionTitle({
          env: { ...process.env, KIMI_CODE_HOME: malformedHome },
          sessionId: malformedId,
          title: "Kimi Ask: malformed",
        }),
      ).toBe("missing-state");
    } finally {
      await cleanupTestPath(missingHome);
      await cleanupTestPath(malformedHome);
    }
  });

  test("skips oversized session index lines without throwing", async () => {
    const kimiHome = await createTestPluginDataRoot("kimi-title-oversized-index-line");
    const sessionId = "session_dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    try {
      await mkdir(kimiHome, { recursive: true });
      await writeFile(
        path.join(kimiHome, "session_index.jsonl"),
        `${"x".repeat(1024 * 1024 + 1)}\n${JSON.stringify({
          sessionId: "session_other",
          sessionDir: path.join(kimiHome, "sessions", "wd_repo_123", "session_other"),
        })}\n`,
        "utf8",
      );

      expect(
        await syncKimiSessionTitle({
          env: { ...process.env, KIMI_CODE_HOME: kimiHome },
          sessionId,
          title: "Kimi Ask: oversized index line",
        }),
      ).toBe("missing-entry");
    } finally {
      await cleanupTestPath(kimiHome);
    }
  });

  test("rejects index entries outside the Kimi sessions directory", async () => {
    const kimiHome = await createTestPluginDataRoot("kimi-title-unsafe");
    const outside = await createTestPluginDataRoot("kimi-title-outside");
    const sessionId = "session_55555555-5555-4555-8555-555555555555";

    try {
      await mkdir(kimiHome, { recursive: true });
      await writeFile(
        path.join(kimiHome, "session_index.jsonl"),
        `${JSON.stringify({
          sessionId,
          sessionDir: path.join(outside, sessionId),
          workDir: process.cwd(),
        })}\n`,
        "utf8",
      );

      expect(
        await syncKimiSessionTitle({
          env: { ...process.env, KIMI_CODE_HOME: kimiHome },
          sessionId,
          title: "Kimi Ask: unsafe",
        }),
      ).toBe("unsafe-entry");
    } finally {
      await cleanupTestPath(kimiHome);
      await cleanupTestPath(outside);
    }
  });

  test("rejects symlinked session directories that escape the Kimi sessions directory", async () => {
    const kimiHome = await createTestPluginDataRoot("kimi-title-symlink-home");
    const outside = await createTestPluginDataRoot("kimi-title-symlink-outside");
    const sessionId = "session_66666666-6666-4666-8666-666666666666";

    try {
      const bucket = path.join(kimiHome, "sessions", "wd_repo_123");
      const outsideSessionDir = path.join(outside, sessionId);
      const linkedSessionDir = path.join(bucket, sessionId);
      await mkdir(bucket, { recursive: true });
      await mkdir(outsideSessionDir, { recursive: true });
      await writeFile(
        path.join(outsideSessionDir, "state.json"),
        `${JSON.stringify({ title: "New Session", isCustomTitle: false }, null, 2)}\n`,
        "utf8",
      );
      await symlink(outsideSessionDir, linkedSessionDir);
      await writeFile(
        path.join(kimiHome, "session_index.jsonl"),
        `${JSON.stringify({
          sessionId,
          sessionDir: linkedSessionDir,
          workDir: process.cwd(),
        })}\n`,
        "utf8",
      );

      expect(
        await syncKimiSessionTitle({
          env: { ...process.env, KIMI_CODE_HOME: kimiHome },
          sessionId,
          title: "Kimi Ask: symlink",
        }),
      ).toBe("unsafe-entry");
    } finally {
      await cleanupTestPath(kimiHome);
      await cleanupTestPath(outside);
    }
  });

  test("rejects a symlinked sessions root", async () => {
    const kimiHome = await createTestPluginDataRoot("kimi-title-sessions-root-home");
    const outside = await createTestPluginDataRoot("kimi-title-sessions-root-outside");
    const sessionId = "session_99999999-9999-4999-8999-999999999999";

    try {
      const outsideBucket = path.join(outside, "wd_repo_123");
      const linkedSessionDir = path.join(kimiHome, "sessions", "wd_repo_123", sessionId);
      await mkdir(path.join(outsideBucket, sessionId), { recursive: true });
      await writeFile(
        path.join(outsideBucket, sessionId, "state.json"),
        `${JSON.stringify({ title: "Outside", isCustomTitle: false }, null, 2)}\n`,
        "utf8",
      );
      await symlink(outside, path.join(kimiHome, "sessions"));
      await writeFile(
        path.join(kimiHome, "session_index.jsonl"),
        `${JSON.stringify({
          sessionId,
          sessionDir: linkedSessionDir,
          workDir: process.cwd(),
        })}\n`,
        "utf8",
      );

      expect(
        await syncKimiSessionTitle({
          env: { ...process.env, KIMI_CODE_HOME: kimiHome },
          sessionId,
          title: "Kimi Ask: sessions root symlink",
        }),
      ).toBe("unsafe-entry");
    } finally {
      await cleanupTestPath(kimiHome);
      await cleanupTestPath(outside);
    }
  });

  test("rejects state.json symlinks that escape the session directory", async () => {
    const kimiHome = await createTestPluginDataRoot("kimi-title-state-symlink-home");
    const outside = await createTestPluginDataRoot("kimi-title-state-symlink-outside");
    const sessionId = "session_88888888-8888-4888-8888-888888888888";

    try {
      const statePath = await seedKimiSession(kimiHome, sessionId, {
        title: "New Session",
        isCustomTitle: false,
      });
      const outsideStatePath = path.join(outside, "state.json");
      await writeFile(
        outsideStatePath,
        `${JSON.stringify({ title: "Outside", isCustomTitle: false }, null, 2)}\n`,
        "utf8",
      );
      await cleanupTestPath(statePath);
      await symlink(outsideStatePath, statePath);

      expect(
        await syncKimiSessionTitle({
          env: { ...process.env, KIMI_CODE_HOME: kimiHome },
          sessionId,
          title: "Kimi Ask: state symlink",
        }),
      ).toBe("unsafe-entry");

      const outsideState = JSON.parse(await readFile(outsideStatePath, "utf8")) as Record<string, unknown>;
      expect(outsideState.title).toBe("Outside");
    } finally {
      await cleanupTestPath(kimiHome);
      await cleanupTestPath(outside);
    }
  });

  test("handles an indexed session with missing state.json without throwing", async () => {
    const kimiHome = await createTestPluginDataRoot("kimi-title-missing-state");
    const sessionId = "session_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    try {
      const statePath = await seedKimiSession(kimiHome, sessionId, {
        title: "New Session",
        isCustomTitle: false,
      });
      await rm(statePath);

      expect(
        await syncKimiSessionTitle({
          env: { ...process.env, KIMI_CODE_HOME: kimiHome },
          sessionId,
          title: "Kimi Ask: missing state",
        }),
      ).toBe("missing-state");
    } finally {
      await cleanupTestPath(kimiHome);
    }
  });

  test("skips oversized state.json without throwing", async () => {
    const kimiHome = await createTestPluginDataRoot("kimi-title-oversized-state");
    const sessionId = "session_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    try {
      const statePath = await seedKimiSession(kimiHome, sessionId, {
        title: "New Session",
        isCustomTitle: false,
      });
      await writeFile(statePath, `${"x".repeat(1024 * 1024 + 1)}`, "utf8");

      expect(
        await syncKimiSessionTitle({
          env: { ...process.env, KIMI_CODE_HOME: kimiHome },
          sessionId,
          title: "Kimi Ask: oversized state",
        }),
      ).toBe("missing-state");
    } finally {
      await cleanupTestPath(kimiHome);
    }
  });

  test("escapes session ids before writing warnings", async () => {
    const kimiHome = await createTestPluginDataRoot("kimi-title-warning-id");
    const outside = await createTestPluginDataRoot("kimi-title-warning-id-outside");
    const sessionId = "session_cccccccc-cccc-4ccc-8ccc-cccccccccccc\nforged";
    let stderr = "";

    try {
      await mkdir(kimiHome, { recursive: true });
      await writeFile(
        path.join(kimiHome, "session_index.jsonl"),
        `${JSON.stringify({
          sessionId,
          sessionDir: path.join(outside, "session_cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
          workDir: process.cwd(),
        })}\n`,
        "utf8",
      );

      expect(
        await syncKimiSessionTitle({
          env: { ...process.env, KIMI_CODE_HOME: kimiHome },
          sessionId,
          title: "Kimi Ask: warning",
          stderr: {
            write(chunk: string | Uint8Array): boolean {
              stderr += String(chunk);
              return true;
            },
          } as NodeJS.WritableStream,
        }),
      ).toBe("unsafe-entry");

      expect(stderr).toContain('"session_cccccccc-cccc-4ccc-8ccc-cccccccccccc forged"');
      expect(stderr).not.toContain("cccc\nforged");
    } finally {
      await cleanupTestPath(kimiHome);
      await cleanupTestPath(outside);
    }
  });

  test("accepts session index entries without a workDir field", async () => {
    const kimiHome = await createTestPluginDataRoot("kimi-title-no-workdir");
    const sessionId = "session_77777777-7777-4777-8777-777777777777";

    try {
      const statePath = await seedKimiSession(kimiHome, sessionId, {
        title: "New Session",
        isCustomTitle: false,
      });
      await writeFile(
        path.join(kimiHome, "session_index.jsonl"),
        `${JSON.stringify({
          sessionId,
          sessionDir: path.dirname(statePath),
        })}\n`,
        "utf8",
      );

      expect(
        await syncKimiSessionTitle({
          env: { ...process.env, KIMI_CODE_HOME: kimiHome },
          sessionId,
          title: "Kimi Ask: no work dir",
        }),
      ).toBe("updated");

      const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
      expect(state.title).toBe("Kimi Ask: no work dir");
    } finally {
      await cleanupTestPath(kimiHome);
    }
  });

  test("treats an empty KIMI_CODE_HOME override as unset", () => {
    expect(resolveKimiHome({ ...process.env, KIMI_CODE_HOME: "" })).toBe(
      path.join(process.env.HOME ?? "", ".kimi-code"),
    );
  });

  test("resolves relative KIMI_CODE_HOME against the command cwd", () => {
    expect(resolveKimiHome({ ...process.env, KIMI_CODE_HOME: "relative-home" }, "/tmp/workspace")).toBe(
      "/tmp/workspace/relative-home",
    );
  });
});

async function seedKimiSession(
  kimiHome: string,
  sessionId: string,
  state: Record<string, unknown>,
): Promise<string> {
  const sessionDir = path.join(kimiHome, "sessions", "wd_repo_123", sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(kimiHome, "session_index.jsonl"),
    `${JSON.stringify({
      sessionId,
      sessionDir,
      workDir: process.cwd(),
    })}\n`,
    "utf8",
  );
  const statePath = path.join(sessionDir, "state.json");
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return statePath;
}
