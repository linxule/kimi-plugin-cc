import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditHighSeverity } from './consumer-audit.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = repo;
const pkg = JSON.parse(readFileSync(path.join(plugin, 'package.json'), 'utf8'));
const destination = process.argv[2] ? path.resolve(process.argv[2]) : mkdtempSync(path.join(os.tmpdir(), 'dsh-package-artifact-'));
const scratch = mkdtempSync(path.join(os.tmpdir(), 'dsh-package-check-'));
const expectedTools = [
  'mcp__kimi__kimi_read',
  'mcp__kimi__kimi_write',
  'mcp__kimi__kimi_job',
  'mcp__kimi__kimi_setup',
];
const expectedSkill = 'kimi';
let dshBin;

function resolveDshBin() {
  if (dshBin !== undefined) return dshBin;
  const prefix = path.join(scratch, 'dsh-cli');
  mkdirSync(prefix, { recursive: true });
  writeFileSync(path.join(prefix, 'package.json'), JSON.stringify({
    name: 'kimi-dsh-host-check', private: true, version: '1.0.0',
    dependencies: { '@deepseek-ai/dsh': '0.2.1-rc.5' },
    overrides: { zod: '^4.6.6', undici: '^8.12.2' },
  }));
  execFileSync('npm', ['install'], {
    cwd: prefix,
    stdio: 'pipe',
    timeout: 180_000,
  });
  const audit = spawnSync('npm', ['audit', '--omit=dev', '--audit-level=info', '--json'], {
    cwd: prefix, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  const issues = auditHighSeverity(audit);
  assert.equal(issues.length, 0, `DSH host has high/critical advisories: ${issues.map(([name]) => name).join(', ')}`);
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

async function bootAndStop(env, cwd, probeResult) {
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
      const cleanup = () => { clearTimeout(timeout); clearInterval(poll); };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`DSH web boot or live Kimi MCP/skill registration timed out.\nOutput:\n${output}`));
      }, 30_000);
      const onData = () => {
        if (!output.includes('dsh web: http://127.0.0.1:')) return;
        try { JSON.parse(readFileSync(probeResult, 'utf8')); } catch { return; }
        cleanup();
        resolve();
      };
      const poll = setInterval(onData, 100);
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('error', error => {
        cleanup();
        reject(error);
      });
      child.once('exit', code => {
        cleanup();
        reject(new Error(`DSH web exited before readiness (${code}).\nOutput:\n${output}`));
      });
    });
  } finally {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve, reject) => {
        let forcedTimeout;
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          forcedTimeout = setTimeout(() => reject(new Error('DSH web did not exit after SIGKILL')), 5_000);
        }, 10_000);
        child.once('exit', () => {
          clearTimeout(timeout);
          clearTimeout(forcedTimeout);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }
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
  const allowed = /^(?:package\/(?:package\.json|\.mcp\.json|plugin\.json|mcp_config\.json|cordis\.patch\.yml|README\.md|LICENSE)|package\/(?:\.claude-plugin|\.agents\/plugins|dsh|skills|assets|dist|plugins\/kimi-codex)\/|package\/docs\/(?:safety|migration|models|session-visibility|swarm-recovery)\.md$|package\/scripts\/companion\.sh$)/;
  const syncConflictCopy = /(?:^|\/)[^/]* [0-9]+(?:\.[^/]*)?(?:\/|$)/;
  for (const file of files) {
    assert(!file.split('/').includes('..'), file);
    assert(!syncConflictCopy.test(file), `Unexpected sync-conflict copy: ${file}`);
    assert(allowed.test(file), `Unexpected DSH package file: ${file}`);
    assert(!file.includes('node_modules') && !file.endsWith('.map'), file);
  }
  execFileSync('tar', ['-xzf', archive, '-C', scratch]);
  for (const file of [
    'package.json',
    'cordis.patch.yml',
    'dsh/index.json',
    'skills/kimi/SKILL.md',
    'scripts/companion.sh',
    'dist/companion.js',
    'dist/hooks/approval-hook.js',
  ]) {
    assert(readFileSync(path.join(scratch, 'package', file)).length > 0, file);
  }

  const dshHome = path.join(scratch, 'dsh-home');
  const workspace = path.join(scratch, 'workspace');
  const dataRoot = path.join(scratch, 'plugin-data');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: path.join(scratch, 'home'),
    DSH_HOME: dshHome,
    KIMI_CODE_HOME: path.join(scratch, 'kimi-home'),
    KIMI_PLUGIN_CC_DATA: dataRoot,
    KIMI_PLUGIN_CC_DISABLE_WEB_ANNOUNCE: '1',
  };
  runDsh(['plugin', '--profile', 'web', 'add', archive], { cwd: workspace, env });
  runDsh(['plugin', '--profile', 'web', 'audit', '--prod', '--audit-level', 'high'], { cwd: workspace, env });
  const config = runDsh(['--profile', 'web', '--dump-config'], { cwd: workspace, env });
  assert(config.includes('@deepseek-ai/dsh-mcp-client'), config);
  assert(config.includes('@deepseek-ai/dsh-skill-filesystem'), config);
  assert(config.includes('toolCallTimeoutMs: 86400000'), config);

  const probe = path.join(scratch, 'mount-probe');
  const probeResult = path.join(scratch, 'mount-probe.json');
  mkdirSync(probe);
  writeFileSync(path.join(probe, 'package.json'), JSON.stringify({
    name: 'kimi-package-mount-probe', version: '1.0.0', type: 'module', main: 'index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }));
  writeFileSync(path.join(probe, 'cordis.patch.yml'), "- insert:\n    - id: kimi-package-mount-probe\n      name: 'kimi-package-mount-probe'\n");
  writeFileSync(path.join(probe, 'index.js'), `
    import { writeFileSync, renameSync } from 'node:fs';
    export const name = 'kimi-package-mount-probe';
    export const inject = ['tools', 'skills'];
    export function apply(ctx) {
      const expectedTools = ${JSON.stringify(expectedTools)};
      const expectedSkill = ${JSON.stringify(expectedSkill)};
      const result = ${JSON.stringify(probeResult)};
      const cwd = ${JSON.stringify(workspace)};
      let busy = false;
      const timer = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          const tools = ctx.tools.schemas().map(tool => tool.name);
          const skills = (await ctx.skills.list({ cwd })).map(skill => skill.name);
          if (!expectedTools.every(name => tools.includes(name))) return;
          if (!skills.includes(expectedSkill)) return;
          const setupTool = ctx.tools.get('mcp__kimi__kimi_setup');
          if (!setupTool) return;
          const modelsResult = await setupTool.execute(
            { action: 'models' },
            {
              callId: 'probe-models',
              rootCallId: 'probe-models',
              name: 'mcp__kimi__kimi_setup',
              arguments: { action: 'models' },
              signal: AbortSignal.timeout(15_000),
              token: Symbol('probe'),
              deferContext: () => {},
            },
          );
          writeFileSync(result + '.tmp', JSON.stringify({ tools, skills, modelsResult }));
          renameSync(result + '.tmp', result);
          clearInterval(timer);
        } finally {
          busy = false;
        }
      }, 100);
      ctx.on('dispose', () => clearInterval(timer));
    }
  `);
  runDsh(['plugin', '--profile', 'web', 'add', probe], { cwd: workspace, env });
  await bootAndStop(env, workspace, probeResult);
  const mounted = JSON.parse(readFileSync(probeResult, 'utf8'));
  for (const tool of expectedTools) {
    assert(mounted.tools.includes(tool), `Missing MCP tool ${tool}; registered: ${mounted.tools.join(', ')}`);
  }
  assert(mounted.skills.includes(expectedSkill), `Missing skill ${expectedSkill}; registered: ${mounted.skills.join(', ')}`);
  assert(mounted.modelsResult && Array.isArray(mounted.modelsResult.content), `Missing live modelsResult from mcp__kimi__kimi_setup: ${JSON.stringify(mounted.modelsResult)}`);
  const modelsText = mounted.modelsResult.content.find(block => block?.type === 'text')?.text ?? '';
  const modelsParsed = JSON.parse(modelsText);
  assert(Array.isArray(modelsParsed.models), `Expected models array from live mcp__kimi__kimi_setup({ action: "models" }): ${modelsText}`);
  console.log(`Verified ${pkg.name}@${pkg.version}: ${files.length} files, audited patched DSH host and profile, 4 MCP tools + kimi skill + live tool call, and Web boot`);
  console.log(archive);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
