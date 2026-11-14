import http from 'node:http';
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { probeProcessIdentity, type ProcessIdentity } from '../../runtime/process-tree.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
// Execute the emitted command, environment builder, and capability map together.
// Source imports below are type-only; the hook installed by setup is emitted too.
const { runSetup } = await import(new URL('../../dist/commands/setup.js', import.meta.url).href) as typeof import('../../runtime/commands/setup.js');
const { runSwarm } = await import(new URL('../../dist/commands/swarm.js', import.meta.url).href) as typeof import('../../runtime/commands/swarm.js');
const { NATIVE_V2_CERTIFIED } = await import(new URL('../../dist/kimi-engine.js', import.meta.url).href) as typeof import('../../runtime/kimi-engine.js');

export const BIN = process.env.KIMI_PLUGIN_CC_KIMI_BIN ?? '';
export const STOCK_SHA = 'f07d4f0d28ba1dd3397cb070aa757f7b7610a51bb15164f1e158fad7809cb36a';
export const BASE = process.env.KIMI_PLUGIN_CC_BOUNDED_SMOKE_OUTPUT ?? '';
export type RequestInfo = { body: any; worker: string | null; index: number; workerAttempt: number; elapsed: number; root: string; last: any };
export type Reply = { status?: number; headers?: Record<string,string>; text?: string; tool?: { name:string; args:any; id?:string }; usage?: {prompt_tokens:number;completion_tokens:number;total_tokens:number}; rawEvents?:any[]; delayMs?:number };
export type LaneContext = {root:string;home:string;workspace:string;data:string;env:NodeJS.ProcessEnv;context:any};
export type SettledContext = LaneContext & {report:string;error:any;settledAt:number;settledMonoMs:number;activeResponseCount:()=>number;observedProcessIdentities:ProcessIdentity[]};
export type Options = { name:string; cap?:number; tasks:number; retry:boolean; write?:boolean; holdMs?:number; rateLimitCount?:number; budgetSeconds?:number; env?:Record<string,string>; handler?:(info:RequestInfo)=>Promise<Reply|undefined>|Reply|undefined; postSetup?:(ctx:LaneContext)=>Promise<void>|void; beforeRun?:(ctx:LaneContext)=>Promise<void>|void; afterSettle?:(ctx:SettledContext)=>Promise<unknown>|unknown; expectFailure?:boolean; };

export const delay = (ms:number)=>new Promise(r=>setTimeout(r,ms));
export function textContent(content:any):string { return typeof content==='string'?content:JSON.stringify(content??''); }
export function sse(reply:Reply):string {
 const usage=reply.usage??{prompt_tokens:1,completion_tokens:1,total_tokens:2};
 const delta=reply.tool?{role:'assistant',tool_calls:[{index:0,id:reply.tool.id??'call_control',type:'function',function:{name:reply.tool.name,arguments:JSON.stringify(reply.tool.args)}}]}:{role:'assistant',content:reply.text??'Completed.'};
 const events=reply.rawEvents??[
  {id:'chatcmpl-control',object:'chat.completion.chunk',created:1,model:'swarm-retry-control',choices:[{index:0,delta,finish_reason:null}]},
  {id:'chatcmpl-control',object:'chat.completion.chunk',created:1,model:'swarm-retry-control',choices:[{index:0,delta:{},finish_reason:reply.tool?'tool_calls':'stop'}],usage}
 ];
 return events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')+'data: [DONE]\n\n';
}
export async function files(dir:string):Promise<string[]> {
 const entries=await readdir(dir,{withFileTypes:true}).catch(()=>[]); const result:string[]=[];
 for(const e of entries){const p=path.join(dir,e.name); if(e.isDirectory()) result.push(...await files(p));else result.push(p);} return result;
}
export async function journalEvidence(home:string) {
 const journals=(await files(path.join(home,'sessions'))).filter(p=>p.endsWith('/wire.jsonl'));
 const turns:any[]=[]; const workers:any[]=[]; const writes:any[]=[]; const mainToolEvents:any[]=[];const mainSubagentEvents:any[]=[];
 for(const file of journals){
  const events=(await readFile(file,'utf8')).split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  const agent=path.basename(path.dirname(file));
  if(agent==='main'){for(const e of events){const tool=e.type==='context.append_loop_event'?e.event:e;if(tool?.type==='tool.call'||tool?.type==='tool.result')mainToolEvents.push({file,agent,time:e.time,...tool});if(e.type.includes('subagent'))mainSubagentEvents.push({file,...e});}continue;}
  workers.push({agent,file,events:events.length,turnPrompts:events.filter(e=>e.type==='turn.prompt').length,turnEnds:events.filter(e=>e.type==='turn.ended').map(e=>({reason:e.reason,error:e.error,time:e.time}))});
  for(const e of events){if(e.type==='turn.prompt'||e.type==='turn.ended')turns.push({type:e.type,agent,turnId:e.turnId,time:e.time,reason:e.reason,error:e.error});
   const tool=e.type==='context.append_loop_event'?e.event:e;
   if(tool?.type==='tool.call'||tool?.type==='tool.result')writes.push({file,agent,time:e.time,...tool});}
 }
 turns.sort((a,b)=>a.time-b.time||(a.type==='turn.ended'?-1:1));
 const active=new Set<string>();let peak=0;
 for(const e of turns){const key=`${e.agent}:${e.turnId}`;if(e.type==='turn.prompt')active.add(key);else active.delete(key);peak=Math.max(peak,active.size);}
 return {workers,turns,peakActiveTurns:peak,remaining:[...active],toolEvents:writes,mainToolEvents,mainSubagentEvents};
}

