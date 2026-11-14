import { describe, expect, test } from "bun:test";
import { runOwnedCaseProcess } from "../helpers/owned-case-process.js";
import { probeProcessIdentity } from "../../runtime/process-tree.js";

const suite=process.platform === "win32" ? describe.skip : describe;
const childScript="process.on('SIGTERM',()=>{});setInterval(()=>{},1000);setTimeout(()=>process.exit(0),10000);";
const script=(exitNormally:boolean)=>`
 const {spawn}=require('node:child_process');
 const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{detached:true,stdio:'ignore'});
 console.log('OWNED_DESCENDANT='+child.pid);
 process.on('SIGTERM',()=>{});
 ${exitNormally?"setTimeout(()=>process.exit(0),600)":"setInterval(()=>{},1000)"};
`;

suite("bounded certification subprocess watchdog",()=>{
 test("escalates a stuck runner and its detached child, then verifies quiescence",async()=>{
  const run=await runOwnedCaseProcess(process.execPath,["-e",script(false)],{timeoutMs:1200,graceMs:200,killWaitMs:3000});
  expect(run.timedOut).toBe(true);expect(run.quiescent).toBe(true);
  const pid=Number(run.stdout.match(/OWNED_DESCENDANT=(\d+)/)?.[1]);expect(pid).toBeGreaterThan(0);
  expect(run.identities.some(identity=>identity.pid===pid)).toBe(true);
  const probe=await probeProcessIdentity(pid);expect(probe.complete).toBe(true);expect(probe.identity).toBeUndefined();
 },10000);
 test("finally cleans an observed detached child after a normal runner exit",async()=>{
  const run=await runOwnedCaseProcess(process.execPath,["-e",script(true)],{timeoutMs:3000,graceMs:200,killWaitMs:3000});
  expect(run.timedOut).toBe(false);expect(run.code).toBe(0);expect(run.quiescent).toBe(true);
  const pid=Number(run.stdout.match(/OWNED_DESCENDANT=(\d+)/)?.[1]);expect(pid).toBeGreaterThan(0);
  expect(run.identities.some(identity=>identity.pid===pid)).toBe(true);
  const probe=await probeProcessIdentity(pid);expect(probe.complete).toBe(true);expect(probe.identity).toBeUndefined();
 },10000);
 test("captures a detached child started by the runner during SIGTERM grace",async()=>{
  const source=`
   const {spawn}=require('node:child_process');
   process.on('SIGTERM',()=>{
    const late=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{detached:true,stdio:'ignore'});
    console.log('LATE_DESCENDANT='+late.pid);
    setTimeout(()=>process.exit(0),500);
   });
   setInterval(()=>{},1000);
  `;
  const run=await runOwnedCaseProcess(process.execPath,["-e",source],{timeoutMs:600,graceMs:1200,killWaitMs:3000});
  expect(run.timedOut).toBe(true);expect(run.quiescent).toBe(true);
  const pid=Number(run.stdout.match(/LATE_DESCENDANT=(\d+)/)?.[1]);expect(pid).toBeGreaterThan(0);
  expect(run.identities.some(identity=>identity.pid===pid)).toBe(true);
  const probe=await probeProcessIdentity(pid);expect(probe.complete).toBe(true);expect(probe.identity).toBeUndefined();
 },10000);
 test("keeps discovering from an owned descendant after the runner exits",async()=>{
  const anchor=`
   const {spawn}=require('node:child_process');
   process.on('SIGTERM',()=>{});
   setTimeout(()=>{
    const late=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{detached:true,stdio:'ignore'});
    console.log('LATE_GRANDCHILD='+late.pid);
    setTimeout(()=>process.exit(0),350);
   },1800);
   setInterval(()=>{},1000);
  `;
  const source=`
   const {spawn}=require('node:child_process');
   const anchor=spawn(process.execPath,['-e',${JSON.stringify(anchor)}],{detached:true,stdio:['ignore','inherit','inherit']});
   console.log('OWNED_ANCHOR='+anchor.pid);
   process.on('SIGTERM',()=>process.exit(0));
   setInterval(()=>{},1000);
  `;
  const run=await runOwnedCaseProcess(process.execPath,["-e",source],{timeoutMs:600,graceMs:2200,killWaitMs:3000});
  expect(run.timedOut).toBe(true);expect(run.quiescent).toBe(true);
  const pid=Number(run.stdout.match(/LATE_GRANDCHILD=(\d+)/)?.[1]);expect(pid).toBeGreaterThan(0);
  expect(run.identities.some(identity=>identity.pid===pid)).toBe(true);
  const probe=await probeProcessIdentity(pid);expect(probe.complete).toBe(true);expect(probe.identity).toBeUndefined();
 },10000);
});
