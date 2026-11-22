import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {apply} from '../ledger.mjs';
import {projectLedger} from '../ui/viewer.mjs';

const id='viewer_task';
const create={id,requestId:'viewer_create_01',action:'create',actor:'coordinator',role:'planner',title:'Read-only viewer verification',project:'Workbench'};
const assign={id,requestId:'viewer_assign_01',action:'assign',actor:'coordinator',role:'planner',owner:'claude'};
const submit={id,requestId:'viewer_submit_01',action:'submit',actor:'claude',role:'developer',evidence:'report SHA256:abcd'};
const accept={id,requestId:'viewer_accept_01',action:'accept',actor:'reviewer_a',role:'reviewer',comment:'Reviewed'};
function fixture(){const dir=mkdtempSync(path.join(os.tmpdir(),'workbench-view-'));return {dir,file:path.join(dir,'tasks.jsonl'),cleanup:()=>rmSync(dir,{recursive:true,force:true})};}

test('viewer verifies v2 chain and projects task states without mutation',async()=>{
 const f=fixture();
 try{
  for(const e of [create,assign,submit,accept])apply(f.file,e);
  const before=readFileSync(f.file,'utf8');
  const result=await projectLedger(before);
  assert.equal(result.integrity,'V2_CHAIN_VERIFIED');
  assert.equal(result.eventCount,4);
  assert.equal(result.v2EventCount,4);
  assert.equal(result.tasks[0].state,'ACCEPTED');
  assert.equal(readFileSync(f.file,'utf8'),before);
 }finally{f.cleanup();}
});

test('viewer marks a legacy-only log as unchained rather than calling it verified',async()=>{
 const f=fixture();
 try{
  const legacy={id,action:'create',actor:'coordinator',role:'planner',title:'Legacy task',project:'Workbench'};
  writeFileSync(f.file,JSON.stringify(legacy)+'\n');
  const result=await projectLedger(readFileSync(f.file,'utf8'));
  assert.equal(result.integrity,'LEGACY_UNCHAINED');
  assert.equal(result.legacyEventCount,1);
  assert.equal(result.tasks[0].state,'QUEUED');
 }finally{f.cleanup();}
});

test('viewer verifies first v2 record anchored to legacy prefix',async()=>{
 const f=fixture();
 try{
  const old={id,action:'create',actor:'coordinator',role:'planner',title:'Legacy task',project:'Workbench',recordedAt:'old',eventId:'legacy1'};
  writeFileSync(f.file,JSON.stringify(old)+'\n');
  const next={...assign,requestId:'viewer_assign_after_legacy'};
  apply(f.file,next);
  const result=await projectLedger(readFileSync(f.file,'utf8'));
  assert.equal(result.integrity,'V2_CHAIN_VERIFIED');
  assert.equal(result.legacyEventCount,1);
  assert.equal(result.v2EventCount,1);
  assert.equal(result.tasks[0].state,'ASSIGNED');
 }finally{f.cleanup();}
});

test('viewer fails closed on tamper, torn tail and invalid transitions',async()=>{
 const f=fixture();
 try{
  apply(f.file,create);
  const original=readFileSync(f.file,'utf8');
  await assert.rejects(projectLedger(original.replace('Read-only viewer verification','changed')),/LEDGER_PAYLOAD_HASH_MISMATCH/);
  await assert.rejects(projectLedger(original.slice(0,-1)),/LEDGER_TORN_TAIL/);
  const oldCreate={id,action:'create',actor:'coordinator',role:'planner',title:'Legacy invalid transition',project:'Workbench'};
  const badAccept={id,action:'accept',actor:'reviewer_a',role:'reviewer',comment:'Cannot accept before submit'};
  const invalidHistory=JSON.stringify(oldCreate)+'\n'+JSON.stringify(badAccept)+'\n';
  await assert.rejects(projectLedger(invalidHistory),/INVALID_TRANSITION/);
 }finally{f.cleanup();}
});


test('viewer UI stays local, read-only and resistant to imported HTML injection',()=>{
 const uiDir=path.resolve(path.dirname(new URL(import.meta.url).pathname),'../ui');
 const html=readFileSync(path.join(uiDir,'index.html'),'utf8');
 const app=readFileSync(path.join(uiDir,'app.mjs'),'utf8');
 const viewer=readFileSync(path.join(uiDir,'viewer.mjs'),'utf8');
 assert.match(html,/connect-src 'none'/);
 assert.match(html,/script-src 'self'/);
 assert.match(html,/src="\.\.\/|src="\.\/app\.mjs"/);
 assert.doesNotMatch(html,/(?:src|href)="https?:\/\//i);
 assert.doesNotMatch(html,/\son(?:click|change|input)=/i);
 for(const source of [app,viewer]){
  assert.doesNotMatch(source,/\bfetch\s*\(/);
  assert.doesNotMatch(source,/\bXMLHttpRequest\b/);
  assert.doesNotMatch(source,/\blocalStorage\b|\bsessionStorage\b/);
  assert.doesNotMatch(source,/\binnerHTML\b/);
 }
 assert.match(app,/\.textContent\s*=/);
});
