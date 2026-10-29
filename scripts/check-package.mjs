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
const expectedMcpTools = [
  'kimi_ask', 'kimi_review', 'kimi_challenge', 'kimi_rescue', 'kimi_pursue', 'kimi_swarm', 'kimi_swarm_write',
  'kimi_job_status', 'kimi_job_result', 'kimi_job_cancel',
];
const destination = process.argv[2] ? path.resolve(process.argv[2]) : scratch;

function runMcpConversation(host, plugin, cwd, env, requests) {
  const result = spawnSync(path.join(plugin, 'scripts/companion.sh'), ['mcp'], {
    cwd, env, encoding: 'utf8', timeout: 15000,
    input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
  });
  const diagnostic = `${host} MCP: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, diagnostic);
  const responses = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(responses.length, requests.length, diagnostic);
  for (const response of responses) {
    assert.equal(response.jsonrpc, '2.0', diagnostic);
    assert.equal(response.error, undefined, diagnostic);
  }
  return new Map(responses.map((response) => [response.id, response]));
}
mkdirSync(destination, { recursive: true });
try {
  execFileSync('bun', ['pm', 'pack', '--ignore-scripts', '--destination', destination, '--quiet'], { cwd: repo, stdio: 'pipe' });
  const archive = path.join(destination, `${pkg.name}-${pkg.version}.tgz`);
  const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  const allowed = /^(?:package\/(?:package\.json|\.mcp\.json|README\.md|LICENSE|CHANGELOG\.md)|package\/(?:\.claude-plugin|\.agents\/plugins|agents|commands|hooks|dist|plugins\/kimi-codex|docs)\/|package\/scripts\/(?:companion|review-gate-hook)\.sh$)/;
  const syncConflictCopy = /(?:^|\/)[^/]* [0-9]+(?:\.[^/]*)?(?:\/|$)/;
  for (const file of files) {
    assert(!file.split('/').includes('..'), file);
    assert(!syncConflictCopy.test(file), `Unexpected sync-conflict copy: ${file}`);
    assert(allowed.test(file), `Unexpected published file: ${file}`);
    assert(!file.includes('node_modules') && !file.endsWith('.map'), file);
  }
  execFileSync('tar', ['-xzf', archive, '-C', scratch]);
  const root = path.join(scratch, 'package');
  for (const file of [
    '.mcp.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json',
    '.agents/plugins/marketplace.json', 'hooks/hooks.json', 'dist/vendor/smol-toml/LICENSE',
    'dist/vendor/shell-quote/LICENSE', 'plugins/kimi-codex/.mcp.json',
    'plugins/kimi-codex/.codex-plugin/plugin.json',
  ]) {
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
    const clientInfo = { name: 'kimi-package-gate', version: pkg.version };
    const modernMeta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': clientInfo,
      'io.modelcontextprotocol/clientCapabilities': {
        extensions: { 'io.modelcontextprotocol/tasks': {} },
      },
    };
    const modern = runMcpConversation(host, plugin, scratch, env, [
      { jsonrpc: '2.0', id: 'discover', method: 'server/discover', params: { _meta: modernMeta } },
      { jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: { _meta: modernMeta } },
    ]);
    const discovery = modern.get('discover');
    const modernListing = modern.get('tools');
    assert.equal(discovery?.result?.resultType, 'complete');
    assert.deepEqual(discovery?.result?.supportedVersions, ['2026-07-28']);
    assert.deepEqual(discovery?.result?.capabilities?.extensions?.['io.modelcontextprotocol/tasks'], {});
    assert.equal(modernListing?.result?.resultType, 'complete');
    const modernTools = modernListing?.result?.tools;
    assert(Array.isArray(modernTools), `${host}: modern tools/list returned no tool array`);
    assert.equal(modernTools.length, 10);
    assert.deepEqual(modernTools.map((tool) => tool.name).sort(), [...expectedMcpTools].sort());

    const legacy = runMcpConversation(host, plugin, scratch, env, [
      {
        jsonrpc: '2.0', id: 'initialize', method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo },
      },
      { jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} },
    ]);
    const initialization = legacy.get('initialize');
    const legacyListing = legacy.get('tools');
    assert.equal(initialization?.result?.protocolVersion, '2025-06-18');
    for (const response of [initialization, legacyListing]) {
      assert(response?.result && typeof response.result === 'object', `${host}: missing ordinary legacy result`);
      assert(!Object.hasOwn(response.result, 'resultType'), `${host}: legacy result must not have resultType`);
    }
    assert.deepEqual(legacyListing.result.tools, modernTools);

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
