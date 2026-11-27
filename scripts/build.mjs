import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "dist");
const tmpDist = mkdtempSync(path.join(os.tmpdir(), "kimi-plugin-cc-dist-"));

function collectTree(rootDir, currentRel = "", files = [], dirs = new Set()) {
  const dirPath = currentRel ? path.join(rootDir, currentRel) : rootDir;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const rel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      dirs.add(rel);
      collectTree(rootDir, rel, files, dirs);
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return { files, dirs };
}

function pruneUnexpectedEntries(currentRel, expectedFiles, expectedDirs) {
  const dirPath = currentRel ? path.join(distDir, currentRel) : distDir;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const rel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
    const absPath = path.join(dirPath, entry.name);
    const info = lstatSync(absPath);
    if (info.isSymbolicLink()) {
      rmSync(absPath, { force: true });
      continue;
    }
    if (info.isDirectory()) {
      pruneUnexpectedEntries(rel, expectedFiles, expectedDirs);
      if (!expectedDirs.has(rel) && readdirSync(absPath).length === 0) {
        rmdirSync(absPath);
      }
    } else if (!expectedFiles.has(rel)) {
      rmSync(absPath, { force: true });
    }
  }
}

try {
  execFileSync("bunx", ["tsc", "-p", "tsconfig.build.json", "--outDir", tmpDist], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  execFileSync(
    "bun",
    [
      "build",
      "runtime/hooks/approval-hook.ts",
      "--target=node",
      "--format=esm",
      `--outfile=${path.join(tmpDist, "hooks/approval-hook.js")}`,
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );

  const shellQuoteDest = path.join(tmpDist, "vendor/shell-quote");
  mkdirSync(shellQuoteDest, { recursive: true });
  copyFileSync(
    path.join(repoRoot, "runtime/vendor/shell-quote/LICENSE"),
    path.join(shellQuoteDest, "LICENSE"),
  );

  const smolTomlSrc = path.join(repoRoot, "runtime/vendor/smol-toml");
  const smolTomlDest = path.join(tmpDist, "vendor/smol-toml");
  mkdirSync(smolTomlDest, { recursive: true });
  for (const entry of readdirSync(smolTomlSrc, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith(".js") || entry.name === "LICENSE")) {
      copyFileSync(path.join(smolTomlSrc, entry.name), path.join(smolTomlDest, entry.name));
    }
  }

  writeFileSync(path.join(tmpDist, "package.json"), '{"type":"module"}\n', "utf8");

  const { files, dirs } = collectTree(tmpDist);
  const expectedFiles = new Set(files);

  mkdirSync(distDir, { recursive: true });
  pruneUnexpectedEntries("", expectedFiles, dirs);

  for (const rel of files.sort()) {
    const src = path.join(tmpDist, rel);
    const dest = path.join(distDir, rel);
    const nextData = readFileSync(src);
    const wantExec = rel === "companion.js";
    const wantMode = wantExec ? 0o755 : 0o644;

    let unchanged = false;
    try {
      const info = statSync(dest);
      if (
        info.isFile() &&
        readFileSync(dest).equals(nextData) &&
        (process.platform === "win32" || ((info.mode & 0o111) !== 0) === wantExec)
      ) {
        unchanged = true;
      }
    } catch {
      // Missing destination will be written below.
    }

    if (unchanged) continue;

    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, nextData);
    if (process.platform !== "win32") {
      chmodSync(dest, wantMode);
    }
  }
} finally {
  rmSync(tmpDist, { recursive: true, force: true });
}
