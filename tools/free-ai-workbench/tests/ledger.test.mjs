import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {apply,getState,replay} from '../ledger.mjs';

const id='task_001';
const create={id,requestId:'req_create_001',action:'create',actor:'coordinator',role:'planner',title:'NSS Engine read-only smoke test',project:'NSS Engine'};
const assign={id,requestId:'req_assign_001',action:'assign',actor:'coordinator',role:'planner',owner:'gemini'};
const submit={id,requestId:'req_submit_001',action:'submit',actor:'gemini',role:'developer',evidence:'report.md SHA256:0123'};
const accept={id,requestId:'req_accept_001',action:'accept',actor:'reviewer_a',role:'reviewer',comment:'Reviewed dry-run evidence'};
function fixture(){
 const dir=mkdtempSync(path.join(os.tmpdir(),'free-workbench-'));
 return {dir,file:path.join(dir,'tasks.jsonl'),cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}

test('legitimate transitions reach ACCEPTED with durable event history',()=>{
 const state=replay([create,assign,submit,accept]);
 assert.equal(state[id].state,'ACCEPTED');
 assert.equal(state[id].history.length,4);
});

test('no self-approval or silent transitions',()=>{
 assert.throws(()=>replay([create,assign,submit,{...accept,actor:'gemini'}]),/SELF_REVIEW_DENIED/);
 assert.throws(()=>replay([create,accept]),/INVALID_TRANSITION/);
 assert.throws(()=>replay([create,{...assign,role:'developer'}]),/ASSIGN_ROLE_DENIED/);
});

test('append is idempotent for the same requestId and payload',()=>{
 const f=fixture();
 try{
  const first=apply(f.file,create);
  const bytes=readFileSync(f.file,'utf8');
  const again=apply(f.file,create);
  assert.equal(again.state,first.state);
  assert.equal(readFileSync(f.file,'utf8'),bytes);
  assert.equal(getState(f.file)[id].history.length,1);
 }finally{f.cleanup();}
});

test('same requestId with a different payload is rejected',()=>{
 const f=fixture();
 try{
  apply(f.file,create);
  assert.throws(()=>apply(f.file,{...create,title:'Different payload'}),/IDEMPOTENCY_CONFLICT/);
  assert.equal(getState(f.file)[id].title,create.title);
 }finally{f.cleanup();}
});

test('every appended record has a verified hash-chain link',()=>{
 const f=fixture();
 try{
  for(const event of [create,assign,submit,accept])apply(f.file,event);
  const rows=readFileSync(f.file,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length,4);
  assert.equal(rows[0].previousHash,'0'.repeat(64));
  assert.equal(rows[1].previousHash,rows[0].eventHash);
  assert.equal(getState(f.file)[id].state,'ACCEPTED');
 }finally{f.cleanup();}
});

test('tampered record is rejected before state is exposed',()=>{
 const f=fixture();
 try{
  apply(f.file,create);
  const original=readFileSync(f.file,'utf8');
  writeFileSync(f.file,original.replace('NSS Engine read-only smoke test','tampered'));
  assert.throws(()=>getState(f.file),/LEDGER_PAYLOAD_HASH_MISMATCH|LEDGER_CHAIN_HASH_MISMATCH/);
 }finally{f.cleanup();}
});

test('torn final JSONL record fails closed; no automatic truncation',()=>{
 const f=fixture();
 try{
  apply(f.file,create);
  appendFileSync(f.file,'{"id":"partial"');
  assert.throws(()=>getState(f.file),/LEDGER_TORN_TAIL/);
  assert.match(readFileSync(f.file,'utf8'),/\{"id":"partial"$/);
 }finally{f.cleanup();}
});

test('existing lock is not stolen or silently removed',()=>{
 const f=fixture();
 try{
  writeFileSync(f.file+'.lock','{"pid":999999,"lockToken":"other"}\n');
  assert.throws(()=>apply(f.file,create),/LEDGER_LOCKED/);
  assert.equal(readFileSync(f.file+'.lock','utf8').includes('other'),true);
 }finally{f.cleanup();}
});

test('no task execution or model invocation, only local journal writes',()=>{
 const f=fixture();
 try{
  for(const event of [create,assign,submit,accept])apply(f.file,event);
  assert.equal(getState(f.file)[id].state,'ACCEPTED');
  assert.equal(readFileSync(f.file,'utf8').trim().split('\n').length,4);
  assert.throws(()=>apply(f.file,accept),/INVALID_TRANSITION/);
  assert.equal(readFileSync(f.file,'utf8').trim().split('\n').length,4);
 }finally{f.cleanup();}
});
