import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  KIMI_SESSION_TITLE_MAX_LENGTH,
  buildKimiSessionTitle,
  normalizeTitleFragment,
  shortenForTitle,
  syncKimiSessionTitle,
  promptMetadataText,
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
    const title = buildKimiSessionTitle("rescue", "word ".repeat(100));
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

describe("native-v2 session discovery", () => {
  test("repairs the real empty-session predicate and leaves fallback eligible for native generation", async () => {
    const home = await createTestPluginDataRoot("kimi-v2-discovery");
    const id = "session_native-test";
    try {
      const statePath = await seedKimiSession(home, id, {
        id, version: 2, title: "New Session", titleKind: "replaceable",
        archived: false, cwd: "/example", agents: { main: { untouched: true } },
        updatedAt: "2026-09-18T00:00:00Z",
      });
      // KAP's exclude_empty / meta.has_prompt queries project this field from
      // root state.json, rather than inferring it from persisted agent messages.
      const visible = (state: { lastPrompt?: string }) => (state.lastPrompt ?? "").length > 0;
      expect(visible(JSON.parse(await readFile(statePath, "utf8")))).toBe(false);
      expect(await syncKimiSessionTitle({
        env: { KIMI_CODE_HOME: home }, sessionId: id,
        title: "Kimi Ask: explain storage", promptText: "Explain storage. token=private-value",
      })).toBe("updated");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      expect(visible(state)).toBe(true);
      expect(state.lastPrompt).toBe("Explain storage. token=[redacted]");
      expect(state.titleKind).toBe("replaceable");
      expect(state.isCustomTitle).toBe(false);
      expect(state.agents).toEqual({ main: { untouched: true } });
      expect(state.updatedAt).toBe("2026-09-18T00:00:00Z");
      const marks = await readdir(path.join(home, "sessions", ".index-dirty"));
      expect(marks.length).toBe(1);
      expect(marks[0]!.slice(0, marks[0]!.lastIndexOf("."))).toBe(id);
      expect((await stat(path.join(home, "sessions", ".index-dirty", marks[0]!))).size).toBe(0);
    } finally { await cleanupTestPath(home); }
  });

  test.each([
    { title: "Human title", titleKind: "custom" },
    { title: "Human title", isCustomTitle: true },
    { title: "Native generated title", titleKind: "generated", isCustomTitle: false },
    { title: "Legacy custom", customTitle: "Legacy custom" },
  ])("repairs previews independently of preserved titles: %j", async (titleState) => {
    const home = await createTestPluginDataRoot("kimi-v2-preserved-title");
    const id = "session_preserve";
    try {
      const p = await seedKimiSession(home, id, { id, version: 2, ...titleState });
      expect(await syncKimiSessionTitle({ env: { KIMI_CODE_HOME: home }, sessionId: id,
        title: "Must not replace", promptText: "Actual task" })).toBe("updated");
      const s = JSON.parse(await readFile(p, "utf8"));
      expect(s).toEqual({ id, version: 2, ...titleState, lastPrompt: "Actual task" });
    } finally { await cleanupTestPath(home); }
  });

  test("dry-run writes neither metadata nor dirty markers; repeated repair preserves previews", async () => {
    const home = await createTestPluginDataRoot("kimi-v2-dry-run");
    const id = "session_dry";
    try {
      const p = await seedKimiSession(home, id, { id, version: 2, title: "Manual", isCustomTitle: true });
      const before = await readFile(p, "utf8");
      const options = { env: { KIMI_CODE_HOME: home }, sessionId: id, title: "",
        preserveTitle: true, requireNativeV2: true, promptText: "Original task" };
      expect(await syncKimiSessionTitle({ ...options, dryRun: true })).toBe("would-update");
      expect(await readFile(p, "utf8")).toBe(before);
      expect(await readdir(path.join(home, "sessions"))).toEqual(["wd_repo_123"]);
      expect(await syncKimiSessionTitle(options)).toBe("updated");
      const repaired = await readFile(p, "utf8");
      expect(await syncKimiSessionTitle({ ...options, promptText: "Later replacement" })).toBe("unchanged");
      expect(await readFile(p, "utf8")).toBe(repaired);
      expect((await readdir(path.join(home, "sessions", ".index-dirty"))).length).toBe(2);
    } finally { await cleanupTestPath(home); }
  });

  test("dirty-journal symlink fails visibly without writing outside, and retry invalidates", async () => {
    const home = await createTestPluginDataRoot("kimi-v2-dirty-symlink");
    const outside = await createTestPluginDataRoot("kimi-v2-dirty-outside");
    const id = "session_dirty";
    try {
      await seedKimiSession(home, id, { id, version: 2, title: "Manual", titleKind: "custom" });
      const dir = path.join(home, "sessions", ".index-dirty");
      await symlink(outside, dir);
      const opts = { env: { KIMI_CODE_HOME: home }, sessionId: id, title: "",
        preserveTitle: true, promptText: "Actual task" };
      expect(await syncKimiSessionTitle(opts)).toBe("index-failed");
      expect(await readdir(outside)).toEqual([]);
      await rm(dir);
      expect(await syncKimiSessionTitle(opts)).toBe("unchanged");
      expect((await readdir(dir)).length).toBe(1);
    } finally { await cleanupTestPath(home); await cleanupTestPath(outside); }
  });

  test("native-only repair refuses legacy state and mismatched identity", async () => {
    const home = await createTestPluginDataRoot("kimi-v2-identity");
    const id = "session_expected";
    try {
      const p = await seedKimiSession(home, id, { title: "Legacy" });
      const options = { env: { KIMI_CODE_HOME: home }, sessionId: id, title: "",
        preserveTitle: true, requireNativeV2: true, promptText: "Task" };
      expect(await syncKimiSessionTitle(options)).toBe("unsupported-state");
      await writeFile(p, JSON.stringify({ version: 2, id: "session_other" }));
      expect(await syncKimiSessionTitle(options)).toBe("invalid-state");
      expect(await readdir(path.join(home, "sessions"))).toEqual(["wd_repo_123"]);
    } finally { await cleanupTestPath(home); }
  });
});

