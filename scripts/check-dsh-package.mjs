import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = repo;
const pkg = JSON.parse(readFileSync(path.join(plugin, 'package.json'), 'utf8'));
const destination = process.argv[2] ? path.resolve(process.argv[2]) : mkdtempSync(path.join(os.tmpdir(), 'dsh-package-artifact-'));
const scratch = mkdtempSync(path.join(os.tmpdir(), 'dsh-package-check-'));
const operations = ['ask', 'review', 'challenge', 'rescue', 'pursue', 'swarm', 'swarm-write'];
let dshBin = process.env.KIMI_DSH_TEST_BIN ? path.resolve(process.env.KIMI_DSH_TEST_BIN) : undefined;

function resolveDshBin() {
  if (dshBin !== undefined) return dshBin;
  const prefix = path.join(scratch, 'dsh-cli');
  execFileSync('npm', ['install', '--prefix', prefix, '@deepseek-ai/dsh@0.2.1-rc.5'], {
    stdio: 'pipe',
    timeout: 180_000,
  });
  dshBin = path.join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  return dshBin;
}

function runDsh(args, options = {}) {
  return execFileSync(process.execPath, [dshBin, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

async function bootAndStop(env, cwd) {
  const child = spawn(process.execPath, [dshBin, 'web', '--no-open', '--port', '0'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('DSH web boot timed out')), 30_000);
      const onData = () => {
        if (!output.includes('dsh web: http://127.0.0.1:')) return;
        clearTimeout(timeout);
        resolve();
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', code => {
        if (output.includes('dsh web: http://127.0.0.1:')) return;
        clearTimeout(timeout);
        reject(new Error(`DSH web exited before readiness (${code})`));
      });
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await new Promise(resolve => {
      const timeout = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        resolve();
      }, 10_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

mkdirSync(destination, { recursive: true });
try {
  resolveDshBin();
  execFileSync('bun', ['pm', 'pack', '--ignore-scripts', '--destination', destination, '--quiet'], {
    cwd: plugin,
    stdio: 'pipe',
  });
  const archive = path.join(destination, `${pkg.name}-${pkg.version}.tgz`);
  const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  const allowed = /^(?:package\/(?:package\.json|\.mcp\.json|README\.md|LICENSE|CHANGELOG\.md)|package\/(?:\.claude-plugin|\.agents\/plugins|agents|commands|hooks|dist|plugins\/kimi-codex|plugins\/kimi-dsh|docs)\/|package\/scripts\/(?:companion|review-gate-hook)\.sh$)/;
  const syncConflictCopy = /(?:^|\/)[^/]* [0-9]+(?:\.[^/]*)?(?:\/|$)/;
  for (const file of files) {
    assert(!file.split('/').includes('..'), file);
    assert(!syncConflictCopy.test(file), `Unexpected sync-conflict copy: ${file}`);
    assert(allowed.test(file), `Unexpected DSH package file: ${file}`);
    assert(!file.includes('node_modules') && !file.endsWith('.map'), file);
  }
  execFileSync('tar', ['-xzf', archive, '-C', scratch]);
  for (const file of ['package.json', 'plugins/kimi-dsh/cordis.patch.yml', 'dist/dsh/index.js', 'dist/companion.js']) {
    assert(readFileSync(path.join(scratch, 'package', file)).length > 0, file);
  }

  const dshHome = path.join(scratch, 'dsh-home');
  const workspace = path.join(scratch, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: path.join(scratch, 'home'),
    DSH_HOME: dshHome,
    KIMI_CODE_HOME: path.join(scratch, 'kimi-home'),
    KIMI_PLUGIN_CC_DISABLE_WEB_ANNOUNCE: '1',
  };
  runDsh(['plugin', '--profile', 'web', 'add', archive], { cwd: workspace, env });
  const config = runDsh(['--profile', 'web', '--dump-config'], { cwd: workspace, env });
  for (const operation of operations) {
    assert(config.includes(`provider: kimi-${operation}`), operation);
    assert(config.includes(`toolName: kimi_${operation.replaceAll('-', '_')}`), operation);
  }
  await bootAndStop(env, workspace);
  console.log(`Verified ${pkg.name}@${pkg.version}: ${files.length} files, isolated DSH install, seven-tool composition, and Web boot`);
  console.log(archive);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
