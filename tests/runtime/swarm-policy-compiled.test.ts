import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const distributions = ["./dist", "./plugins/kimi-codex/dist", "./plugins/kimi-dsh/dist"];

// Node resolves the emitted JavaScript, including the real hook entry point;
// Bun's .js-to-.ts loader must not turn these into source-only regressions.
test.each(distributions)("%s exports only plan-owned bounded swarm settings", (root) => {
  const script = `
    import assert from 'node:assert/strict';
    import { buildKimiCliEnvironment } from '${root}/cli-client.js';
    import {
      BOUNDED_SWARM_POLICY, SWARM_CHILD_TIMEOUT_MS, SWARM_POLICY_ENV, SWARM_WAVE_SIZE_ENV,
    } from '${root}/swarm-policy.js';
    const plan = {
      schemaVersion: 1, operationKind: 'swarm', intendedEngine: 'native-v2',
      command: process.execPath, prefixArgs: [], kimiVersion: '2.6.2',
      certification: 'certified', resumedFromJobId: null, safetyProfile: 'native-v2-no-plan/1',
    };
    const ambient = {
      KIMI_CODE_HOME: process.cwd(),
      [SWARM_POLICY_ENV]: 'disabled', [SWARM_WAVE_SIZE_ENV]: '9999',
      KIMI_CODE_SWARM_TIMEOUT_MS: '3', KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '9999',
      KIMI_PLUGIN_CC_OPERATION: 'rescue', KIMI_PLUGIN_CC_CMD: 'rescue',
    };
    for (const operationKind of ['swarm', 'swarm-write']) {
      for (const concurrency of [1, 4]) {
        const env = buildKimiCliEnvironment({
          cwd: process.cwd(), env: ambient,
          executionPlan: { ...plan, operationKind }, commandLabel: operationKind,
          swarmMaxConcurrency: concurrency, trustedWorkspaceRoot: process.cwd(),
        });
        assert.equal(env[SWARM_POLICY_ENV], BOUNDED_SWARM_POLICY);
        assert.equal(env[SWARM_WAVE_SIZE_ENV], String(concurrency));
        assert.equal(env.KIMI_CODE_SWARM_TIMEOUT_MS, '2147483647');
        assert.equal(SWARM_CHILD_TIMEOUT_MS, 2147483647);
        assert.equal(env.KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY, String(concurrency));
        assert.equal(env.KIMI_PLUGIN_CC_OPERATION, operationKind);
        assert.equal(env.KIMI_PLUGIN_CC_CMD, operationKind);
      }
    }
    assert.equal(ambient[SWARM_POLICY_ENV], 'disabled');
    assert.equal(ambient[SWARM_WAVE_SIZE_ENV], '9999');
    const options = {
      cwd: process.cwd(), env: ambient, executionPlan: plan,
      commandLabel: 'swarm', swarmMaxConcurrency: 4,
    };
    for (const concurrency of [undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => buildKimiCliEnvironment({ ...options, swarmMaxConcurrency: concurrency }),
        error => error.code === 'SWARM_POLICY_INVALID');
    }
    for (const commandLabel of [undefined, '', 'rescue', 'swarm-write']) {
      assert.throws(() => buildKimiCliEnvironment({ ...options, commandLabel }),
        error => error.code === 'SWARM_POLICY_INVALID');
    }
    for (const unboundedPlan of [
      { ...plan, kimiVersion: '2.5.3' },
      { ...plan, kimiVersion: '2.6.0' },
      { ...plan, kimiVersion: '2.6.3' },
      { ...plan, kimiVersion: '2.6.2+build' },
      { ...plan, intendedEngine: 'legacy-v1' },
      { ...plan, operationKind: 'rescue' },
    ]) {
      const env = buildKimiCliEnvironment({
        ...options, executionPlan: unboundedPlan, commandLabel: unboundedPlan.operationKind,
      });
      assert.equal(env[SWARM_POLICY_ENV], undefined);
      assert.equal(env[SWARM_WAVE_SIZE_ENV], undefined);
      assert.equal(env.KIMI_CODE_SWARM_TIMEOUT_MS, '3');
    }
  `;
  const result = spawnSync("node", ["--input-type=module", "-e", script], {
    cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 15_000);

test.each(distributions)("%s enforces bounded waves through the compiled hook protocol", (root) => {
  const script = `
    import assert from 'node:assert/strict';
    import { spawnSync } from 'node:child_process';
    import path from 'node:path';
    import { buildKimiCliEnvironment } from '${root}/cli-client.js';
    import { SWARM_POLICY_ENV, SWARM_WAVE_SIZE_ENV } from '${root}/swarm-policy.js';
    const plan = {
      schemaVersion: 1, operationKind: 'swarm', intendedEngine: 'native-v2',
      command: process.execPath, prefixArgs: [], kimiVersion: '2.6.2',
      certification: 'certified', resumedFromJobId: null, safetyProfile: 'native-v2-no-plan/1',
    };
    const makeEnv = (operationKind, width) => buildKimiCliEnvironment({
      cwd: process.cwd(), env: { KIMI_CODE_HOME: process.cwd() },
      executionPlan: { ...plan, operationKind }, commandLabel: operationKind,
      swarmMaxConcurrency: width, trustedWorkspaceRoot: process.cwd(),
    });
    const hook = path.resolve('${root}/hooks/approval-hook.js');
    const invoke = (env, name, args, expected, reason) => {
      const child = spawnSync(process.execPath, [hook], {
        cwd: process.cwd(), env, encoding: 'utf8', timeout: 2000,
        input: JSON.stringify({
          hook_event_name: 'PreToolUse', tool_name: name, tool_input: args,
          tool_call_id: 'compiled-wave-control', session_id: 'compiled-wave-session',
          cwd: '/untrusted-payload-root',
        }),
      });
      assert.ifError(child.error);
      assert.equal(child.status, expected, child.stderr);
      assert.equal(child.stdout, '');
      if (reason) assert.match(child.stderr, reason);
      return child.stderr;
    };
    const four = {
      description: 'mixed wave', items: ['a', 'b'], prompt_template: '{{item}}',
      resume_agent_ids: { 'agent-1': 'continue first', 'agent-2': 'continue second' },
    };
    for (const operationKind of ['swarm', 'swarm-write']) {
      const env = makeEnv(operationKind, 4);
      invoke(env, 'AgentSwarm', four, 0);
      invoke(env, 'AgentSwarm', { ...four, items: ['a', 'b', 'c'] }, 2, /exceeding the limit 4/);
      invoke(env, 'AgentSwarm', { ...four, fork: true }, 2, /forked subagents/);
      invoke(env, 'AgentSwarm', { description: 'last target', items: ['one'] }, 2, /fresh-only waves require at least two entries/);
      invoke(env, 'AgentSwarm', { description: 'last target', resume_agent_ids: { 'agent-1': 'finish' } }, 0);
      invoke(env, 'AgentSwarm', { ...four, resume_agent_ids: ['agent-1'] }, 2, /resume_agent_ids/);
      invoke(env, 'Bash', { command: 'git status', run_in_background: true }, 2, /explicit background commands are disabled/);
      const missing = { ...env };
      delete missing[SWARM_WAVE_SIZE_ENV];
      invoke(missing, 'AgentSwarm', four, 2, /trusted wave size/);
      invoke({ ...env, [SWARM_WAVE_SIZE_ENV]: '4.5' }, 'AgentSwarm', four, 2, /trusted wave size/);
      invoke({ ...env, [SWARM_POLICY_ENV]: 'disabled' }, 'AgentSwarm', four, 2, /unrecognized swarm policy/);
      const single = makeEnv(operationKind, 1);
      invoke(single, 'AgentSwarm', four, 2, /one worker directly/);
      invoke(single, 'Agent', { prompt: 'delegate anyway' }, 2, /Agent/);
      invoke(single, 'Read', { path: 'README.md' }, 0);
      invoke(single, 'Bash', { command: 'git status', run_in_background: true }, 2, /foreground/);
      if (operationKind === 'swarm') {
        const denial = invoke(single, 'Write', { path: 'denied.txt', content: 'denied' }, 2,
          /Complete the review yourself; delegation is denied/);
        assert.match(denial, /Read, Grep, or Glob/);
        assert.doesNotMatch(denial, /coordinator|fan out|subagents/);
      }
    }
    // Missing both new overlays remains the explicitly older-version behavior.
    const oldEnv = buildKimiCliEnvironment({
      cwd: process.cwd(), env: { KIMI_CODE_HOME: process.cwd() },
      executionPlan: { ...plan, kimiVersion: '2.5.3' }, commandLabel: 'swarm',
      swarmMaxConcurrency: 4,
    });
    invoke(oldEnv, 'AgentSwarm', { ...four, items: ['a', 'b', 'c'] }, 0);
  `;
  const result = spawnSync("node", ["--input-type=module", "-e", script], {
    cwd: process.cwd(), encoding: "utf8", timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 20_000);

test.each(distributions)("%s forwards the exported wave policy into stream monitoring", (root) => {
  const script = `
    import assert from 'node:assert/strict';
    import { mkdtemp, rm } from 'node:fs/promises';
    import os from 'node:os';
    import path from 'node:path';
    import { runCliPrompt } from '${root}/cli-client.js';
    import { NATIVE_V2_CERTIFIED } from '${root}/kimi-engine.js';
    const home = await mkdtemp(path.join(os.tmpdir(), 'kimi-wave-monitor-'));
    const command = ${JSON.stringify(Bun.which("bun"))};
    const prefixArgs = ['run', path.resolve('tests/helpers/mock-kimi-stream.ts')];
    // Isolated test-only candidate map: this test does not promote certification.
    NATIVE_V2_CERTIFIED.set('swarm', [...new Set([...NATIVE_V2_CERTIFIED.get('swarm'), '2.6.2'])]);
    const executionPlan = {
      schemaVersion: 1, operationKind: 'swarm', intendedEngine: 'native-v2', command, prefixArgs,
      kimiVersion: '2.6.2', certification: 'certified', resumedFromJobId: null,
      safetyProfile: 'native-v2-no-plan/1',
    };
    try {
      for (const content of [undefined, 'executed oversized wave']) {
        const records = [
          { role: 'meta', type: 'system.version', version: '2.6.2' },
          { role: 'assistant', tool_calls: [{ id: 'oversized', type: 'function', function: {
            name: 'AgentSwarm', arguments: JSON.stringify({ description: 'too many', items: ['one','two','three'] }),
          } }] },
          ...(content === undefined ? [] : [{ role: 'tool', tool_call_id: 'oversized', content }]),
        ];
        const result = await runCliPrompt({
          cwd: home, command, prefixArgs, executionPlan, prompt: 'monitor control',
          commandLabel: 'swarm', swarmMaxConcurrency: 2,
          env: { PATH: process.env.PATH, KIMI_CODE_HOME: home,
            KIMI_PLUGIN_CC_SWARM_POLICY: 'forged', KIMI_PLUGIN_CC_SWARM_WAVE_SIZE: '999',
            KIMI_MOCK_EMIT_ANNOUNCE: '0', KIMI_MOCK_RECORDS: JSON.stringify(records) },
        });
        assert.equal(result.exitCode, 0);
        assert.equal(result.hookEscapes.length, 1);
        assert.equal(result.hookEscapes[0].tool_name, 'AgentSwarm');
        assert.equal(result.hookEscapes[0].kind, content === undefined ? 'unresolved' : 'mismatch');
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  `;
  const result = spawnSync("node", ["--input-type=module", "-e", script], {
    cwd: process.cwd(), encoding: "utf8", timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 20_000);
