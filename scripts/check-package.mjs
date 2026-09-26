// Inspect and execute the actual packed plugin; no host config or model calls.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'kimi-package-'));
const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
const destination = process.argv[2] ? path.resolve(process.argv[2]) : scratch;
mkdirSync(destination, { recursive: true });
try {
  execFileSync('bun', ['pm', 'pack', '--ignore-scripts', '--destination', destination, '--quiet'], { cwd: repo, stdio: 'pipe' });
  const archive = path.join(destination, `${pkg.name}-${pkg.version}.tgz`);
  const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  const allowed = /^(?:package\/(?:package\.json|README\.md|LICENSE|CHANGELOG\.md)|package\/(?:\.claude-plugin|\.agents\/plugins|agents|commands|hooks|dist|plugins\/kimi-codex|docs)\/|package\/scripts\/(?:companion|review-gate-hook)\.sh$)/;
  for (const file of files) {
    assert(!file.split('/').includes('..'), file);
    assert(allowed.test(file), `Unexpected published file: ${file}`);
    assert(!file.includes('node_modules') && !file.endsWith('.map'), file);
  }
  execFileSync('tar', ['-xzf', archive, '-C', scratch]);
  const root = path.join(scratch, 'package');
  for (const file of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json', 'hooks/hooks.json', 'dist/vendor/smol-toml/LICENSE', 'dist/vendor/shell-quote/LICENSE', 'plugins/kimi-codex/.codex-plugin/plugin.json']) {
    assert(statSync(path.join(root, file)).isFile(), file);
  }
  // Every generated runtime file must survive packing byte-for-byte.
  function verifyTree(relative) {
    for (const entry of readdirSync(path.join(repo, relative), { withFileTypes: true })) {
      const rel = path.join(relative, entry.name);
      if (entry.isDirectory()) verifyTree(rel);
      else assert.deepEqual(readFileSync(path.join(root, rel)), readFileSync(path.join(repo, rel)), rel);
    }
  }
  verifyTree('dist');
  verifyTree('plugins/kimi-codex');
  for (const [host, plugin] of [['claude', root], ['codex', path.join(root, 'plugins/kimi-codex')]]) {
    const home = path.join(scratch, host);
    const kimiHome = path.join(home, 'kimi-home');
    mkdirSync(kimiHome, { recursive: true });
    const env = { PATH: process.env.PATH, HOME: home, KIMI_CODE_HOME: kimiHome,
      CLAUDE_PLUGIN_ROOT: plugin, PLUGIN_ROOT: plugin,
      KIMI_PLUGIN_CC_DATA: path.join(home, 'data'),
      KIMI_PLUGIN_CC_DISABLE_WEB_ANNOUNCE: '1' };
    for (const args of [['setup'], ['setup', '--check']]) {
      const result = spawnSync(path.join(plugin, 'scripts/companion.sh'), args, { cwd: scratch, env, encoding: 'utf8' });
      assert.equal(result.status, 0, `${host}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Probe:\s+ok/, result.stdout);
    }
    const config = readFileSync(path.join(kimiHome, 'config.toml'), 'utf8');
    assert(config.includes(path.join(plugin, 'dist/hooks/approval-hook.js')), config);
    assert(config.includes(pkg.version), config);
    // A fake, unsupported version must be rejected before any prompt execution.
    const fake = path.join(home, 'fake-kimi');
    writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "99.0.0"; exit 0; fi\necho UNEXPECTED_MODEL_CALL >&2\nexit 99\n', { mode: 0o755 });
    const result = spawnSync(path.join(plugin, 'scripts/companion.sh'), ['ask', 'packaging probe'], {
      cwd: scratch, env: { ...env, KIMI_PLUGIN_CC_KIMI_BIN: fake }, encoding: 'utf8', timeout: 15000,
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert(!`${result.stdout}${result.stderr}`.includes('UNEXPECTED_MODEL_CALL'));
    assert.match(`${result.stdout}${result.stderr}`, /KIMI_CAPABILITY_NOT_CERTIFIED|CLI_VERSION/, `${result.stdout}\n${result.stderr}`);
  }
  console.log(`Verified ${pkg.name}@${pkg.version}: ${files.length} files, both compiled distributions, isolated hook setup/check and version refusal`);
  console.log(archive);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