export async function runLane(options:Options) {
 assert(BIN && path.isAbsolute(BIN), 'explicit absolute stock binary required');
 assert(BASE && path.isAbsolute(BASE), 'explicit absolute evidence directory required');
 await mkdir(BASE,{recursive:true});
 const root=path.join(BASE,options.name);await mkdir(root);const home=path.join(root,'home');const workspace=path.join(root,'workspace');const data=path.join(root,'data');
 const implementationHashes=await implementationFingerprints();
 await Promise.all([mkdir(home,{mode:0o700}),mkdir(workspace),mkdir(data)]);
 if(execFileSync(BIN,['--version'],{encoding:'utf8'}).trim()!=='2.6.2')throw Error('binary not exact2.6.2');
 const binaryMain=await realpath(BIN);const sha=createHash('sha256').update(await readFile(binaryMain)).digest('hex');
 if(sha!=='f07d4f0d28ba1dd3397cb070aa757f7b7610a51bb15164f1e158fad7809cb36a')throw Error(`binary hash mismatch ${sha}`);
 const gitEnv={PATH:process.env.PATH,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_AUTHOR_NAME:'retry-control',GIT_AUTHOR_EMAIL:'retry@test',GIT_COMMITTER_NAME:'retry-control',GIT_COMMITTER_EMAIL:'retry@test'};
 const git=(args:string[])=>execFileSync('git',args,{cwd:workspace,env:gitEnv,encoding:'utf8'});
 git(['init','-q']);await writeFile(path.join(workspace,'seed.txt'),'original\n');git(['add','seed.txt']);git(['commit','-q','-m','initial']);
 const startedAt=Date.now();const startedMono=performance.now();const requests:any[]=[];const attempts=new Map<string,number>();let firstWorkerAt=0;let rejected=0;let closed=0;const providerErrors:string[]=[];const responseTimers=new Set<ReturnType<typeof setTimeout>>();const activeResponses=new Set<http.ServerResponse>();
 const log=(event:any)=>appendFileSync(path.join(root,'requests.jsonl'),JSON.stringify({time:Date.now(),monoMs:performance.now()-startedMono,...event})+'\n');
 const server=http.createServer((req,res)=>{activeResponses.add(res);res.once('close',()=>activeResponses.delete(res));void(async()=>{
   if(req.method!=='POST'||req.url!=='/v1/chat/completions'||req.headers.authorization!=='Bearer scripted-test-only'){rejected++;res.writeHead(401);res.end('unexpected route/auth');return;}
   const chunks=[];for await(const part of req)chunks.push(part);const body=JSON.parse(Buffer.concat(chunks).toString());
   const users=(body.messages??[]).filter((m:any)=>m.role==='user').map((m:any)=>textContent(m.content));
   const worker=users.map((s:string)=>s.match(/WORKER_KEY:\s*(worker-\d+)/)?.[1]).find(Boolean)??null;
   const last=body.messages?.at(-1);const workerAttempt=worker?(attempts.get(worker)??0)+1:0;if(worker)attempts.set(worker,workerAttempt);
   if(worker&&!firstWorkerAt)firstWorkerAt=Date.now();
   const info:RequestInfo={body,worker,index:requests.length,workerAttempt,elapsed:firstWorkerAt?Date.now()-firstWorkerAt:0,root,last};
   requests.push({index:info.index,worker,workerAttempt,elapsed:info.elapsed,lastRole:last?.role});
   log({event:'request',...requests.at(-1),tools:body.tools?.map((x:any)=>x.function?.name)});
   if(info.index<3||(worker&&workerAttempt===1))await writeFile(path.join(root,`request-${info.index}.json`),JSON.stringify(body,null,2));
   res.on('close',()=>{closed++;log({event:'response-close',index:info.index,worker});});
   let reply=await options.handler?.(info);
   if(!reply){
    if(!worker){
     reply=last?.role==='tool'?{text:'SWARM_CONTROL_COMPLETE'}:{tool:{name:'AgentSwarm',id:'call_swarm_control',args:{description:'scripted retry control',subagent_type:'coder',prompt_template:'WORKER_KEY: {{item}}. Execute scripted control.',items:Array.from({length:options.tasks},(_,i)=>`worker-${i+1}`)}}};
    } else if(last?.role==='tool')reply={text:`${worker} TOOL_RESULT ${textContent(last.content)}`};
    else if(workerAttempt<=(options.rateLimitCount??0))reply={status:429,headers:{'retry-after':'1'},text:JSON.stringify({error:{type:'rate_limit_error',message:'scripted rate limit'}})};
    else reply={tool:{name:'Write',id:`call_write_${worker}`,args:{path:`${worker}.txt`,content:`CONTROL_${worker}\n`}},delayMs:Math.max(0,(options.holdMs??0)-info.elapsed)};
   }
   if(reply.delayMs){await new Promise<void>(resolve=>{const timer=setTimeout(()=>{responseTimers.delete(timer);resolve();},reply!.delayMs);responseTimers.add(timer);res.once('close',()=>{clearTimeout(timer);responseTimers.delete(timer);resolve();});});}
   if(res.destroyed)return;
   const status=reply.status??200;log({event:'response',index:info.index,worker,status,tool:reply.tool?.name});
   if(status!==200){res.writeHead(status,{'content-type':'application/json',...reply.headers});res.end(reply.text);return;}
   res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache',...reply.headers});res.end(sse(reply));
  })().catch(error=>{providerErrors.push(String(error));log({event:'provider-error',message:String(error)});if(!res.headersSent)res.writeHead(500);res.end(String(error));});});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const address=server.address() as any;
 const env:NodeJS.ProcessEnv={HOME:root,TMPDIR:process.env.TMPDIR,KIMI_CODE_HOME:home,KIMI_PLUGIN_CC_DATA:data,KIMI_PLUGIN_CC_KIMI_BIN:BIN,KIMI_PLUGIN_CC_NODE_BIN:execFileSync('which',['node'],{encoding:'utf8'}).trim(),KIMI_CODE_NO_AUTO_UPDATE:'1',KIMI_MODEL_API_KEY:'scripted-test-only',KIMI_CODE_API_KEY:'scripted-test-only',KIMI_MODEL_NAME:'swarm-retry-control',KIMI_MODEL_PROVIDER_TYPE:'kimi',KIMI_MODEL_BASE_URL:`http://127.0.0.1:${address.port}/v1`,KIMI_MODEL_CAPABILITIES:'tool_use',KIMI_CODE_INFINITE_RETRY:options.retry?'1':'0',KIMI_LOOP_MAX_ATTEMPTS_PER_STEP:'1',...gitEnv,...options.env};
 const context={cwd:workspace,env,stdout:process.stdout,stderr:process.stderr};
 if(process.env.KIMI_PLUGIN_CC_SMOKE_V2_CANDIDATE==='2.6.2'){const matrix=NATIVE_V2_CERTIFIED as Map<any,readonly string[]>;for(const op of ['swarm','swarm-write'])matrix.set(op,[...new Set([...(matrix.get(op)??[]),'2.6.2'])]);}
 let report='';let error:any;let setup:any;let settledAt:number|undefined;let settledMonoMs:number|undefined;let afterSettleReport:unknown;
 const snapshots:any[]=[];let polling=false;const observedProcesses=new Map<string,ProcessIdentity>();
 const poll=setInterval(()=>{if(polling)return;polling=true;void journalEvidence(home).then(j=>{snapshots.push({time:Date.now(),workers:j.workers.length,active:j.remaining.length,peak:j.peakActiveTurns});}).then(async()=>{const db=await collectDatabase(data);for(const job of db.jobs){if(typeof job.kimi_pid==='number'){const probe=await probeProcessIdentity(job.kimi_pid);if(probe.identity)observedProcesses.set(`${probe.identity.pid}:${probe.identity.startToken}`,probe.identity);}}}).finally(()=>polling=false);},250);
 try {setup=await runSetup([],context);if(setup.probe!=='ok')throw Error(`setup failed ${JSON.stringify(setup)}`);
   const laneContext={root,home,workspace,data,env,context};
   await options.postSetup?.(laneContext);
   await options.beforeRun?.(laneContext);
   report=await runSwarm([...(options.write?['--write']:[]),'--budget',`${options.budgetSeconds??60}s`,...(options.cap===undefined?[]:['--max-concurrency',String(options.cap)]),`ROOT_CONTROL ${options.name}`],context);
 } catch(e:any){error={name:e.name,message:e.message,code:e.code,details:e.details};}
 finally {settledAt=Date.now();settledMonoMs=performance.now()-startedMono;log({event:'run-settled',activeResponses:activeResponses.size,settledAt,settledMonoMs});
  try{afterSettleReport=await (options.afterSettle??assertSettled)({root,home,workspace,data,env,context,report,error,settledAt,settledMonoMs,activeResponseCount:()=>activeResponses.size,observedProcessIdentities:[...observedProcesses.values()]});}catch(e:any){error??={name:e.name,message:e.message,stage:'harness.afterSettle'};}
  log({event:'harness-server-cleanup',activeResponses:activeResponses.size});clearInterval(poll);for(const timer of responseTimers)clearTimeout(timer);server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
 const evidence=await journalEvidence(home);const all=await files(data);const patches=await Promise.all(all.filter(p=>p.endsWith('.patch')).map(async p=>({path:p,text:await readFile(p,'utf8')})));
 const database=await collectDatabase(data);const rawJournals=await readJournals(home);
 const implementationFinalHashes=await implementationFingerprints();
 assert.deepEqual(implementationHashes,implementationFinalHashes,'implementation changed during binary control');
 const output={name:options.name,options:{...options,handler:options.handler?'custom':undefined,postSetup:options.postSetup?'custom':undefined,beforeRun:options.beforeRun?'custom':undefined,afterSettle:options.afterSettle?'custom':undefined},binary:BIN,binaryMain,sha256:sha,implementationHashes,implementationFinalHashes,database,rawJournals,elapsedMs:Date.now()-startedAt,settledAt,settledMonoMs,afterSettleReport,requestCount:requests.length,requests,attempts:Object.fromEntries(attempts),rejected,closed,providerErrors,setup,report,error,evidence,snapshots,patches,userStatus:git(['status','--porcelain','--untracked-files=all']),userFiles:await readdir(workspace),dataFiles:all};
 await writeFile(path.join(root,'result.json'),JSON.stringify(output,null,2));
 console.log(JSON.stringify({name:options.name,elapsedMs:output.elapsedMs,requests:requests.length,attempts:output.attempts,peak:evidence.peakActiveTurns,workers:evidence.workers.length,error,report:report.slice(0,200),patches:patches.length}));
 assert.equal(rejected,0,'unexpected provider route/auth');assert.equal(providerErrors.length,0,providerErrors.join('\n'));
 return output;
}



export async function collectDatabase(data:string):Promise<{jobs:any[];recovery:any[]}> {
 const file=(await files(data)).find(p=>p.endsWith('/state.db'));
 if(!file)return {jobs:[],recovery:[]};
 const db=new Database(file,{readonly:true});
 try{return {jobs:db.query('select * from jobs').all(),recovery:db.query('select * from swarm_recovery').all().map((row:any)=>({...row,payload:JSON.parse(row.payload)}))};}finally{db.close();}
}
export async function readJournals(home:string):Promise<Array<{agent:string;file:string;events:any[]}>> {
 return Promise.all((await files(path.join(home,'sessions'))).filter(p=>p.endsWith('/wire.jsonl')).map(async file=>({agent:path.basename(path.dirname(file)),file,events:(await readFile(file,'utf8')).split('\n').filter(Boolean).map(s=>JSON.parse(s))})));
}
export function pairedCalls(journals:Array<{agent:string;events:any[]}>,name?:string):Array<{agent:string;call:any;result:any}> {
 const pairs=[];
 for(const journal of journals){const tools=journal.events.map(e=>e.type==='context.append_loop_event'?e.event:e);for(const call of tools){if(call?.type!=='tool.call'||name&&call.name!==name)continue;const results=tools.filter(e=>e?.type==='tool.result'&&e.toolCallId===call.toolCallId&&e.parentUuid===call.uuid);assert.equal(results.length,1,`result must match ${journal.agent}/${call.toolCallId}/${call.uuid}`);pairs.push({agent:journal.agent,call,result:results[0]});}}
 return pairs;
}
export type RunResult = Awaited<ReturnType<typeof runLane>>;

async function implementationFingerprints():Promise<Record<string,string>> {
 const names=['runtime/commands/swarm.ts','runtime/cli-client.ts','runtime/process-tree.ts','runtime/hooks/approval-policy.ts','runtime/swarm-policy.ts','runtime/swarm-tool-policy.ts','dist/commands/swarm.js','dist/commands/setup.js','dist/cli-client.js','dist/process-tree.js','dist/kimi-engine.js','dist/swarm-activation.js','dist/hooks/approval-hook.js','dist/hooks/approval-policy.js','dist/swarm-policy.js','dist/swarm-tool-policy.js'];
 return Object.fromEntries(await Promise.all(names.map(async name=>[name,createHash('sha256').update(await readFile(new URL(`../../${name}`,import.meta.url))).digest('hex')])));
}

async function assertSettled(ctx:SettledContext):Promise<unknown> {
 const database=await collectDatabase(ctx.data);
 const identities=[...ctx.observedProcessIdentities,...database.recovery.flatMap((row:any)=>row.payload.launches.flatMap((launch:any)=>launch.identities))];
 const unique=[...new Map(identities.map((identity:ProcessIdentity)=>[`${identity.pid}:${identity.startToken}`,identity])).values()];
 assert(unique.length>0,'must observe an owned Kimi process before checking settlement');
 const snapshot=async()=>{
  assert.equal(ctx.activeResponseCount(),0,'provider requests must close before provider shutdown');
  const probes=await Promise.all(unique.map(async original=>({original,probe:await probeProcessIdentity(original.pid)})));
  for(const {original,probe} of probes){assert(probe.complete);assert(!probe.identity||probe.identity.startToken!==original.startToken,`owned process ${original.pid} survived settlement`);}
  return {time:Date.now(),activeResponses:ctx.activeResponseCount(),probes};
 };
 const before=await snapshot();await delay(1000);const after=await snapshot();return {before,after};
}
