import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Execute shipped JS under Node, not Bun's .js -> .ts resolution. The stdout
// refusal has no stderr fallback: losing it makes a busy session opaque.
test("compiled distributions preserve the stdout-only CLI refusal", () => {
  for (const root of ["./dist", "./plugins/kimi-codex/dist"]) {
    const script = `
      import assert from 'node:assert/strict';
      import { StreamJsonParser } from '${root}/stream-json.js';
      import { assertCliResultSuccess } from '${root}/commands/cli-helpers.js';
      const raw = {type:'error', code:'session.occupied', message:'Session is in use',
        details:{holder:{token:'do-not-persist'},sessionId:'not-a-resume-hint'}};
      const [outcome] = new StreamJsonParser().push(JSON.stringify(raw) + '\\n');
      assert.equal(outcome.record, undefined);
      assert.equal(outcome.cliError.code, 'session.occupied');
      const result = {exitCode:4,aborted:false,signal:null,records:[],malformed:[],
        stderrTail:'',cliError:outcome.cliError};
      assert.throws(() => assertCliResultSuccess(result, 'ask.runtime'), error => {
        assert.equal(error.code, 'CLI_NONZERO_EXIT');
        assert.equal(error.details.cli_error.code, 'session.occupied');
        assert.match(error.message, /Session is in use/);
        assert.ok(!JSON.stringify(error).includes('do-not-persist'));
        return true;
      });
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  }
});


// Execute full and narrowed operation scopes through all three emitted runtimes.
test("compiled distributions certify exact 2.6.2 and retain the 2.6.0 non-swarm scope", () => {
  for (const root of ["./dist", "./plugins/kimi-codex/dist", "./plugins/kimi-dsh/dist"]) {
    const script = `
      import assert from 'node:assert/strict';
      import {
        assertExecutionPlanMatchesSpawn,
        NATIVE_V2_ANY_OPERATION_VERSIONS,
        NATIVE_V2_CERTIFIED,
        NATIVE_V2_CERTIFIED_VERSIONS,
        NATIVE_V2_SAFETY_PROFILE,
        selectIntendedEngine,
      } from '${root}/kimi-engine.js';
      import { usesBoundedSwarmPolicy } from '${root}/swarm-policy.js';
      assert.equal(NATIVE_V2_CERTIFIED_VERSIONS.includes('2.6.0'), false);
      assert.equal(NATIVE_V2_CERTIFIED_VERSIONS.includes('2.6.2'), true);
      assert.equal(NATIVE_V2_CERTIFIED_VERSIONS.at(-1), '2.6.2');
      for (const operationKind of ['swarm', 'swarm-write']) {
        const versions = NATIVE_V2_CERTIFIED.get(operationKind).filter(
          version => version.localeCompare('2.5.3', 'en', { numeric: true }) > 0,
        );
        assert.ok(versions.length > 0);
        for (const kimiVersion of versions) {
          assert.equal(usesBoundedSwarmPolicy({
            operationKind, intendedEngine: 'native-v2', kimiVersion,
          }), true, operationKind + ' ' + kimiVersion + ' must use the bounded execution policy');
        }
      }
      for (const version of ['2.6.0', '2.6.2']) {
        assert.equal(NATIVE_V2_ANY_OPERATION_VERSIONS.includes(version), true);
        const base = {
          schemaVersion: 1,
          operationKind: 'ask',
          intendedEngine: 'native-v2',
          command: process.execPath,
          prefixArgs: [],
          kimiVersion: version,
          certification: 'certified',
          resumedFromJobId: null,
          safetyProfile: NATIVE_V2_SAFETY_PROFILE,
        };
        for (const operationKind of ['review', 'challenge', 'ask', 'rescue', 'review_gate', 'pursue']) {
          assert.doesNotThrow(() => assertExecutionPlanMatchesSpawn(
            { ...base, operationKind }, process.execPath, [],
          ));
        }
        for (const operationKind of ['swarm', 'swarm-write']) {
          assert.equal(selectIntendedEngine(operationKind, { version }), 'native-v2');
          if (version === '2.6.2') {
            assert.doesNotThrow(() => assertExecutionPlanMatchesSpawn(
              { ...base, operationKind }, process.execPath, [],
            ));
            continue;
          }
          assert.throws(
            () => assertExecutionPlanMatchesSpawn({ ...base, operationKind }, process.execPath, []),
            error => {
              assert.equal(error.code, 'KIMI_CAPABILITY_NOT_CERTIFIED');
              assert.equal(error.details.refusal_kind, 'v2-swarm-not-certified');
              assert.equal(error.details.certification_scope, 'non-swarm');
              assert.ok(error.message.includes('Select exact kimi-code 2.6.2'));
              assert.equal(error.details.kimi_version, version);
              return true;
            },
          );
        }
      }
      for (const version of ['2.6.1', '2.6.3', '2.6.2-rc.1', '2.6.2+unreviewed']) {
        assert.equal(NATIVE_V2_ANY_OPERATION_VERSIONS.includes(version), false);
        for (const operationKind of NATIVE_V2_CERTIFIED.keys()) {
          assert.throws(() => assertExecutionPlanMatchesSpawn({
            schemaVersion: 1, operationKind, intendedEngine: 'native-v2',
            command: process.execPath, prefixArgs: [], kimiVersion: version,
            certification: 'certified', resumedFromJobId: null,
            safetyProfile: NATIVE_V2_SAFETY_PROFILE,
          }, process.execPath, []), error => {
            assert.equal(error.code, 'KIMI_CAPABILITY_NOT_CERTIFIED');
            assert.equal(error.details.refusal_kind, 'v2-version-not-certified');
            return true;
          });
        }
      }
      for (const operationKind of ['rescue', 'swarm-write']) {
        const smokeMatrix = NATIVE_V2_CERTIFIED;
        smokeMatrix.set(operationKind, [...smokeMatrix.get(operationKind), '9.9.9']);
        assert.equal(selectIntendedEngine(operationKind, { version: '9.9.9' }), 'native-v2');
      }
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  }
});
