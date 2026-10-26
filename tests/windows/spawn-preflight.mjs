import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { assertPromptFitsCommandLine, windowsCommandLineLength } from '../../dist/prompt-size.js';
import { runCliPrompt } from '../../dist/cli-client.js';

// No Kimi binary, credentials, shell wrapper, or provider access.
test('Windows UTF-16 command-line bounds include quoting, Unicode and terminator', () => {
  assert.equal(windowsCommandLineLength('x', ['a']), 4);
  assert.equal(windowsCommandLineLength('x', ['']), 5);
  assert.equal(windowsCommandLineLength('x', ['a b']), 8);
  assert.equal(windowsCommandLineLength('x', ['a"b']), 9);
  assert.equal(windowsCommandLineLength('x', ['a b\\']), 10);
  assert.equal(windowsCommandLineLength('x', ['😀']), 5);
  assert.doesNotThrow(() => assertPromptFitsCommandLine('x', ['a'.repeat(32764)], 'win32'));
  assert.throws(() => assertPromptFitsCommandLine('x', ['a'.repeat(32765)], 'win32'), { code: 'CLI_COMMAND_LINE_TOO_LONG' });
  assert.doesNotThrow(() => assertPromptFitsCommandLine('x', ['a'.repeat(100000)], 'linux'));
});

test('a short real Node process preserves Windows quoting', () => {
  const values = ['a b', 'a"b', 'trailing \\', '😀'];
  const args = ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...values];
  assertPromptFitsCommandLine(process.execPath, args);
  const child = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), values);
});

test('production compiled client refuses 103KB before a Windows spawn', { skip: process.platform !== 'win32' }, async () => {
  let spawned = false;
  const command = process.execPath;
  const executionPlan = { schemaVersion: 1, operationKind: 'review', intendedEngine: 'legacy-v1', command,
    prefixArgs: [], kimiVersion: '0.41.0', certification: 'certified', resumedFromJobId: null, safetyProfile: null };
  await assert.rejects(runCliPrompt({ cwd: process.cwd(), command, executionPlan, env: {}, prompt: 'x'.repeat(103000),
    onSpawn: () => { spawned = true; } }), { code: 'CLI_COMMAND_LINE_TOO_LONG' });
  assert.equal(spawned, false);
});
