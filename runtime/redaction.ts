import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { RuntimeError } from "./errors.js";
import { parse as parseToml } from "./vendor/smol-toml/parse.js";

const POLICY_FILE = ".kimi-plugin.toml";
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_PATTERNS = 64;
const MAX_PATTERN_CHARS = 512;
const REDACTION_TIMEOUT_MS = 250;

export interface RedactionResult {
  text: string;
  replacements: number;
}

export async function loadRedactionPatterns(cwd: string): Promise<string[]> {
  const policyPath = path.join(cwd, POLICY_FILE);
  let source: string;
  try {
    source = await readFile(policyPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (Buffer.byteLength(source, "utf8") > MAX_POLICY_BYTES) {
    throw policyError(policyPath, `policy exceeds ${MAX_POLICY_BYTES} bytes`, "size");
  }

  let parsed: unknown;
  try {
    parsed = parseToml(source);
  } catch (error) {
    throw policyError(policyPath, "invalid TOML", "parse", error);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw policyError(policyPath, "policy must be a TOML table", "root");
  }
  const redaction = (parsed as Record<string, unknown>).redaction;
  if (redaction === undefined) return [];
  if (typeof redaction !== "object" || redaction === null || Array.isArray(redaction)) {
    throw policyError(policyPath, "[redaction] must be a table", "redaction");
  }
  const patterns = (redaction as Record<string, unknown>).patterns;
  if (patterns === undefined) return [];
  if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string")) {
    throw policyError(policyPath, "[redaction] patterns must be an array of strings", "patterns");
  }
  if (patterns.length > MAX_PATTERNS) {
    throw policyError(policyPath, `at most ${MAX_PATTERNS} patterns are allowed`, "patterns");
  }
  for (const [index, pattern] of patterns.entries()) {
    if (pattern.length === 0 || pattern.length > MAX_PATTERN_CHARS) {
      throw policyError(policyPath, `pattern ${index} must contain 1–${MAX_PATTERN_CHARS} characters`, "pattern");
    }
    try {
      new RegExp(pattern, "g");
    } catch (error) {
      throw policyError(policyPath, `pattern ${index} is not a valid JavaScript regex`, "pattern", error);
    }
  }
  return patterns;
}

export function redactText(text: string, patterns: readonly string[]): RedactionResult {
  let redacted = text;
  let replacements = 0;
  for (const [index, pattern] of patterns.entries()) {
    redacted = redacted.replace(new RegExp(pattern, "g"), () => {
      replacements += 1;
      return `[REDACTED-${index}]`;
    });
  }
  return { text: redacted, replacements };
}

export async function redactPromptForWorkspace(cwd: string, prompt: string): Promise<RedactionResult> {
  const patterns = await loadRedactionPatterns(cwd);
  if (patterns.length === 0) return { text: prompt, replacements: 0 };

  const extension = path.extname(fileURLToPath(import.meta.url));
  const workerUrl = new URL(`./redaction-worker${extension}`, import.meta.url);
  const execArgv = process.execArgv.filter((argument, index, arguments_) =>
    argument !== "--input-type" && !argument.startsWith("--input-type=") && arguments_[index - 1] !== "--input-type"
  );
  const worker = new Worker(workerUrl, { workerData: { prompt, patterns }, execArgv });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<RedactionResult>((resolve, reject) => {
      timer = setTimeout(() => {
        void worker.terminate();
        reject(new RuntimeError(
          "REDACTION_TIMEOUT",
          `Workspace redaction exceeded ${REDACTION_TIMEOUT_MS}ms; the prompt was not sent.`,
          "redaction.worker",
        ));
      }, REDACTION_TIMEOUT_MS);
      worker.once("message", (result: RedactionResult) => resolve(result));
      worker.once("error", (error) => reject(new RuntimeError(
        "REDACTION_FAILED",
        "Workspace redaction failed; the prompt was not sent.",
        "redaction.worker",
        { cause: error },
      )));
      worker.once("exit", (code) => {
        if (code !== 0) reject(new RuntimeError(
          "REDACTION_FAILED",
          `Workspace redaction worker exited with code ${code}; the prompt was not sent.`,
          "redaction.worker",
        ));
      });
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await worker.terminate();
  }
}

function policyError(
  policyPath: string,
  message: string,
  field: string,
  cause?: unknown,
): RuntimeError {
  return new RuntimeError(
    "REDACTION_POLICY_INVALID",
    `${policyPath}: ${message}. No model call was made.`,
    "redaction.policy",
    { ...(cause instanceof Error ? { cause } : {}), details: { policyPath, field } },
  );
}
