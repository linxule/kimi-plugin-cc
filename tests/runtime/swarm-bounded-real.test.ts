// Opt-in deterministic certification controls against the untouched 2.6.2 binary.
// Every case runs in a dedicated process so cancellation cannot hit a sibling.
// No provider credentials, personal Kimi configuration or network model calls.
import { describe, expect, test } from 'bun:test';
import { runOwnedCaseProcess } from '../helpers/owned-case-process.js';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const enabled=process.env.KIMI_PLUGIN_CC_BOUNDED_SMOKE==='1';
const cases=['waves-read','waves-write','waves-odd','background-denial','auto-background-write','single-auto-background-write','resumes','invalid-resumes','single-read','single-write','single-write-default','nesting-builtin','nesting-custom','timeout-http','timeout-tool','cancel-read','cancel-write','single-timeout-read','single-timeout-write','single-cancel-read','single-cancel-write','recovery-429','recovery-context'];
const suite=enabled?describe:describe.skip;
const caseFile=fileURLToPath(new URL('../helpers/swarm-bounded-cases.ts',import.meta.url));
let outputPromise:Promise<string>|undefined;
const getOutput=()=>outputPromise??=(process.env.KIMI_PLUGIN_CC_BOUNDED_SMOKE_OUTPUT
 ?Promise.resolve(process.env.KIMI_PLUGIN_CC_BOUNDED_SMOKE_OUTPUT)
 :mkdtemp(path.join(os.tmpdir(),'kimi-bounded-cert-')));

suite('real stock 2.6.2 bounded swarm, canonical hook',()=>{
 for(const name of cases)test(name,async()=>{
  expect(process.platform).not.toBe('win32');
  expect(path.isAbsolute(process.env.KIMI_PLUGIN_CC_KIMI_BIN??'')).toBe(true);
  const output=await getOutput();
  await mkdir(output,{recursive:true});
  const run=await runOwnedCaseProcess(process.execPath,[caseFile,name],{
   env:{...process.env,KIMI_PLUGIN_CC_BOUNDED_SMOKE_OUTPUT:output},
   timeoutMs:260000,graceMs:10000,killWaitMs:4000,
  });
  await writeFile(path.join(output,`${name}.log`),run.stdout+run.stderr);
  expect(run.timedOut,run.stdout+run.stderr).toBe(false);
  expect(run.quiescent).toBe(true);
  expect(run.code,run.stdout+run.stderr).toBe(0);
  expect(run.stdout).toContain(`PASS bounded swarm ${name}`);
 },300000);
});
