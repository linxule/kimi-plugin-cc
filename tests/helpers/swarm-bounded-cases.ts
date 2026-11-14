import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { runLane, textContent, journalEvidence, pairedCalls, collectDatabase, delay, BASE, type Reply, type RunResult } from './swarm-bounded-harness.js';
import { probeProcessIdentity } from '../../runtime/process-tree.js';
import { LIFECYCLE_MODES, runLifecycleCase } from './swarm-bounded-lifecycle.js';

export const ADMISSION_CASES = ['waves-read','waves-write','waves-odd','resumes','invalid-resumes','single-read','single-write','single-write-default'] as const;
export const RECOVERY_CASES = ['recovery-429','recovery-context'] as const;
const tasks=(start:number,count:number)=>Array.from({length:count},(_,i)=>`worker-${start+i}`);
const wave=(id:string,items:string[],extra:Record<string,unknown>={}):Reply=>({tool:{name:'AgentSwarm',id,args:{description:id,subagent_type:'coder',prompt_template:'WORKER_KEY: {{item}}. Execute the scripted control.',items,...extra}}});
const byCall=(result:RunResult,id:string)=>{
 const pair=pairedCalls(result.rawJournals).find(pair=>pair.call.toolCallId===id);
 assert(pair,`missing same-call evidence for ${id}`);return pair;
};
function assertCommon(result:RunResult,write:boolean,children:number,cap:number):void {
 assert.equal(result.error,undefined,JSON.stringify(result.error));
 assert.equal(result.setup.probe,'ok');assert.equal(result.rejected,0);assert.equal(result.userStatus,'');
 assert(result.afterSettleReport,'quiescence must be proved before closing provider');
 assert.equal(result.database.jobs.length,1);
 const job=result.database.jobs[0];assert.equal(job.status,'completed');assert.equal(job.kimi_version,'2.6.2');
 assert.equal(job.operation_kind,write?'swarm-write':'swarm');assert.equal(job.intended_engine,'native-v2');
 assert.equal(result.rawJournals.filter(j=>j.agent!=='main').length,children);
 assert.equal(result.rawJournals.filter(j=>j.agent==='main').length,1);
 assert(result.evidence.peakActiveTurns<=cap);assert.equal(result.evidence.remaining.length,0);
 if(children>=2)assert(result.evidence.peakActiveTurns>=2,'the fixture must positively observe overlapping child turns');
 const main=result.rawJournals.find(j=>j.agent==='main')!;
 const mainPairs=pairedCalls([main]);const spawned=main.events.filter(e=>e.type==='subagent.spawned');
 const ids=new Set(result.rawJournals.filter(j=>j.agent!=='main').map(j=>j.agent));
 assert.deepEqual(new Set(spawned.map(e=>e.subagentId)),ids);
 for(const event of spawned){assert.equal(event.callerAgentId,'main');assert.equal(event.parentAgentId,'main');const parent=mainPairs.find(p=>p.call.toolCallId===event.parentToolCallId);assert(parent);assert(JSON.stringify(parent.result).includes(event.subagentId));}
 for(const journal of result.rawJournals){
  const bindings=journal.events.filter(e=>e.type==='environment.set_binding');assert(bindings.length>0);
  assert(bindings.every(e=>e.environmentId==='local'));
 }
 const pairs=pairedCalls(result.rawJournals);
 for(const pair of pairs.filter(p=>p.call.name==='Write')){
  if(write&&pair.call.toolCallId!=='call_outside')assert(!pair.result.result.isError,JSON.stringify(pair.result));
  else {assert(pair.result.result.isError);assert.match(pair.result.result.output,write?/rescue rejects file edits outside the workspace or inside \.git:/ : /kimi-plugin-cc safety hook:/);}
 }
}