describe("native-v2 preview shows the raw task text", () => {
  const submitted = [
    "Answer directly in free-form prose.",
    "Do not narrate tool progress; make the final response self-contained.",
    "",
    "User question:",
    "",
    "Where are sessions stored?",
  ].join("\n");
  const raw = "Where are sessions stored?";
  const kimiStored = promptMetadataText(submitted)!;

  async function syncWith(state: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const home = await createTestPluginDataRoot("kimi-v2-raw-preview");
    const id = "session_raw_preview";
    try {
      const p = await seedKimiSession(home, id, { id, version: 2, title: "New Session", ...state });
      const before = await readFile(p, "utf8");
      const result = await syncKimiSessionTitle({ env: { KIMI_CODE_HOME: home }, sessionId: id,
        title: "Kimi Ask: Where are sessions stored?", promptText: raw, submittedPrompt: submitted, ...extra });
      const after = await readFile(p, "utf8");
      return { result, before, after, state: JSON.parse(after) as Record<string, unknown> };
    } finally { await cleanupTestPath(home); }
  }

  test("fills a missing or blank preview with the raw text", async () => {
    const filled = await syncWith({});
    expect(filled.result).toBe("updated");
    expect(filled.state.lastPrompt).toBe(raw);
    expect((await syncWith({ lastPrompt: " \n " })).state.lastPrompt).toBe(raw);
  });

  test.each([
    ["exact Kimi-stored form", kimiStored],
    ["raw submitted text", submitted],
    ["whitespace-different form", submitted.replace(/\n+/g, "   \t")],
    ["truncated prefix", kimiStored.slice(0, 40)],
    ["submitted prompt followed by more text", `${kimiStored} [image]`],
  ])("replaces the plugin's own submitted prompt (%s)", async (_label, existing) => {
    const { result, state } = await syncWith({ lastPrompt: existing });
    expect(result).toBe("preview-replaced");
    expect(state.lastPrompt).toBe(raw);
  });

  test("matches Kimi's redacted, 4000-character form of a long prompt with secrets and long paths", async () => {
    const longSubmitted = `Perform a read-only code review.\nRepository root: /Users/example/Documents/Apps/some-long-repository-name\ntoken=abc123\n${"diff line\n".repeat(600)}`;
    const stored = promptMetadataText(longSubmitted)!;
    expect(stored).toContain("[redacted]");
    expect(stored.length).toBe(4000);
    const { state } = await syncWith({ lastPrompt: stored },
      { submittedPrompt: longSubmitted, promptText: "Review target: current working tree changes" });
    expect(state.lastPrompt).toBe("Review target: current working tree changes");
  });

  test.each([
    ["a foreign preview", "Something the user typed natively later"],
    ["text sharing only an inner substring", "User question: Where are sessions stored?"],
  ])("keeps %s", async (_label, existing) => {
    const { result, before, after } = await syncWith({ lastPrompt: existing, title: "Manual", isCustomTitle: true });
    expect(result).toBe("custom-title");
    expect(after).toBe(before);
  });

  test("matches any of several submitted prompts", async () => {
    const { result, state } = await syncWith({ lastPrompt: kimiStored, title: "Manual", isCustomTitle: true },
      { submittedPrompt: ["Another run's prompt", submitted] });
    expect(result).toBe("preview-replaced");
    expect(state.lastPrompt).toBe(raw);
  });

  test("never treats a preview as its own without the submitted prompt, or with a blank one", async () => {
    for (const submittedPrompt of [undefined, "", " \n\t "]) {
      const { state } = await syncWith({ lastPrompt: kimiStored, title: "Manual", isCustomTitle: true }, { submittedPrompt });
      expect(state.lastPrompt).toBe(kimiStored);
    }
    const { state } = await syncWith({ lastPrompt: "Foreign", title: "Manual", isCustomTitle: true }, { submittedPrompt: " " });
    expect(state.lastPrompt).toBe("Foreign");
  });

  test.each([
    { title: "Human title", titleKind: "custom" },
    { title: "Human title", isCustomTitle: true },
    { title: "Native generated title", titleKind: "generated", isCustomTitle: false },
  ])("replaces the own-prompt preview while keeping title %j", async (titleState) => {
    const { state } = await syncWith({ ...titleState, lastPrompt: kimiStored });
    expect(state).toMatchObject({ ...titleState, lastPrompt: raw });
  });

  test("keeps the replaceable fallback title semantics while replacing the preview", async () => {
    const { state } = await syncWith({ titleKind: "replaceable", lastPrompt: kimiStored });
    expect(state).toMatchObject({ title: "Kimi Ask: Where are sessions stored?", titleKind: "replaceable",
      isCustomTitle: false, lastPrompt: raw });
  });

  test("redacts and caps the replacement preview", async () => {
    const longRaw = `Fix login password=hunter2 ${"word ".repeat(1000)}`;
    const { state } = await syncWith({ lastPrompt: kimiStored }, { promptText: longRaw });
    expect(state.lastPrompt).toBe(promptMetadataText(longRaw));
    expect((state.lastPrompt as string).length).toBe(4000);
    expect(state.lastPrompt).not.toContain("hunter2");
  });

  test("writes nothing when the preview already shows the raw text", async () => {
    const { result, before, after } = await syncWith({ lastPrompt: raw, title: "Kimi Ask: Where are sessions stored?",
      titleKind: "replaceable", isCustomTitle: false });
    expect(result).toBe("unchanged");
    expect(after).toBe(before);
  });

  test("dry-run reports the replacement without writing", async () => {
    const { result, before, after } = await syncWith({ lastPrompt: kimiStored, title: "Manual", titleKind: "custom" }, { dryRun: true });
    expect(result).toBe("would-replace-preview");
    expect(after).toBe(before);
  });

  test("legacy-v1 state keeps its preview even when it is the submitted prompt", async () => {
    const home = await createTestPluginDataRoot("kimi-legacy-raw-preview");
    const id = "session_legacy_preview";
    try {
      const p = await seedKimiSession(home, id, { title: "New Session", lastPrompt: kimiStored });
      await syncKimiSessionTitle({ env: { KIMI_CODE_HOME: home }, sessionId: id,
        title: "Kimi Ask: Where are sessions stored?", promptText: raw, submittedPrompt: submitted });
      const state = JSON.parse(await readFile(p, "utf8"));
      expect(state.lastPrompt).toBe(kimiStored);
      expect(state.isCustomTitle).toBe(true);
      expect(await readdir(path.join(home, "sessions"))).toEqual(["wd_repo_123"]);
    } finally { await cleanupTestPath(home); }
  });
});

