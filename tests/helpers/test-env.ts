import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const repoRoot = process.cwd();
const testRoot = path.join(repoRoot, "runtime", "dev-data", "tests");
const execFileAsync = promisify(execFile);

// Disable the kimi-web session-rename announce call across the entire test
// suite. Without this, every managed command invocation in tests burns the
// full health-probe budget (200ms each across 40+ invocations = ~8s of dead
// time) and, worse, pollutes any developer's actual kimi web session index
// with PATCH attempts for invalid test session ids. Tests that need to
// exercise announceSessionTitle explicitly can unset this in a local makeMockEnv.
process.env.KIMI_PLUGIN_CC_DISABLE_WEB_ANNOUNCE ??= "1";

export async function createTestPluginDataRoot(prefix: string): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  return mkdtemp(path.join(testRoot, `${prefix}-`));
}

export async function cleanupTestPath(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
}

export async function createGitRepoFixture(prefix: string): Promise<string> {
  const fixtureRoot = await createTestPluginDataRoot(prefix);

  await execFileAsync("git", ["init"], { cwd: fixtureRoot });
  await execFileAsync("git", ["config", "user.name", "Codex Test"], { cwd: fixtureRoot });
  await execFileAsync("git", ["config", "user.email", "codex@example.com"], { cwd: fixtureRoot });

  const filePath = path.join(fixtureRoot, "src.ts");
  await writeFile(filePath, "export const answer = 41;\n", "utf8");
  await execFileAsync("git", ["add", "src.ts"], { cwd: fixtureRoot });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: fixtureRoot });

  await writeFile(filePath, "export const answer = 42;\n", "utf8");

  return fixtureRoot;
}