export async function runAdmissionCase(mode:string):Promise<void> {
 const single=mode.startsWith('single');const write=mode.includes('write');const cap=single?1:write?2:4;
 let step=0;let resumeIds:string[]=[];
 const result=await runLane({name:mode,cap:mode==='single-write-default'?undefined:cap,tasks:6,retry:false,write,holdMs:500,budgetSeconds:75,
  // Both values are deliberately hostile ambient inputs, never the desired bound.
  env:{KIMI_PLUGIN_CC_SWARM_POLICY:'forged',KIMI_PLUGIN_CC_SWARM_WAVE_SIZE:'999',KIMI_CODE_SWARM_TIMEOUT_MS:'3000'},
  handler(info){
   if(info.worker)return undefined;
   const current=step++;
   if(single){
    if(current===0)return wave('call_single_swarm',tasks(1,2));
    if(current===1)return {tool:{name:'Agent',id:'call_single_agent',args:{description:'forbidden nested worker',subagent_type:'coder',prompt:'WORKER_KEY: worker-99. Write forbidden.txt'}}};
    if(current===2)return {tool:{name:'Write',id:'call_outside',args:{path:path.join(info.root,'outside.txt'),content:'FORBIDDEN_OUTSIDE'}}};
    if(current===3)return {tool:{name:'Write',id:'call_single_write',args:{path:'single.txt',content:'SINGLE_WORKER_SENTINEL\n'}}};
    return {text:'SINGLE_WORKER_COMPLETE'};
   }
   if(mode==='invalid-resumes'){
    if(current===0)return wave('call_resume_main',[],{resume_agent_ids:{main:'Resume main as a child.'}});
    if(current===1)return wave('call_resume_missing',[],{resume_agent_ids:{'agent-missing':'Resume absent child.'}});
    return {text:'INVALID_RESUMES_COMPLETE'};
   }
   if(mode==='resumes'){
    if(current===0)return wave('call_seed2',tasks(1,2));
    if(current===1){resumeIds=[...new Set([...textContent(info.last.content).matchAll(/agent_id="([^"]+)"/g)].map(m=>m[1]))].slice(0,2);assert.equal(resumeIds.length,2);return wave('call_oversize_mix5',tasks(3,3),{resume_agent_ids:Object.fromEntries(resumeIds.map((id,i)=>[id,`WORKER_KEY: worker-${i+1}. Continue.`]))});}
    if(current===2)return wave('call_mixed4',tasks(3,2),{resume_agent_ids:Object.fromEntries(resumeIds.map((id,i)=>[id,`WORKER_KEY: worker-${i+1}. Continue.`]))});
    return {text:'RESUME_COMPLETE'};
   }
   if(mode==='waves-odd'){
    if(current===0)return wave('call_singleton',tasks(1,1));
    if(current===1)return wave('call_oversize5',tasks(1,5));
    if(current===2)return wave('call_odd_three',tasks(1,3));
    if(current===3)return wave('call_odd_two',tasks(4,2));
    return {text:'ODD_TARGETS_COMPLETE'};
   }
   if(current===0)return wave('call_oversize6',tasks(1,6));
   if(current===1)return wave('call_wave_first',tasks(1,cap));
   if(current===2)return wave('call_wave_second',tasks(cap+1,2));
   return {text:'WAVES_COMPLETE'};
  }
 });
 const children=single||mode==='invalid-resumes'?0:mode==='resumes'?4:mode==='waves-odd'?5:cap+2;
 assertCommon(result,write,children,cap);
 if(single){
  assert.equal(result.database.recovery.length,1);
  const recovery=result.database.recovery[0].payload;
  assert.equal(recovery.session,null);assert.equal(recovery.sessionDirty,false);
  assert(recovery.launches.every((launch:any)=>launch.kind==='print'),'direct worker must not launch activation web processes');
  assert.equal(result.database.jobs[0].kimi_session_id_source,'announced');
  for(const id of ['call_single_swarm','call_single_agent'])assert(byCall(result,id).result.result.isError);
  assert.match(byCall(result,'call_single_swarm').result.result.output,/^Swarm mode is off, so AgentSwarm did not run and no subagents were started\./);
  assert.match(byCall(result,'call_single_agent').result.result.output,/^kimi-plugin-cc safety hook: singular Agent delegation is denied/);
  const positive=byCall(result,'call_single_write');assert.equal(!!positive.result.result.isError,!write);
  assert.equal(await readFile(path.join(BASE,mode,'workspace','seed.txt'),'utf8'),'original\n');
  await assert.rejects(readFile(path.join(BASE,mode,'outside.txt')));
  if(write){assert.equal(result.patches.length,1);assert(result.patches[0].text.includes('SINGLE_WORKER_SENTINEL'));}
  else assert.equal(result.patches.length,0);
 }else if(mode==='invalid-resumes'){
  for(const id of ['call_resume_main','call_resume_missing']){
   const output=byCall(result,id).result.result.output;
   assert.match(output,/<subagent mode="resume" state="not_started" outcome="failed">/);
   assert.match(output,/Agent instance "(?:main|agent-missing)" is not a subagent/);
  }
 }else{
  const rejected=byCall(result,mode==='resumes'?'call_oversize_mix5':mode==='waves-odd'?'call_oversize5':'call_oversize6');
  assert(rejected.result.result.isError);assert.match(rejected.result.result.output,/kimi-plugin-cc safety hook:/);
  assert.match(rejected.result.result.output,/wave|entries|limit|bound/i);
  if(mode==='waves-odd'){
   const singleton=byCall(result,'call_singleton').result.result;
   assert(singleton.isError);assert.match(singleton.output,/at least (?:2|two)/);
  }
  const writes=pairedCalls(result.rawJournals.filter(j=>j.agent!=='main'),'Write');
  assert.equal(writes.length,mode==='resumes'?6:children);
  if(write){assert.equal(result.patches.length,1);for(let i=1;i<=children;i++)assert(result.patches[0].text.includes(`CONTROL_worker-${i}`));}
 }
 await writeFile(path.join(BASE,mode,'verified.json'),JSON.stringify({case:mode,children,cap,peak:result.evidence.peakActiveTurns,status:'passed',patchBytes:result.patches.reduce((n,p)=>n+p.text.length,0)},null,2));
}

export async function runBackgroundDenialCase():Promise<void> {
 let step=0;
 const result=await runLane({name:'background-denial',cap:2,tasks:2,retry:false,write:true,budgetSeconds:45,
  beforeRun:async ctx=>{
   const eventFile=path.join(ctx.root,'background-events.jsonl');
   await writeFile(path.join(ctx.workspace,'background.test.ts'),[
    "import { test } from 'bun:test';",
    "import { appendFileSync } from 'node:fs';",
    `const log=(event:string)=>appendFileSync(${JSON.stringify(eventFile)},JSON.stringify({event,pid:process.pid,time:Date.now()})+'\\n');`,
    "test('background guard control',async()=>{log('started');await new Promise(resolve=>setTimeout(resolve,1500));log('finished');},5000);",
   ].join('\n'));
   await writeFile(path.join(ctx.workspace,'foreground.test.ts'),[
    "import { test } from 'bun:test';",
    "import { writeFileSync } from 'node:fs';",
    "test('foreground positive control',()=>writeFileSync('foreground-ran.txt','FOREGROUND_RAN\\n'));",
   ].join('\n'));
   execFileSync('git',['add','background.test.ts','foreground.test.ts'],{cwd:ctx.workspace,env:ctx.env});
   execFileSync('git',['commit','-qm','add isolated background control'],{cwd:ctx.workspace,env:ctx.env});
  },
  handler(info){
   if(!info.worker){
    if(step++===0)return wave('call_background_wave',tasks(1,2));
    if(step===2)return wave('call_following_wave',tasks(3,2));
    return {text:'BACKGROUND_DENIAL_COMPLETE'};
   }
   if(info.last?.role==='tool')return {text:`${info.worker} completed after tool result`};
   if(info.worker==='worker-1')return {tool:{name:'Bash',id:'call_background_bash',args:{command:'bun test background.test.ts',description:'Background guard control',run_in_background:true}},delayMs:500};
   if(info.worker==='worker-2')return {tool:{name:'Bash',id:'call_foreground_bash',args:{command:'bun test foreground.test.ts',description:'Foreground positive control',run_in_background:false}},delayMs:500};
   return {tool:{name:'Write',id:`call_write_${info.worker}`,args:{path:`${info.worker}.txt`,content:`FOLLOWING_WAVE_${info.worker}\n`}},delayMs:4000};
  },
 });
 assertCommon(result,true,4,2);
 const rejected=byCall(result,'call_background_bash');
 assert.equal(rejected.result.result.isError,true);
 assert.match(rejected.result.result.output,/kimi-plugin-cc safety hook:/);
 assert.match(rejected.result.result.output,/background/i);
 const foreground=byCall(result,'call_foreground_bash');
 assert(!foreground.result.result.isError,'the corresponding foreground test command must actually execute');
 assert(result.patches.some(p=>p.text.includes('FOREGROUND_RAN')));
 await assert.rejects(readFile(path.join(BASE,'background-denial','background-events.jsonl')), (error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT');
 const main=result.rawJournals.find(j=>j.agent==='main')!;
 const firstWaveIds=new Set(main.events.filter(e=>e.type==='subagent.spawned'&&e.parentToolCallId==='call_background_wave').map(e=>e.subagentId));
 assert.equal(firstWaveIds.size,2);
 const followingIds=new Set(main.events.filter(e=>e.type==='subagent.spawned'&&e.parentToolCallId==='call_following_wave').map(e=>e.subagentId));
 const nextStarts=result.evidence.turns.filter(e=>e.type==='turn.prompt'&&followingIds.has(e.agent));
 assert.equal(nextStarts.length,2);
 for(const journal of result.rawJournals.filter(j=>firstWaveIds.has(j.agent))){
  assert.equal(journal.events.filter(e=>e.type==='turn.prompt').length,1,'a finished child must not wake into another model turn');
  const end=journal.events.find(e=>e.type==='turn.ended');assert(end);
  assert(nextStarts.every(e=>e.time>=end.time));
 }
 assert(result.elapsedMs>=4000,'hold the following wave beyond the rejected background task duration');
 await writeFile(path.join(BASE,'background-denial','verified.json'),JSON.stringify({case:'background-denial',status:'passed',children:4,peak:result.evidence.peakActiveTurns,backgroundProcessStarted:false,lateFirstWaveTurns:0},null,2));
}

export async function runAutoBackgroundCase(single:boolean):Promise<void> {
 const name=single?'single-auto-background-write':'auto-background-write';
 let rootCalls=0;let rootPath='';
 const beforeFollowing:unknown[]=[];
 const entries=async()=>{
  const text=await readFile(path.join(rootPath,'auto-background-events.jsonl'),'utf8').catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return '';throw error;});
  return text.split('\n').filter(Boolean).map(line=>JSON.parse(line));
 };
 const tailProcesses=async()=>{
  const events=await entries();const pids=[...new Set<number>(events.map(e=>e.pid))];
  return {time:Date.now(),events,processes:await Promise.all(pids.map(async pid=>({pid,probe:await probeProcessIdentity(pid)})))};
 };
 const bash=():Reply=>({tool:{name:'Bash',id:'call_auto_timeout',args:{command:'bun test auto-background.test.ts',description:'Foreground timeout control',timeout:1,run_in_background:false}}});
 const result=await runLane({name,cap:single?1:2,tasks:single?1:2,retry:false,write:true,budgetSeconds:45,
  beforeRun:async ctx=>{
   rootPath=ctx.root;
   await writeFile(path.join(ctx.workspace,'auto-background.test.ts'),[
    "import { test } from 'bun:test';",
    "import { appendFileSync, writeFileSync } from 'node:fs';",
    `const log=(event:string,details:Record<string,unknown>={})=>appendFileSync(${JSON.stringify(path.join(ctx.root,'auto-background-events.jsonl'))},JSON.stringify({event,pid:process.pid,time:Date.now(),...details})+'\\n');`,
    "let signals=0;process.on('SIGTERM',()=>{const marker='AUTO_TIMEOUT_SIGNAL_'+(++signals);writeFileSync('auto-timeout-signal-'+signals+'.txt',marker+'\\n');log('SIGTERM-ignored',{marker});});",
    "test('foreground timeout must settle',async()=>{writeFileSync('auto-timeout-started.txt','AUTO_TIMEOUT_STARTED\\n');log('started');await new Promise(resolve=>setTimeout(resolve,15000));writeFileSync('auto-timeout-finished.txt','AUTO_TIMEOUT_FINISHED\\n');log('finished');},20000);",
   ].join('\n'));
   execFileSync('git',['add','auto-background.test.ts'],{cwd:ctx.workspace,env:ctx.env});
   execFileSync('git',['commit','-qm','add isolated automatic background control'],{cwd:ctx.workspace,env:ctx.env});
  },
  afterSettle:async ctx=>{
   const snapshot=async()=>{
    const database=await collectDatabase(ctx.data);const tail=await tailProcesses();
    const pids=new Set<number>([...ctx.observedProcessIdentities.map(i=>i.pid),...tail.processes.map(p=>p.pid),...database.recovery.flatMap((row:any)=>row.payload.launches.flatMap((launch:any)=>launch.identities.map((i:any)=>i.pid)))]);
    return {...tail,activeResponses:ctx.activeResponseCount(),processes:await Promise.all([...pids].map(async pid=>({pid,probe:await probeProcessIdentity(pid)})))};
   };
   const before=await snapshot();await delay(1000);const after=await snapshot();return {before,after};
  },
  handler:async info=>{
   if(!info.worker){
    rootCalls++;
    if(single){if(rootCalls===1)return bash();beforeFollowing.push(await tailProcesses());return {text:'SINGLE_AUTO_TIMEOUT_COMPLETE'};}
    if(rootCalls===1)return wave('call_auto_first',tasks(1,2));
    if(rootCalls===2){beforeFollowing.push(await tailProcesses());return wave('call_auto_following',tasks(3,2));}
    return {text:'AUTO_TIMEOUT_COMPLETE'};
   }
   if(info.worker==='worker-1')return info.last?.role==='tool'?{text:'First worker finished after its Bash result'}:bash();
   if(info.worker==='worker-2')return {text:'Companion completed',delayMs:1000};
   return {text:'Following wave completed',delayMs:3000};
  },
 });
 await writeFile(path.join(BASE,name,'auto-background-evidence.json'),JSON.stringify({single,rootCalls,beforeFollowing,settlement:result.afterSettleReport},null,2));
 assertCommon(result,true,single?0:4,single?1:2);
 const pair=byCall(result,'call_auto_timeout');
 if(!single){assert(pair.result.result.isError);assert.match(pair.result.result.output,/Command killed by timeout \(1s\)/);assert.doesNotMatch(pair.result.result.output,/moved to background|backgrounded|task_id:/i);}
 else{
  const rawOutput=pair.result.result.output;
  const output=typeof rawOutput==='string'?rawOutput:rawOutput.map((part:any)=>part.text??'').join('\n');
  assert(!pair.result.result.isError);assert.match(output,/status: running/);assert.match(output,/automatic_notification: true/);
  const taskId=output.match(/task_id: (\S+)/)?.[1];assert(taskId,'the direct-worker control must actually enter the native automatic-background path');
  const main=result.rawJournals.find(j=>j.agent==='main')!;
  assert(main.events.some(e=>e.type==='turn.prompt'&&e.trigger==='notify'&&e.origin?.kind==='task'&&e.origin?.taskId===taskId&&e.origin?.status==='completed'),'the same background task must notify the root before settlement');
 }
 const settlement=result.afterSettleReport as {before:any;after:any};
 for(const snap of [settlement.before,settlement.after]){
  assert.equal(snap.activeResponses,0);assert(snap.processes.length>0);
  assert(snap.events.some((event:any)=>event.event==='started'),'the timed foreground command must actually execute');
  assert(snap.events.every((event:any)=>event.time<=result.settledAt),'the timed command must not write after runSwarm returns');
  if(!single)assert(!snap.events.some((event:any)=>event.event==='finished'),'the killed command must not write a completion marker');
  for(const process of snap.processes){assert(process.probe.complete);assert.equal(process.probe.identity,undefined,'timed foreground work must be gone before provider cleanup');}
 }
 assert.deepEqual(settlement.before.events,settlement.after.events,'no fixture activity may occur after runSwarm returns');
 assert(result.patches.some(p=>p.text.includes('AUTO_TIMEOUT_STARTED')),'the patch must capture writes before the foreground timeout');
 for(const event of settlement.before.events.filter((event:any)=>event.marker))assert(result.patches.some(p=>p.text.includes(event.marker)),'the patch must capture writes made by the owned task during termination');
 if(single){
  assert(settlement.before.events.some((event:any)=>event.event==='finished'),'the stock direct-worker path must settle its automatic background task');
  assert(result.patches.some(p=>p.text.includes('AUTO_TIMEOUT_FINISHED')),'the patch must capture task writes completed before the direct worker settles');
 }
 if(!single){
  for(const snap of beforeFollowing as any[]){assert(snap.processes.length>0);assert(snap.processes.every((p:any)=>p.probe.complete),'the native timeout descendant state must be observed at the next wave');}
  const first=result.rawJournals.find(j=>j.agent!=='main'&&pairedCalls([j],'Bash').length>0)!;
  assert.equal(first.events.filter(e=>e.type==='turn.prompt').length,1,'foreground timeout must not wake the completed child');
  assert(!first.events.some(e=>e.type==='prompt.notified'&&JSON.stringify(e).includes('async-tool')));
 }
 await writeFile(path.join(BASE,name,'verified.json'),JSON.stringify({case:name,status:'passed',single,children:single?0:4,peak:result.evidence.peakActiveTurns,postSettlementWrites:false,quiescentBeforeProviderClose:true},null,2));
}

export async function runRecoveryCase(mode:string):Promise<void> {
 const contextError={error:{code:'context_length_exceeded',type:'invalid_request_error',message:'Context length exceeded. See https://example.invalid/docs/rate-limits for limits.'}};
 const result=await runLane({name:mode,cap:4,tasks:4,retry:false,holdMs:193000,budgetSeconds:250,
  env:{KIMI_CODE_SWARM_TIMEOUT_MS:'3000'},handler:async info=>{
   if(textContent(info.last?.content).includes('Create a handoff summary'))return {rawEvents:[contextError]};
   if(info.worker!=='worker-1'||info.last?.role==='tool')return undefined;
   if(mode==='recovery-429')return info.workerAttempt===1?{status:429,headers:{'retry-after':'1'},text:JSON.stringify({error:{type:'rate_limit_error',message:'scripted rate limit'}})}:undefined;
   const evidence=await journalEvidence(path.join(info.root,'home'));
   if(evidence.workers.some(w=>w.turnEnds.some((e:any)=>e.reason==='failed')))return undefined;
   return {rawEvents:[contextError]};
  }
 });
 assertCommon(result,false,4,4);
 const failed=result.evidence.turns.filter(e=>e.type==='turn.ended'&&e.reason==='failed');assert(failed.length>0);
 assert(result.evidence.workers.some(w=>w.turnPrompts>1),'native recovery must actually retry a failed child');
 assert(result.elapsedMs>193000);assert.equal(pairedCalls(result.rawJournals.filter(j=>j.agent!=='main'),'Write').length,4);
 await writeFile(path.join(BASE,mode,'verified.json'),JSON.stringify({case:mode,cap:4,children:4,peak:result.evidence.peakActiveTurns,elapsedMs:result.elapsedMs,status:'passed'},null,2));
}

if(import.meta.main){
 const mode=process.argv[2];
 if((ADMISSION_CASES as readonly string[]).includes(mode))await runAdmissionCase(mode);
 else if((RECOVERY_CASES as readonly string[]).includes(mode))await runRecoveryCase(mode);
 else if(mode==='background-denial')await runBackgroundDenialCase();
 else if(mode==='auto-background-write'||mode==='single-auto-background-write')await runAutoBackgroundCase(mode==='single-auto-background-write');
 else if((LIFECYCLE_MODES as readonly string[]).includes(mode))await runLifecycleCase(mode as Parameters<typeof runLifecycleCase>[0]);
 else throw Error(`unknown bounded swarm case: ${mode}`);
 console.log(`PASS bounded swarm ${mode}`);
}