describe("prompt metadata redaction", () => {
  test("fallback titles redact long quoted credentials before shortening loses their closing quote", () => {
    const title = buildKimiSessionTitle("ask", 'Fix login password="' + "privateword ".repeat(100) + '" and check it');
    expect(title).toBe("Kimi Ask: Fix login password=[redacted] and check it");
    expect(title).not.toContain("privateword");
  });
  test("redacts credential forms and private keys before whitespace normalization and truncation", () => {
    const secret = "a".repeat(50);
    expect(promptMetadataText(`\nDo work\tAuthorization: Bearer abc123\napi_key="private value" password=abc token='def ghi' secret: ${secret}\n-----BEGIN RSA PRIVATE KEY-----\nSECRET\n-----END RSA PRIVATE KEY----- sk-abcdefghijklmnopqrst`))
      .toBe("Do work Authorization: Bearer [redacted] api_key=[redacted] password=[redacted] token=[redacted] secret=[redacted] [redacted] [redacted]");
    expect(promptMetadataText(" \n\0 ")).toBeUndefined();
    const prefix = "word ".repeat(799);
    const result = promptMetadataText(prefix + 'password="' + "secret ".repeat(1000) + '"');
    expect(result?.length).toBe(4000);
    expect(result).not.toContain("secret");
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
