import { describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runModelInventory } from "../../runtime/commands/models.js";
import { formatError } from "../../runtime/errors.js";
import type { CommandContext } from "../../runtime/types.js";
import { cleanupTestPath, createTestPluginDataRoot } from "../helpers/test-env.js";

function context(root: string, env: NodeJS.ProcessEnv = {}): CommandContext {
  return { cwd: root, env: { KIMI_CODE_HOME: "home", ...env }, stdout: process.stdout, stderr: process.stderr };
}

const fixture = `default_model = "subscription/main"
[models."subscription/main"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
[models."other/fast"]
provider = "other"
model = "fast-model"
api_key = "FAKE_MODEL_SECRET"
[models."other/fast".overrides]
display_name = "FAKE_PRIVATE_LABEL"
[providers."managed:kimi-code"]
type = "kimi"
oauth = { storage = "file", key = "FAKE_OAUTH_REF", oauth_host = "FAKE_OAUTH_HOST" }
[providers.other]
type = "openai"
api_key = "FAKE_PROVIDER_SECRET"
base_url = "https://FAKE_PRIVATE_ENDPOINT"
custom_headers = { Authorization = "FAKE_HEADER_SECRET" }
env = { KEY = "FAKE_ENV_SECRET" }
source = { url = "FAKE_SOURCE_SECRET" }
[secondary_model]
default_model = "other/fast"
force = true
`;

describe("safe model inventory", () => {
  test("projects only model routing fields, without writes or credential reads", async () => {
    const root = await createTestPluginDataRoot("models");
    try {
      const home = path.join(root, "home");
      await mkdir(home);
      await writeFile(path.join(home, "config.toml"), fixture, { mode: 0o600 });
      // An inaccessible/non-directory credential store must not affect listing.
      await writeFile(path.join(home, "credentials"), "FAKE_TOKEN_SECRET", { mode: 0 });
      const before = await readdir(home);
      const output = await runModelInventory(["--json"], context(root));
      const result = JSON.parse(output);
      expect(result.models).toEqual([
        { alias: "subscription/main", provider: "managed:kimi-code", model: "kimi-for-coding" },
        { alias: "other/fast", provider: "other", model: "fast-model" },
      ]);
      expect(result.providers).toEqual([{ id: "managed:kimi-code", type: "kimi" }, { id: "other", type: "openai" }]);
      expect(result.freshSessionDefault).toBe("subscription/main");
      expect(result.validation).toBe("not-connection-tested");
      expect(result.secondaryModelConfigured).toBe(true);
      for (const args of [[], ["--json"]]) {
        const rendered = await runModelInventory(args, context(root));
        expect(rendered).not.toContain("FAKE_");
        expect(rendered).not.toContain("api_key");
        expect(rendered).toContain("/provider");
        expect(rendered).toContain("/login");
      }
      expect(await readFile(path.join(home, "config.toml"), "utf8")).toBe(fixture);
      expect(await readdir(home)).toEqual(before);
      expect(await readdir(root)).toEqual(["home"]);
    } finally { await cleanupTestPath(root); }
  });

  test("recognizes normalized keys and environment default without exposing environment credentials", async () => {
    const root = await createTestPluginDataRoot("models-env");
    try {
      await mkdir(path.join(root, "home"));
      await writeFile(path.join(root, "home/config.toml"), fixture.replace("default_model =", "defaultModel ="));
      const output = await runModelInventory(["--json"], context(root, {
        KIMI_MODEL_NAME: " environment-model ",
        KIMI_MODEL_PROVIDER_TYPE: "anthropic",
        KIMI_MODEL_API_KEY: "FAKE_ENV_API_SECRET",
        KIMI_MODEL_BASE_URL: "https://FAKE_ENV_ENDPOINT",
      }));
      const result = JSON.parse(output);
      expect(result.configuredDefault).toBe("subscription/main");
      expect(result.freshSessionDefault).toBe("__kimi_env_model__");
      expect(result.defaultSource).toBe("KIMI_MODEL_NAME");
      expect(result.models.at(-1)).toEqual({ alias: "__kimi_env_model__", provider: "__kimi_env__", model: "environment-model" });
      expect(result.providers.at(-1).type).toBe("anthropic");
      expect(output).not.toContain("FAKE_");
    } finally { await cleanupTestPath(root); }
  });

  test("missing home produces setup guidance without creating files", async () => {
    const root = await createTestPluginDataRoot("models-empty");
    try {
      const result = JSON.parse(await runModelInventory(["--json"], context(root)));
      expect(result.configPresent).toBe(false);
      expect(result.models).toEqual([]);
      expect(result.freshSessionDefault).toBeNull();
      expect(await readdir(root)).toEqual([]);
    } finally { await cleanupTestPath(root); }
  });

  test.each([
    'api_key = "FAKE_PARSE_SECRET',
    'default_model = { api_key = "FAKE_SHAPE_SECRET" }',
    'models = ["FAKE_SHAPE_SECRET"]',
    'default_model = "one"\ndefaultModel = "FAKE_COLLISION_SECRET"',
  ])("malformed config errors do not reproduce config content: %j", async (config) => {
    const root = await createTestPluginDataRoot("models-bad");
    try {
      await mkdir(path.join(root, "home"));
      await writeFile(path.join(root, "home/config.toml"), config);
      let error: unknown;
      try { await runModelInventory([], context(root)); } catch (caught) { error = caught; }
      expect(formatError(error)).toContain("MODEL_CONFIG_UNREADABLE");
      expect(formatError(error)).not.toContain("FAKE_");
    } finally { await cleanupTestPath(root); }
  });

  test("companion routes listing before setup mutations and rejects mixed flags", async () => {
    const root = await createTestPluginDataRoot("models-companion");
    try {
      const invoke = (args: string[]) => spawnSync(process.execPath, [path.join(process.cwd(), "runtime/companion.ts"), "setup", ...args], {
        cwd: root,
        env: { ...process.env, KIMI_CODE_HOME: "home", KIMI_MODEL_NAME: undefined, KIMI_PLUGIN_CC_DATA: path.join(root, "plugin-data"), KIMI_PLUGIN_CC_WORKSPACE_CWD: root },
        encoding: "utf8",
      });
      const success = invoke(["--models", "--json"]);
      expect(success.status).toBe(0);
      expect(JSON.parse(success.stdout).models).toEqual([]);
      expect(success.stderr).toBe("");
      for (const args of [["--models", "--check"], ["--uninstall", "--models"], ["--models", "--models"], ["--models", "FAKE_ARG_SECRET"]]) {
        const failure = invoke(args);
        expect(failure.status).toBe(1);
        expect(failure.stderr).toContain("INVALID_ARGS");
        expect(failure.stderr).not.toContain("FAKE_ARG_SECRET");
        expect(failure.stdout).toBe("");
      }
      expect(await readdir(root)).toEqual([]);
    } finally { await cleanupTestPath(root); }
  });
});
