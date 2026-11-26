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
const expectedMcpTools = ['kimi_read', 'kimi_write', 'kimi_job', 'kimi_setup'];
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
  const allowed = /^(?:package\/(?:package\.json|\.mcp\.json|plugin\.json|mcp_config\.json|cordis\.patch\.yml|README\.md|LICENSE)|package\/(?:\.claude-plugin|\.agents\/plugins|dsh|skills|assets|dist|plugins\/kimi-codex)\/|package\/docs\/(?:safety|migration|models|session-visibility|swarm-recovery)\.md$|package\/scripts\/companion\.sh$)/;
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
    '.agents/plugins/marketplace.json', 'plugin.json', 'mcp_config.json',
    'cordis.patch.yml', 'dsh/index.json', 'skills/kimi/SKILL.md',
    'skills/kimi/agents/openai.yaml', 'assets/logo.svg',
    'dist/hooks/approval-hook.js', 'dist/vendor/smol-toml/LICENSE',
    'dist/vendor/shell-quote/LICENSE', 'plugins/kimi-codex/.mcp.json',
    'plugins/kimi-codex/.codex-plugin/plugin.json',
    'plugins/kimi-codex/skills/kimi/SKILL.md',
    'plugins/kimi-codex/skills/kimi/agents/openai.yaml',
  ]) {
    assert(statSync(path.join(root, file)).isFile(), file);
  }
  // Bundled approval-hook.js must be self-contained with zero relative ../ imports.
  const hookSource = readFileSync(path.join(root, 'dist/hooks/approval-hook.js'), 'utf8');
  assert(!/from\s+["']\.\.\//.test(hookSource) && !/import\s*\(\s*["']\.\.\//.test(hookSource), 'approval-hook.js must be self-contained');

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

  // Verify the published `kimi-companion` bin installs and executes via shebang.
  const binCheckDir = path.join(scratch, 'bin-check');
  mkdirSync(binCheckDir, { recursive: true });
  writeFileSync(path.join(binCheckDir, 'package.json'), JSON.stringify({
    name: 'kimi-bin-smoke', private: true, version: '1.0.0',
  }));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', archive], {
    cwd: binCheckDir, stdio: 'pipe', timeout: 60_000,
  });
  const binPath = path.join(binCheckDir, 'node_modules', '.bin', 'kimi-companion');
  const binHelp = spawnSync(binPath, ['--help'], { cwd: binCheckDir, encoding: 'utf8', timeout: 15_000 });
  assert.equal(binHelp.status, 0, `kimi-companion --help failed: ${binHelp.stdout}\n${binHelp.stderr}`);
  assert.match(binHelp.stdout, /read|write|job|setup|mcp/, `unexpected kimi-companion --help output: ${binHelp.stdout}`);

  for (const [host, plugin] of [['root', root], ['codex', path.join(root, 'plugins/kimi-codex')]]) {
    const home = path.join(scratch, host);
    const kimiHome = path.join(home, 'kimi-home');
    const dataRoot = path.join(home, 'data');
    mkdirSync(kimiHome, { recursive: true });
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      KIMI_CODE_HOME: kimiHome,
      KIMI_PLUGIN_CC_DATA: dataRoot,
      KIMI_PLUGIN_CC_DISABLE_WEB_ANNOUNCE: '1',
    };
    for (const args of [['setup'], ['setup', '--check']]) {
      const result = spawnSync(path.join(plugin, 'scripts/companion.sh'), args, { cwd: scratch, env, encoding: 'utf8' });
      assert.equal(result.status, 0, `${host}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Probe:\s+ok/, result.stdout);
    }
    const config = readFileSync(path.join(kimiHome, 'config.toml'), 'utf8');
    const publishedHook = path.join(dataRoot, 'kimi-plugin-cc', 'hook', 'approval-hook.js');
    assert(statSync(publishedHook).isFile(), `${host}: published hook artifact missing at ${publishedHook}`);
    assert(config.includes(publishedHook), config);
    assert(config.includes(pkg.version), config);

    const clientInfo = { name: 'kimi-package-gate', version: pkg.version };
    const modernMeta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': clientInfo,
      'io.modelcontextprotocol/clientCapabilities': {
        extensions: { 'io.modelcontextprotocol/tasks': {}, 'io.modelcontextprotocol/skills': {} },
      },
    };
    const modern = runMcpConversation(host, plugin, scratch, env, [
      { jsonrpc: '2.0', id: 'discover', method: 'server/discover', params: { _meta: modernMeta } },
      { jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: { _meta: modernMeta } },
      { jsonrpc: '2.0', id: 'skills', method: 'skills/list', params: { _meta: modernMeta } },
      { jsonrpc: '2.0', id: 'getSkill', method: 'skills/get', params: { uri: 'skill://kimi/SKILL.md', _meta: modernMeta } },
      { jsonrpc: '2.0', id: 'resources', method: 'resources/list', params: { _meta: modernMeta } },
      { jsonrpc: '2.0', id: 'readSkill', method: 'resources/read', params: { uri: 'skill://kimi/SKILL.md', _meta: modernMeta } },
      { jsonrpc: '2.0', id: 'readAgent', method: 'resources/read', params: { uri: 'skill://kimi/agents/openai.yaml', _meta: modernMeta } },
    ]);
    const discovery = modern.get('discover');
    const modernListing = modern.get('tools');
    assert.equal(discovery?.result?.resultType, 'complete');
    assert.deepEqual(discovery?.result?.supportedVersions, ['2026-07-28']);
    assert.deepEqual(discovery?.result?.capabilities?.extensions?.['io.modelcontextprotocol/tasks'], {});
    assert.deepEqual(discovery?.result?.capabilities?.extensions?.['io.modelcontextprotocol/skills'], {});
    assert.match(discovery?.result?.instructions ?? '', /kimi_job/, `${host}: discovery lacks server instructions`);
    assert.equal(modernListing?.result?.resultType, 'complete');
    const modernTools = modernListing?.result?.tools;
    assert(Array.isArray(modernTools), `${host}: modern tools/list returned no tool array`);
    assert.equal(modernTools.length, expectedMcpTools.length);
    assert.deepEqual(modernTools.map((tool) => tool.name).sort(), [...expectedMcpTools].sort());
    for (const key of ['skills', 'getSkill', 'resources', 'readSkill', 'readAgent']) {
      const res = modern.get(key)?.result;
      assert.equal(res?.resultType, 'complete', `${host}: modern ${key} missing resultType`);
      assert.equal(res?.ttlMs, 0, `${host}: modern ${key} missing ttlMs=0`);
      assert.equal(res?.cacheScope, 'private', `${host}: modern ${key} missing cacheScope=private`);
    }
    const skillManifest = modern.get('skills')?.result?.skills?.[0];
    assert.equal(skillManifest?.uri, 'skill://kimi/SKILL.md');
    assert.equal(skillManifest?.frontmatter?.name, 'kimi');
    assert(typeof skillManifest?.frontmatter?.description === 'string' && skillManifest.frontmatter.description.length > 0);
    assert.deepEqual(
      skillManifest?.resources?.map((r) => r.uri),
      ['skill://kimi/SKILL.md', 'skill://kimi/agents/openai.yaml'],
    );
    for (const ref of skillManifest.resources) {
      assert.match(ref.digest, /^sha256:[0-9a-f]{64}$/);
      assert(Number.isSafeInteger(ref.size) && ref.size > 0);
    }
    assert.deepEqual(modern.get('getSkill')?.result?.skill, skillManifest);
    assert.deepEqual(
      modern.get('resources')?.result?.resources?.map((r) => r.uri),
      ['skill://kimi/SKILL.md', 'skill://kimi/agents/openai.yaml'],
    );
    assert.match(modern.get('readSkill')?.result?.contents?.[0]?.text ?? '', /^---\nname: kimi\n/);
    assert.match(modern.get('readAgent')?.result?.contents?.[0]?.text ?? '', /display_name/);

    const legacy = runMcpConversation(host, plugin, scratch, env, [
      {
        jsonrpc: '2.0', id: 'initialize', method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo },
      },
      { jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 'skills', method: 'skills/list', params: {} },
      { jsonrpc: '2.0', id: 'getSkill', method: 'skills/get', params: { uri: 'skill://kimi/SKILL.md' } },
      { jsonrpc: '2.0', id: 'readSkill', method: 'resources/read', params: { uri: 'skill://kimi/SKILL.md' } },
    ]);
    const initialization = legacy.get('initialize');
    const legacyListing = legacy.get('tools');
    assert.equal(initialization?.result?.protocolVersion, '2025-06-18');
    assert.equal(initialization?.result?.instructions, discovery?.result?.instructions, `${host}: initialize lacks server instructions`);
    for (const response of [initialization, legacyListing, legacy.get('skills'), legacy.get('getSkill'), legacy.get('readSkill')]) {
      assert(response?.result && typeof response.result === 'object', `${host}: missing ordinary legacy result`);
      assert(!Object.hasOwn(response.result, 'resultType'), `${host}: legacy result must not have resultType`);
      assert(!Object.hasOwn(response.result, 'ttlMs'), `${host}: legacy result must not have ttlMs`);
    }
    assert.deepEqual(legacyListing.result.tools, modernTools);
    assert.deepEqual(legacy.get('skills')?.result?.skills?.[0], skillManifest);
    assert.deepEqual(legacy.get('getSkill')?.result?.skill, skillManifest);
    assert.match(legacy.get('readSkill')?.result?.contents?.[0]?.text ?? '', /^---\nname: kimi\n/);

    // A fake, unsupported version must be rejected before any prompt execution.
    const fake = path.join(home, 'fake-kimi');
    writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "99.0.0"; exit 0; fi\necho UNEXPECTED_MODEL_CALL >&2\nexit 99\n', { mode: 0o755 });
    const result = spawnSync(path.join(plugin, 'scripts/companion.sh'), ['read', '--mode', 'ask', '--', 'packaging probe'], {
      cwd: scratch, env: { ...env, KIMI_PLUGIN_CC_KIMI_BIN: fake }, encoding: 'utf8', timeout: 15000,
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert(!`${result.stdout}${result.stderr}`.includes('UNEXPECTED_MODEL_CALL'));
    assert.match(`${result.stdout}${result.stderr}`, /KIMI_CAPABILITY_NOT_CERTIFIED|CLI_VERSION/, `${result.stdout}\n${result.stderr}`);
  }
  console.log(`Verified ${pkg.name}@${pkg.version}: ${files.length} files, root + Codex distributions, 4-tool MCP + SEP-2640 skills, isolated hook setup/check, and version refusal`);
  console.log(archive);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
